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
import { getGuildMember } from '../services/guild-members'
import type { GatewayPayload } from './protocol'

const TOKEN = 'Bot human-reactions'
const BOT = '111111111111111111'
const HUMAN = '888888888888888888'
const SECOND = '999999999999999999'
const OTHER_TOKEN = 'Bot other-reactions'
const OTHER_BOT = '444444444444444444'
const ROOT = '/_test/gateway-event-controls'

/** Connected client with an ordered, bounded reader and current sequence. */
interface Client {
  ws: WebSocket
  next: () => Promise<GatewayPayload<Record<string, unknown>>>
  seq: number
  sessionId: string
}

/** Public snapshot of a captured event used for release and replay. */
interface Observation {
  events_captured: {
    id: string
    envelope: GatewayPayload<Record<string, unknown>>
    state: string
    last_sequence: number | null
  }[]
}

/** Buffers bursts and limits every read so a missing dispatch fails promptly. */
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

describe('human reactions over real HTTP and WebSocket connections', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let channel: string
  let message: string
  let otherGuild: string
  let otherChannel: string
  let otherMessage: string
  let client: Client
  const sockets: WebSocket[] = []
  const servers: Awaited<ReturnType<typeof createTestGatewayServer>>[] = []

  /** Calls controls without credentials, and native routes as the given bot. */
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

  /** Establishes one identified session, with no Guilds availability frames. */
  async function connect(
    token = TOKEN,
    intents = GatewayIntentBits.GuildMessageReactions |
      GatewayIntentBits.GuildMessages,
    target = server
  ): Promise<Client> {
    const ws = new WebSocket(target.url)
    sockets.push(ws)
    const next = reader(ws)
    const result1 = await next()
    expect(result1.op).toBe(10)
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

  /** Ordered heartbeat ACK proves no unconsumed event was dispatched. */
  async function fence(target = client): Promise<void> {
    target.ws.send(JSON.stringify({ op: 1, d: target.seq }))
    const result2 = await target.next()
    expect(result2.op).toBe(11)
  }

  /** Produces a persisted human reaction, never a caller-supplied event frame. */
  async function react(
    user = HUMAN,
    emoji = '🐝',
    cid = channel,
    mid = message
  ): Promise<Response> {
    return request(`/_test/channels/${cid}/messages/${mid}/reactions`, 'POST', {
      user_id: user,
      emoji,
    })
  }

  /** Asserts the complete native payload and monotonic session sequence. */
  async function addition(
    target = client,
    user = HUMAN,
    emoji = '🐝',
    cid = channel,
    mid = message,
    gid = guild
  ): Promise<GatewayPayload<Record<string, unknown>>> {
    const frame = await target.next()
    expect(frame).toEqual({
      op: 0,
      t: 'MESSAGE_REACTION_ADD',
      s: ++target.seq,
      d: {
        user_id: user,
        channel_id: cid,
        message_id: mid,
        guild_id: gid,
        emoji: { id: null, name: emoji },
        member: getGuildMember(server.db, gid, user),
        message_author_id: gid === guild ? BOT : OTHER_BOT,
        burst: false,
        type: 0,
        burst_colors: [],
      },
    })
    return frame
  }

  /** Arms a human-reaction capture against exactly one owner session. */
  async function arm(target = client, gid = guild, bot = BOT): Promise<string> {
    const result = await request(ROOT, 'POST', {
      guild_id: gid,
      bot_id: bot,
      session_id: target.sessionId,
      events: ['MESSAGE_REACTION_ADD'],
      hold: true,
      allow_original_sequence: true,
    })
    expect(result.status).toBe(201)
    return ((await result.json()) as { id: string }).id
  }

  /** Reads the actual captured native envelope. */
  async function observe(id: string): Promise<Observation> {
    const result = await request(`${ROOT}/${id}`)
    expect(result.status).toBe(200)
    return (await result.json()) as Observation
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    servers.push(server)
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    channel = seedChannel(server.db, guild)
    message = seedMessage(server.db, channel, BOT, TOKEN)
    seedBot(server.db, OTHER_TOKEN, OTHER_BOT)
    otherGuild = seedGuild(server.db, OTHER_TOKEN, '555555555555555555')
    otherChannel = seedChannel(server.db, otherGuild, '666666666666666666')
    otherMessage = seedMessage(server.db, otherChannel, OTHER_BOT, OTHER_TOKEN)
    for (const user of [HUMAN, SECOND]) {
      const result3 = await request('/_test/users', 'POST', {
        id: user,
        username: `Human ${user}`,
        global_name: 'Real Human',
        avatar: 'a_human',
      })
      expect(result3.status).toBe(201)
      const result4 = await request(
        `/_test/guilds/${guild}/members/${user}`,
        'POST',
        {
          nick: 'Human Nick',
        }
      )
      expect(result4.status).toBe(201)
    }
    const result5 = await request(
      `/_test/guilds/${otherGuild}/members/${SECOND}`,
      'POST',
      {
        nick: 'Other Nick',
      }
    )
    expect(result5.status).toBe(201)
    client = await connect()
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    for (const target of servers.splice(0)) await target.close()
  })

  it('delivers multiple humans/emoji only to owning sessions across guilds, aliases, intents and databases', async () => {
    const sibling = await connect(TOKEN.slice(4))
    const withoutIntent = await connect(TOKEN, GatewayIntentBits.GuildMessages)
    const other = await connect(OTHER_TOKEN)
    seedBot(server.db, 'Bot alias', BOT)
    seedGuild(server.db, 'Bot alias', '777777777777777777')
    const alias = await connect('alias')
    const isolated = await createTestGatewayServer()
    servers.push(isolated)
    seedBot(isolated.db, TOKEN, BOT)
    seedGuild(isolated.db, TOKEN, guild)
    const isolatedClient = await connect(
      TOKEN,
      GatewayIntentBits.GuildMessageReactions,
      isolated
    )
    for (const [user, emoji] of [
      [HUMAN, '🐝'],
      [SECOND, '🐝'],
      [HUMAN, '👍'],
    ]) {
      const result6 = await react(user, emoji)
      expect(result6.status).toBe(204)
      await addition(client, user, emoji)
      await addition(sibling, user, emoji)
      const result7 = await react(user, emoji)
      expect(result7.status).toBe(204)
      await fence(client)
      await fence(sibling)
      for (const target of [withoutIntent, other, alias, isolatedClient])
        await fence(target)
    }
    const read = await request(
      `/api/v10/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('🐝')}?limit=100`
    )
    expect((await read.json()) as unknown[]).toEqual([
      expect.objectContaining({
        id: HUMAN,
        bot: false,
        avatar: 'a_human',
        global_name: 'Real Human',
      }),
      expect.objectContaining({ id: SECOND, bot: false }),
    ])
    const snapshot = await request(
      `/api/v10/channels/${channel}/messages/${message}`
    )
    expect(await snapshot.json()).toMatchObject({
      reactions: [
        {
          count: 2,
          count_details: { normal: 2, burst: 0 },
          emoji: { name: '🐝', id: null },
        },
        { count: 1, emoji: { name: '👍', id: null } },
      ],
    })
    const result8 = await react(SECOND, '❤️', otherChannel, otherMessage)
    expect(result8.status).toBe(204)
    await addition(other, SECOND, '❤️', otherChannel, otherMessage, otherGuild)
    await fence(client)
    await fence(sibling)
    expect(isolated.db.prepare('SELECT * FROM reactions').all()).toEqual([])
  })

  it('rejects wrong actors and scopes over HTTP without writes, events or sequence changes', async () => {
    const other = await connect(OTHER_TOKEN)
    for (const [user, emoji, cid, mid, status] of [
      ['unknown', '🐝', channel, message, 404],
      [BOT, '🐝', channel, message, 400],
      [HUMAN, '🐝', otherChannel, otherMessage, 404],
      [HUMAN, 'not emoji', channel, message, 400],
      [HUMAN, '🐝', otherChannel, message, 404],
      [HUMAN, '🐝', 'unknown', message, 404],
      [HUMAN, '🐝', channel, 'unknown', 404],
    ] as const) {
      const result9 = await react(user, emoji, cid, mid)
      expect(result9.status).toBe(status)
    }
    server.db
      .prepare('UPDATE channels SET guild_id = NULL, type = 1 WHERE id = ?')
      .run(channel)
    const result10 = await react()
    expect(result10.status).toBe(400)
    server.db
      .prepare('UPDATE channels SET guild_id = ?, type = 4 WHERE id = ?')
      .run(guild, channel)
    const result11 = await react()
    expect(result11.status).toBe(400)
    expect(server.db.prepare('SELECT * FROM reactions').all()).toEqual([])
    await fence(client)
    await fence(other)
    expect(server.sessionManager.get(client.sessionId)?.seq).toBe(client.seq)
    expect(server.sessionManager.get(other.sessionId)?.seq).toBe(other.seq)
  })

  it('holds and replays the complete human snapshot after warming REST state and deleting its message', async () => {
    const id = await arm()
    const result12 = await react()
    expect(result12.status).toBe(204)
    const captured = await observe(id)
    expect(captured.events_captured).toHaveLength(1)
    const event = captured.events_captured[0]
    expect(event.state).toBe('held')
    const payload = event.envelope.d
    expect(payload).toMatchObject({
      user_id: HUMAN,
      member: {
        nick: 'Human Nick',
        user: { id: HUMAN, bot: false, avatar: 'a_human' },
      },
    })
    expect(event.envelope.s).toBe(client.seq + 1)
    const result13 = await react()
    expect(result13.status).toBe(204)
    const result14 = await observe(id)
    expect(result14.events_captured).toHaveLength(1)
    await fence()
    const warm = await request(
      `/api/v10/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('🐝')}?limit=100`
    )
    expect(await warm.json()).toEqual([
      expect.objectContaining({ id: HUMAN, bot: false }),
    ])
    const warmMessage = await request(
      `/api/v10/channels/${channel}/messages/${message}`
    )
    expect(await warmMessage.json()).toMatchObject({
      reactions: [{ count: 1 }],
    })
    const result15 = await request(
      `/api/v10/channels/${channel}/messages/${message}`,
      'DELETE'
    )
    expect(result15.status).toBe(204)
    const deleted = await client.next()
    expect(deleted).toMatchObject({
      t: 'MESSAGE_DELETE',
      s: Number(event.envelope.s) + 1,
      d: { id: message, guild_id: guild, channel_id: channel },
    })
    client.seq = Number(deleted.s)
    const result16 = await request(
      `/api/v10/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('🐝')}`
    )
    expect(result16.status).toBe(404)
    expect(server.db.prepare('SELECT * FROM reactions').all()).toEqual([])
    const result17 = await react()
    expect(result17.status).toBe(404)
    server.db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(HUMAN)
    server.db
      .prepare('UPDATE guild_members SET nick = ? WHERE user_id = ?')
      .run('Changed Nick', HUMAN)
    const body = { event_ids: [event.id] }
    const result18 = await request(`${ROOT}/${id}/release`, 'POST', body)
    expect(result18.status).toBe(200)
    const released = await client.next()
    expect(released).toEqual({ ...event.envelope, s: ++client.seq })
    const result19 = await request(`${ROOT}/${id}/replay`, 'POST', {
      ...body,
      sequence: 'original',
    })
    expect(result19.status).toBe(200)
    expect(await client.next()).toEqual(event.envelope)
    const result20 = await request(`${ROOT}/${id}/replay`, 'POST', body)
    expect(result20.status).toBe(200)
    expect(await client.next()).toEqual({ ...event.envelope, s: ++client.seq })
    const result21 = await observe(id)
    expect(result21.events_captured[0].envelope.d).toEqual(payload)
    expect(server.db.prepare('SELECT * FROM reactions').all()).toEqual([])
    await fence()
  })

  it.each([
    'token reset',
    'full reset',
    'setup deletion',
    'channel deletion',
    'guild deletion',
  ])(
    'applies the existing reaction and capture lifecycle on %s',
    async (lifecycle) => {
      const other = await connect(OTHER_TOKEN)
      const id = await arm()
      const otherId = await arm(other, otherGuild, OTHER_BOT)
      const result22 = await react()
      expect(result22.status).toBe(204)
      const result23 = await react(SECOND, '🐝', otherChannel, otherMessage)
      expect(result23.status).toBe(204)
      const result24 = await observe(id)
      expect(result24.events_captured).toHaveLength(1)
      switch (lifecycle) {
        case 'token reset': {
          const result25 = await request('/_test/reset', 'POST', {
            token: TOKEN,
          })
          expect(result25.status).toBe(204)
          break
        }
        case 'full reset': {
          const result26 = await request('/_test/reset', 'POST', {})
          expect(result26.status).toBe(204)
          break
        }
        case 'setup deletion': {
          const result27 = await request(
            `/_test/setup/${encodeURIComponent(TOKEN)}`,
            'DELETE'
          )
          expect(result27.status).toBe(204)
          break
        }
        case 'channel deletion': {
          const result28 = await request(
            `/api/v10/channels/${channel}`,
            'DELETE'
          )
          expect(result28.status).toBe(200)
          break
        }
        case 'guild deletion': {
          const result29 = await request(`/api/v10/guilds/${guild}`, 'DELETE')
          expect(result29.status).toBe(204)
          break
        }
      }
      expect(
        server.db
          .prepare('SELECT * FROM reactions WHERE message_id = ?')
          .all(message)
      ).toEqual([])
      const result30 = await request(`${ROOT}/${id}`)
      expect(result30.status).toBe(lifecycle === 'channel deletion' ? 200 : 404)
      const remaining = server.db
        .prepare('SELECT * FROM reactions WHERE message_id = ?')
        .all(otherMessage)
      expect(remaining).toHaveLength(lifecycle === 'full reset' ? 0 : 1)
      const result31 = await request(`${ROOT}/${otherId}`)
      expect(result31.status).toBe(lifecycle === 'full reset' ? 404 : 200)
      expect(
        server.db.prepare('SELECT bot FROM users WHERE id = ?').get(HUMAN)
      ).toEqual({ bot: 0 })
      await fence(client)
      await fence(other)
    }
  )

  it('retains human-message reactions on token reset and removes them on full reset', async () => {
    const injected = await request(
      `/_test/channels/${channel}/messages`,
      'POST',
      { content: 'Human source', author: { id: SECOND } }
    )
    expect(injected.status).toBe(201)
    const humanMessage = ((await injected.json()) as { id: string }).id
    const result32 = await client.next()
    expect(result32.t).toBe('MESSAGE_CREATE')
    const result33 = await react(HUMAN, '🐝', channel, humanMessage)
    expect(result33.status).toBe(204)
    const result34 = await client.next()
    expect(result34.d).toMatchObject({
      message_author_id: SECOND,
      user_id: HUMAN,
    })
    const result35 = await request('/_test/reset', 'POST', { token: TOKEN })
    expect(result35.status).toBe(204)
    expect(
      server.db
        .prepare('SELECT user_id FROM reactions WHERE message_id = ?')
        .all(humanMessage)
    ).toEqual([{ user_id: HUMAN }])
    const result36 = await request('/_test/reset', 'POST', {})
    expect(result36.status).toBe(204)
    expect(server.db.prepare('SELECT * FROM reactions').all()).toEqual([])
    await fence()
  })
})
