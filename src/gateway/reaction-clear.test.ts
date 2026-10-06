import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'

const TOKEN = 'Bot reaction-clear'
const BOT = '111111111111111111'
const HUMAN = '888888888888888888'
const SECOND = '999999999999999999'
const CUSTOM = 'party:123456789012345678'
const ROOT = '/_test/gateway-event-controls'
const EVENTS = ['MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI']

/** Identified socket with ordered frame reads and current sequence. */
interface Client {
  ws: WebSocket
  next: () => Promise<GatewayPayload<Record<string, unknown>>>
  seq: number
  sessionId: string
}

/** Native envelopes exposed by capture controls. */
interface Observation {
  events_captured: {
    id: string
    envelope: GatewayPayload<Record<string, unknown>>
    state: string
  }[]
}

/** Buffers dispatch bursts and bounds waits for missing frames. */
function reader(ws: WebSocket): Client['next'] {
  const frames: GatewayPayload<Record<string, unknown>>[] = []
  const waiters: ((frame: GatewayPayload<Record<string, unknown>>) => void)[] =
    []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as GatewayPayload<
      Record<string, unknown>
    >
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
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
      waiters.push((next) => {
        clearTimeout(timer)
        resolve(next)
      })
    })
}

describe('native reaction-clear REST and Gateway contract', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let channel: string
  let message: string
  const sockets: WebSocket[] = []
  const servers: Awaited<ReturnType<typeof createTestGatewayServer>>[] = []

  /** Calls native routes with auth, and capture controls without credentials. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token = TOKEN
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(!path.startsWith('/_test/') && { Authorization: token }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2000),
    })
  }

  /** Identifies without Guilds intent to avoid guild availability frames. */
  async function connect(
    token = TOKEN,
    intents = GatewayIntentBits.GuildMessageReactions,
    target = server
  ): Promise<Client> {
    const ws = new WebSocket(target.url)
    sockets.push(ws)
    const next = reader(ws)
    const hello = await next()
    expect(hello.op).toBe(10)
    ws.send(JSON.stringify({ op: 2, d: { token, intents } }))
    const ready = await next()
    expect(ready.t).toBe('READY')
    return {
      ws,
      next,
      seq: Number(ready.s),
      sessionId: String(ready.d.session_id),
    }
  }

  /** Heartbeat acknowledgement exposes unexpected or duplicate dispatches. */
  async function fence(client: Client): Promise<void> {
    client.ws.send(JSON.stringify({ op: 1, d: client.seq }))
    const ack = await client.next()
    expect(ack.op).toBe(11)
  }

  /** Seeds multiple users through the same reaction storage as REST. */
  function populate(mid = message, emojis = ['🐝', '👍', CUSTOM]): void {
    for (const user of [HUMAN, SECOND]) {
      server.db
        .prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)')
        .run(user, `Human ${user}`)
      for (const emoji of emojis) {
        server.db
          .prepare(
            'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
          )
          .run(mid, user, emoji)
      }
    }
  }

  /** Reads persisted reaction rows for precise scope assertions. */
  function rows(mid = message): unknown[] {
    return server.db
      .prepare('SELECT user_id, emoji FROM reactions WHERE message_id = ?')
      .all(mid)
  }

  /** Asserts the exact native payload, sequence and resume buffer envelope. */
  async function clearEvent(
    client: Client,
    emoji?: string,
    cid = channel,
    mid = message,
    gid: string | undefined = guild
  ): Promise<void> {
    const envelope = {
      op: 0,
      t: emoji === undefined ? EVENTS[0] : EVENTS[1],
      s: ++client.seq,
      d: {
        channel_id: cid,
        message_id: mid,
        ...(gid && { guild_id: gid }),
        ...(emoji !== undefined && {
          emoji:
            emoji === CUSTOM
              ? { id: '123456789012345678', name: 'party' }
              : { id: null, name: emoji },
        }),
      },
    }
    expect(await client.next()).toEqual(envelope)
    expect(
      server.sessionManager.get(client.sessionId)?.replayBuffer.at(-1)?.event
    ).toEqual(envelope)
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    servers.push(server)
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    channel = seedChannel(server.db, guild)
    message = seedMessage(server.db, channel, BOT, TOKEN)
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    for (const target of servers.splice(0)) await target.close()
  })

  it.each(['/api/v10', '/api', ''])(
    'clears multiple users and emoji through %s with one native event per mutation',
    async (prefix) => {
      populate()
      const sibling = seedMessage(server.db, channel, BOT, TOKEN)
      populate(sibling)
      const client = await connect()
      const secondSession = await connect(TOKEN.slice(4))
      const path = `${prefix}/channels/${channel}/messages/${message}`
      for (const emoji of ['🐝', CUSTOM, undefined]) {
        const response = await request(
          `${path}/reactions${emoji === undefined ? '' : `/${encodeURIComponent(emoji)}`}`,
          'DELETE'
        )
        expect(response.status).toBe(204)
        expect(await response.text()).toBe('')
        if (emoji === undefined) expect(rows()).toEqual([])
        else {
          expect(rows()).not.toContainEqual({ user_id: HUMAN, emoji })
          expect(rows()).not.toContainEqual({ user_id: SECOND, emoji })
          expect(rows()).toContainEqual({ user_id: HUMAN, emoji: '👍' })
        }
        await clearEvent(client, emoji)
        await clearEvent(secondSession, emoji)
        await fence(client)
        await fence(secondSession)
        expect(rows(sibling)).toHaveLength(6)
        const read = await request(path)
        expect(read.status).toBe(200)
        expect(await read.json()).toMatchObject({ id: message })
      }
      const read = await request(
        `${path}/reactions/${encodeURIComponent('👍')}`
      )
      expect(await read.json()).toEqual([])
    }
  )

  it('routes by guild setup across request tokens, aliases, intents and databases', async () => {
    const otherToken = seedBot(server.db, 'Bot other', '444444444444444444')
    const otherGuild = seedGuild(server.db, otherToken, '555555555555555555')
    const otherChannel = seedChannel(
      server.db,
      otherGuild,
      '666666666666666666'
    )
    const otherMessage = seedMessage(
      server.db,
      otherChannel,
      '444444444444444444',
      otherToken
    )
    populate()
    populate(otherMessage)
    seedBot(server.db, 'Bot alias', BOT)
    seedGuild(server.db, 'Bot alias', '777777777777777777')
    const owner = await connect()
    const other = await connect(otherToken)
    const alias = await connect('alias')
    const noIntent = await connect(TOKEN, GatewayIntentBits.GuildMessages)
    const dmIntent = await connect(
      TOKEN,
      GatewayIntentBits.DirectMessageReactions
    )
    const isolated = await createTestGatewayServer()
    servers.push(isolated)
    seedBot(isolated.db, TOKEN, BOT)
    seedGuild(isolated.db, TOKEN, guild)
    seedChannel(isolated.db, guild, channel)
    const isolatedClient = await connect(TOKEN, undefined, isolated)
    for (const emoji of ['🐝', undefined]) {
      for (const [cid, mid, gid, recipient, excluded] of [
        [channel, message, guild, owner, other],
        [otherChannel, otherMessage, otherGuild, other, owner],
      ] as const) {
        const untouched = rows(mid === message ? otherMessage : message)
        // Keep existing cross-guild REST access; delivery follows the guild owner.
        const response = await request(
          `/api/v10/channels/${cid}/messages/${mid}/reactions${emoji === undefined ? '' : `/${encodeURIComponent(emoji)}`}`,
          'DELETE'
        )
        expect(response.status).toBe(204)
        await clearEvent(recipient, emoji, cid, mid, gid)
        for (const client of [
          recipient,
          excluded,
          alias,
          noIntent,
          dmIntent,
          isolatedClient,
        ])
          await fence(client)
        expect(rows(mid === message ? otherMessage : message)).toEqual(
          untouched
        )
      }
    }
    expect(isolated.db.prepare('SELECT * FROM reactions').all()).toEqual([])
  })

  it('keeps no-ops and rejected requests silent without changing state or sequences', async () => {
    populate()
    const siblingChannel = seedChannel(server.db, guild, '333333333333333334')
    const ephemeral = seedMessage(server.db, channel, BOT, TOKEN)
    populate(ephemeral)
    server.db
      .prepare('UPDATE messages SET flags = 64 WHERE id = ?')
      .run(ephemeral)
    const client = await connect()
    const original = rows()
    const ephemeralRows = rows(ephemeral)
    for (const emoji of [undefined, '🐝']) {
      const suffix = emoji === undefined ? '' : `/${encodeURIComponent(emoji)}`
      for (const [cid, mid, token, status] of [
        [channel, message, '', 401],
        [channel, message, 'Bot unregistered', 401],
        [channel, 'unknown', TOKEN, 404],
        ['unknown', message, TOKEN, 404],
        [siblingChannel, message, TOKEN, 404],
        [channel, ephemeral, TOKEN, 404],
      ] as const) {
        const response = await request(
          `/channels/${cid}/messages/${mid}/reactions${suffix}`,
          'DELETE',
          undefined,
          token
        )
        expect(response.status).toBe(status)
        expect(rows()).toEqual(original)
        expect(rows(ephemeral)).toEqual(ephemeralRows)
        await fence(client)
      }
    }
    for (const [suffix, status] of [
      ['/%E0%A4%A', 400],
      ['/absent', 204],
    ] as const) {
      const response = await request(
        `/channels/${channel}/messages/${message}/reactions${suffix}`,
        'DELETE'
      )
      expect(response.status).toBe(status)
      expect(rows()).toEqual(original)
      await fence(client)
    }
    for (const emoji of ['🐝', undefined]) {
      const path = `/channels/${channel}/messages/${message}/reactions${emoji === undefined ? '' : `/${encodeURIComponent(emoji)}`}`
      const deleted = await request(path, 'DELETE')
      expect(deleted.status).toBe(204)
      await clearEvent(client, emoji)
      const repeated = await request(path, 'DELETE')
      expect(repeated.status).toBe(204)
      await fence(client)
    }
    expect(server.sessionManager.get(client.sessionId)?.seq).toBe(client.seq)
  })

  it.each([undefined, CUSTOM])(
    'captures, holds and replays native clear %s after source deletion',
    async (emoji) => {
      populate()
      const client = await connect()
      const otherGuild = seedGuild(server.db, TOKEN, '222222222222222223')
      const otherChannel = seedChannel(
        server.db,
        otherGuild,
        '333333333333333334'
      )
      const otherMessage = seedMessage(server.db, otherChannel, BOT, TOKEN)
      populate(otherMessage)
      const arm = await request(ROOT, 'POST', {
        guild_id: guild,
        bot_id: BOT,
        session_id: client.sessionId,
        events: EVENTS,
        hold: true,
        allow_original_sequence: true,
      })
      expect(arm.status).toBe(201)
      const id = ((await arm.json()) as { id: string }).id
      const otherClear = await request(
        `/channels/${otherChannel}/messages/${otherMessage}/reactions`,
        'DELETE'
      )
      expect(otherClear.status).toBe(204)
      await clearEvent(
        client,
        undefined,
        otherChannel,
        otherMessage,
        otherGuild
      )
      const path = `/channels/${channel}/messages/${message}`
      const clear = await request(
        `${path}/reactions${emoji === undefined ? '' : `/${encodeURIComponent(emoji)}`}`,
        'DELETE'
      )
      expect(clear.status).toBe(204)
      const observed = await request(`${ROOT}/${id}`)
      const snapshot = (await observed.json()) as Observation
      expect(snapshot.events_captured).toHaveLength(1)
      const event = snapshot.events_captured[0]
      expect(event.state).toBe('held')
      expect(rows()).toHaveLength(emoji === undefined ? 0 : 4)
      if (emoji !== undefined) {
        expect(rows()).not.toContainEqual({ user_id: HUMAN, emoji })
        expect(rows()).not.toContainEqual({ user_id: SECOND, emoji })
      }
      expect(event.envelope).toEqual({
        op: 0,
        t: emoji === undefined ? EVENTS[0] : EVENTS[1],
        s: ++client.seq,
        d: {
          guild_id: guild,
          channel_id: channel,
          message_id: message,
          ...(emoji !== undefined && {
            emoji: { id: '123456789012345678', name: 'party' },
          }),
        },
      })
      expect(
        server.sessionManager.get(client.sessionId)?.replayBuffer.at(-1)?.event
          .s
      ).toBe(client.seq - 1)
      await fence(client)
      const deleted = await request(path, 'DELETE')
      expect(deleted.status).toBe(204)
      const read = await request(path)
      expect(read.status).toBe(404)
      for (const [operation, sequence] of [
        ['release', 'new'],
        ['replay', 'original'],
        ['replay', 'new'],
      ]) {
        const delivery = await request(`${ROOT}/${id}/${operation}`, 'POST', {
          event_ids: [event.id],
          sequence,
        })
        expect(delivery.status).toBe(200)
        expect(await client.next()).toEqual({
          ...event.envelope,
          s: sequence === 'original' ? event.envelope.s : ++client.seq,
        })
        expect(rows()).toEqual([])
        const missing = await request(path)
        expect(missing.status).toBe(404)
      }
      await fence(client)
    }
  )

  it('omits guild_id and uses Direct Message Reactions for DM clears', async () => {
    server.db
      .prepare('UPDATE channels SET guild_id = NULL, type = 1 WHERE id = ?')
      .run(channel)
    populate()
    const dm = await connect(TOKEN, GatewayIntentBits.DirectMessageReactions)
    const guildOnly = await connect()
    for (const emoji of ['🐝', undefined]) {
      const response = await request(
        `/channels/${channel}/messages/${message}/reactions${emoji === undefined ? '' : `/${encodeURIComponent(emoji)}`}`,
        'DELETE'
      )
      expect(response.status).toBe(204)
      // Empty guild sentinel prevents the helper's guild default.
      await clearEvent(dm, emoji, channel, message, '')
      await fence(dm)
      await fence(guildOnly)
    }
  })
})
