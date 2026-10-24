import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app'
import { request as httpRequest } from 'node:http'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { initializeDatabase, type Database } from './db'
import { gatewayBus } from './gateway/bus'
import { GatewayOp } from './gateway/opcodes'
import { getMessage } from './services/messages'
import {
  createRealServer,
  seedBearerCredential,
  seedBot,
  seedChannel,
  seedGuild,
  type RealServerContext,
} from './test-helpers'
import type { RestFault } from './services/rest-faults'

const token = 'Bot edit-owner'
const otherToken = 'Bot edit-other'
const author = '100000000000000001'
const otherAuthor = '100000000000000002'
const messageId = '1513052391153471489'
const otherMessageId = '1513052391153471490'
const failure = { status: 500, code: 0, message: 'Edit failed' }
const edit = { content: 'changed', embeds: [{ description: 'changed embed' }] }

/** Returns a response status after the request completes. */
async function responseStatus(response: Promise<Response>): Promise<number> {
  const result = await response
  return result.status
}

/** Seeds an exact bot-authored message without producing a Gateway dispatch. */
function seedEditableMessage(db: Database, channel: string, id = messageId) {
  db.prepare(
    `INSERT INTO messages (id, channel_id, author_id, author_token, content)
     VALUES (?, ?, ?, ?, 'original')`
  ).run(id, channel, author, token)
  db.prepare(
    'INSERT INTO embeds (message_id, data, position) VALUES (?, ?, 0)'
  ).run(id, JSON.stringify({ description: 'original embed' }))
}

/** Snapshots persisted rows, including timestamps and embed identities. */
function storedMessage(db: Database) {
  return {
    message: db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId),
    embeds: db
      .prepare('SELECT * FROM embeds WHERE message_id = ?')
      .all(messageId),
    // Native messages currently expose components as an empty array only.
    components: getMessage(db, messageId, 'http://localhost')?.components,
  }
}

describe('exact message edit REST fault controls through buildApp', () => {
  let db: ReturnType<typeof initializeDatabase>
  let built: ReturnType<typeof buildApp>
  let guild: string
  let channel: string
  let path: string

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

  /** Arms an exact edit selector, including before its message exists. */
  async function arm(
    overrides: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'PATCH',
      path,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Inspects evidence without triggering the selected native route. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    built = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, token, author)
    seedBot(db, otherToken, otherAuthor)
    guild = seedGuild(db, token)
    channel = seedChannel(db, guild)
    path = `/channels/${channel}/messages/${messageId}`
  })

  afterEach(() => {
    vi.restoreAllMocks()
    built.shutdownRestFaults()
    built.shutdownRestPageHolds()
    built.unsubscribeGateway()
    built.wss.close()
    db.close()
  })

  it('prearms an absent message with exact IDs and fails before native lookup', async () => {
    const fault = await arm()
    expect(fault).toMatchObject({
      method: 'PATCH',
      path,
      guild_id: guild,
      channel_id: channel,
      remaining: 1,
      consumed: 0,
    })
    const response = await request(path, 'PATCH', edit)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      message: failure.message,
      code: failure.code,
    })
    expect(await responseStatus(request(path, 'PATCH', edit))).toBe(404)
  })

  it.each([
    failure,
    { status: 403, code: 50_013, message: 'Missing Permissions' },
  ])(
    'fails retries across all prefixes with $status before mutation or dispatch',
    async (error) => {
      const fault = await arm({ ...error, times: 3 })
      seedEditableMessage(db, channel)
      const before = storedMessage(db)
      const dispatch = vi.spyOn(gatewayBus, 'emit')
      for (const prefix of ['/api/v10', '/api', '']) {
        const response = await request(
          `${prefix}${path}?reason=test`,
          'PATCH',
          {
            ...edit,
            components: [{ type: 1, components: [] }],
          }
        )
        expect(response.status).toBe(error.status)
        await expect(response.json()).resolves.toEqual({
          message: error.message,
          code: error.code,
        })
        expect(storedMessage(db)).toEqual(before)
      }
      expect(dispatch).not.toHaveBeenCalled()
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 3,
        remaining: 0,
      })
      const success = await request(path, 'PATCH', edit)
      expect(success.status).toBe(200)
      await expect(success.json()).resolves.toMatchObject({
        ...edit,
        components: [],
      })
      expect(dispatch).toHaveBeenCalledWith('message.update', expect.anything())
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 3,
        remaining: 0,
      })
    }
  )

  it('does not consume wrong IDs, channels, guilds, methods, or unauthenticated requests', async () => {
    const fault = await arm({ times: 2 })
    seedEditableMessage(db, channel)
    seedEditableMessage(db, channel, otherMessageId)
    for (const auth of ['', 'Bot unknown'])
      expect(await responseStatus(request(path, 'PATCH', edit, auth))).toBe(401)
    expect(await responseStatus(request(path))).toBe(200)
    for (const method of ['PUT', 'POST'])
      expect(await responseStatus(request(path, method, edit))).toBe(404)
    expect(
      await responseStatus(
        request(
          `/channels/${channel}/messages/${otherMessageId}`,
          'PATCH',
          edit
        )
      )
    ).toBe(200)
    const otherGuild = seedGuild(db, otherToken, '222222222222222223')
    for (const scope of [guild, otherGuild]) {
      const otherChannel = seedChannel(db, scope, scope)
      expect(
        await responseStatus(
          request(
            `/channels/${otherChannel}/messages/${messageId}`,
            'PATCH',
            edit
          )
        )
      ).toBe(404)
    }
    expect(await responseStatus(request(`${path}/`, 'PATCH', edit))).toBe(404)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 0, remaining: 2 })
    // A selected request precedes native payload validation and lookup.
    expect(
      await responseStatus(
        request(path, 'PATCH', { content: 'x'.repeat(2001) })
      )
    ).toBe(500)
    expect(await responseStatus(request(path, 'PATCH', edit))).toBe(500)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 2, remaining: 0 })
  })

  it('preserves legacy authenticated-caller semantics and native authorship/validation', async () => {
    seedEditableMessage(db, channel)
    const before = storedMessage(db)
    const fault = await arm()
    expect(await responseStatus(request(path, 'PATCH', edit, otherToken))).toBe(
      500
    )
    const forbidden = await request(path, 'PATCH', edit, otherToken)
    expect(forbidden.status).toBe(403)
    await expect(forbidden.json()).resolves.toMatchObject({ code: 50_005 })
    expect(
      await responseStatus(
        request(path, 'PATCH', { content: 'x'.repeat(2001) })
      )
    ).toBe(400)
    expect(storedMessage(db)).toEqual(before)
    expect(await responseStatus(request(path, 'PATCH', edit))).toBe(200)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1, remaining: 0 })
  })

  it('rejects active conflicts across modes, bounds concurrent consumption, and permits rearming/removal', async () => {
    seedEditableMessage(db, channel)
    const fault = await arm({ times: 2 })
    expect(
      await responseStatus(
        request('/_test/rest-faults', 'POST', {
          method: 'PATCH',
          path,
          mode: 'rate_limit',
          retry_after: 0.1,
        })
      )
    ).toBe(409)
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(path, 'PATCH', edit))
    )
    expect(
      responses.map((response) => response.status).toSorted((a, b) => a - b)
    ).toEqual([200, 200, 200, 500, 500])
    expect(await inspect(fault.id)).toMatchObject({ consumed: 2, remaining: 0 })
    const rearmed = await arm()
    expect(
      await responseStatus(
        request(`/_test/rest-faults/${rearmed.id}`, 'DELETE')
      )
    ).toBe(204)
    expect(
      await responseStatus(request(`/_test/rest-faults/${rearmed.id}`))
    ).toBe(404)
    expect(
      await responseStatus(
        request(`/_test/rest-faults/${rearmed.id}`, 'DELETE')
      )
    ).toBe(404)
    expect(await responseStatus(request(path, 'PATCH', edit))).toBe(200)
  })

  it.each([
    '/channels/*/messages/1',
    '/channels/{channelID}/messages/{messageID}',
    '/channels/1/messages',
    '/channels/1/messages/pins',
    '/channels/1/messages/2/',
    '/channels/1/messages/2?wait=true',
    '/api/channels/1/messages/2',
    '/api/v10/channels/1/messages/2',
    '/channels/123456789012345678901/messages/2',
    '/channels/1/messages/123456789012345678901',
    '/channels/-1/messages/2',
    '/channels/1/messages/1.5',
  ])('rejects malformed or unsupported PATCH selector %s', async (selector) => {
    expect(
      await responseStatus(
        request('/_test/rest-faults', 'POST', {
          method: 'PATCH',
          path: selector,
          ...failure,
        })
      )
    ).toBe(400)
  })

  it.each([
    { method: 'patch' },
    { query: {} },
    { recipient_id: '123' },
    { times: 0 },
    { times: 101 },
    { times: 1.5 },
    { status: 200 },
    { mode: 'rate_limit', retry_after: 0 },
    { mode: 'delay', delay_ms: 0 },
    { mode: 'disconnect', timeout_ms: 60_001 },
  ])('rejects invalid edit fault configuration %j', async (overrides) => {
    expect(
      await responseStatus(
        request('/_test/rest-faults', 'POST', {
          method: 'PATCH',
          path,
          ...failure,
          ...overrides,
        })
      )
    ).toBe(400)
  })

  it('requires an existing guild channel but derives scope without a message or guild override', async () => {
    db.prepare("INSERT INTO channels (id, type) VALUES ('456', 1)").run()
    for (const channelId of ['123', '456'])
      expect(
        await responseStatus(
          request('/_test/rest-faults', 'POST', {
            method: 'PATCH',
            path: `/channels/${channelId}/messages/${messageId}`,
            ...failure,
          })
        )
      ).toBe(404)
    const fault = await arm({ guild_id: '999' })
    expect(fault.guild_id).toBe(guild)
    expect(fault.path).toBe(path)
  })

  it.each(
    [
      'cancel',
      'reset',
      'scoped reset',
      'setup deletion',
      'guild deletion',
      'channel deletion',
    ].flatMap((cleanup) => [
      { cleanup, mode: undefined },
      { cleanup, mode: 'rate_limit' },
    ])
  )(
    'removes active and exhausted PATCH controls on $cleanup ($mode) with scope isolation',
    async ({ cleanup, mode }) => {
      const configuration = mode ? { mode, retry_after: 0.02, status: 429 } : {}
      const exhausted = await arm(configuration)
      await request(path, 'PATCH', edit)
      const active = await arm(configuration)
      const otherGuild = seedGuild(db, otherToken, '222222222222222223')
      const otherChannel = seedChannel(db, otherGuild, '333333333333333334')
      const other = await arm({
        path: `/channels/${otherChannel}/messages/${messageId}`,
        ...configuration,
      })
      const target =
        cleanup === 'cancel'
          ? `/_test/rest-faults/${active.id}`
          : cleanup.includes('reset')
            ? '/_test/reset'
            : cleanup === 'setup deletion'
              ? `/_test/setup/${encodeURIComponent(token)}`
              : cleanup === 'guild deletion'
                ? `/guilds/${guild}`
                : `/channels/${channel}`
      expect(
        await responseStatus(
          request(
            target,
            cleanup.includes('reset') ? 'POST' : 'DELETE',
            cleanup.includes('reset')
              ? cleanup === 'scoped reset'
                ? { token }
                : {}
              : undefined
          )
        )
      ).toBeLessThan(300)
      if (cleanup === 'cancel')
        expect(
          await responseStatus(
            request(`/_test/rest-faults/${exhausted.id}`, 'DELETE')
          )
        ).toBe(204)
      for (const fault of [active, exhausted])
        expect(
          await responseStatus(request(`/_test/rest-faults/${fault.id}`))
        ).toBe(404)
      expect(
        await responseStatus(request(`/_test/rest-faults/${other.id}`))
      ).toBe(cleanup === 'reset' ? 404 : 200)
    }
  )
})

describe('message edit transport faults over real HTTP and Gateway', () => {
  let server: RealServerContext
  let guild: string
  let channel: string
  let path: string

  /** Sends a bounded request to the real production HTTP server. */
  function request(
    route: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ) {
    return fetch(server.baseUrl + route, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  }

  /** Arms the same public control for all supported explicit transport modes. */
  async function arm(overrides: Record<string, unknown>): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'PATCH',
      path,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Reads arrival and completion evidence without guessing request timing. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Connects a GuildMessages subscriber and provides ordered ACK barriers. */
  async function gateway() {
    const ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
    const ready = Promise.withResolvers<undefined>()
    let ack = Promise.withResolvers<undefined>()
    const updates: unknown[] = []
    ws.on('error', ready.reject)
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { op: number; t?: string }
      if (frame.op === GatewayOp.Hello)
        ws.send(
          JSON.stringify({
            op: GatewayOp.Identify,
            d: { token, intents: GatewayIntentBits.GuildMessages },
          })
        )
      else if (frame.t === 'READY') ready.resolve(undefined)
      if (frame.t === 'MESSAGE_UPDATE') updates.push(frame)
      if (frame.op === GatewayOp.HeartbeatAck) ack.resolve(undefined)
    })
    await ready.promise
    return {
      updates,
      barrier: async () => {
        ack = Promise.withResolvers<undefined>()
        ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
        await ack.promise
      },
    }
  }

  /** Proves socket destruction, with no synthetic HTTP response or fetch retry. */
  function disconnected(route: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const attempt = httpRequest(server.baseUrl + route, {
        method: 'PATCH',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
      })
      attempt.on('response', (response) => {
        response.resume()
        reject(new Error(`Unexpected HTTP response: ${response.statusCode}`))
      })
      attempt.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') resolve()
        else reject(error)
      })
      attempt.setTimeout(2000, () => {
        attempt.destroy(new Error('Disconnect attempt timed out'))
      })
      attempt.end(JSON.stringify(edit))
    })
  }

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token, author)
    seedBot(server.db, otherToken, otherAuthor)
    guild = seedGuild(server.db, token)
    channel = seedChannel(server.db, guild)
    path = `/channels/${channel}/messages/${messageId}`
    seedEditableMessage(server.db, channel)
  })

  afterEach(async () => {
    await server.close()
  })

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'keeps %s owner-scoped, consumes exact retries, and never dispatches a failed edit',
    async (mode) => {
      const fault = await arm({
        mode,
        times: 3,
        ...(mode === 'rate_limit' && { retry_after: 0.02, global: true }),
        ...(mode === 'delay' && { delay_ms: 20 }),
      })
      const listener = await gateway()
      const before = storedMessage(server.db)
      const { bearerToken } = seedBearerCredential(server.db)
      expect(
        await responseStatus(request(path, 'PATCH', edit, otherToken))
      ).toBe(403)
      expect(
        await responseStatus(request(path, 'PATCH', edit, 'Bot unknown'))
      ).toBe(401)
      // Valid Bearer credentials reach native validation without consuming it.
      expect(
        await responseStatus(
          request(
            path,
            'PATCH',
            { content: 'x'.repeat(2001) },
            `Bearer ${bearerToken}`
          )
        )
      ).toBe(400)
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 0,
        remaining: 3,
      })
      for (const prefix of ['/api/v10', '/api', '']) {
        if (mode === 'disconnect') await disconnected(prefix + path)
        else {
          const response = await request(prefix + path, 'PATCH', edit)
          expect(response.status).toBe(mode === 'rate_limit' ? 429 : 504)
          if (mode === 'rate_limit') {
            expect(response.headers.get('Retry-After')).toBe('1')
            expect(response.headers.get('X-RateLimit-Global')).toBe('true')
            await expect(response.json()).resolves.toEqual({
              message: 'You are being rate limited.',
              retry_after: 0.02,
              global: true,
            })
          }
        }
        expect(storedMessage(server.db)).toEqual(before)
      }
      await listener.barrier()
      expect(listener.updates).toEqual([])
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 3,
        remaining: 0,
        state: 'exhausted',
        outcomes: {
          pending: 0,
          cancelled: 0,
          responded: mode === 'disconnect' ? 0 : 3,
          disconnected: mode === 'disconnect' ? 3 : 0,
          delayed: mode === 'delay' ? 3 : 0,
        },
      })
      expect(await responseStatus(request(path, 'PATCH', edit))).toBe(200)
      await listener.barrier()
      expect(listener.updates).toHaveLength(1)
    }
  )

  it.each(['cancel', 'expire'])(
    'does not resume a delayed edit after %s and retains native success on retry',
    async (action) => {
      const listener = await gateway()
      const fault = await arm({
        mode: 'delay',
        delay_ms: 60_000,
        timeout_ms: action === 'expire' ? 500 : 30_000,
        times: 2,
      })
      const before = storedMessage(server.db)
      const pending = request(path, 'PATCH', edit)
      await expect
        .poll(() => inspect(fault.id))
        .toMatchObject({
          consumed: 1,
          outcomes: { pending: 1 },
        })
      if (action === 'cancel')
        expect(
          await responseStatus(
            request(`/_test/rest-faults/${fault.id}`, 'DELETE')
          )
        ).toBe(204)
      expect(await responseStatus(pending)).toBe(504)
      expect(storedMessage(server.db)).toEqual(before)
      await listener.barrier()
      expect(listener.updates).toEqual([])
      if (action === 'expire')
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 0,
          consumed: 1,
          state: 'expired',
          outcomes: { pending: 0, cancelled: 1, responded: 0 },
        })
      else
        expect(
          await responseStatus(request(`/_test/rest-faults/${fault.id}`))
        ).toBe(404)
      expect(await responseStatus(request(path, 'PATCH', edit))).toBe(200)
      await listener.barrier()
      expect(listener.updates).toHaveLength(1)
    }
  )
})
