import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { Database } from '../db'
import {
  createTestGatewayServer,
  seedBan,
  seedBot,
  seedChannel,
  seedApplicationCommand,
  seedGuild,
  seedMember,
  seedMessage,
  seedVoiceChannel,
  seedVoiceState,
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
  sessionId: string
  /** Sequence of the last frame consumed by `connect`. */
  sequence: number
  /** GUILD_CREATE payloads received while connecting. */
  guildCreates: Record<string, unknown>[]
  next: () => Promise<Frame>
  /** Returns every dispatch received before an ordered heartbeat ACK. */
  drain: () => Promise<Frame[]>
}

const BOT = '111111111111111111'
const TOKEN = 'Bot removal-fixtures'
const GUILD = '222222222222222222'
const OTHER_GUILD = '222222222222222223'
const CHANNEL = '333333333333333333'
const VOICE = '555555555555555555'
const OTHER_VOICE = '555555555555555556'
const OTHER_BOT = '444444444444444444'
const OTHER_TOKEN = 'Bot removal-fixtures-other'
const ALICE = '700000000000000001'
const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.GuildVoiceStates |
  GatewayIntentBits.GuildModeration

describe('guild fixtures survive the bot leaving, being kicked or banned', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>> | undefined
  const sockets: WebSocket[] = []
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    await server?.close()
    server = undefined
  })

  /** Boots a server with a bot, a text and voice channel and a human. */
  async function start(): Promise<Database> {
    server = await createTestGatewayServer()
    const { db } = server
    seedBot(db, TOKEN, BOT)
    seedGuild(db, TOKEN, GUILD)
    seedMember(db, GUILD, BOT)
    seedChannel(db, GUILD, CHANNEL)
    seedVoiceChannel(db, GUILD, VOICE)
    seedMember(db, GUILD, ALICE)
    return db
  }

  /** Calls the live HTTP API. */
  async function http(
    path: string,
    method = 'GET',
    body?: unknown,
    token = TOKEN
  ): Promise<Response> {
    if (!server) throw new Error('server not started')
    return fetch(server.url.replace('ws://', 'http://') + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: token },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Returns only the HTTP status of a live API call. */
  async function statusOf(
    path: string,
    method = 'GET',
    body?: unknown,
    token = TOKEN
  ): Promise<number> {
    const response = await http(path, method, body, token)
    return response.status
  }

  /** Returns the JSON body of a live API call. */
  async function jsonOf(
    path: string,
    method = 'GET',
    body?: unknown,
    token = TOKEN
  ): Promise<unknown> {
    const response = await http(path, method, body, token)
    return response.json()
  }

  /** Identifies a session and consumes READY plus its GUILD_CREATE frames. */
  async function connect(token = TOKEN): Promise<Client> {
    if (!server) throw new Error('server not started')
    const ws = new WebSocket(server.url)
    sockets.push(ws)
    const queue: Frame[] = []
    const waiters: ((frame: Frame) => void)[] = []
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Frame
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else queue.push(frame)
    })
    const next = (): Promise<Frame> =>
      new Promise((resolve) => {
        const frame = queue.shift()
        if (frame) resolve(frame)
        else waiters.push(resolve)
      })
    const hello = await next()
    expect(hello.op).toBe(GatewayOp.Hello)
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token: token.replace(/^Bot /, ''), intents: INTENTS },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    const data = ready.d as { session_id: string; guilds: unknown[] }
    let sequence = Number(ready.s)
    const guildCreates: Record<string, unknown>[] = []
    for (const stub of data.guilds as { id: string }[]) {
      const create = await next()
      expect(create.t).toBe('GUILD_CREATE')
      expect(create.d).toMatchObject({ id: stub.id })
      guildCreates.push(create.d as Record<string, unknown>)
      sequence = Number(create.s)
    }
    const drain = async (): Promise<Frame[]> => {
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      const frames: Frame[] = []
      for (;;) {
        const frame = await next()
        if (frame.op === GatewayOp.HeartbeatAck) return frames
        frames.push(frame)
      }
    }
    return {
      ws,
      sessionId: data.session_id,
      sequence,
      guildCreates,
      next,
      drain,
    }
  }

  /** Removal requests that detach the guild's own bot. */
  const REMOVALS: [string, string, string, unknown][] = [
    ['leave', `/users/@me/guilds/${GUILD}`, 'DELETE', undefined],
    ['kick', `/guilds/${GUILD}/members/${BOT}`, 'DELETE', undefined],
    ['ban', `/guilds/${GUILD}/bans/${BOT}`, 'PUT', {}],
    ['bulk ban', `/guilds/${GUILD}/bulk-ban`, 'POST', { user_ids: [BOT] }],
  ]

  it.each(REMOVALS)(
    'keeps channels, humans, voice states and messages after a %s',
    async (_name, path, method, body) => {
      const db = await start()
      seedMessage(db, CHANNEL, BOT, TOKEN)
      const aliceSession = seedVoiceState(db, GUILD, ALICE, VOICE)
      expect(await statusOf(path, method, body)).toBeLessThan(300)

      const count = (sql: string): number =>
        (db.prepare(sql).get(GUILD) as { n: number }).n
      expect(count('SELECT COUNT(*) n FROM guilds WHERE id = ?')).toBe(1)
      expect(count('SELECT COUNT(*) n FROM channels WHERE guild_id = ?')).toBe(
        2
      )
      expect(
        count(
          `SELECT COUNT(*) n FROM messages WHERE channel_id IN
             (SELECT id FROM channels WHERE guild_id = ?)`
        )
      ).toBe(1)
      expect(
        count(
          `SELECT COUNT(*) n FROM guild_members WHERE guild_id = ? AND user_id = '${ALICE}'`
        )
      ).toBe(1)
      expect(
        db
          .prepare(
            'SELECT session_id FROM guild_voice_states WHERE guild_id = ? AND user_id = ?'
          )
          .get(GUILD, ALICE)
      ).toEqual({ session_id: aliceSession })
      // The bot's own membership is gone, so the member list excludes it.
      const members = (await jsonOf(`/guilds/${GUILD}/members`)) as {
        user: { id: string }
      }[]
      expect(members.map(({ user }) => user.id)).toEqual([ALICE])
      expect(await jsonOf('/users/@me/guilds')).toEqual([])
    }
  )

  it('records the ban of a banned bot with its reason', async () => {
    const db = await start()
    await http(`/guilds/${GUILD}/bans/${BOT}?reason=spam`, 'PUT', {})
    expect(
      db
        .prepare(
          'SELECT reason FROM guild_bans WHERE guild_id = ? AND user_id = ?'
        )
        .get(GUILD, BOT)
    ).toEqual({ reason: 'spam' })
  })

  it('lets external controls manipulate human voice states after leaving', async () => {
    const db = await start()
    const client = await connect()
    expect(await statusOf(`/users/@me/guilds/${GUILD}`, 'DELETE')).toBe(204)
    const removal = await client.drain()
    expect(removal.map(({ t }) => t)).toEqual([
      'GUILD_MEMBER_REMOVE',
      'GUILD_DELETE',
    ])

    const join = await http(
      `/_test/guilds/${GUILD}/voice-states/${ALICE}`,
      'PATCH',
      { channel_id: VOICE }
    )
    expect(join.status).toBe(200)
    expect(await join.json()).toMatchObject({ channel_id: VOICE })
    expect(
      db
        .prepare('SELECT channel_id FROM guild_voice_states WHERE user_id = ?')
        .get(ALICE)
    ).toEqual({ channel_id: VOICE })
    const leave = await http(
      `/_test/guilds/${GUILD}/voice-states/${ALICE}`,
      'PATCH',
      { channel_id: null }
    )
    expect(leave.status).toBe(200)
    // Nothing for the detached guild reaches the removed bot's session.
    expect(await client.drain()).toEqual([])
  })

  it('delivers a connected bot voice disconnect before its removal events', async () => {
    const db = await start()
    seedVoiceState(db, GUILD, BOT, VOICE)
    seedVoiceState(db, GUILD, ALICE, VOICE)
    const client = await connect()
    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')

    const frames = await client.drain()
    expect(frames.map(({ t, s }) => [t, s])).toEqual([
      ['VOICE_STATE_UPDATE', client.sequence + 1],
      ['GUILD_MEMBER_REMOVE', client.sequence + 2],
      ['GUILD_DELETE', client.sequence + 3],
    ])
    expect(frames[0]?.d).toMatchObject({
      guild_id: GUILD,
      user_id: BOT,
      channel_id: null,
    })
    expect(
      db
        .prepare('SELECT user_id FROM guild_voice_states WHERE guild_id = ?')
        .all(GUILD)
    ).toEqual([{ user_id: ALICE }])
  })

  it('drops every later dispatch of the guild before sequencing', async () => {
    const db = await start()
    const client = await connect()
    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    const removal = await client.drain()
    const lastSeq = Number(removal.at(-1)?.s)

    await http(`/_test/channels/${CHANNEL}/messages`, 'POST', {
      author: { id: ALICE },
      content: 'hello',
    })
    await http(`/guilds/${GUILD}/members/${ALICE}`, 'DELETE')
    await http(`/guilds/${GUILD}/bans/${ALICE}`, 'PUT', {})
    await http(`/guilds/${GUILD}/roles`, 'POST', { name: 'late' })
    expect(await client.drain()).toEqual([])

    // The next dispatch of an attached guild continues the sequence.
    seedGuild(db, TOKEN, OTHER_GUILD)
    seedMember(db, OTHER_GUILD, BOT)
    seedChannel(db, OTHER_GUILD, '333333333333333334')
    await http('/_test/channels/333333333333333334/messages', 'POST', {
      author: { id: ALICE },
      content: 'other guild',
    })
    const other = await client.drain()
    expect(other.map(({ t, s }) => [t, s])).toEqual([
      ['MESSAGE_CREATE', lastSeq + 1],
    ])
  })

  it('omits the guild from a fresh IDENTIFY and keeps resume replay exact', async () => {
    const db = await start()
    seedGuild(db, TOKEN, OTHER_GUILD)
    seedMember(db, OTHER_GUILD, BOT)
    const first = await connect()
    first.ws.terminate()
    await new Promise((resolve) => setTimeout(resolve, 50))

    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    await http(`/_test/channels/${CHANNEL}/messages`, 'POST', {
      author: { id: ALICE },
      content: 'while away',
    })

    const resumed = await connect().catch(() => undefined)
    // A fresh IDENTIFY lists only the surviving guild.
    expect(resumed).toBeDefined()
    expect(
      (
        db.prepare('SELECT id FROM guilds WHERE bot_present = 1').all() as {
          id: string
        }[]
      ).map(({ id }) => id)
    ).toEqual([OTHER_GUILD])

    const socket = new WebSocket(server?.url ?? '')
    sockets.push(socket)
    const frames: Frame[] = []
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Frame)
    })
    await new Promise((resolve) => socket.once('open', resolve))
    socket.send(
      JSON.stringify({
        op: GatewayOp.Resume,
        d: {
          token: TOKEN.replace(/^Bot /, ''),
          session_id: first.sessionId,
          seq: first.sequence,
        },
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(
      frames.filter(({ op }) => op === GatewayOp.Dispatch).map(({ t }) => t)
    ).toEqual(['GUILD_MEMBER_REMOVE', 'GUILD_DELETE', 'RESUMED'])
  })

  it('treats repeated removal as a no-op', async () => {
    const db = await start()
    const client = await connect()
    expect(await statusOf(`/users/@me/guilds/${GUILD}`, 'DELETE')).toBe(204)
    await client.drain()

    const leave = await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    expect(leave.status).toBe(404)
    expect(await leave.json()).toEqual({
      message: 'Unknown Guild',
      code: 10_004,
    })
    const kick = await http(`/guilds/${GUILD}/members/${BOT}`, 'DELETE')
    expect(kick.status).toBe(404)
    expect((await kick.json()) as { code: number }).toMatchObject({
      code: 10_007,
    })
    expect(await statusOf(`/guilds/${GUILD}/bans/${BOT}`, 'PUT', {})).toBe(204)
    expect(
      await statusOf(`/guilds/${GUILD}/bulk-ban`, 'POST', { user_ids: [BOT] })
    ).toBe(403)
    expect(await client.drain()).toEqual([])
    expect(
      db.prepare('SELECT bot_present FROM guilds WHERE id = ?').get(GUILD)
    ).toEqual({ bot_present: 0 })
  })

  it('rejects native REST that requires the bot to be in the guild', async () => {
    await start()
    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')

    // Message creation resolves the (removed) bot's permissions.
    const send = await http(`/channels/${CHANNEL}/messages`, 'POST', {
      content: 'after leave',
    })
    expect(send.status).toBe(403)
    expect(await send.json()).toMatchObject({ code: 50_001 })
    // Routes that check guild ownership treat the removed bot as a stranger.
    expect(await statusOf(`/guilds/${GUILD}/incident-actions`, 'PUT', {})).toBe(
      403
    )
  })

  it('rejoins through setup: re-lists the guild, clears the ban and sends GUILD_CREATE', async () => {
    const db = await start()
    seedVoiceState(db, GUILD, ALICE, VOICE)
    await http(`/guilds/${GUILD}/bans/${BOT}`, 'PUT', {})

    const setup = await fetch(
      (server?.url ?? '').replace('ws://', 'http://') + '/_test/setup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: OTHER_TOKEN,
          user: { id: BOT, username: 'Rejoined' },
          guilds: [{ id: GUILD, name: 'Back' }],
        }),
      }
    )
    expect(setup.status).toBe(201)
    expect(
      db
        .prepare('SELECT bot_present, bot_token FROM guilds WHERE id = ?')
        .get(GUILD)
    ).toEqual({ bot_present: 1, bot_token: OTHER_TOKEN })
    expect(
      db
        .prepare('SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?')
        .get(GUILD, BOT)
    ).toBeUndefined()

    const client = await connect(OTHER_TOKEN)
    expect(client.guildCreates).toHaveLength(1)
    expect(client.guildCreates[0]).toMatchObject({
      id: GUILD,
      name: 'Back',
      voice_states: [{ user_id: ALICE, channel_id: VOICE }],
    })
    expect(
      (client.guildCreates[0]?.members as { user: { id: string } }[])
        .map(({ user }) => user.id)
        .toSorted((a, b) => a.localeCompare(b))
    ).toEqual([BOT, ALICE])
  })

  it('never re-exposes a rejoined guild to the setup that was removed', async () => {
    const db = await start()
    const removed = await connect()
    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    await removed.drain()

    // Another bot setup takes the surviving guild over.
    const setup = await fetch(
      (server?.url ?? '').replace('ws://', 'http://') + '/_test/setup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: OTHER_TOKEN,
          user: { id: OTHER_BOT, username: 'Successor' },
          guilds: [{ id: GUILD, name: 'Taken over' }],
        }),
      }
    )
    expect(setup.status).toBe(201)
    const successor = await connect(OTHER_TOKEN)
    expect(successor.guildCreates).toHaveLength(1)

    await http(`/_test/channels/${CHANNEL}/messages`, 'POST', {
      author: { id: ALICE },
      content: 'after takeover',
    })
    await http(`/_test/guilds/${GUILD}/voice-states/${ALICE}`, 'PATCH', {
      channel_id: VOICE,
    })
    const successorFrames = await successor.drain()
    expect(successorFrames.map(({ t }) => t)).toEqual([
      'MESSAGE_CREATE',
      'VOICE_STATE_UPDATE',
    ])
    expect(await removed.drain()).toEqual([])
    expect(
      db
        .prepare('SELECT bot_token FROM guild_bot_removals WHERE guild_id = ?')
        .all(GUILD)
    ).toEqual([{ bot_token: TOKEN }])
    // Deleting the removed setup keeps its session excluded: the sockets
    // outlive the setup.
    expect(
      await statusOf(`/_test/setup/${encodeURIComponent(TOKEN)}`, 'DELETE')
    ).toBe(204)
    await http(`/_test/channels/${CHANNEL}/messages`, 'POST', {
      author: { id: ALICE },
      content: 'after setup deletion',
    })
    const afterDeletion = await successor.drain()
    expect(afterDeletion.map(({ t }) => t)).toEqual(['MESSAGE_CREATE'])
    expect(await removed.drain()).toEqual([])
    // Channel-only interactions are scoped to the channel's guild too.
    seedApplicationCommand(db, OTHER_BOT, null, 'ping')
    const interaction = await http('/_test/interactions', 'POST', {
      application_id: OTHER_BOT,
      command_name: 'ping',
      channel_id: CHANNEL,
    })
    expect(interaction.status).toBe(201)
    expect(await removed.drain()).toEqual([])
    const interactionFrames = await successor.drain()
    expect(interactionFrames.map(({ t }) => t)).toEqual(['INTERACTION_CREATE'])
    expect(interactionFrames[0]?.d).toMatchObject({ guild_id: GUILD })
    expect(
      db.prepare('SELECT 1 FROM guilds WHERE id = ?').get(GUILD)
    ).toBeDefined()
  })

  it('still destroys everything on explicit guild deletion, silently once detached', async () => {
    const db = await start()
    seedVoiceState(db, GUILD, ALICE, VOICE)
    const client = await connect()
    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    await client.drain()

    expect(await statusOf(`/guilds/${GUILD}`, 'DELETE')).toBe(204)
    expect(await client.drain()).toEqual([])
    for (const table of [
      'guilds',
      'channels',
      'guild_members',
      'guild_voice_states',
    ]) {
      const column = table === 'guilds' ? 'id' : 'guild_id'
      expect(
        db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(GUILD)
      ).toBeUndefined()
    }
    expect(await statusOf(`/guilds/${GUILD}`, 'DELETE')).toBe(404)
  })

  it('cleans a detached guild with setup deletion and reset', async () => {
    const db = await start()
    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    const reset = await http('/_test/reset', 'POST', {})
    expect(reset.status).toBe(204)
    expect(
      db.prepare('SELECT 1 FROM guilds WHERE id = ?').get(GUILD)
    ).toBeDefined()
    expect(
      await statusOf(`/_test/setup/${encodeURIComponent(TOKEN)}`, 'DELETE')
    ).toBe(204)
    expect(
      db.prepare('SELECT 1 FROM guilds WHERE id = ?').get(GUILD)
    ).toBeUndefined()
    expect(
      db.prepare('SELECT 1 FROM channels WHERE guild_id = ?').get(GUILD)
    ).toBeUndefined()
  })

  it('cancels scoped Gateway controls and rejects new ones', async () => {
    await start()
    const client = await connect()
    const arm = (): Promise<Response> =>
      http('/_test/gateway-event-controls', 'POST', {
        guild_id: GUILD,
        bot_id: BOT,
        events: ['MESSAGE_CREATE'],
        hold: true,
        limit: 5,
        ttl_ms: 30_000,
        allow_original_sequence: false,
      })
    const armed = await arm()
    expect(armed.status).toBe(201)
    const { id } = (await armed.json()) as { id: string }

    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    await client.drain()
    expect(await statusOf(`/_test/gateway-event-controls/${id}`)).toBe(404)
    const rearmed = await arm()
    expect(rearmed.status).toBe(404)
    const outage = await http('/_test/gateway-guild-outages', 'POST', {
      guild_id: GUILD,
      bot_id: BOT,
      ttl_ms: 5000,
    })
    expect(outage.status).toBe(404)
  })

  it('does not affect other guilds or other bots', async () => {
    const db = await start()
    seedGuild(db, TOKEN, OTHER_GUILD)
    seedMember(db, OTHER_GUILD, BOT)
    seedBot(db, OTHER_TOKEN, OTHER_BOT)
    seedGuild(db, OTHER_TOKEN, '666666666666666666')
    seedMember(db, '666666666666666666', OTHER_BOT)
    const own = await connect()
    const other = await connect(OTHER_TOKEN)

    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    const ownFrames = await own.drain()
    expect(ownFrames.map(({ t }) => t)).toEqual([
      'GUILD_MEMBER_REMOVE',
      'GUILD_DELETE',
    ])
    expect(await other.drain()).toEqual([])
    expect(
      db
        .prepare('SELECT id FROM guilds WHERE bot_present = 1 ORDER BY id')
        .all()
    ).toEqual([{ id: OTHER_GUILD }, { id: '666666666666666666' }])
    expect(
      await jsonOf('/users/@me/guilds', 'GET', undefined, OTHER_TOKEN)
    ).toMatchObject([{ id: '666666666666666666' }])
  })

  it('keeps a human switching from a detached guild silent for the removed bot', async () => {
    const db = await start()
    seedGuild(db, TOKEN, OTHER_GUILD)
    seedMember(db, OTHER_GUILD, BOT)
    seedMember(db, OTHER_GUILD, ALICE)
    seedVoiceChannel(db, OTHER_GUILD, OTHER_VOICE)
    seedVoiceState(db, GUILD, ALICE, VOICE)
    const client = await connect()
    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    await client.drain()

    // Joining the attached guild displaces the detached-guild connection.
    const join = await http(
      `/_test/guilds/${OTHER_GUILD}/voice-states/${ALICE}`,
      'PATCH',
      { channel_id: OTHER_VOICE }
    )
    expect(join.status).toBe(200)
    const frames = await client.drain()
    expect(frames.map(({ t }) => t)).toEqual(['VOICE_STATE_UPDATE'])
    expect(frames[0]?.d).toMatchObject({
      guild_id: OTHER_GUILD,
      channel_id: OTHER_VOICE,
    })
    expect(
      db
        .prepare(
          'SELECT channel_id FROM guild_voice_states WHERE guild_id = ? AND user_id = ?'
        )
        .get(GUILD, ALICE)
    ).toEqual({ channel_id: null })

    // The reverse switch disconnects from the attached guild as usual.
    const back = await http(
      `/_test/guilds/${GUILD}/voice-states/${ALICE}`,
      'PATCH',
      { channel_id: VOICE }
    )
    expect(back.status).toBe(200)
    const leave = await client.drain()
    expect(leave.map(({ t }) => t)).toEqual(['VOICE_STATE_UPDATE'])
    expect(leave[0]?.d).toMatchObject({
      guild_id: OTHER_GUILD,
      channel_id: null,
    })
  })

  it('keeps a previously banned human banned and lists no stale bot ban', async () => {
    const db = await start()
    const banned = seedBan(db, GUILD)
    await http(`/users/@me/guilds/${GUILD}`, 'DELETE')
    expect(
      db.prepare('SELECT user_id FROM guild_bans WHERE guild_id = ?').all(GUILD)
    ).toEqual([{ user_id: banned }])
  })
})
