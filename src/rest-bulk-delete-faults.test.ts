import { request as httpRequest, type ClientRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createRealServer,
  seedBearerCredential,
  seedBot,
  seedChannel,
  seedGroupDmChannel,
  seedGuild,
  seedMessage,
  type RealServerContext,
} from './test-helpers'
import { GatewayOp } from './gateway/opcodes'
import { generateSnowflake } from './snowflake'
import type { RestFault } from './services/rest-faults'
import type { RestObservationSnapshot } from './services/rest-observations'

const token = 'Bot bulk-owner'
const otherToken = 'Bot bulk-other'
const botId = '100000000000000001'
const otherBotId = '100000000000000002'
const failure = { status: 500, code: 0, message: 'Internal Server Error' }

/** Bulk-delete selector path of a channel. */
const bulkPath = (channel: string): string =>
  `/channels/${channel}/messages/bulk-delete`

/** Buffers Gateway frames and bounds each wait. */
function reader(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const frames: Record<string, unknown>[] = []
  const waiting: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    const resolve = waiting.shift()
    if (resolve) resolve(frame)
    else frames.push(frame)
  })
  return () =>
    new Promise((resolve, reject) => {
      const frame = frames.shift()
      if (frame) {
        resolve(frame)
        return
      }
      const timer = setTimeout(() => {
        reject(new Error('Gateway frame timed out'))
      }, 2000)
      waiting.push((next) => {
        clearTimeout(timer)
        resolve(next)
      })
    })
}

/**
 * Builds two distinct recent 19-digit Snowflakes that a floating-point JSON
 * number cannot tell apart.
 */
function collidingSnowflakes(): [string, string] {
  // A high sequence number keeps both clear of IDs generated for fixtures.
  const base = ((BigInt(generateSnowflake()) >> 12n) << 12n) + 0xf_00n
  return [String(base + 1n), String(base + 2n)]
}

describe('bulk message deletion REST faults', () => {
  let server: RealServerContext
  let guild: string
  let otherGuild: string
  let channel: string
  let siblingChannel: string
  let otherChannel: string
  let ids: string[]
  const sockets: WebSocket[] = []
  const uploads: ClientRequest[] = []

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
      body:
        body === undefined || typeof body === 'string'
          ? body
          : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  }

  /** Returns the HTTP status after a request completes. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Sends one bulk-delete request and returns its status. */
  function bulk(
    messages: unknown,
    target = channel,
    auth = token,
    prefix = '/api/v10'
  ): Promise<number> {
    return status(
      prefix + bulkPath(target),
      'POST',
      typeof messages === 'string' ? messages : { messages },
      auth
    )
  }

  /**
   * Sends only the headers of a bulk-delete request and returns once the server
   * has started handling it; the body follows when the test calls `finish`.
   */
  async function startUpload(body: string, target = channel, auth = token) {
    const upload = httpRequest(server.baseUrl + bulkPath(target), {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Expect: '100-continue',
      },
    })
    uploads.push(upload)
    upload.setTimeout(3000, () => {
      upload.destroy(new Error('Upload response timed out'))
    })
    const response = new Promise<number>((resolve, reject) => {
      upload.once('response', (message) => {
        message.resume()
        resolve(message.statusCode ?? 0)
      })
      upload.on('error', reject)
    })
    // A test that fails early leaves the upload to be destroyed by cleanup.
    response.catch(() => undefined)
    await new Promise<void>((resolve) => {
      upload.once('continue', resolve)
      upload.flushHeaders()
    })
    return {
      response,
      finish: (): void => {
        upload.end(body)
      },
      abort: (): void => {
        upload.destroy()
      },
    }
  }

  /**
   * Moves the server's clock forward without waiting, so a lifetime can end
   * between two steps of one request. Timers keep running in real time.
   */
  function advanceClock(milliseconds: number): void {
    const now = Date.now() + milliseconds
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  }

  /** Arms a bulk-delete failure on the primary channel. */
  async function arm(
    overrides: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'POST',
      path: bulkPath(channel),
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Attempts to arm a control and returns the control API status. */
  function armStatus(overrides: Record<string, unknown> = {}): Promise<number> {
    return status('/_test/rest-faults', 'POST', {
      method: 'POST',
      path: bulkPath(channel),
      ...failure,
      ...overrides,
    })
  }

  /** Reads retained configuration and counters without consuming a fault. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Snapshots every row a bulk deletion may remove. */
  function snapshot(): unknown[] {
    return ['messages', 'embeds', 'reactions'].map((table) =>
      server.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    )
  }

  /** Lists the stored message IDs among the given ones. */
  function stored(messageIds: string[]): string[] {
    const find = server.db.prepare('SELECT 1 FROM messages WHERE id = ?')
    return messageIds.filter((id) => find.get(id) !== undefined)
  }

  /** Stores recent messages in a channel and returns their IDs. */
  function seedMessages(count: number, target = channel): string[] {
    return Array.from({ length: count }, () =>
      seedMessage(server.db, target, botId, token)
    )
  }

  /** Stores one message under a chosen ID. */
  function seedMessageWithId(id: string): void {
    server.db
      .prepare(
        'INSERT INTO messages (id, channel_id, author_id, author_token, content) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, channel, botId, token, 'Fixed')
  }

  /** Identifies a Gateway session that receives guild message events. */
  async function connect() {
    const ws = new WebSocket(server.baseUrl.replace('http://', 'ws://'))
    sockets.push(ws)
    const next = reader(ws)
    const hello = await next()
    expect(hello.op).toBe(GatewayOp.Hello)
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token, intents: GatewayIntentBits.GuildMessages },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    /** Asserts no dispatch is queued ahead of a heartbeat acknowledgement. */
    const barrier = async (): Promise<void> => {
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      const ack = await next()
      expect(ack.op).toBe(GatewayOp.HeartbeatAck)
    }
    return { next, barrier }
  }

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token, botId)
    seedBot(server.db, otherToken, otherBotId)
    guild = seedGuild(server.db, token)
    otherGuild = seedGuild(server.db, otherToken, '222222222222222223')
    channel = seedChannel(server.db, guild)
    siblingChannel = seedChannel(server.db, guild, '333333333333333335')
    otherChannel = seedChannel(server.db, otherGuild, '333333333333333334')
    ids = seedMessages(2)
    server.db
      .prepare('INSERT INTO embeds (message_id, data) VALUES (?, ?)')
      .run(ids[0], '{}')
    server.db
      .prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      )
      .run(ids[0], botId, 'x')
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const socket of sockets.splice(0)) socket.terminate()
    for (const upload of uploads.splice(0)) upload.destroy()
    await server.close()
  })

  it('fails every prefix without changing data or dispatching, then deletes natively', async () => {
    const client = await connect()
    const fault = await arm({
      status: 403,
      code: 50_013,
      message: 'Missing Permissions',
      times: 3,
    })
    expect(fault).toMatchObject({
      method: 'POST',
      path: bulkPath(channel),
      guild_id: guild,
      channel_id: channel,
      remaining: 3,
      consumed: 0,
    })
    expect(fault).not.toHaveProperty('message_id')
    const before = snapshot()
    for (const prefix of ['/api/v10', '/api', '']) {
      const response = await request(prefix + bulkPath(channel), 'POST', {
        messages: ids,
      })
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        code: 50_013,
        message: 'Missing Permissions',
      })
      expect(snapshot()).toEqual(before)
    }
    await client.barrier()
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 3 })
    expect(await bulk(ids)).toBe(204)
    await expect(client.next()).resolves.toMatchObject({
      t: 'MESSAGE_DELETE_BULK',
      s: 2,
      d: { ids, channel_id: channel, guild_id: guild },
    })
    await client.barrier()
    expect(stored(ids)).toEqual([])
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 3 })
  })

  it.each([
    ['too few IDs', () => ({ messages: ['1'] })],
    ['duplicate IDs', () => ({ messages: [ids[0], ids[0]] })],
    ['messages of the wrong type', () => ({ messages: 'nope' })],
    ['malformed JSON', () => '{"messages":'],
    ['an empty body', () => ''],
  ])(
    'fails before validation for a body with %s, then validates it natively',
    async (_name, body) => {
      const fault = await arm()
      const route = bulkPath(channel)
      expect(await status(route, 'POST', body())).toBe(500)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 1 })
      expect(await status(route, 'POST', body())).toBe(400)
    }
  )

  it.each(['rate_limit', 'delay', 'disconnect'])(
    'applies %s without deleting or dispatching, then follows the route',
    async (mode) => {
      const client = await connect()
      const fault = await arm({
        mode,
        status: mode === 'rate_limit' ? 429 : 503,
        ...(mode === 'rate_limit' && { retry_after: 0.25 }),
        ...(mode === 'delay' && { delay_ms: 20 }),
      })
      const before = snapshot()
      const pending = request(bulkPath(channel), 'POST', { messages: ids })
      if (mode === 'disconnect') await expect(pending).rejects.toThrow()
      else {
        const response = await pending
        expect(response.status).toBe(mode === 'rate_limit' ? 429 : 503)
        if (mode === 'rate_limit') {
          expect(response.headers.get('Retry-After')).toBe('1')
          expect(response.headers.get('X-RateLimit-Reset-After')).toBe('0.25')
          await expect(response.json()).resolves.toMatchObject({
            retry_after: 0.25,
            global: false,
          })
        }
      }
      expect(snapshot()).toEqual(before)
      await client.barrier()
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 1,
        state: 'exhausted',
      })
      expect(await bulk(ids)).toBe(204)
      await expect(client.next()).resolves.toMatchObject({
        t: 'MESSAGE_DELETE_BULK',
      })
      expect(stored(ids)).toEqual([])
    }
  )

  it('never resumes a delayed deletion after its control is cancelled', async () => {
    const client = await connect()
    // Longer than the request deadline: only cancellation can answer in time.
    const fault = await arm({ mode: 'delay', delay_ms: 10_000, status: 503 })
    const before = snapshot()
    const pending = bulk(ids)
    await vi.waitFor(async () => {
      await expect(inspect(fault.id)).resolves.toMatchObject({
        state: 'delaying',
        outcomes: { pending: 1 },
      })
    })
    expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(204)
    await expect(pending).resolves.toBe(503)
    expect(snapshot()).toEqual(before)
    await client.barrier()
    expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
    expect(await bulk(ids)).toBe(204)
  })

  it('follows the ordinary route after cancellation', async () => {
    const fault = await arm({ times: 5, message_id: ids[0] })
    expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(204)
    expect(await bulk(ids)).toBe(204)
    expect(stored(ids)).toEqual([])
  })

  it('follows the ordinary route after expiry and permits rearming', async () => {
    const fault = await arm({
      mode: 'rate_limit',
      status: 429,
      retry_after: 1,
      timeout_ms: 20,
      message_id: ids[0],
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await bulk(ids)).toBe(204)
    expect(await inspect(fault.id)).toMatchObject({
      state: 'expired',
      consumed: 0,
    })
    await arm({ message_id: ids[0] })
  })

  it('consumes mode-omitted controls for any authenticated caller only', async () => {
    const { bearerToken } = seedBearerCredential(server.db)
    const fault = await arm({ times: 2 })
    for (const auth of ['', 'Bot missing', 'Bearer missing'])
      expect(await bulk(ids, channel, auth)).toBe(401)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 0 })
    expect(await bulk(ids, channel, otherToken)).toBe(500)
    expect(await bulk(ids, channel, `Bearer ${bearerToken}`)).toBe(500)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 2 })
    expect(stored(ids)).toEqual(ids)
  })

  it.each(['rate_limit', 'delay', 'disconnect'])(
    'binds explicit %s controls to the owning bot',
    async (mode) => {
      const fault = await arm({
        mode,
        status: mode === 'rate_limit' ? 429 : 503,
        ...(mode === 'rate_limit' && { retry_after: 1 }),
        ...(mode === 'delay' && { delay_ms: 5 }),
        message_id: ids[0],
      })
      // The ordinary route refuses a bot outside the channel's guild.
      expect(await bulk(ids, channel, otherToken)).toBe(403)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 1,
        consumed: 0,
      })
      const pending = bulk(ids)
      if (mode === 'disconnect') await expect(pending).rejects.toThrow()
      else await expect(pending).resolves.toBe(mode === 'delay' ? 503 : 429)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 1 })
    }
  )

  it.each([
    ['an unnarrowed', false],
    ['a narrowed', true],
  ])(
    'applies %s failure before the permission checks of the route',
    async (_name, narrowed) => {
      // Neither the guild owner nor a member: the route refuses the bot.
      server.db
        .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
        .run('999', guild)
      await arm(narrowed ? { message_id: ids[0] } : {})
      const before = snapshot()
      expect(await bulk(ids)).toBe(500)
      const response = await request(bulkPath(channel), 'POST', {
        messages: ids,
      })
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ code: 50_001 })
      expect(snapshot()).toEqual(before)
    }
  )

  it('selects the exact channel and route', async () => {
    const fault = await arm()
    const sibling = seedMessages(2, siblingChannel)
    expect(await bulk(sibling, siblingChannel)).toBe(204)
    expect(
      await bulk(seedMessages(2, otherChannel), otherChannel, otherToken)
    ).toBe(204)
    expect(
      await status(`/channels/${channel}/messages`, 'POST', { content: 'hi' })
    ).toBe(200)
    expect(
      await status(`/channels/${channel}/messages/${ids[0]}`, 'DELETE')
    ).toBe(204)
    expect(await status(bulkPath(channel))).not.toBe(500)
    expect(await bulk(ids, `0${channel}`)).toBe(404)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 1, consumed: 0 })
    expect(await bulk(ids)).toBe(500)
  })

  it('ignores request query parameters and bounds concurrent attempts', async () => {
    const fault = await arm({ times: 3 })
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        status(`${bulkPath(channel)}?extra=1`, 'POST', { messages: ids })
      )
    )
    expect(statuses.filter((code) => code === 500)).toHaveLength(3)
    expect(statuses.filter((code) => code === 204)).toHaveLength(5)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 3 })
  })

  it('matches a narrowed control only when the request lists its message', async () => {
    const others = seedMessages(4)
    const fault = await arm({ message_id: ids[1], times: 2 })
    expect(fault.message_id).toBe(ids[1])
    expect(await bulk(others.slice(0, 2))).toBe(204)
    expect(
      await status(bulkPath(channel), 'POST', {
        messages: others.slice(2),
        reason: ids[1],
      })
    ).toBe(204)
    // A body the route cannot read as a Snowflake list never matches.
    for (const body of [
      `{"messages":[["${ids[1]}"],true]}`,
      `{"messages":"${ids[1]}"}`,
      `{"other":["${ids[1]}"]}`,
      `{"messages":["${ids[1]}"]`,
    ])
      expect(await bulk(body)).toBe(400)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 2, consumed: 0 })
    expect(await bulk(ids)).toBe(500)
    // The last position matches too, ahead of the route's count validation.
    expect(await bulk([ids[1]])).toBe(500)
    expect(stored(ids)).toEqual(ids)
    expect(await inspect(fault.id)).toMatchObject({
      message_id: ids[1],
      remaining: 0,
      consumed: 2,
    })
    expect(await bulk(ids)).toBe(204)
    expect(stored(ids)).toEqual([])
  })

  it('matches a listed message whatever the other entries are', async () => {
    const fault = await arm({ message_id: ids[1], times: 3 })
    for (const entry of ['false', 'null', '"not-an-id"'])
      expect(await bulk(`{"messages":[${entry},"${ids[1]}"]}`)).toBe(500)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 3 })
    // The ordinary route still rejects the whole body afterwards.
    expect(await bulk(`{"messages":[false,"${ids[1]}"]}`)).toBe(400)
    expect(stored(ids)).toEqual(ids)
  })

  it('answers unnarrowed and unarmed requests without waiting for the body', async () => {
    const body = JSON.stringify({ messages: ids })
    const fault = await arm()
    const faulted = await startUpload(body)
    await expect(faulted.response).resolves.toBe(500)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1 })
    const unknown = await startUpload(body, '999')
    await expect(unknown.response).resolves.toBe(404)
    expect(stored(ids)).toEqual(ids)
  })

  it('does not make another bot wait for an owner-bound narrowed control', async () => {
    const fault = await arm({
      mode: 'rate_limit',
      status: 429,
      retry_after: 1,
      message_id: ids[0],
    })
    const body = JSON.stringify({ messages: ids })
    // The route refuses this bot on the headers alone.
    const foreign = await startUpload(body, channel, otherToken)
    await expect(foreign.response).resolves.toBe(403)
    await expect(inspect(fault.id)).resolves.toMatchObject({ consumed: 0 })
    const owner = await startUpload(body)
    owner.finish()
    await expect(owner.response).resolves.toBe(429)
  })

  it('decides on arrival once a narrowed control has expired', async () => {
    await arm({
      mode: 'rate_limit',
      status: 429,
      retry_after: 1,
      message_id: ids[0],
    })
    // Nothing inspects or prunes the control after its lifetime ends.
    advanceClock(31_000)
    const upload = await startUpload(JSON.stringify({ messages: ids }))
    const later = await arm()
    upload.finish()
    await expect(upload.response).resolves.toBe(204)
    await expect(inspect(later.id)).resolves.toMatchObject({
      remaining: 1,
      consumed: 0,
    })
  })

  it.each(['quoted', 'unquoted'])(
    'compares %s 19-digit IDs without rounding',
    async (form) => {
      const [selected, neighbor] = collidingSnowflakes()
      expect(selected).toHaveLength(19)
      expect(Number(selected)).toBe(Number(neighbor))
      seedMessageWithId(selected)
      seedMessageWithId(neighbor)
      /** Serializes a raw body in the requested ID form. */
      const body = (list: string[]): string => {
        const items = list.map((id) => (form === 'quoted' ? `"${id}"` : id))
        return `{"messages":[${items.join(',')}]}`
      }
      const fault = await arm({ message_id: selected })
      expect(await bulk(body([neighbor, ids[0]]))).toBe(204)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 0 })
      expect(stored([selected, neighbor])).toEqual([selected])
      expect(await bulk(body([ids[1], selected]))).toBe(500)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 1 })
      expect(stored([selected, ids[1]])).toEqual([selected, ids[1]])
    }
  )

  it('prearms a message that is not stored yet', async () => {
    const [future] = collidingSnowflakes()
    await arm({ message_id: future })
    expect(await bulk([ids[0], future])).toBe(500)
    expect(await bulk([ids[0], future])).toBe(204)
  })

  it('fails only the second chunk of 150 messages', async () => {
    const all = seedMessages(150)
    const first = all.slice(0, 100)
    const second = all.slice(100)
    const fault = await arm({ message_id: second[0] })
    expect(await bulk(first)).toBe(204)
    expect(await bulk(second)).toBe(500)
    expect(stored(all)).toEqual(second)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 1 })
    expect(await bulk(second)).toBe(204)
    expect(stored(all)).toEqual([])
  })

  it.each([
    ['an unnarrowed control', undefined, 'narrowed'],
    ['a narrowed control', 'narrowed', undefined],
    ['the same message', 'narrowed', 'narrowed'],
    ['another unnarrowed control', undefined, undefined],
  ])(
    'rejects a control overlapping %s, including across modes',
    async (_name, first, second) => {
      /** Selects the narrowing fields of one side of the overlap. */
      const narrowing = (kind: string | undefined) =>
        kind === undefined ? {} : { message_id: ids[0] }
      const active = await arm(narrowing(first))
      expect(await armStatus(narrowing(second))).toBe(409)
      expect(
        await armStatus({
          ...narrowing(second),
          mode: 'disconnect',
          status: 503,
        })
      ).toBe(409)
      expect(await bulk(ids)).toBe(500)
      expect(await inspect(active.id)).toMatchObject({ remaining: 0 })
      await arm(narrowing(second))
    }
  )

  it('admits different messages and channels, consuming the earliest armed match', async () => {
    const first = await arm({ message_id: ids[1], status: 501 })
    const second = await arm({ message_id: ids[0], status: 502 })
    await arm({ path: bulkPath(siblingChannel), message_id: ids[0] })
    await arm({ path: bulkPath(otherChannel) })
    await arm({ path: `/channels/${channel}/messages` })
    expect(await bulk(ids)).toBe(501)
    expect(await inspect(first.id)).toMatchObject({ consumed: 1 })
    expect(await inspect(second.id)).toMatchObject({ consumed: 0 })
    expect(await bulk(ids)).toBe(502)
    expect(await bulk(ids)).toBe(204)
  })

  it('skips an earlier owner-bound match for other callers', async () => {
    const owned = await arm({
      message_id: ids[0],
      mode: 'rate_limit',
      status: 429,
      retry_after: 1,
    })
    const open = await arm({ message_id: ids[1], status: 502 })
    expect(await bulk(ids, channel, otherToken)).toBe(502)
    expect(await inspect(owned.id)).toMatchObject({ consumed: 0 })
    expect(await inspect(open.id)).toMatchObject({ consumed: 1 })
    expect(await bulk(ids)).toBe(429)
  })

  it.each([
    'cancel',
    'reset',
    'scoped reset',
    'setup deletion',
    'guild deletion',
    'channel deletion',
  ])(
    'removes active and exhausted controls through %s cleanup',
    async (cleanup) => {
      const active = await arm({ message_id: ids[0], times: 2 })
      const exhausted = await arm({ message_id: ids[1] })
      const foreign = await arm({ path: bulkPath(otherChannel) })
      await bulk([ids[1], '1'])
      expect(await inspect(exhausted.id)).toMatchObject({ remaining: 0 })
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
        case 'channel deletion': {
          expect(await status(`/channels/${channel}`, 'DELETE')).toBe(200)
          break
        }
      }
      for (const fault of [active, exhausted])
        expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${foreign.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
    }
  )

  it('returns 404 for unknown and private channels', async () => {
    const dm = seedGroupDmChannel(server.db, '444444444444444444')
    for (const target of ['999', dm]) {
      expect(await armStatus({ path: bulkPath(target) })).toBe(404)
      expect(
        await armStatus({ path: bulkPath(target), message_id: ids[0] })
      ).toBe(404)
    }
  })

  it.each([
    { path: '/channels/123/messages/bulk-delete/' },
    { path: '/channels/123/messages/bulk-delete?limit=1' },
    { path: '/api/v10/channels/123/messages/bulk-delete' },
    { path: '/channels/*/messages/bulk-delete' },
    { path: '/channels/{channelId}/messages/bulk-delete' },
    { path: '/channels/123456789012345678901/messages/bulk-delete' },
    { method: 'GET' },
    { method: 'PUT' },
    { method: 'PATCH' },
    { method: 'DELETE' },
    { guild_id: '222222222222222222' },
    { guild_id: 222 },
    { recipient_id: '123' },
    { query: {} },
    { message_id: null },
    { message_id: 123 },
    { message_id: '' },
    { message_id: 'abc' },
    { message_id: '-1' },
    { message_id: '1.5' },
    { message_id: '0123' },
    { message_id: ' 123' },
    { message_id: '18446744073709551616' },
    { message_id: ['123'] },
  ])('rejects invalid selector fields: %j', async (overrides) => {
    for (const endpoint of ['rest-faults', 'rest-observations']) {
      const response = await request(`/_test/${endpoint}`, 'POST', {
        method: 'POST',
        path: bulkPath(channel),
        ...(endpoint === 'rest-faults' && failure),
        ...overrides,
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        message: '400: Bad Request',
        code: 0,
      })
    }
  })

  it.each([
    ['POST', '/channels/123/messages'],
    ['POST', '/channels/123/invites'],
    ['POST', '/users/@me/channels', '222'],
    ['PATCH', '/channels/123'],
    ['POST', '/guilds/222/channels'],
    ['DELETE', '/channels/123/messages/456'],
    ['PATCH', '/channels/123/messages/456'],
    ['DELETE', '/channels/123'],
    ['PUT', '/guilds/222/bans/456'],
    ['DELETE', '/guilds/222/bans/456'],
    ['PATCH', '/guilds/222/members/456'],
    ['PUT', '/guilds/222/members/456/roles/789'],
    ['DELETE', '/guilds/222/members/456/roles/789'],
    ['GET', '/guilds/222/audit-logs'],
    ['GET', '/guilds/222/invites'],
    ['GET', '/guilds/222/channels'],
    ['DELETE', '/users/@me/guilds/222'],
    ['POST', '/interactions/444/callback'],
    ['GET', '/interactions/444/messages/@original'],
    ['PATCH', '/interactions/444/messages/@original'],
    ['DELETE', '/interactions/444/messages/@original'],
    ['GET', '/guilds/222/members/456'],
    ['GET', '/guilds/222/voice-states/456'],
    ['GET', '/guilds/222/roles'],
    ['GET', '/applications/111/guilds/222/commands'],
    ['PUT', '/applications/111/guilds/222/commands'],
    ['GET', '/applications/111/guilds/222/commands/permissions'],
    ['GET', '/applications/111/guilds/222/commands/333/permissions'],
    ['PUT', '/applications/111/guilds/222/commands/333/permissions'],
    ['GET', '/users/456', '222'],
    ['GET', '/guilds/222/members'],
    ['GET', '/guilds/222/bans'],
    ['GET', '/channels/123/messages'],
    ['GET', '/channels/123/messages/456'],
  ])('rejects message_id on %s %s', async (method, path, guildId?: string) => {
    for (const endpoint of ['rest-faults', 'rest-observations']) {
      const selector = {
        method,
        path,
        ...(guildId !== undefined && { guild_id: guildId }),
        ...(endpoint === 'rest-faults' && failure),
      }
      // Valid without the narrowing field: any rejection is a scope lookup.
      expect(await status(`/_test/${endpoint}`, 'POST', selector)).not.toBe(400)
      expect(
        await status(`/_test/${endpoint}`, 'POST', {
          ...selector,
          message_id: '456',
        })
      ).toBe(400)
    }
  })

  describe('observations', () => {
    /** Creates a bulk-delete observation on the primary channel. */
    async function observe(
      overrides: Record<string, unknown> = {}
    ): Promise<RestObservationSnapshot> {
      const response = await request('/_test/rest-observations', 'POST', {
        method: 'POST',
        path: bulkPath(channel),
        ...overrides,
      })
      expect(response.status).toBe(201)
      return response.json() as Promise<RestObservationSnapshot>
    }

    /** Reads an observation snapshot. */
    async function read(id: string): Promise<RestObservationSnapshot> {
      const response = await request(`/_test/rest-observations/${id}`)
      expect(response.status).toBe(200)
      return response.json() as Promise<RestObservationSnapshot>
    }

    it('counts the two chunks of 150 messages without failing them', async () => {
      const all = seedMessages(150)
      const every = await observe()
      const narrowed = await observe({ message_id: all[100] })
      const overlapping = await observe({ message_id: all[100] })
      expect(every).toMatchObject({
        guild_id: guild,
        path: bulkPath(channel),
        count: 0,
      })
      expect(every).not.toHaveProperty('message_id')
      expect(narrowed).toMatchObject({ message_id: all[100] })
      expect(await bulk(all.slice(0, 100))).toBe(204)
      expect(await bulk(all.slice(100), channel, token, '/api')).toBe(204)
      expect(stored(all)).toEqual([])
      await expect(read(every.id)).resolves.toMatchObject({
        count: 2,
        requests: [
          { method: 'POST', path: bulkPath(channel), status: 204 },
          { method: 'POST', path: bulkPath(channel), status: 204 },
        ],
      })
      for (const observation of [narrowed, overlapping])
        await expect(read(observation.id)).resolves.toMatchObject({
          message_id: all[100],
          count: 1,
          requests: [{ status: 204, credential: 'bot' }],
        })
    })

    it('records final statuses of faulted, invalid and other callers’ requests', async () => {
      const every = await observe()
      const narrowed = await observe({ message_id: ids[0] })
      await arm({ message_id: ids[0] })
      expect(await bulk(ids)).toBe(500)
      expect(await bulk([ids[0]], channel, otherToken)).toBe(403)
      expect(await bulk('{', channel, token, '')).toBe(400)
      expect(await bulk(ids, siblingChannel)).toBe(204)
      expect(await bulk(ids, channel, 'Bot missing')).toBe(401)
      const all = await read(every.id)
      expect(all.requests.map((entry) => entry.status)).toEqual([500, 403, 400])
      const matched = await read(narrowed.id)
      expect(matched.requests.map((entry) => entry.status)).toEqual([500, 403])
    })

    it('selects observations when the request arrives, not when its body ends', async () => {
      const expiring = await observe({ message_id: ids[0] })
      const upload = await startUpload(JSON.stringify({ messages: ids }))
      const late = await observe({ message_id: ids[0] })
      const lateAll = await observe()
      // Past the default lifetime of the observation armed before the upload.
      advanceClock(60_000)
      upload.finish()
      await expect(upload.response).resolves.toBe(204)
      await expect(read(expiring.id)).resolves.toMatchObject({
        count: 1,
        state: 'expired',
      })
      for (const observation of [late, lateAll])
        await expect(read(observation.id)).resolves.toMatchObject({ count: 0 })
    })

    it('lets a fault apply on arrival while a narrowed observation reads the body', async () => {
      const observation = await observe({ message_id: ids[0] })
      const fault = await arm({
        mode: 'rate_limit',
        status: 429,
        retry_after: 1,
      })
      const upload = await startUpload(JSON.stringify({ messages: ids }))
      await expect(inspect(fault.id)).resolves.toMatchObject({ consumed: 1 })
      // The fault expires before the body ends: the outcome must not change.
      advanceClock(31_000)
      upload.finish()
      await expect(upload.response).resolves.toBe(429)
      expect(stored(ids)).toEqual(ids)
      await expect(read(observation.id)).resolves.toMatchObject({
        count: 1,
        requests: [{ status: 429 }],
      })
    })

    it('counts a split upload that an unnarrowed fault disconnects', async () => {
      const all = seedMessages(100)
      const observation = await observe({ message_id: all[99] })
      const fault = await arm({ mode: 'disconnect', status: 503 })
      const upload = await startUpload(JSON.stringify({ messages: all }))
      // Consumed on the headers; the cut waits for the observed body.
      await expect(inspect(fault.id)).resolves.toMatchObject({ consumed: 1 })
      upload.finish()
      await expect(upload.response).rejects.toThrow()
      await vi.waitFor(async () => {
        await expect(read(observation.id)).resolves.toMatchObject({
          count: 1,
          requests: [{ status: 204 }],
        })
      })
      await expect(inspect(fault.id)).resolves.toMatchObject({
        outcomes: { disconnected: 1 },
      })
      expect(stored(all)).toEqual(all)
    })

    it('counts an upload that fails only in observations without message_id', async () => {
      const every = await observe()
      const narrowed = await observe({ message_id: ids[0] })
      await arm({ mode: 'disconnect', status: 503 })
      const upload = await startUpload(JSON.stringify({ messages: ids }))
      upload.abort()
      await vi.waitFor(async () => {
        await expect(read(every.id)).resolves.toMatchObject({ count: 1 })
      })
      await expect(read(narrowed.id)).resolves.toMatchObject({ count: 0 })
      expect(stored(ids)).toEqual(ids)
    })

    it('records unnarrowed observations without waiting for a narrowed one', async () => {
      const every = await observe()
      const narrowed = await observe({ message_id: ids[0] })
      await arm({ mode: 'rate_limit', status: 429, retry_after: 1 })
      const upload = await startUpload(JSON.stringify({ messages: ids }))
      expect(await bulk(ids)).toBe(204)
      const early = await read(every.id)
      expect(early.requests.map((entry) => entry.status)).toEqual([429, 204])
      upload.finish()
      await expect(upload.response).resolves.toBe(429)
      await expect(read(every.id)).resolves.toMatchObject({ count: 2 })
      await expect(read(narrowed.id)).resolves.toMatchObject({ count: 2 })
    })

    it('consumes no fault for an upload that fails while matching waits for it', async () => {
      const errors = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      const every = await observe()
      const narrowed = await arm({ message_id: ids[0] })
      const upload = await startUpload(JSON.stringify({ messages: ids }))
      expect(await status(`/_test/rest-faults/${narrowed.id}`, 'DELETE')).toBe(
        204
      )
      const later = await arm()
      upload.abort()
      await vi.waitFor(async () => {
        await expect(read(every.id)).resolves.toMatchObject({ count: 1 })
      })
      await expect(inspect(later.id)).resolves.toMatchObject({
        remaining: 1,
        consumed: 0,
      })
      expect(stored(ids)).toEqual(ids)
      expect(await bulk(ids)).toBe(500)
      errors.mockRestore()
    })

    it('counts a listed message whatever the other entries are', async () => {
      const observation = await observe({ message_id: ids[0] })
      expect(await bulk(`{"messages":[false,"${ids[0]}"]}`)).toBe(400)
      await expect(read(observation.id)).resolves.toMatchObject({
        count: 1,
        requests: [{ status: 400 }],
      })
    })

    it('matches 19-digit IDs without rounding', async () => {
      const [selected, neighbor] = collidingSnowflakes()
      const observation = await observe({ message_id: selected })
      expect(await bulk(`{"messages":[${neighbor},${ids[0]}]}`)).toBe(204)
      await expect(read(observation.id)).resolves.toMatchObject({ count: 0 })
      expect(await bulk(`{"messages":[${selected},${ids[1]}]}`)).toBe(204)
      await expect(read(observation.id)).resolves.toMatchObject({ count: 1 })
    })

    it('returns 404 for unknown and private channels', async () => {
      const dm = seedGroupDmChannel(server.db, '444444444444444444')
      for (const target of ['999', dm])
        expect(
          await status('/_test/rest-observations', 'POST', {
            method: 'POST',
            path: bulkPath(target),
          })
        ).toBe(404)
    })
  })
})
