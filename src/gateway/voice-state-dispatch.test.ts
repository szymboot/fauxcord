import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedVoiceChannel,
} from '../test-helpers'
import { getGuildVoiceState } from '../services/guild-advanced'
import { getGuildMember } from '../services/guild-members'
import { GatewayOp } from './opcodes'

/** Connected client with a queue that preserves back-to-back frames. */
interface Client {
  ws: WebSocket
  next: () => Promise<Record<string, unknown>>
  sequence: number
  sessionId: string
  guilds: Record<string, unknown>[]
}

/** Queues incoming frames before tests start awaiting dispatches. */
function createReader(ws: WebSocket): Client['next'] {
  const queue: Record<string, unknown>[] = []
  const waiters: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  return () =>
    new Promise((resolve) => {
      const frame = queue.shift()
      if (frame) resolve(frame)
      else waiters.push(resolve)
    })
}

/** Identifies and drains READY and any initial guild availability events. */
async function connect(
  url: string,
  token: string,
  intents: number,
  guildIds: string[],
  sockets: WebSocket[]
): Promise<Client> {
  const ws = new WebSocket(url)
  sockets.push(ws)
  const next = createReader(ws)
  const hello = await next()
  expect(hello.op).toBe(GatewayOp.Hello)
  ws.send(JSON.stringify({ op: GatewayOp.Identify, d: { token, intents } }))
  const ready = await next()
  expect(ready.t).toBe('READY')
  let sequence = Number(ready.s)
  const guilds: Record<string, unknown>[] = []
  if (intents & GatewayIntentBits.Guilds) {
    for (const id of guildIds) {
      const guild = await next()
      expect(guild).toMatchObject({ t: 'GUILD_CREATE', d: { id } })
      guilds.push(guild)
      sequence = Number(guild.s)
    }
  }
  return {
    ws,
    next,
    sequence,
    sessionId: (ready.d as { session_id: string }).session_id,
    guilds,
  }
}

/** Checks absence using an ordered heartbeat ACK, without timeout races. */
async function expectSilent(client: Client): Promise<void> {
  client.ws.send(
    JSON.stringify({ op: GatewayOp.Heartbeat, d: client.sequence })
  )
  expect(await client.next()).toMatchObject({ op: GatewayOp.HeartbeatAck })
}

/** Writes the typed fixture through HTTP, exercising the real service path. */
async function patchVoice(
  url: string,
  guildId: string,
  userId: string,
  payload: Record<string, unknown>
): Promise<Response> {
  return fetch(
    `${url.replace('ws://', 'http://')}/_test/guilds/${guildId}/voice-states/${userId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  )
}

/** Asserts an HTTP status without reading directly from an await expression. */
async function expectStatus(
  pending: Promise<Response>,
  status: number
): Promise<void> {
  const response = await pending
  expect(response.status).toBe(status)
}

describe('native VOICE_STATE_UPDATE delivery', () => {
  const sockets: WebSocket[] = []
  const servers: Awaited<ReturnType<typeof createTestGatewayServer>>[] = []

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    for (const server of servers.splice(0)) await server.close()
  })

  it('combines prepared startup history, live updates and fresh IDENTIFY snapshots', async () => {
    const server = await createTestGatewayServer()
    servers.push(server)
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const userId = seedMember(server.db, guildId)
    const channelId = seedVoiceChannel(server.db, guildId)
    const intents =
      GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates
    await expectStatus(
      patchVoice(server.url, guildId, userId, {
        channel_id: channelId,
        self_stream: true,
        emit: false,
      }),
      200
    )
    const initial = getGuildVoiceState(server.db, guildId, userId)
    const first = await connect(server.url, token, intents, [guildId], sockets)
    expect(first.guilds[0]?.d).toMatchObject({
      id: guildId,
      voice_states: [
        {
          channel_id: channelId,
          user_id: userId,
          session_id: initial?.session_id,
          self_stream: true,
        },
      ],
      members: expect.arrayContaining([
        getGuildMember(server.db, guildId, userId),
      ]),
    })
    const history = (
      first.guilds[0]?.d as { voice_states: Record<string, unknown>[] }
    ).voice_states
    expect(history[0]).not.toHaveProperty('guild_id')
    await expectSilent(first)

    await expectStatus(
      patchVoice(server.url, guildId, userId, { self_stream: false }),
      200
    )
    const stopped = getGuildVoiceState(server.db, guildId, userId)
    expect(stopped).toMatchObject({
      session_id: initial?.session_id,
      self_stream: false,
    })
    expect(await first.next()).toMatchObject({
      t: 'VOICE_STATE_UPDATE',
      s: ++first.sequence,
      d: { ...stopped, member: getGuildMember(server.db, guildId, userId) },
    })
    const second = await connect(server.url, token, intents, [guildId], sockets)
    expect(second.guilds[0]?.d).toMatchObject({
      id: guildId,
      voice_states: [
        {
          user_id: userId,
          session_id: initial?.session_id,
          self_stream: false,
        },
      ],
    })
    await expectSilent(first)

    await expectStatus(
      patchVoice(server.url, guildId, userId, { channel_id: null }),
      200
    )
    for (const client of [first, second]) {
      expect(await client.next()).toMatchObject({
        t: 'VOICE_STATE_UPDATE',
        s: ++client.sequence,
        d: {
          guild_id: guildId,
          user_id: userId,
          channel_id: null,
          session_id: initial?.session_id,
        },
      })
    }
    const third = await connect(server.url, token, intents, [guildId], sockets)
    expect(third.guilds[0]?.d).toMatchObject({ id: guildId, voice_states: [] })
    for (const client of [first, second, third]) await expectSilent(client)
  })

  it('delivers committed join, stream start/stop, flags, move and disconnect to every eligible session', async () => {
    const server = await createTestGatewayServer()
    servers.push(server)
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const userId = seedMember(server.db, guildId)
    server.db
      .prepare('UPDATE users SET avatar = ?, global_name = ? WHERE id = ?')
      .run('0123456789abcdef0123456789abcdef', 'Human display', userId)
    server.db
      .prepare(
        'UPDATE guild_members SET nick = ? WHERE guild_id = ? AND user_id = ?'
      )
      .run('Human nick', guildId, userId)
    const channelId = seedVoiceChannel(server.db, guildId)
    const movedId = seedVoiceChannel(server.db, guildId, '555555555555555556')
    const clients = [
      await connect(
        server.url,
        token,
        GatewayIntentBits.GuildVoiceStates,
        [],
        sockets
      ),
      await connect(
        server.url,
        token.slice(4),
        GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates,
        [guildId],
        sockets
      ),
    ]
    let voiceSession: string | undefined
    for (const payload of [
      { channel_id: channelId },
      { self_stream: true },
      { self_stream: false },
      { request_to_speak_timestamp: '2026-10-01T12:00:00.000Z' },
      {
        self_mute: true,
        self_deaf: true,
        self_video: true,
        mute: true,
        deaf: true,
        suppress: true,
      },
      { channel_id: movedId },
      { self_mute: false, self_deaf: false, self_video: false },
      { channel_id: null },
    ]) {
      const response = await patchVoice(server.url, guildId, userId, payload)
      expect(response.status).toBe(200)
      const state = (await response.json()) as Record<string, unknown>
      voiceSession ??= state.session_id as string
      expect(state.session_id).toBe(voiceSession)
      expect(state).toMatchObject({
        guild_id: guildId,
        user_id: userId,
        ...payload,
        ...(payload.request_to_speak_timestamp && {
          request_to_speak_timestamp: '2026-10-01T12:00:00.000000+00:00',
        }),
      })
      expect(getGuildVoiceState(server.db, guildId, userId)).toMatchObject(
        state
      )
      for (const client of clients) {
        const frame = await client.next()
        expect(frame).toEqual({
          op: GatewayOp.Dispatch,
          t: 'VOICE_STATE_UPDATE',
          s: ++client.sequence,
          d: { ...state, member: getGuildMember(server.db, guildId, userId) },
        })
        expect(frame.d).not.toHaveProperty('BeforeUpdate')
        expect(frame.d).not.toHaveProperty('before_update')
        expect(frame.d).toMatchObject({
          member: {
            nick: 'Human nick',
            user: {
              id: userId,
              bot: false,
              global_name: 'Human display',
              avatar: '0123456789abcdef0123456789abcdef',
            },
          },
        })
        expect(
          server.sessionManager.get(client.sessionId)?.replayBuffer.at(-1)
            ?.event
        ).toEqual(frame)
      }
    }
    for (const client of clients) await expectSilent(client)
  })

  it.each(['/api/v10', '/api', ''])(
    'publishes validated stage mutations for @me and members under %s',
    async (prefix) => {
      const server = await createTestGatewayServer()
      servers.push(server)
      const token = seedBot(server.db)
      const guildId = seedGuild(server.db, token)
      const botId = seedMember(server.db, guildId, '111111111111111111')
      const humanId = seedMember(server.db, guildId)
      const channelId = seedVoiceChannel(server.db, guildId)
      server.db
        .prepare('UPDATE channels SET type = 13 WHERE id = ?')
        .run(channelId)
      const client = await connect(
        server.url,
        token,
        GatewayIntentBits.GuildVoiceStates,
        [],
        sockets
      )
      const foreignToken = seedBot(
        server.db,
        'Bot stage-foreign',
        '111111111111111112'
      )
      for (const [subject, userId] of [
        ['@me', botId],
        [humanId, humanId],
      ]) {
        await expectStatus(
          patchVoice(server.url, guildId, userId, {
            channel_id: channelId,
            self_stream: true,
            emit: false,
          }),
          200
        )
        const initial = getGuildVoiceState(server.db, guildId, userId)
        const url = `${server.url.replace('ws://', 'http://')}${prefix}/guilds/${guildId}/voice-states/${subject}`
        const response = await fetch(url, {
          method: 'PATCH',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_id: channelId, suppress: true }),
        })
        expect(response.status).toBe(204)
        const current = getGuildVoiceState(server.db, guildId, userId)
        expect(current).toMatchObject({
          ...initial,
          suppress: true,
          self_stream: true,
        })
        expect(await client.next()).toEqual({
          op: GatewayOp.Dispatch,
          t: 'VOICE_STATE_UPDATE',
          s: ++client.sequence,
          d: { ...current, member: getGuildMember(server.db, guildId, userId) },
        })
        for (const [payload, auth, status] of [
          [{ suppress: true }, token, 204],
          [{ self_stream: false }, token, 400],
          [{ suppress: 'true' }, token, 400],
          [{ request_to_speak_timestamp: 'invalid' }, token, 400],
          [{ channel_id: '999999999999999999' }, token, 404],
          [{ suppress: false }, '', 401],
          [{ suppress: false }, foreignToken, 403],
        ] as const) {
          const rejected = await fetch(url, {
            method: 'PATCH',
            headers: {
              Authorization: auth,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          })
          expect(rejected.status).toBe(status)
          expect(getGuildVoiceState(server.db, guildId, userId)).toEqual(
            current
          )
          await expectSilent(client)
        }
        const malformed = await fetch(url, {
          method: 'PATCH',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: '{',
        })
        expect(malformed.status).toBe(400)
        await expectSilent(client)
      }
    }
  )

  it('isolates intent, registered bot, token aliases, and database even when IDs match', async () => {
    const server = await createTestGatewayServer()
    const other = await createTestGatewayServer()
    servers.push(server, other)
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const userId = seedMember(server.db, guildId)
    const channelId = seedVoiceChannel(server.db, guildId)
    const foreignToken = seedBot(server.db, 'Bot foreign', '111111111111111112')
    const foreignGuild = seedGuild(
      server.db,
      foreignToken,
      '222222222222222223'
    )
    const aliasToken = seedBot(server.db, 'Bot alias')
    const aliasGuild = seedGuild(server.db, aliasToken, '222222222222222224')
    seedGuild(other.db, seedBot(other.db), guildId)
    const owner = await connect(
      server.url,
      token,
      GatewayIntentBits.GuildVoiceStates,
      [],
      sockets
    )
    const excluded = [
      await connect(
        server.url,
        token,
        GatewayIntentBits.Guilds,
        [guildId],
        sockets
      ),
      await connect(
        server.url,
        foreignToken,
        GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates,
        [foreignGuild],
        sockets
      ),
      await connect(
        server.url,
        aliasToken,
        GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates,
        [aliasGuild],
        sockets
      ),
      await connect(
        other.url,
        token,
        GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates,
        [guildId],
        sockets
      ),
    ]
    await expectStatus(
      patchVoice(server.url, guildId, userId, {
        channel_id: channelId,
        self_stream: true,
      }),
      200
    )
    expect(await owner.next()).toMatchObject({
      t: 'VOICE_STATE_UPDATE',
      s: ++owner.sequence,
      d: { guild_id: guildId, user_id: userId, self_stream: true },
    })
    for (const client of excluded) {
      await expectSilent(client)
      expect(
        server.sessionManager.get(client.sessionId)?.seq ??
          other.sessionManager.get(client.sessionId)?.seq
      ).toBe(client.sequence)
    }
  })

  it('emits nothing for rejected writes, no-op patches, repeated disconnects and historical fixtures', async () => {
    const server = await createTestGatewayServer()
    servers.push(server)
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const userId = seedMember(server.db, guildId)
    const channelId = seedVoiceChannel(server.db, guildId)
    const textId = seedChannel(server.db, guildId)
    const foreignGuild = seedGuild(server.db, token, '222222222222222223')
    const foreignChannel = seedVoiceChannel(
      server.db,
      foreignGuild,
      '555555555555555556'
    )
    const client = await connect(
      server.url,
      token,
      GatewayIntentBits.GuildVoiceStates,
      [],
      sockets
    )
    await expectStatus(
      patchVoice(server.url, guildId, userId, { channel_id: null }),
      200
    )
    await expectSilent(client)
    await expectStatus(
      patchVoice(server.url, guildId, userId, {
        channel_id: channelId,
        emit: false,
      }),
      200
    )
    const original = getGuildVoiceState(server.db, guildId, userId)
    for (const [payload, status] of [
      [{}, 200],
      [{ channel_id: channelId }, 200],
      [{ self_stream: false }, 200],
      [{ self_stream: 'true' }, 400],
      [{ channel_id: textId }, 400],
      [{ channel_id: foreignChannel }, 404],
      [{ channel_id: '999999999999999999' }, 404],
      [{ emit: 'false' }, 400],
    ] as const) {
      const response = await patchVoice(server.url, guildId, userId, payload)
      expect(response.status).toBe(status)
      expect(getGuildVoiceState(server.db, guildId, userId)).toEqual(original)
      await expectSilent(client)
    }
    await expectStatus(
      patchVoice(server.url, '999999999999999999', userId, {
        channel_id: channelId,
      }),
      404
    )
    await expectStatus(
      patchVoice(server.url, guildId, '999999999999999999', {
        channel_id: channelId,
      }),
      404
    )
    const malformed = await fetch(
      `${server.url.replace('ws://', 'http://')}/_test/guilds/${guildId}/voice-states/${userId}`,
      { method: 'PATCH', body: '{' }
    )
    expect(malformed.status).toBe(400)
    await expectSilent(client)
    server.db
      .exec(`CREATE TRIGGER reject_stream BEFORE UPDATE ON guild_voice_states
      WHEN NEW.self_stream = 1 BEGIN SELECT RAISE(ABORT, 'Rejected stream'); END`)
    await expectStatus(
      patchVoice(server.url, guildId, userId, { self_stream: true }),
      500
    )
    expect(getGuildVoiceState(server.db, guildId, userId)).toEqual(original)
    await expectSilent(client)
    await expectStatus(
      patchVoice(server.url, guildId, userId, {
        channel_id: null,
        emit: false,
      }),
      200
    )
    expect(getGuildVoiceState(server.db, guildId, userId)).toMatchObject({
      channel_id: null,
    })
    await expectStatus(
      patchVoice(server.url, guildId, userId, { channel_id: null }),
      200
    )
    await expectSilent(client)
    expect(server.sessionManager.get(client.sessionId)?.seq).toBe(
      client.sequence
    )
  })

  it('replays exact missed transitions on RESUME and keeps the voice session distinct from the Gateway session', async () => {
    const server = await createTestGatewayServer()
    servers.push(server)
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const userId = seedMember(server.db, guildId)
    const channelId = seedVoiceChannel(server.db, guildId)
    const client = await connect(
      server.url,
      token,
      GatewayIntentBits.GuildVoiceStates,
      [],
      sockets
    )
    await expectStatus(
      patchVoice(server.url, guildId, userId, { channel_id: channelId }),
      200
    )
    const join = await client.next()
    client.sequence = Number(join.s)
    const closed = new Promise<void>((resolve) => {
      client.ws.once('close', () => {
        resolve()
      })
    })
    client.ws.close()
    await closed
    const missed: unknown[] = []
    for (const payload of [
      { self_stream: true },
      { self_stream: false },
      { channel_id: null },
    ]) {
      await expectStatus(patchVoice(server.url, guildId, userId, payload), 200)
      const event = server.sessionManager
        .get(client.sessionId)
        ?.replayBuffer.at(-1)?.event
      expect(event?.t).toBe('VOICE_STATE_UPDATE')
      missed.push(event)
    }
    const resumed = new WebSocket(server.url)
    sockets.push(resumed)
    const next = createReader(resumed)
    const hello = await next()
    expect(hello.op).toBe(GatewayOp.Hello)
    for (const invalid of [
      { token: 'Bot wrong', session_id: client.sessionId },
      { token, session_id: 'missing-session' },
    ]) {
      resumed.send(
        JSON.stringify({
          op: GatewayOp.Resume,
          d: { ...invalid, seq: client.sequence },
        })
      )
      expect(await next()).toMatchObject({
        op: GatewayOp.InvalidSession,
        d: false,
      })
    }
    resumed.send(
      JSON.stringify({
        op: GatewayOp.Resume,
        d: { token, session_id: client.sessionId, seq: client.sequence },
      })
    )
    for (const event of missed) expect(await next()).toEqual(event)
    expect(await next()).toMatchObject({
      t: 'RESUMED',
      s: client.sequence + missed.length + 1,
    })
    expect(getGuildVoiceState(server.db, guildId, userId)).toMatchObject({
      channel_id: null,
    })
    const response = await patchVoice(server.url, guildId, userId, {
      channel_id: channelId,
    })
    expect(response.status).toBe(200)
    const rejoin = await next()
    expect(rejoin).toMatchObject({
      t: 'VOICE_STATE_UPDATE',
      s: client.sequence + missed.length + 2,
    })
    expect((rejoin.d as { session_id: string }).session_id).not.toBe(
      (join.d as { session_id: string }).session_id
    )
    expect((rejoin.d as { session_id: string }).session_id).not.toBe(
      client.sessionId
    )
  })
})
