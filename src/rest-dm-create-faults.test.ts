import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRealServer,
  seedBot,
  seedGuild,
  seedMember,
  type RealServerContext,
} from './test-helpers'
import type { RestFault } from './services/rest-faults'

const token = 'Bot dm-owner'
const otherToken = 'Bot dm-other'
const path = '/users/@me/channels'
const failure = {
  status: 403,
  code: 50_007,
  message: 'Cannot send messages to this user',
}

describe('bot-scoped DM creation REST faults', () => {
  let server: RealServerContext
  let guild: string
  let otherGuild: string
  let recipient: string
  let otherRecipient: string

  /** Sends real HTTP requests through production authentication and middleware. */
  function request(
    route: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ): Promise<Response> {
    return fetch(server.baseUrl + route, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  }

  /** Returns the HTTP status after a request completes. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Arms a DM creation failure with optional recipient and transport policy. */
  async function arm(
    overrides: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'POST',
      path,
      guild_id: guild,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Reads retained configuration and counters without consuming a fault. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Counts persisted private channels to detect route side effects. */
  function privateChannelCount(): number {
    const row = server.db
      .prepare('SELECT COUNT(*) AS count FROM channels WHERE guild_id IS NULL')
      .get() as { count: number }
    return row.count
  }

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token, '100000000000000001')
    seedBot(server.db, otherToken, '100000000000000002')
    guild = seedGuild(server.db, token)
    otherGuild = seedGuild(server.db, otherToken, '222222222222222223')
    recipient = seedMember(server.db, guild)
    otherRecipient = seedMember(server.db, guild)
  })

  afterEach(async () => {
    await server.close()
  })

  it('fails every recipient for its owner across prefixes and exhausts atomically', async () => {
    const fault = await arm({ times: 3 })
    expect(fault).toMatchObject({
      guild_id: guild,
      channel_id: null,
      remaining: 3,
      consumed: 0,
    })
    expect(
      await status(path, 'POST', { recipient_id: recipient }, 'Bot unknown')
    ).toBe(401)
    expect(await status(`/users/${recipient}`)).toBe(200)
    const responses = await Promise.all(
      ['', '/api', '/api/v10'].map((prefix, index) =>
        request(
          `${prefix}/users/${index === 2 ? '%40me' : '@me'}/channels`,
          'POST',
          {
            recipient_id: index === 1 ? otherRecipient : recipient,
          }
        )
      )
    )
    for (const response of responses) {
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        message: failure.message,
        code: failure.code,
      })
    }
    expect(privateChannelCount()).toBe(0)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 3 })
    expect(await status(path, 'POST', { recipient_id: recipient })).toBe(200)
    expect(privateChannelCount()).toBe(1)
  })

  it('matches only the exact recipient and owner, preserving ordinary body parsing', async () => {
    const fault = await arm({ recipient_id: recipient, times: 2 })
    expect(fault.recipient_id).toBe(recipient)
    for (const [target, auth] of [
      [otherRecipient, token],
      [recipient, otherToken],
    ]) {
      expect(await status(path, 'POST', { recipient_id: target }, auth)).toBe(
        200
      )
    }
    expect(await status(path, 'POST', {})).toBe(400)
    expect(await status(path, 'POST', { recipient_id: '999' })).toBe(404)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 2, consumed: 0 })
    const before = privateChannelCount()
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await status(path, 'POST', { recipient_id: recipient })).toBe(403)
    expect(privateChannelCount()).toBe(before)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 2 })
    expect(await status(path, 'POST', { recipient_id: recipient })).toBe(200)
    expect(privateChannelCount()).toBe(before + 1)
  })

  it('admits independent bots and recipients but rejects overlapping active selectors', async () => {
    const own = await arm({ recipient_id: recipient })
    await arm({ recipient_id: otherRecipient })
    const other = await arm({ guild_id: otherGuild, recipient_id: recipient })
    const sameBotGuild = seedGuild(server.db, token, '222222222222222224')
    for (const overrides of [
      { recipient_id: recipient },
      { recipient_id: recipient, guild_id: sameBotGuild },
      {},
    ]) {
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'POST',
          path,
          guild_id: guild,
          ...failure,
          ...overrides,
        })
      ).toBe(409)
    }
    expect(
      await status(path, 'POST', { recipient_id: recipient }, otherToken)
    ).toBe(403)
    expect(await inspect(own.id)).toMatchObject({ remaining: 1, consumed: 0 })
    expect(await inspect(other.id)).toMatchObject({ remaining: 0, consumed: 1 })
    await request(`/_test/rest-faults/${own.id}`, 'DELETE')
    await arm({ recipient_id: recipient })
  })

  it.each([
    'cancel',
    'reset',
    'scoped reset',
    'setup deletion',
    'guild deletion',
  ])(
    'removes active and exhausted controls through %s cleanup',
    async (cleanup) => {
      const active = await arm({ recipient_id: recipient })
      const exhausted = await arm({ recipient_id: otherRecipient })
      const other = await arm({ guild_id: otherGuild })
      await request(path, 'POST', { recipient_id: otherRecipient })
      switch (cleanup) {
        case 'cancel': {
          for (const fault of [active, exhausted])
            expect(
              await status(`/_test/rest-faults/${fault.id}`, 'DELETE')
            ).toBe(204)
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
          server.db.prepare('DELETE FROM guilds WHERE id = ?').run(guild)
          break
        }
      }
      for (const fault of [active, exhausted])
        expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${other.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
      if (cleanup !== 'setup deletion')
        expect(await status(path, 'POST', { recipient_id: recipient })).toBe(
          200
        )
    }
  )

  it.each([
    { guild_id: undefined },
    { guild_id: null },
    { guild_id: 123 },
    { guild_id: 'invalid' },
    { recipient_id: null },
    { recipient_id: 123 },
    { recipient_id: '' },
    { recipient_id: 'invalid' },
    { recipient_id: '1'.repeat(21) },
    { query: {} },
    { method: 'GET' },
    { path: '/api/v10/users/@me/channels' },
    { path: '/users/%40me/channels' },
    { path: '/users/@me/channels/' },
    { method: 'GET', path: '/users/123', recipient_id: '123' },
    { method: 'POST', path: '/channels/123/messages', recipient_id: '123' },
  ])('rejects invalid scope or selector fields: %j', async (overrides) => {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'POST',
      path,
      guild_id: guild,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      message: '400: Bad Request',
      code: 0,
    })
  })

  it('returns 404 for unknown cleanup scope and permits prearming an unknown recipient', async () => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'POST',
        path,
        guild_id: '999',
        ...failure,
      })
    ).toBe(404)
    const fault = await arm({
      recipient_id: '999',
      status: 500,
      code: 0,
      message: 'Internal Server Error',
    })
    expect(await status(path, 'POST', { recipient_id: '999' })).toBe(500)
    expect(privateChannelCount()).toBe(0)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 1 })
    expect(await status(path, 'POST', { recipient_id: '999' })).toBe(404)
  })

  it.each(['rate_limit', 'delay', 'disconnect'])(
    'supports generic %s faults without creating a channel',
    async (mode) => {
      const fault = await arm({
        recipient_id: recipient,
        mode,
        status: mode === 'rate_limit' ? 429 : 500,
        ...(mode === 'rate_limit' && { retry_after: 0.01 }),
        ...(mode === 'delay' && { delay_ms: 10 }),
      })
      const pending = request(path, 'POST', { recipient_id: recipient })
      if (mode === 'disconnect') await expect(pending).rejects.toThrow()
      else {
        const response = await pending
        expect(response.status).toBe(mode === 'rate_limit' ? 429 : 500)
        if (mode === 'rate_limit') {
          expect(response.headers.get('Retry-After')).toBe('1')
          await expect(response.json()).resolves.toMatchObject({
            retry_after: 0.01,
            global: false,
          })
        }
      }
      expect(privateChannelCount()).toBe(0)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 1,
        state: 'exhausted',
      })
      expect(await status(path, 'POST', { recipient_id: recipient })).toBe(200)
    }
  )
})
