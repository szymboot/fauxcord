import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { Database } from '../db'
import {
  createTestGatewayServer,
  seedApplicationCommand,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
} from '../test-helpers'
import { GatewayOp } from './opcodes'

/** One decoded Gateway frame as seen by the client. */
interface Frame {
  op: number
  t?: string | null
  s?: number | null
  d: unknown
}

/** Connected Gateway client with a lossless frame queue. */
interface Client {
  ws: WebSocket
  /** Resolves with the next frame, or rejects after `timeoutMs`. */
  next: (timeoutMs?: number) => Promise<Frame>
  /** Resolves with every frame received within `ms` (for absence checks). */
  drain: (ms?: number) => Promise<Frame[]>
}

const BOT = '111111111111111111'
const TOKEN = 'Bot guild-delete-token'
const GUILD = '222222222222222222'
const OTHER_GUILD = '222222222222222223'
const CHANNEL = '333333333333333333'
const ALL_INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildMessages

/**
 * Opens a Gateway connection, queueing every frame from the first byte so
 * frames sent back-to-back are never lost.
 * @param url - Gateway URL
 * @returns The connected client after HELLO
 */
async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url)
  const queue: Frame[] = []
  const waiters: ((frame: Frame) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Frame
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  const next = (timeoutMs = 2000): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const queued = queue.shift()
      if (queued) {
        resolve(queued)
        return
      }
      const state: { timer?: NodeJS.Timeout } = {}
      /** Resolves the pending read once a frame arrives. */
      const waiter = (frame: Frame): void => {
        clearTimeout(state.timer)
        resolve(frame)
      }
      state.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new Error('Timed out waiting for a Gateway frame'))
      }, timeoutMs)
      waiters.push(waiter)
    })
  const drain = async (ms = 150): Promise<Frame[]> => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return queue.splice(0)
  }
  const hello = await next()
  expect(hello.op).toBe(GatewayOp.Hello)
  return { ws, next, drain }
}

/**
 * Sends IDENTIFY and consumes READY plus the expected GUILD_CREATE frames.
 * @param client - Connected client
 * @param token - Raw bot token as sent by libraries
 * @param intents - Intent bitfield
 * @returns READY data and the GUILD_CREATE guild IDs received
 */
async function identify(
  client: Client,
  token: string,
  intents: number
): Promise<{
  ready: { session_id: string; guilds: { id: string }[] }
  readySeq: number
  guildCreates: string[]
  lastSeq: number
}> {
  client.ws.send(
    JSON.stringify({
      op: GatewayOp.Identify,
      d: { token: token.replace(/^Bot /, ''), intents, properties: {} },
    })
  )
  const readyFrame = await client.next()
  expect(readyFrame.t).toBe('READY')
  const ready = readyFrame.d as {
    session_id: string
    guilds: { id: string }[]
  }
  const guildCreates: string[] = []
  let lastSeq = readyFrame.s ?? 0
  if (intents & GatewayIntentBits.Guilds) {
    for (const stub of ready.guilds) {
      const frame = await client.next()
      expect(frame.t).toBe('GUILD_CREATE')
      expect(frame.d).toMatchObject({ id: stub.id })
      guildCreates.push(stub.id)
      lastSeq = frame.s ?? lastSeq
    }
  }
  return { ready, readySeq: readyFrame.s ?? 0, guildCreates, lastSeq }
}

/**
 * Reads the next `count` frames and returns their event names.
 * @param client - Connected client
 * @param count - Number of frames to read
 * @returns Event names in arrival order
 */
async function nextTypes(client: Client, count: number): Promise<unknown[]> {
  const types: unknown[] = []
  for (let read = 0; read < count; read += 1) {
    const frame = await client.next()
    types.push(frame.t)
  }
  return types
}

/**
 * Awaits a response and returns its HTTP status.
 * @param response - Pending response
 * @returns The status code
 */
async function statusOf(response: Promise<Response>): Promise<number> {
  const resolved = await response
  return resolved.status
}

/**
 * Awaits a JSON list response and returns the listed IDs.
 * @param response - Pending response with an array of `{ id }` objects
 * @returns The IDs in order
 */
async function idsOf(response: Promise<Response>): Promise<string[]> {
  const resolved = await response
  const body = (await resolved.json()) as { id: string }[]
  return body.map(({ id }) => id)
}

/**
 * Seeds the bot with two guilds; the bot is a member row of the first.
 * @param db - Database
 * @param token - Bot token
 * @param botId - Bot user ID
 * @param guilds - Guild IDs to create
 */
function seedBotWithGuilds(
  db: Database,
  token = TOKEN,
  botId = BOT,
  guilds = [GUILD, OTHER_GUILD]
): void {
  seedBot(db, token, botId)
  for (const guildId of guilds) {
    seedGuild(db, token, guildId)
    db.prepare(
      'INSERT OR IGNORE INTO guild_members (guild_id, user_id) VALUES (?, ?)'
    ).run(guildId, botId)
  }
  seedChannel(db, guilds[0] ?? GUILD, CHANNEL)
}

describe('GUILD_DELETE when the bot loses a guild', () => {
  let close: (() => Promise<void>) | undefined
  const sockets: WebSocket[] = []
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    await close?.()
    close = undefined
  })

  /**
   * Starts a server and returns helpers bound to it.
   * @returns The database, HTTP request helper and a connect helper
   */
  async function start(): Promise<{
    db: Database
    http: (
      path: string,
      init?: RequestInit,
      token?: string
    ) => Promise<Response>
    open: () => Promise<Client>
    url: string
  }> {
    const server = await createTestGatewayServer()
    close = server.close
    const base = server.url.replace('ws://', 'http://')
    return {
      db: server.db,
      url: server.url,
      http: (path, init, token = TOKEN) =>
        fetch(base + path, {
          ...init,
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
        }),
      open: async () => {
        const client = await connect(server.url)
        sockets.push(client.ws)
        return client
      },
    }
  }

  it('dispatches GUILD_MEMBER_REMOVE then GUILD_DELETE {id} on Leave Guild', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const client = await open()
    const { lastSeq } = await identify(client, TOKEN, ALL_INTENTS)

    const res = await http(`/api/v10/users/@me/guilds/${GUILD}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(204)

    const remove = await client.next()
    expect(remove.t).toBe('GUILD_MEMBER_REMOVE')
    expect(remove.s).toBe(lastSeq + 1)
    expect(remove.d).toMatchObject({ guild_id: GUILD, user: { id: BOT } })
    const deleted = await client.next()
    expect(deleted).toEqual({
      op: GatewayOp.Dispatch,
      t: 'GUILD_DELETE',
      s: lastSeq + 2,
      d: { id: GUILD },
    })
    expect(deleted.d).not.toHaveProperty('unavailable')
    expect(await client.drain()).toEqual([])
  })

  it('dispatches only GUILD_DELETE {id} when the guild is deleted', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const client = await open()
    const { lastSeq } = await identify(client, TOKEN, ALL_INTENTS)

    const res = await http(`/guilds/${GUILD}`, { method: 'DELETE' })
    expect(res.status).toBe(204)

    expect(await client.next()).toEqual({
      op: GatewayOp.Dispatch,
      t: 'GUILD_DELETE',
      s: lastSeq + 1,
      d: { id: GUILD },
    })
    expect(await client.drain()).toEqual([])
  })

  it.each([
    ['leave', `/api/users/@me/guilds/${GUILD}`],
    ['delete', `/guilds/${GUILD}`],
  ])(
    'removes the guild from REST and later READY/GUILD_CREATE after %s',
    async (_kind, path) => {
      const { db, http, open } = await start()
      seedBotWithGuilds(db)
      const first = await open()
      await identify(first, TOKEN, ALL_INTENTS)
      expect(await statusOf(http(path, { method: 'DELETE' }))).toBe(204)

      expect(await idsOf(http('/users/@me/guilds'))).toEqual([OTHER_GUILD])
      expect(await statusOf(http(`/guilds/${GUILD}`))).toBe(404)

      const second = await open()
      const { ready, guildCreates } = await identify(second, TOKEN, ALL_INTENTS)
      expect(ready.guilds).toEqual([{ id: OTHER_GUILD, unavailable: true }])
      expect(guildCreates).toEqual([OTHER_GUILD])
    }
  )

  it.each([
    ['kick', `/guilds/${GUILD}/members/${BOT}`, 'DELETE', undefined, 204],
    ['ban', `/api/v10/guilds/${GUILD}/bans/${BOT}`, 'PUT', {}, 204],
  ])(
    'treats a %s of the bot itself as removal from the guild',
    async (_kind, path, method, body, status) => {
      const { db, http, open } = await start()
      seedBotWithGuilds(db)
      const client = await open()
      const { lastSeq } = await identify(client, TOKEN, ALL_INTENTS)

      const res = await http(path, {
        method,
        ...(body && { body: JSON.stringify(body) }),
      })
      expect(res.status).toBe(status)

      const remove = await client.next()
      expect(remove).toMatchObject({
        t: 'GUILD_MEMBER_REMOVE',
        s: lastSeq + 1,
        d: { guild_id: GUILD, user: { id: BOT } },
      })
      expect(await client.next()).toEqual({
        op: GatewayOp.Dispatch,
        t: 'GUILD_DELETE',
        s: lastSeq + 2,
        d: { id: GUILD },
      })
      expect(await client.drain()).toEqual([])
      expect(await idsOf(http('/users/@me/guilds'))).toEqual([OTHER_GUILD])
    }
  )

  it('removes the guild when a bulk ban includes the bot itself', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const humanId = seedMember(db, GUILD)
    const client = await open()
    await identify(client, TOKEN, ALL_INTENTS)

    const res = await http(`/guilds/${GUILD}/bulk-ban`, {
      method: 'POST',
      body: JSON.stringify({ user_ids: [humanId, BOT, BOT] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      banned_users: [humanId, BOT],
      failed_users: [],
    })
    // The human's removal is published before the bot loses the guild.
    const removed = [await client.next(), await client.next()]
    expect(removed).toMatchObject([
      { t: 'GUILD_MEMBER_REMOVE', d: { user: { id: humanId } } },
      { t: 'GUILD_MEMBER_REMOVE', d: { user: { id: BOT } } },
    ])
    expect(await nextTypes(client, 1)).toEqual(['GUILD_DELETE'])
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(await client.drain()).toEqual([])
    expect(await statusOf(http(`/guilds/${GUILD}`))).toBe(404)
  })

  it('still kicks other members without removing the guild', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const humanId = seedMember(db, GUILD)
    const client = await open()
    await identify(client, TOKEN, ALL_INTENTS)

    expect(
      await statusOf(
        http(`/guilds/${GUILD}/members/${humanId}`, { method: 'DELETE' })
      )
    ).toBe(204)
    const frames = [await client.next(), ...(await client.drain())]
    expect(frames.map(({ t }) => t)).toEqual(['GUILD_MEMBER_REMOVE'])
    expect(await statusOf(http(`/guilds/${GUILD}`))).toBe(200)
  })

  it.each([
    ['leave', `/users/@me/guilds/${GUILD}`],
    ['delete', `/guilds/${GUILD}`],
  ])(
    'rejects test interactions for the guild after %s',
    async (_kind, path) => {
      const { db, http, open } = await start()
      seedBotWithGuilds(db)
      seedApplicationCommand(db, BOT, null, 'ping')
      const client = await open()
      await identify(client, TOKEN, ALL_INTENTS)
      await http(path, { method: 'DELETE' })
      await client.drain()

      const res = await http('/_test/interactions', {
        method: 'POST',
        body: JSON.stringify({
          application_id: BOT,
          command_name: 'ping',
          guild_id: GUILD,
          channel_id: CHANNEL,
        }),
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        message: 'Unknown Guild',
        code: 10_004,
      })
      const orphan = await http('/_test/interactions', {
        method: 'POST',
        body: JSON.stringify({
          application_id: BOT,
          command_name: 'ping',
          channel_id: CHANNEL,
        }),
      })
      expect(orphan.status).toBe(404)
      expect(await orphan.json()).toEqual({
        message: 'Unknown Channel',
        code: 10_003,
      })
      expect(await client.drain()).toEqual([])
    }
  )

  it('rejects test interactions whose channel is outside the guild', async () => {
    const { db, http } = await start()
    seedBotWithGuilds(db)
    seedApplicationCommand(db, BOT, null, 'ping')
    const res = await http('/_test/interactions', {
      method: 'POST',
      body: JSON.stringify({
        application_id: BOT,
        command_name: 'ping',
        guild_id: OTHER_GUILD,
        channel_id: CHANNEL,
      }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      message: 'Unknown Channel',
      code: 10_003,
    })
    const ok = await http('/_test/interactions', {
      method: 'POST',
      body: JSON.stringify({
        application_id: BOT,
        command_name: 'ping',
        guild_id: GUILD,
        channel_id: CHANNEL,
      }),
    })
    expect(ok.status).toBe(201)
  })

  it('delivers no further events for the guild after GUILD_DELETE', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const humanId = seedMember(db, GUILD)
    const client = await open()
    await identify(client, TOKEN, ALL_INTENTS)
    await http(`/users/@me/guilds/${GUILD}`, { method: 'DELETE' })
    expect(await nextTypes(client, 2)).toEqual([
      'GUILD_MEMBER_REMOVE',
      'GUILD_DELETE',
    ])

    const send = await http(`/channels/${CHANNEL}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'after leave' }),
    })
    expect(send.status).toBe(404)
    const injected = await http(`/_test/channels/${CHANNEL}/messages`, {
      method: 'POST',
      body: JSON.stringify({ author: { id: humanId }, content: 'human' }),
    })
    expect(injected.status).toBe(404)
    expect(
      await statusOf(http(`/guilds/${GUILD}/roles`, { method: 'POST' }))
    ).toBe(404)
    expect(await client.drain()).toEqual([])
  })

  it('filters GUILD_DELETE by the Guilds intent', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const membersOnly = await open()
    await identify(membersOnly, TOKEN, GatewayIntentBits.GuildMembers)
    const noIntents = await open()
    await identify(noIntents, TOKEN, 0)

    await http(`/users/@me/guilds/${GUILD}`, { method: 'DELETE' })

    const frames = [await membersOnly.next(), ...(await membersOnly.drain())]
    expect(frames.map(({ t }) => t)).toEqual(['GUILD_MEMBER_REMOVE'])
    expect(await noIntents.drain()).toEqual([])
  })

  it('reaches every live session of the bot but no other bot', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const otherToken = 'Bot other-bot-token'
    seedBotWithGuilds(db, otherToken, '444444444444444444', [
      '555555555555555555',
    ])
    const sessionA = await open()
    const { lastSeq: seqA } = await identify(sessionA, TOKEN, ALL_INTENTS)
    const sessionB = await open()
    const { lastSeq: seqB } = await identify(sessionB, TOKEN, ALL_INTENTS)
    const other = await open()
    await identify(other, otherToken, ALL_INTENTS)

    await http(`/guilds/${GUILD}`, { method: 'DELETE' })

    for (const [client, seq] of [
      [sessionA, seqA],
      [sessionB, seqB],
    ] as const) {
      expect(await client.next()).toMatchObject({
        t: 'GUILD_DELETE',
        s: seq + 1,
        d: { id: GUILD },
      })
    }
    expect(await other.drain()).toEqual([])

    expect(
      await idsOf(http('/users/@me/guilds', undefined, otherToken))
    ).toEqual(['555555555555555555'])
  })

  it('isolates setups sharing one bot user ID by token', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const twinToken = 'Bot twin-setup-token'
    seedBotWithGuilds(db, twinToken, BOT, ['666666666666666666'])
    const owner = await open()
    const { lastSeq } = await identify(owner, TOKEN, ALL_INTENTS)
    const twin = await open()
    await identify(twin, twinToken, ALL_INTENTS)

    await http(`/users/@me/guilds/${GUILD}`, { method: 'DELETE' })

    const removed = await owner.next()
    expect(removed).toMatchObject({ t: 'GUILD_MEMBER_REMOVE', s: lastSeq + 1 })
    const deleted = await owner.next()
    expect(deleted).toMatchObject({ t: 'GUILD_DELETE', s: lastSeq + 2 })
    expect(await twin.drain()).toEqual([])
  })

  it('rejects leaving an unknown or foreign guild with Unknown Guild', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const otherToken = 'Bot other-bot-token'
    seedBotWithGuilds(db, otherToken, '444444444444444444', [
      '555555555555555555',
    ])
    const client = await open()
    await identify(client, TOKEN, ALL_INTENTS)

    for (const guildId of ['999999999999999999', '555555555555555555']) {
      const res = await http(`/users/@me/guilds/${guildId}`, {
        method: 'DELETE',
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        message: 'Unknown Guild',
        code: 10_004,
      })
    }
    expect(
      db.prepare('SELECT id FROM guilds WHERE id = ?').get('555555555555555555')
    ).toBeDefined()
    expect(await client.drain()).toEqual([])
  })

  it('replays GUILD_DELETE with its sequence on RESUME after a disconnect', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const first = await open()
    const { ready, lastSeq } = await identify(first, TOKEN, ALL_INTENTS)
    first.ws.terminate()
    await new Promise((resolve) => setTimeout(resolve, 50))

    // The session survives the disconnect, so the events are buffered.
    await http(`/users/@me/guilds/${GUILD}`, { method: 'DELETE' })

    const resumed = await open()
    resumed.ws.send(
      JSON.stringify({
        op: GatewayOp.Resume,
        d: {
          token: TOKEN.replace(/^Bot /, ''),
          session_id: ready.session_id,
          seq: lastSeq,
        },
      })
    )
    const frames = [
      await resumed.next(),
      await resumed.next(),
      await resumed.next(),
    ]
    expect(frames.map(({ t, s }) => [t, s])).toEqual([
      ['GUILD_MEMBER_REMOVE', lastSeq + 1],
      ['GUILD_DELETE', lastSeq + 2],
      ['RESUMED', lastSeq + 3],
    ])
    expect(frames[1]?.d).toEqual({ id: GUILD })
  })

  it('delivers GUILD_DELETE before clearing gateway event controls', async () => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const client = await open()
    const { lastSeq } = await identify(client, TOKEN, ALL_INTENTS)
    const armed = await http('/_test/gateway-event-controls', {
      method: 'POST',
      body: JSON.stringify({
        guild_id: GUILD,
        bot_id: BOT,
        events: ['MESSAGE_CREATE'],
        hold: true,
        limit: 5,
        ttl_ms: 30_000,
        allow_original_sequence: false,
      }),
    })
    expect(armed.status).toBe(201)
    const { id } = (await armed.json()) as { id: string }
    const sent = await http(`/channels/${CHANNEL}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'held' }),
    })
    expect(sent.status).toBe(200)

    await http(`/users/@me/guilds/${GUILD}`, { method: 'DELETE' })

    // The held MESSAGE_CREATE consumed lastSeq + 1 and is dropped with the
    // control; the removal events still arrive in sequence.
    const frames = [await client.next(), await client.next()]
    expect(frames.map(({ t, s }) => [t, s])).toEqual([
      ['GUILD_MEMBER_REMOVE', lastSeq + 2],
      ['GUILD_DELETE', lastSeq + 3],
    ])
    expect(await statusOf(http(`/_test/gateway-event-controls/${id}`))).toBe(
      404
    )
    expect(await client.drain()).toEqual([])
  })

  it.each([
    [
      'DELETE /_test/setup/:token',
      `/_test/setup/${encodeURIComponent(TOKEN)}`,
      'DELETE',
    ],
    ['POST /_test/reset', '/_test/reset', 'POST'],
  ])('keeps %s cleanup silent', async (_name, path, method) => {
    const { db, http, open } = await start()
    seedBotWithGuilds(db)
    const client = await open()
    await identify(client, TOKEN, ALL_INTENTS)

    const res = await http(path, { method, body: '{}' })
    expect(res.ok).toBe(true)
    expect(await client.drain()).toEqual([])
  })
})
