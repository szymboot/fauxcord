import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { buildApp } from './app'
import { closeDatabase, initializeDatabase } from './db'
import { gatewayBus } from './gateway/bus'
import { GatewayOp } from './gateway/opcodes'
import {
  createRealServer,
  seedBot,
  seedChannel,
  seedGuild,
  type RealServerContext,
} from './test-helpers'
import type { RestFault } from './services/rest-faults'
import { consumeRestFault } from './services/rest-faults'

const token = 'Bot channel-owner'
const otherToken = 'Bot channel-other'
const guild = '222222222222222222'
const otherGuild = '222222222222222223'
const path = `/guilds/${guild}/channels`
const failure = { status: 403, code: 50_013, message: 'Missing Permissions' }
const payload = { name: 'shop', type: 4 }

describe('guild channel creation REST faults through buildApp', () => {
  let db: ReturnType<typeof initializeDatabase>
  let built: ReturnType<typeof buildApp>
  let creations: number

  /** Counts the native event from which CHANNEL_CREATE is dispatched. */
  function onChannelCreate() {
    creations++
  }

  /** Sends JSON through the complete production middleware and route assembly. */
  async function request(
    route: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ) {
    return built.app.request(route, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Returns the native or control response status. */
  async function status(...args: Parameters<typeof request>) {
    const response = await request(...args)
    return response.status
  }

  /** Arms an exact guild route before any channel exists. */
  async function arm(overrides: Record<string, unknown> = {}) {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'POST',
      path,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Reads retained evidence independently of channel state. */
  async function inspect(id: string) {
    const response = await request(`/_test/rest-faults/${id}`)
    return response.json() as Promise<RestFault>
  }

  /** Verifies both persistent state and the source of CHANNEL_CREATE dispatch. */
  function expectNoCreation() {
    expect(db.prepare('SELECT id FROM channels').all()).toEqual([])
    expect(creations).toBe(0)
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    built = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, token, '100000000000000001')
    seedBot(db, otherToken, '100000000000000002')
    seedGuild(db, token, guild)
    seedGuild(db, otherToken, otherGuild)
    creations = 0
    gatewayBus.on('channel.create', onChannelCreate)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    gatewayBus.off('channel.create', onChannelCreate)
    built.unsubscribeGateway()
    built.wss.close()
    closeDatabase(db)
  })

  it.each([
    failure,
    { status: 404, code: 10_004, message: 'Unknown Guild' },
    { status: 500, code: 0, message: 'Internal Server Error' },
  ])(
    'prearms $status across all prefixes, exhausts atomically and retries normally',
    async (error) => {
      const fault = await arm({ ...error, times: 3 })
      expect(fault).toMatchObject({
        guild_id: guild,
        channel_id: null,
        path,
        remaining: 3,
        consumed: 0,
      })
      const responses = await Promise.all(
        ['', '/api', '/api/v10'].map((prefix, index) =>
          request(prefix + path, 'POST', { ...payload, type: [0, 2, 4][index] })
        )
      )
      for (const response of responses) {
        expect(response.status).toBe(error.status)
        await expect(response.json()).resolves.toEqual({
          code: error.code,
          message: error.message,
        })
      }
      expectNoCreation()
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
      for (const prefix of ['', '/api', '/api/v10']) {
        const response = await request(prefix + path, 'POST', payload)
        expect(response.status).toBe(201)
        await expect(response.json()).resolves.toMatchObject({
          guild_id: guild,
          ...payload,
        })
      }
      expect(db.prepare('SELECT id FROM channels').all()).toHaveLength(3)
      expect(creations).toBe(3)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
    }
  )

  it('isolates methods, exact paths, guilds, and registered Bot tokens', async () => {
    const fault = await arm()
    expect(await status(path, 'POST', payload, 'Bot unknown')).toBe(401)
    expect(await status(path, 'POST', payload, '')).toBe(401)
    expect(await status(path)).toBe(200)
    expect(await status(path, 'PATCH', payload)).toBe(400)
    expect(await status(path + '/', 'POST', payload)).toBe(404)
    expect(await status(path + '/extra', 'POST', payload)).toBe(404)
    expect(await status(`/guilds/0${guild}/channels`, 'POST', payload)).toBe(
      400
    )
    expect(await status('/guilds/999/channels', 'POST', payload)).toBe(404)
    expect(await status(path, 'POST', {}, otherToken)).toBe(400)
    expect(await status(path, 'POST', payload, otherToken)).toBe(201)
    expect(
      await status(`/guilds/${otherGuild}/channels`, 'POST', payload)
    ).toBe(201)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 1, consumed: 0 })
    expect(await status(path, 'POST', {})).toBe(403)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 1 })
    expect(await status(path, 'POST', {})).toBe(400)
  })

  it.each([undefined, 'rate_limit', 'delay', 'disconnect'])(
    'preserves Bot scope with auth disabled for mode %s',
    async (mode) => {
      const fault = await arm({
        ...(mode && { mode }),
        ...(mode === 'rate_limit' && { status: 429, retry_after: 0.01 }),
        ...(mode === 'delay' && { delay_ms: 1 }),
      })
      const disabled = buildApp(db, {
        baseUrl: 'http://localhost',
        disableAuth: true,
      })
      try {
        for (const auth of [
          'Bot unregistered',
          otherToken,
          'Bearer accepted',
        ]) {
          const response = await disabled.app.request(path, {
            method: 'POST',
            headers: {
              Authorization: auth,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          })
          expect(response.status).toBe(201)
        }
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 1,
          consumed: 0,
        })
        expect(await status(path, 'POST', payload)).toBe(
          mode === 'disconnect' ? 501 : mode === 'rate_limit' ? 429 : 403
        )
      } finally {
        disabled.unsubscribeGateway()
        disabled.wss.close()
      }
    }
  )

  it('keeps every previously supported selector scoped with independent counters', async () => {
    const channel = seedChannel(db, guild)
    const user = '555555555555555555'
    const message = '666666666666666666'
    const role = '777777777777777777'
    const creation = await arm({ times: 2 })
    const selectors = [
      { method: 'POST', path: `/channels/${channel}/messages` },
      { method: 'DELETE', path: `/channels/${channel}` },
      { method: 'DELETE', path: `/channels/${channel}/messages/${message}` },
      { method: 'PATCH', path: `/channels/${channel}/messages/${message}` },
      { method: 'PUT', path: `/guilds/${guild}/bans/${user}` },
      { method: 'PATCH', path: `/guilds/${guild}/members/${user}` },
      { method: 'PUT', path: `/guilds/${guild}/members/${user}/roles/${role}` },
      {
        method: 'DELETE',
        path: `/guilds/${guild}/members/${user}/roles/${role}`,
      },
      { method: 'GET', path: `/guilds/${guild}/audit-logs` },
      { method: 'GET', path: `/guilds/${guild}/members/${user}` },
      { method: 'GET', path: `/guilds/${guild}/members` },
      { method: 'GET', path: `/guilds/${guild}/bans` },
      { method: 'GET', path: `/channels/${channel}/messages` },
      { method: 'GET', path: `/users/${user}`, guild_id: guild },
      { method: 'POST', path: '/users/@me/channels', guild_id: guild },
    ]
    const controls: RestFault[] = []
    for (const selector of selectors)
      controls.push(
        await arm({
          ...selector,
          mode: 'rate_limit',
          status: 429,
          retry_after: 0.01,
          times: 2,
        })
      )
    for (const [index, selector] of selectors.entries()) {
      expect(
        consumeRestFault(db, selector.method, selector.path, otherToken)
      ).toBeUndefined()
      expect(await inspect(controls[index].id)).toMatchObject({
        remaining: 2,
        consumed: 0,
      })
      expect(
        await status(
          selector.path,
          selector.method,
          selector.method === 'POST' ? { recipient_id: user } : undefined
        )
      ).toBe(429)
      expect(await inspect(creation.id)).toMatchObject({
        remaining: 2,
        consumed: 0,
      })
    }
    expect(await status(path, 'POST', payload)).toBe(403)
    for (const control of controls)
      expect(await inspect(control.id)).toMatchObject({
        remaining: 1,
        consumed: 1,
      })
    expect(await inspect(creation.id)).toMatchObject({
      remaining: 1,
      consumed: 1,
    })
    expect(db.prepare('SELECT id FROM channels').all()).toEqual([
      { id: channel },
    ])
    expect(creations).toBe(0)
  })

  it('isolates identical Bot and Guild selectors in separate application databases', async () => {
    const first = await arm({ times: 2 })
    const secondDb = initializeDatabase(':memory:')
    const second = buildApp(secondDb, {
      baseUrl: 'http://localhost',
      disableAuth: false,
    })
    try {
      seedBot(secondDb, token, '100000000000000001')
      seedGuild(secondDb, token, guild)
      const armed = await second.app.request('/_test/rest-faults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'POST', path, ...failure }),
      })
      expect(armed.status).toBe(201)
      const control = (await armed.json()) as RestFault
      const failed = await second.app.request(path, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(failed.status).toBe(403)
      expect(await inspect(first.id)).toMatchObject({
        remaining: 2,
        consumed: 0,
      })
      expect(await status(path, 'POST', payload)).toBe(403)
      expect(await inspect(first.id)).toMatchObject({
        remaining: 1,
        consumed: 1,
      })
      const observed = await second.app.request(
        `/_test/rest-faults/${control.id}`
      )
      await expect(observed.json()).resolves.toMatchObject({
        remaining: 0,
        consumed: 1,
      })
      expect(secondDb.prepare('SELECT id FROM channels').all()).toEqual([])
      expectNoCreation()
    } finally {
      second.unsubscribeGateway()
      second.wss.close()
      closeDatabase(secondDb)
    }
  })

  it('preserves a concrete 20-digit scope without numeric coercion', async () => {
    const exact = '01234567890123456789'
    seedGuild(db, token, exact)
    const fault = await arm({
      path: `/guilds/${exact}/channels`,
      guild_id: exact,
    })
    expect(fault.guild_id).toBe(exact)
    expect(
      await status(`/guilds/${BigInt(exact)}/channels`, 'POST', payload)
    ).toBe(404)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 1, consumed: 0 })
    expect(await status(`/guilds/${exact}/channels`, 'POST', payload)).toBe(403)
    expectNoCreation()
  })

  it('retains failure evidence after native retry and compensating channel deletion', async () => {
    const fault = await arm()
    expect(await status(path, 'POST', payload)).toBe(403)
    expectNoCreation()
    const created = await request(path, 'POST', payload)
    expect(created.status).toBe(201)
    const channel = (await created.json()) as { id: string }
    expect(await status(`/channels/${channel.id}`, 'DELETE')).toBe(200)
    expect(db.prepare('SELECT id FROM channels').all()).toEqual([])
    expect(await inspect(fault.id)).toMatchObject({
      guild_id: guild,
      channel_id: null,
      remaining: 0,
      consumed: 1,
    })
  })

  it('rejects overlapping active controls and permits independent guilds, removal and rearming', async () => {
    const first = await arm()
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'POST',
        path,
        mode: 'disconnect',
      })
    ).toBe(409)
    const other = await arm({ path: `/guilds/${otherGuild}/channels` })
    expect(await status(`/_test/rest-faults/${first.id}`, 'DELETE')).toBe(204)
    expect(await status(`/_test/rest-faults/${first.id}`)).toBe(404)
    expect(await status(path, 'POST', payload)).toBe(201)
    const second = await arm({ guild_id: guild })
    expect(second.id).not.toBe(first.id)
    expect(await status(path, 'POST', payload)).toBe(403)
    await arm()
    expect(await inspect(other.id)).toMatchObject({ remaining: 1, consumed: 0 })
  })

  it.each([
    { method: 'PUT' },
    { method: 'PATCH' },
    { method: 'DELETE' },
    { method: 'GET' },
    { path: '/guilds/{guildID}/channels' },
    { path: '/guilds/*/channels' },
    { path: '/guilds/1.2/channels' },
    { path: '/guilds/-1/channels' },
    { path: `/guilds/${'1'.repeat(21)}/channels` },
    { path: '/api/v10' + path },
    { path: path + '/' },
    { path: path + '?x=1' },
    { guild_id: otherGuild },
    { guild_id: 222 },
    { guild_id: null },
    { query: {} },
    { recipient_id: '123' },
    { times: 0 },
    { times: 101 },
    { mode: 'delay', delay_ms: 0 },
    { mode: 'disconnect', timeout_ms: 0 },
    { mode: 'rate_limit', retry_after: 0 },
  ])('rejects invalid selector or policy %j', async (overrides) => {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'POST',
      path,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      message: '400: Bad Request',
      code: 0,
    })
    expectNoCreation()
  })

  it('rejects nonexistent scope without requiring a future channel ID', async () => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'POST',
        path: '/guilds/999/channels',
        ...failure,
      })
    ).toBe(404)
    expectNoCreation()
    await arm()
  })

  it.each(['reset', 'scoped reset', 'setup deletion', 'guild deletion'])(
    'cleans active and exhausted evidence on %s',
    async (cleanup) => {
      const exhausted = await arm()
      await request(path, 'POST', payload)
      const active = await arm({ mode: 'disconnect' })
      const other = await arm({ path: `/guilds/${otherGuild}/channels` })
      if (cleanup === 'guild deletion')
        db.prepare('DELETE FROM guilds WHERE id = ?').run(guild)
      else if (cleanup === 'setup deletion')
        expect(
          await status(`/_test/setup/${encodeURIComponent(token)}`, 'DELETE')
        ).toBe(204)
      else
        expect(
          await status(
            '/_test/reset',
            'POST',
            cleanup === 'reset' ? {} : { token }
          )
        ).toBe(204)
      for (const control of [active, exhausted])
        expect(await status(`/_test/rest-faults/${control.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${other.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
      expectNoCreation()
      if (cleanup === 'reset' || cleanup === 'scoped reset')
        expect(await status(path, 'POST', payload)).toBe(201)
    }
  )

  it('follows the current Guild owner for controls without an explicit mode', async () => {
    const fault = await arm()
    db.prepare('UPDATE guilds SET bot_token = ? WHERE id = ?').run(
      otherToken,
      guild
    )
    expect(await status(path, 'POST', payload, token)).toBe(201)
    expect(await inspect(fault.id)).toMatchObject({
      remaining: 1,
      consumed: 0,
    })
    expect(await status(path, 'POST', payload, otherToken)).toBe(403)
    expect(await inspect(fault.id)).toMatchObject({
      guild_id: guild,
      remaining: 0,
      consumed: 1,
    })
    expect(db.prepare('SELECT id FROM channels').all()).toHaveLength(1)
    expect(creations).toBe(1)
  })

  it('expires unused attempts and cancels controls after explicit ownership changes', async () => {
    const expired = await arm({ mode: 'disconnect', timeout_ms: 1000 })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 1001)
    expect(await inspect(expired.id)).toMatchObject({
      state: 'expired',
      remaining: 0,
      consumed: 0,
    })
    expect(await status(path, 'POST', payload)).toBe(201)
    vi.restoreAllMocks()
    const invalidated = await arm({ mode: 'disconnect' })
    db.prepare('UPDATE guilds SET bot_token = ? WHERE id = ?').run(
      otherToken,
      guild
    )
    expect(await status(`/_test/rest-faults/${invalidated.id}`)).toBe(404)
    expect(await status(path, 'POST', payload, otherToken)).toBe(201)
  })

  it.each([
    'removal',
    'reset',
    'scoped reset',
    'setup deletion',
    'guild deletion',
    'ownership change',
    'expiry',
  ])(
    'cancels in-flight delays on %s without resuming channel creation',
    async (cleanup) => {
      const fault = await arm({
        mode: 'delay',
        delay_ms: 60_000,
        timeout_ms: cleanup === 'expiry' ? 1000 : 30_000,
      })
      const pending = request(path, 'POST', payload)
      await expect
        .poll(async () => {
          const control = await inspect(fault.id)
          return control.outcomes?.pending
        })
        .toBe(1)
      switch (cleanup) {
        case 'removal': {
          expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(
            204
          )
          break
        }
        case 'reset':
        case 'scoped reset': {
          expect(
            await status(
              '/_test/reset',
              'POST',
              cleanup === 'reset' ? {} : { token }
            )
          ).toBe(204)
          break
        }
        case 'setup deletion': {
          expect(
            await status(`/_test/setup/${encodeURIComponent(token)}`, 'DELETE')
          ).toBe(204)
          break
        }
        case 'guild deletion': {
          db.prepare('DELETE FROM guilds WHERE id = ?').run(guild)
          break
        }
        case 'ownership change': {
          db.prepare('UPDATE guilds SET bot_token = ? WHERE id = ?').run(
            otherToken,
            guild
          )
          await request(`/_test/rest-faults/${fault.id}`)
          break
        }
      }
      const response = await pending
      expect(response.status).toBe(403)
      expectNoCreation()
      if (cleanup === 'expiry')
        expect(await inspect(fault.id)).toMatchObject({
          state: 'expired',
          consumed: 1,
          remaining: 0,
          outcomes: { cancelled: 1, pending: 0 },
        })
      else expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      if (!['guild deletion', 'setup deletion'].includes(cleanup))
        expect(await status(path, 'POST', payload)).toBe(201)
    }
  )

  it('returns the disconnect fallback for requests without a Node socket', async () => {
    const fault = await arm({ mode: 'disconnect' })
    expect(await status(path, 'POST', payload)).toBe(501)
    expectNoCreation()
    expect(await inspect(fault.id)).toMatchObject({
      consumed: 1,
      remaining: 0,
      outcomes: { cancelled: 1 },
    })
  })
})

describe('guild channel creation transport faults over real HTTP and Gateway', () => {
  let server: RealServerContext
  let ws: WebSocket | undefined

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token, '100000000000000001')
    seedGuild(server.db, token, guild)
  })

  afterEach(async () => {
    ws?.terminate()
    ws = undefined
    await server.close()
  })

  it.each(['', '/api', '/api/v10'])(
    'disconnects POST/PATCH before parent validation under %s, then retries native parent changes',
    async (prefix) => {
      const parent = '1300000000000000002'
      const nextParent = '1300000000000000003'
      for (const id of [parent, nextParent]) {
        seedChannel(server.db, guild, id)
        server.db.prepare('UPDATE channels SET type = 4 WHERE id = ?').run(id)
      }
      const frames: {
        op: number
        t?: string
        d?: { id?: string; parent_id?: string | null }
      }[] = []
      ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
      ws.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString()) as (typeof frames)[number])
      })
      await expect
        .poll(() => frames.some((frame) => frame.op === GatewayOp.Hello))
        .toBe(true)
      ws.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: { token, intents: GatewayIntentBits.Guilds },
        })
      )
      await expect
        .poll(() => frames.some((frame) => frame.t === 'GUILD_CREATE'))
        .toBe(true)

      /** Issues raw JSON so 19-digit parent integers retain their wire representation. */
      function request(route: string, method = 'GET', body?: string) {
        return fetch(server.baseUrl + route, {
          method,
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(3000),
        })
      }

      /** Captures all persisted channel fields, including both category fixtures. */
      function snapshot() {
        return server.db.prepare('SELECT * FROM channels ORDER BY id').all()
      }

      /** Uses an ordered heartbeat ACK to fence preceding mutation dispatches. */
      async function fence() {
        const acknowledgements = frames.filter(
          (frame) => frame.op === GatewayOp.HeartbeatAck
        ).length
        ws?.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
        await expect
          .poll(
            () =>
              frames.filter((frame) => frame.op === GatewayOp.HeartbeatAck)
                .length
          )
          .toBe(acknowledgements + 1)
      }

      /** Arms a socket disconnect for an exact native mutation route. */
      async function arm(method: string, route: string, times: number) {
        const response = await request(
          '/_test/rest-faults',
          'POST',
          JSON.stringify({ method, path: route, mode: 'disconnect', times })
        )
        expect(response.status).toBe(201)
        return response.json() as Promise<RestFault>
      }

      const creation = await arm('POST', path, 1)
      const original = snapshot()
      const invalidParent =
        '{"name":"invalid-parent","parent_id":999999999999999999}'
      await expect(
        request(prefix + path, 'POST', invalidParent)
      ).rejects.toThrow()
      await fence()
      expect(snapshot()).toEqual(original)
      expect(frames.filter((frame) => frame.t === 'CHANNEL_CREATE')).toEqual([])
      const invalidPost = await request(prefix + path, 'POST', invalidParent)
      expect(invalidPost.status).toBe(400)
      await expect(invalidPost.json()).resolves.toMatchObject({
        code: 50_035,
        errors: { parent_id: expect.any(Object) },
      })
      await fence()
      expect(snapshot()).toEqual(original)
      expect(frames.filter((frame) => frame.t === 'CHANNEL_CREATE')).toEqual([])
      const created = await request(
        prefix + path,
        'POST',
        `{"name":"child","parent_id":${parent}}`
      )
      expect(created.status).toBe(201)
      const child = (await created.json()) as { id: string; parent_id: string }
      expect(child.parent_id).toBe(parent)
      await fence()
      expect(
        frames.filter((frame) => frame.t === 'CHANNEL_CREATE')
      ).toMatchObject([{ d: { id: child.id, parent_id: parent } }])

      const childPath = `/channels/${child.id}`
      const editing = await arm('PATCH', childPath, 2)
      const beforeEdits = snapshot()
      const move = `{"parent_id":${nextParent}}`
      const clear = '{"parent_id":null}'
      for (const body of [move, clear]) {
        await expect(
          request(prefix + childPath, 'PATCH', body)
        ).rejects.toThrow()
        await fence()
        expect(snapshot()).toEqual(beforeEdits)
        expect(frames.filter((frame) => frame.t === 'CHANNEL_UPDATE')).toEqual(
          []
        )
      }
      const invalidPatch = await request(
        prefix + childPath,
        'PATCH',
        invalidParent
      )
      expect(invalidPatch.status).toBe(400)
      await expect(invalidPatch.json()).resolves.toMatchObject({
        code: 50_035,
        errors: { parent_id: expect.any(Object) },
      })
      await fence()
      expect(snapshot()).toEqual(beforeEdits)
      expect(frames.filter((frame) => frame.t === 'CHANNEL_UPDATE')).toEqual([])
      for (const [body, expectedParent] of [
        [move, nextParent],
        [clear, null],
      ] as const) {
        const response = await request(prefix + childPath, 'PATCH', body)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({
          parent_id: expectedParent,
        })
        expect(
          server.db
            .prepare('SELECT parent_id FROM channels WHERE id = ?')
            .get(child.id)
        ).toEqual({ parent_id: expectedParent })
        await fence()
        expect(
          frames.findLast((frame) => frame.t === 'CHANNEL_UPDATE')
        ).toMatchObject({ d: { id: child.id, parent_id: expectedParent } })
      }
      expect(
        frames.filter((frame) => frame.t === 'CHANNEL_UPDATE')
      ).toHaveLength(2)
      for (const [fault, consumed] of [
        [creation, 1],
        [editing, 2],
      ] as const) {
        const evidence = await request(`/_test/rest-faults/${fault.id}`)
        await expect(evidence.json()).resolves.toMatchObject({
          remaining: 0,
          consumed,
          outcomes: { disconnected: consumed, responded: 0, pending: 0 },
        })
      }
    }
  )

  for (const prefix of ['', '/api', '/api/v10']) {
    it.each(['rate_limit', 'delay', 'disconnect'])(
      `fails %s before mutation/CHANNEL_CREATE under '${prefix}', then retries`,
      async (mode) => {
        const frames: { op: number; t?: string; d?: { id?: string } }[] = []
        ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
        ws.on('message', (raw: Buffer) => {
          frames.push(JSON.parse(raw.toString()) as (typeof frames)[number])
        })
        await expect
          .poll(() => frames.some((frame) => frame.op === GatewayOp.Hello))
          .toBe(true)
        ws.send(
          JSON.stringify({
            op: GatewayOp.Identify,
            d: { token, intents: GatewayIntentBits.Guilds },
          })
        )
        await expect
          .poll(() => frames.some((frame) => frame.t === 'GUILD_CREATE'))
          .toBe(true)
        const armed = await fetch(server.baseUrl + '/_test/rest-faults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'POST',
            path,
            mode,
            ...(mode === 'rate_limit' && { retry_after: 0.01 }),
            ...(mode === 'delay' && { delay_ms: 10 }),
          }),
        })
        expect(armed.status).toBe(201)
        const fault = (await armed.json()) as RestFault
        /** Issues one native attempt on a real socket. */
        const create = () =>
          fetch(server.baseUrl + prefix + path, {
            method: 'POST',
            headers: {
              Authorization: token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(3000),
          })
        if (mode === 'disconnect') await expect(create()).rejects.toThrow()
        else {
          const response = await create()
          expect(response.status).toBe(mode === 'rate_limit' ? 429 : 504)
          if (mode === 'rate_limit') {
            expect(response.headers.get('Retry-After')).toBe('1')
            await expect(response.json()).resolves.toMatchObject({
              retry_after: 0.01,
              global: false,
            })
          }
        }
        expect(server.db.prepare('SELECT id FROM channels').all()).toEqual([])
        ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
        await expect
          .poll(() =>
            frames.some((frame) => frame.op === GatewayOp.HeartbeatAck)
          )
          .toBe(true)
        expect(frames.filter((frame) => frame.t === 'CHANNEL_CREATE')).toEqual(
          []
        )
        const observed = await fetch(
          server.baseUrl + `/_test/rest-faults/${fault.id}`
        )
        await expect(observed.json()).resolves.toMatchObject({
          remaining: 0,
          consumed: 1,
          state: 'exhausted',
          outcomes: {
            pending: 0,
            responded: mode === 'disconnect' ? 0 : 1,
            disconnected: mode === 'disconnect' ? 1 : 0,
            delayed: mode === 'delay' ? 1 : 0,
          },
        })
        const response = await create()
        expect(response.status).toBe(201)
        const channel = (await response.json()) as { id: string }
        await expect
          .poll(
            () => frames.filter((frame) => frame.t === 'CHANNEL_CREATE').length
          )
          .toBe(1)
        expect(
          frames.find((frame) => frame.t === 'CHANNEL_CREATE')?.d?.id
        ).toBe(channel.id)
        expect(server.db.prepare('SELECT id FROM channels').all()).toEqual([
          { id: channel.id },
        ])
      }
    )
  }
})
