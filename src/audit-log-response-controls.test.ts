import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { GatewayOp } from './gateway/opcodes'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRealServer,
  seedBot,
  seedGuild,
  seedChannel,
  type RealServerContext,
} from './test-helpers'

const TOKEN = 'Bot audit-response'
const BOT = '111111111111111111'
const GUILD = '222222222222222222'
let server: RealServerContext

/** Calls mounted routes over the actual HTTP server. */
function request(path: string, method = 'GET', body?: unknown, token?: string) {
  return fetch(server.baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: token }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(2000),
  })
}

/** Projects a response status without accessing an await expression. */
async function statusOf(response: Promise<Response>): Promise<number> {
  const result = await response
  return result.status
}

/** Reads untrusted JSON from an HTTP response. */
async function json(response: Promise<Response>): Promise<unknown> {
  const result = await response
  return result.json()
}

/** Builds an explicit exact-query control. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    bot_id: BOT,
    guild_id: GUILD,
    query: { action_type: 72, limit: 1 },
    entries: [{ action_type: 73, id: 'not-a-snowflake', options: null }],
    ttl_ms: 60_000,
    ...overrides,
  }
}

/** Creates a control through the public test API. */
async function arm(overrides: Record<string, unknown> = {}) {
  const response = await request(
    '/_test/audit-log-responses',
    'POST',
    payload(overrides)
  )
  expect(response.status).toBe(201)
  return response.json() as Promise<{
    id: string
    remaining: number
    consumed: number
  }>
}

beforeEach(async () => {
  server = await createRealServer()
  seedBot(server.db, TOKEN, BOT)
  seedGuild(server.db, TOKEN, GUILD)
  const channel = seedChannel(server.db, GUILD)
  const fixture = await request(`/_test/guilds/${GUILD}/audit-logs`, 'POST', {
    id: '100',
    action_type: 72,
    user_id: BOT,
    target_id: BOT,
    options: { channel_id: channel, count: '1' },
  })
  expect(fixture.status).toBe(201)
})

afterEach(async () => {
  await server.close()
})

describe('controlled audit responses over actual HTTP', () => {
  it.each(['/api/v10', '/api', ''])(
    'delivers unexpected actions despite filtering under %s, then restores normal data',
    async (prefix) => {
      const entries = [
        { action_type: 73, id: 'invalid', options: null },
        { action_type: 999, options: { channel_id: 42, count: 'NaN' } },
        { action_type: 72, id: null },
        { action_type: 72, id: 42, options: {} },
        { action_type: 72, id: {}, options: { count: null } },
        { action_type: 72, id: '01', options: { channel_id: null, count: 1 } },
        {
          action_type: 72,
          id: '-1',
          options: { channel_id: 'bad', count: [] },
        },
        { action_type: 72, id: [], options: [] },
        {},
      ]
      const control = await arm({ entries, times: 2 })
      const path = `${prefix}/guilds/${GUILD}/audit-logs?limit=1&action_type=72`
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await request(path, 'GET', undefined, TOKEN)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          audit_log_entries: entries,
          users: [],
          integrations: [],
          webhooks: [],
          guild_scheduled_events: [],
          threads: [],
          application_commands: [],
          auto_moderation_rules: [],
        })
        expect(
          await json(request(`/_test/audit-log-responses/${control.id}`))
        ).toMatchObject({ remaining: 2 - attempt, consumed: attempt })
      }
      expect(await json(request(path, 'GET', undefined, TOKEN))).toMatchObject({
        audit_log_entries: [{ id: '100', action_type: 72 }],
      })
      expect(
        server.db.prepare('SELECT id FROM guild_audit_log_entries').all()
      ).toEqual([{ id: '100' }])
    }
  )
})

describe('audit response policy and isolation', () => {
  it.each(['/api/v10', '/api', ''])(
    'does not consume controls on HEAD under %s',
    async (prefix) => {
      const control = await arm()
      const path = `${prefix}/guilds/${GUILD}/audit-logs?limit=1&action_type=72`
      const head = await request(path, 'HEAD', undefined, TOKEN)
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect(
        await json(request(`/_test/audit-log-responses/${control.id}`))
      ).toMatchObject({
        state: 'armed',
        remaining: 1,
        consumed: 0,
        consumed_at: null,
      })
      expect(await json(request(path, 'GET', undefined, TOKEN))).toMatchObject({
        audit_log_entries: payload().entries,
      })
      expect(
        await json(request(`/_test/audit-log-responses/${control.id}`))
      ).toMatchObject({
        state: 'exhausted',
        remaining: 0,
        consumed: 1,
      })
    }
  )

  it('requires bot ownership, guild existence and valid control policy', async () => {
    seedBot(server.db, 'Bot other', '444444444444444444')
    for (const invalid of [
      { bot_id: '999' },
      { guild_id: '999' },
      { bot_id: '444444444444444444' },
    ]) {
      const response = await request(
        '/_test/audit-log-responses',
        'POST',
        payload(invalid)
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        message: '404: Not Found',
        code: 0,
      })
    }
    expect(
      server.db.prepare('SELECT * FROM test_audit_log_responses').all()
    ).toEqual([])
  })

  it.each([
    { bot_id: '0' },
    { bot_id: '01' },
    { guild_id: 123 },
    { guild_id: '18446744073709551616' },
    { query: null },
    { query: [] },
    { query: { limit: 0 } },
    { query: { limit: 101 } },
    { query: { limit: 1.5 } },
    { query: { limit: null } },
    { query: { action_type: 999 } },
    { query: { before: '01' } },
    { query: { after: 123 } },
    { query: { other: 'x' } },
    { ttl_ms: 0 },
    { ttl_ms: 60_001 },
    { ttl_ms: 1.5 },
    { ttl_ms: '100' },
    { ttl_ms: null },
    { times: 0 },
    { times: 101 },
    { times: 1.5 },
    { times: '1' },
    { times: null },
    { entries: null },
    { entries: {} },
    { entries: [null] },
    { entries: [1] },
    { entries: [[]] },
    { entries: [{ reason: 'unsupported' }] },
    { entries: Array.from({ length: 101 }, () => ({})) },
    { entries: [{ options: [[[[[[[[[[[null]]]]]]]]]]] }] },
    { path: '/arbitrary' },
    { method: 'POST' },
  ])('rejects invalid policy without writing: %j', async (overrides) => {
    const response = await request(
      '/_test/audit-log-responses',
      'POST',
      payload(overrides)
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      message: '400: Bad Request',
      code: 0,
    })
    expect(
      server.db.prepare('SELECT * FROM test_audit_log_responses').all()
    ).toEqual([])
  })

  it('accepts maximum entry/use bounds and rejects non-finite raw entry numbers', async () => {
    const entries = Array.from({ length: 100 }, () => ({
      options: { count: false },
    }))
    const control = await arm({ entries, times: 100, ttl_ms: 60_000 })
    expect(
      await json(request(`/_test/audit-log-responses/${control.id}`))
    ).toMatchObject({ entries, remaining: 100 })
    const invalidNumber = await fetch(
      server.baseUrl + '/_test/audit-log-responses',
      {
        method: 'POST',
        body: JSON.stringify(payload()).replace('null', '1e400'),
        signal: AbortSignal.timeout(2000),
      }
    )
    expect(invalidNumber.status).toBe(400)
  })

  it('rejects missing fields, malformed JSON and oversized bodies', async () => {
    for (const field of ['bot_id', 'guild_id', 'query', 'entries', 'ttl_ms']) {
      const body = Object.fromEntries(
        Object.entries(payload()).filter(([key]) => key !== field)
      )
      expect(
        await statusOf(request('/_test/audit-log-responses', 'POST', body))
      ).toBe(400)
    }
    for (const raw of ['{', 'null', '[]']) {
      const response = await fetch(
        server.baseUrl + '/_test/audit-log-responses',
        {
          method: 'POST',
          body: raw,
          signal: AbortSignal.timeout(2000),
        }
      )
      expect(response.status).toBe(400)
    }
    const oversized = await request(
      '/_test/audit-log-responses',
      'POST',
      payload({
        entries: [{ id: 'x'.repeat(65_536) }],
      })
    )
    expect(oversized.status).toBe(413)
    expect(
      server.db.prepare('SELECT * FROM test_audit_log_responses').all()
    ).toEqual([])
  })

  it('does not consume other requests, unauthenticated requests or other bots/guilds', async () => {
    const otherBot = '444444444444444444'
    const otherToken = 'Bot other'
    seedBot(server.db, otherToken, otherBot)
    const otherGuild = seedGuild(server.db, otherToken, '555555555555555555')
    const sameBotGuild = seedGuild(server.db, TOKEN, '666666666666666666')
    const control = await arm()
    const path = `/api/v10/guilds/${GUILD}/audit-logs`
    for (const query of [
      '',
      '?action_type=72',
      '?limit=1&action_type=73',
      '?limit=2&action_type=72',
      '?limit=1&action_type=72&user_id=999',
      '?limit=1&action_type=72&target_id=999',
      '?limit=1&action_type=72&before=99',
      '?limit=1&action_type=72&after=0',
      '?limit=1&action_type=72&extra=x',
      '?limit=1&limit=1&action_type=72',
      '?limit=1&action_type=72&__proto__=x',
    ]) {
      const response = await request(path + query, 'GET', undefined, TOKEN)
      expect(response.status).toBe(200)
      expect(await response.json()).not.toMatchObject({
        audit_log_entries: payload().entries,
      })
    }
    expect(
      await statusOf(request(path + '?limit=0', 'GET', undefined, TOKEN))
    ).toBe(400)
    expect(await statusOf(request(path, 'GET'))).toBe(401)
    expect(await statusOf(request(path, 'GET', undefined, 'Bot unknown'))).toBe(
      401
    )
    expect(await statusOf(request(path, 'GET', undefined, otherToken))).toBe(
      403
    )
    for (const [guild, token] of [
      [otherGuild, otherToken],
      [sameBotGuild, TOKEN],
    ]) {
      expect(
        await json(
          request(
            `/guilds/${guild}/audit-logs?limit=1&action_type=72`,
            'GET',
            undefined,
            token
          )
        )
      ).toMatchObject({ audit_log_entries: [] })
    }
    expect(await statusOf(request(path, 'POST', {}, TOKEN))).toBe(404)
    expect(
      await json(request(`/_test/audit-log-responses/${control.id}`))
    ).toMatchObject({
      state: 'armed',
      remaining: 1,
      consumed: 0,
      consumed_at: null,
    })
    expect(
      await json(
        request(path + '?action_type=72&limit=1', 'GET', undefined, TOKEN)
      )
    ).toMatchObject({ audit_log_entries: payload().entries })
  })

  it('matches every supported query field exactly and canonicalizes numeric selectors', async () => {
    const query = {
      user_id: BOT,
      target_id: BOT,
      action_type: '72',
      before: '101',
      after: '0',
      limit: '1',
    }
    const control = await arm({ query, entries: [] })
    expect(
      await json(request(`/_test/audit-log-responses/${control.id}`))
    ).toMatchObject({
      query: { ...query, action_type: 72, limit: 1 },
    })
    const search = new URLSearchParams(query)
    expect(
      await json(
        request(
          `/guilds/${GUILD}/audit-logs?${search}`,
          'GET',
          undefined,
          TOKEN
        )
      )
    ).toMatchObject({ audit_log_entries: [] })
    expect(
      await json(
        request(
          `/guilds/${GUILD}/audit-logs?${search}`,
          'GET',
          undefined,
          TOKEN
        )
      )
    ).toMatchObject({ audit_log_entries: [{ id: '100' }] })
    const emptyQuery = await arm({ query: {}, entries: [{}] })
    expect(
      await json(
        request(`/guilds/${GUILD}/audit-logs?limit=50`, 'GET', undefined, TOKEN)
      )
    ).toMatchObject({ audit_log_entries: [{ id: '100' }] })
    expect(
      await json(
        request(`/guilds/${GUILD}/audit-logs`, 'GET', undefined, TOKEN)
      )
    ).toMatchObject({ audit_log_entries: [{}] })
    expect(
      await json(request(`/_test/audit-log-responses/${emptyQuery.id}`))
    ).toMatchObject({ state: 'exhausted' })
  })

  it('rejects an active duplicate, allows independent selectors and rearms after exhaustion', async () => {
    const control = await arm()
    expect(
      await statusOf(
        request(
          '/_test/audit-log-responses',
          'POST',
          payload({ query: { limit: '1', action_type: '72' } })
        )
      )
    ).toBe(409)
    await arm({ query: {} })
    await request(
      `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
      'GET',
      undefined,
      TOKEN
    )
    await arm()
    expect(
      await json(request(`/_test/audit-log-responses/${control.id}`))
    ).toMatchObject({ state: 'exhausted', consumed: 1 })
  })

  it('expires without consumption and permits rearming the same selector', async () => {
    const control = await arm({ ttl_ms: 1 })
    await expect
      .poll(async () => {
        const response = await request(
          `/_test/audit-log-responses/${control.id}`
        )
        return ((await response.json()) as { state: string }).state
      })
      .toBe('expired')
    expect(
      await json(
        request(
          `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
          'GET',
          undefined,
          TOKEN
        )
      )
    ).toMatchObject({ audit_log_entries: [{ id: '100' }] })
    const status = await request(`/_test/audit-log-responses/${control.id}`)
    expect(status.headers.get('Cache-Control')).toBe('no-store')
    expect(await status.json()).toMatchObject({
      state: 'expired',
      remaining: 1,
      consumed: 0,
      consumed_at: null,
    })
    await arm()
  })

  it('consumes a bounded control atomically across concurrent reads', async () => {
    const control = await arm({ times: 3 })
    const results = (await Promise.all(
      Array.from({ length: 8 }, () =>
        json(
          request(
            `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
            'GET',
            undefined,
            TOKEN
          )
        )
      )
    )) as { audit_log_entries: { id: string }[] }[]
    expect(
      results.filter(
        (result) => result.audit_log_entries[0]?.id === 'not-a-snowflake'
      )
    ).toHaveLength(3)
    expect(
      results.filter((result) => result.audit_log_entries[0]?.id === '100')
    ).toHaveLength(5)
    expect(
      await json(request(`/_test/audit-log-responses/${control.id}`))
    ).toMatchObject({
      state: 'exhausted',
      consumed: 3,
      remaining: 0,
      consumed_at: expect.any(String),
    })
  })

  it('gives existing REST faults precedence without consuming the audit control', async () => {
    const control = await arm()
    expect(
      await statusOf(
        request('/_test/rest-faults', 'POST', {
          method: 'GET',
          path: `/guilds/${GUILD}/audit-logs`,
          times: 1,
          status: 500,
          code: 0,
          message: 'Forced failure',
        })
      )
    ).toBe(201)
    const path = `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`
    expect(await statusOf(request(path, 'GET', undefined, TOKEN))).toBe(500)
    expect(
      await json(request(`/_test/audit-log-responses/${control.id}`))
    ).toMatchObject({ consumed: 0, remaining: 1 })
    expect(await json(request(path, 'GET', undefined, TOKEN))).toMatchObject({
      audit_log_entries: payload().entries,
    })
  })
})

describe('audit response lifecycle cleanup', () => {
  it('removes configuration and evidence explicitly and restores fixtures', async () => {
    const control = await arm()
    expect(
      await statusOf(
        request(`/_test/audit-log-responses/${control.id}`, 'DELETE')
      )
    ).toBe(204)
    for (const method of ['GET', 'DELETE']) {
      expect(
        await statusOf(
          request(`/_test/audit-log-responses/${control.id}`, method)
        )
      ).toBe(404)
      expect(
        await statusOf(request('/_test/audit-log-responses/missing', method))
      ).toBe(404)
    }
    expect(
      await json(
        request(
          `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
          'GET',
          undefined,
          TOKEN
        )
      )
    ).toMatchObject({ audit_log_entries: [{ id: '100' }] })
  })

  it.each(['reset', 'empty-reset', 'token-reset', 'setup', 'guild'])(
    'clears armed, expired and exhausted evidence through %s',
    async (action) => {
      const otherToken = 'Bot other-cleanup'
      const otherBot = '444444444444444444'
      seedBot(server.db, otherToken, otherBot)
      const otherGuild = seedGuild(server.db, otherToken, '555555555555555555')
      const other = await arm({ bot_id: otherBot, guild_id: otherGuild })
      const armed = await arm()
      const exhausted = await arm({ query: {} })
      await request(`/guilds/${GUILD}/audit-logs`, 'GET', undefined, TOKEN)
      const expired = await arm({ query: { limit: 2 }, ttl_ms: 1 })
      await expect
        .poll(async () => {
          const response = await request(
            `/_test/audit-log-responses/${expired.id}`
          )
          return ((await response.json()) as { state: string }).state
        })
        .toBe('expired')
      const response =
        action === 'setup'
          ? await request(`/_test/setup/${encodeURIComponent(TOKEN)}`, 'DELETE')
          : action === 'guild'
            ? await request(`/guilds/${GUILD}`, 'DELETE', undefined, TOKEN)
            : await request(
                '/_test/reset',
                'POST',
                action === 'token-reset'
                  ? { token: TOKEN }
                  : action === 'empty-reset'
                    ? { token: '' }
                    : {}
              )
      expect(response.ok).toBe(true)
      for (const control of [armed, exhausted, expired])
        expect(
          await statusOf(request(`/_test/audit-log-responses/${control.id}`))
        ).toBe(404)
      expect(
        await statusOf(request(`/_test/audit-log-responses/${other.id}`))
      ).toBe(['reset', 'empty-reset'].includes(action) ? 404 : 200)
      if (['reset', 'empty-reset', 'token-reset'].includes(action))
        expect(
          await json(
            request(
              `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
              'GET',
              undefined,
              TOKEN
            )
          )
        ).toMatchObject({ audit_log_entries: [] })
    }
  )
})

describe('audit controls alongside the real Gateway', () => {
  it('leaves messages and Gateway dispatch unchanged when fixtures and overrides are created, consumed and removed', async () => {
    const socket = new WebSocket(server.baseUrl.replace('http://', 'ws://'))
    const frames: { op: number; t?: string }[] = []
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as { op: number; t?: string })
    })
    try {
      await expect
        .poll(() => frames.some((frame) => frame.op === GatewayOp.Hello))
        .toBe(true)
      socket.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: {
            token: TOKEN,
            intents:
              GatewayIntentBits.Guilds |
              GatewayIntentBits.GuildMessages |
              GatewayIntentBits.MessageContent,
          },
        })
      )
      await expect
        .poll(() => frames.some((frame) => frame.t === 'GUILD_CREATE'))
        .toBe(true)
      const channel = seedChannel(server.db, GUILD)
      const created = await request(
        `/channels/${channel}/messages`,
        'POST',
        { content: 'Still here' },
        TOKEN
      )
      expect(created.status).toBe(200)
      const message = (await created.json()) as { id: string }
      await expect
        .poll(() => frames.some((frame) => frame.t === 'MESSAGE_CREATE'))
        .toBe(true)
      const before = frames.filter((frame) => frame.op === GatewayOp.Dispatch)
      expect(
        await statusOf(
          request(`/_test/guilds/${GUILD}/audit-logs`, 'POST', {
            id: '101',
            action_type: 72,
            user_id: BOT,
            target_id: BOT,
            options: { channel_id: channel, count: '1' },
          })
        )
      ).toBe(201)
      const control = await arm()
      expect(
        await json(
          request(
            `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
            'GET',
            undefined,
            TOKEN
          )
        )
      ).toMatchObject({ audit_log_entries: payload().entries })
      await request(`/_test/audit-log-responses/${control.id}`, 'DELETE')
      expect(
        await json(
          request(
            `/channels/${channel}/messages/${message.id}`,
            'GET',
            undefined,
            TOKEN
          )
        )
      ).toMatchObject({ id: message.id, content: 'Still here' })
      expect(server.db.prepare('SELECT id FROM messages').all()).toEqual([
        { id: message.id },
      ])
      expect(
        server.db
          .prepare('SELECT id FROM guild_audit_log_entries ORDER BY id')
          .all()
      ).toEqual([{ id: '100' }, { id: '101' }])
      socket.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      await expect
        .poll(() => frames.some((frame) => frame.op === GatewayOp.HeartbeatAck))
        .toBe(true)
      expect(frames.filter((frame) => frame.op === GatewayOp.Dispatch)).toEqual(
        before
      )
    } finally {
      socket.terminate()
    }
  })
})
