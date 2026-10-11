import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedMessage,
  seedRole,
  seedStageChannel,
  seedVoiceChannel,
} from '../test-helpers'
import { getGuildMember } from '../services/guild-members'
import { getGuildVoiceState } from '../services/voice-states'
import type { GuildVoiceState } from '../services/voice-states'
import { GatewayOp } from './opcodes'

/** Gateway frame as received by the test client. */
type Frame = Record<string, unknown> & { t?: string; s?: number; d?: unknown }

/** Connected client with an ordered frame queue. */
interface Client {
  ws: WebSocket
  next: () => Promise<Frame>
  sessionId: string
  /** Sequence of READY, the last dispatch drained by connect. */
  sequence: number
}

const TOKEN = 'Bot member-removal'
const BOT_ID = '111111111111111111'
const ALICE = '700000000000000001'
const BOB = '700000000000000002'
const CAROL = '700000000000000003'
const ALL_INTENTS =
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildModeration |
  GatewayIntentBits.GuildVoiceStates

describe('voice disconnects when members are removed', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let voice: string
  /** Role every seeded member holds, so removal snapshots carry roles. */
  let role: string
  const sockets: WebSocket[] = []
  const extraServers: Awaited<ReturnType<typeof createTestGatewayServer>>[] = []

  /** Queues frames so back-to-back dispatches are never lost. */
  function createReader(ws: WebSocket): Client['next'] {
    const queue: Frame[] = []
    const waiters: ((frame: Frame) => void)[] = []
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Frame
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

  /** Identifies a session without the Guilds intent and drains READY. */
  async function connect(
    intents: number = ALL_INTENTS,
    token = TOKEN,
    url = server.url
  ): Promise<Client> {
    const ws = new WebSocket(url)
    sockets.push(ws)
    const next = createReader(ws)
    const hello = await next()
    expect(hello.op).toBe(GatewayOp.Hello)
    ws.send(JSON.stringify({ op: GatewayOp.Identify, d: { token, intents } }))
    const ready = await next()
    expect(ready.t).toBe('READY')
    return {
      ws,
      next,
      sessionId: (ready.d as { session_id: string }).session_id,
      sequence: Number(ready.s),
    }
  }

  /** Collects every dispatch received before an ordered heartbeat ACK. */
  async function drain(client: Client): Promise<Frame[]> {
    client.ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
    const frames: Frame[] = []
    for (;;) {
      const frame = await client.next()
      if (frame.op === GatewayOp.HeartbeatAck) return frames
      frames.push(frame)
    }
  }

  /** Drains a client and returns only the dispatch event names. */
  async function eventTypes(client: Client): Promise<unknown[]> {
    const frames = await drain(client)
    return frames.map((frame) => frame.t)
  }

  /** Calls the live HTTP API with the fixture bot token. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token = TOKEN
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: token },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Returns only the HTTP status of a live API call. */
  async function status(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<number> {
    const response = await request(path, method, body)
    return response.status
  }

  /** Prepares a silent voice fixture and returns the stored state. */
  async function joinVoice(
    userId: string,
    patch: Record<string, unknown>
  ): Promise<GuildVoiceState> {
    const response = await request(
      `/_test/guilds/${guild}/voice-states/${userId}`,
      'PATCH',
      { emit: false, ...patch }
    )
    expect(response.status).toBe(200)
    return (await response.json()) as GuildVoiceState
  }

  /** Expected native disconnect for a departing member's prior state. */
  function disconnectOf(
    previous: GuildVoiceState,
    member: ReturnType<typeof getGuildMember>
  ): Record<string, unknown> {
    assert.ok(member)
    return {
      ...previous,
      channel_id: null,
      self_stream: false,
      self_video: false,
      request_to_speak_timestamp: null,
      member: { ...member, user: { ...member.user, primary_guild: null } },
    }
  }

  /** Normalized user payload carried by member removal and ban events. */
  function userOf(userId: string): Record<string, unknown> {
    return {
      id: userId,
      username: 'TestMember',
      discriminator: '0',
      avatar: null,
      bot: false,
      flags: 0,
      public_flags: 0,
      global_name: null,
      primary_guild: null,
    }
  }

  /** Counts the remaining role assignments of the given users. */
  function roleRows(...userIds: string[]): number {
    const placeholders = userIds.map(() => '?').join(', ')
    const row = server.db
      .prepare(
        `SELECT COUNT(*) AS count FROM member_roles WHERE guild_id = ? AND user_id IN (${placeholders})`
      )
      .get(guild, ...userIds) as { count: number }
    return row.count
  }

  /** GUILD_BAN_ADD payload, including Discord's undocumented deletion window. */
  function banOf(userId: string, seconds = 0): Record<string, unknown> {
    return {
      guild_id: guild,
      user: userOf(userId),
      delete_message_secs: seconds,
    }
  }

  /** Asserts the frames carry strictly consecutive sequence numbers. */
  function expectConsecutive(frames: Frame[]): void {
    const sequences = frames.map((frame) => Number(frame.s))
    expect(sequences).toEqual(sequences.map((_, index) => sequences[0] + index))
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT_ID)
    guild = seedGuild(server.db, TOKEN)
    voice = seedVoiceChannel(server.db, guild)
    role = seedRole(server.db, guild)
    for (const user of [ALICE, BOB, CAROL]) {
      seedMember(server.db, guild, user)
      server.db
        .prepare(
          'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
        )
        .run(guild, user, role)
    }
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    for (const extra of extraServers.splice(0)) await extra.close()
    await server.close()
  })

  it('kick emits the voice disconnect before GUILD_MEMBER_REMOVE', async () => {
    const previous = await joinVoice(ALICE, {
      channel_id: voice,
      self_stream: true,
      self_video: true,
      self_mute: true,
      deaf: true,
    })
    const member = getGuildMember(server.db, guild, ALICE)
    expect(member).not.toBeNull()
    const client = await connect()

    const response = await request(
      `/guilds/${guild}/members/${ALICE}`,
      'DELETE'
    )
    expect(response.status).toBe(204)

    const frames = await drain(client)
    expect(frames.map((frame) => frame.t)).toEqual([
      'VOICE_STATE_UPDATE',
      'GUILD_MEMBER_REMOVE',
    ])
    expectConsecutive(frames)
    expect(frames[0].d).toEqual(disconnectOf(previous, member))
    expect(frames[0].d).toMatchObject({
      session_id: previous.session_id,
      self_mute: true,
      deaf: true,
      member: { roles: [role] },
    })
    expect(frames[1].d).toEqual({ guild_id: guild, user: userOf(ALICE) })
    expect(getGuildVoiceState(server.db, guild, ALICE)).toBeNull()
    expect(roleRows(ALICE)).toBe(0)
  })

  it('ban of a member in a stage channel emits ban add, disconnect and member remove', async () => {
    const { stageChannelId } = seedStageChannel(server.db, guild)
    const previous = await joinVoice(BOB, {
      channel_id: stageChannelId,
      suppress: true,
      request_to_speak_timestamp: '2026-01-01T00:00:00.000Z',
    })
    const member = getGuildMember(server.db, guild, BOB)
    const client = await connect()

    const response = await request(`/guilds/${guild}/bans/${BOB}`, 'PUT', {})
    expect(response.status).toBe(204)

    // Order observed on real Discord when banning a connected member.
    const frames = await drain(client)
    expect(frames.map((frame) => frame.t)).toEqual([
      'GUILD_BAN_ADD',
      'VOICE_STATE_UPDATE',
      'GUILD_MEMBER_REMOVE',
    ])
    expectConsecutive(frames)
    expect(frames[0].d).toEqual(banOf(BOB))
    expect(frames[1].d).toEqual(disconnectOf(previous, member))
    expect(frames[1].d).toMatchObject({
      suppress: true,
      member: { roles: [role] },
    })
    expect(frames[2].d).toEqual({ guild_id: guild, user: userOf(BOB) })
    expect(roleRows(BOB)).toBe(0)
  })

  it('ban of a member who is not in voice emits ban add and member remove only', async () => {
    await joinVoice(CAROL, { channel_id: voice })
    await joinVoice(CAROL, { channel_id: null })
    const client = await connect()

    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    expect(await status(`/guilds/${guild}/bans/${CAROL}`, 'PUT')).toBe(204)

    const frames = await drain(client)
    expect(
      frames.map((frame) => [
        frame.t,
        (frame.d as { user: { id: string } }).user.id,
      ])
    ).toEqual([
      ['GUILD_BAN_ADD', ALICE],
      ['GUILD_MEMBER_REMOVE', ALICE],
      ['GUILD_BAN_ADD', CAROL],
      ['GUILD_MEMBER_REMOVE', CAROL],
    ])
    expectConsecutive(frames)
  })

  it('re-banning is silent and keeps the reason; banning a non-member emits only GUILD_BAN_ADD', async () => {
    const client = await connect()
    const ban = await fetch(`${base}/guilds/${guild}/bans/${ALICE}`, {
      method: 'PUT',
      headers: { Authorization: TOKEN, 'X-Audit-Log-Reason': 'first' },
    })
    expect(ban.status).toBe(204)
    const first = await drain(client)
    expect(first.map((frame) => frame.t)).toEqual([
      'GUILD_BAN_ADD',
      'GUILD_MEMBER_REMOVE',
    ])
    // Observed on real Discord: 204, no events, original reason kept.
    const reban = await fetch(`${base}/guilds/${guild}/bans/${ALICE}`, {
      method: 'PUT',
      headers: { Authorization: TOKEN, 'X-Audit-Log-Reason': 'second' },
    })
    expect(reban.status).toBe(204)
    expect(await drain(client)).toEqual([])
    const stored = await request(`/guilds/${guild}/bans/${ALICE}`)
    expect(await stored.json()).toMatchObject({ reason: 'first' })

    const outsider = '700000000000000009'
    server.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'TestMember', '0', 0)"
      )
      .run(outsider)
    expect(await status(`/guilds/${guild}/bans/${outsider}`, 'PUT')).toBe(204)
    const frames = await drain(client)
    expect(frames).toMatchObject([{ t: 'GUILD_BAN_ADD', d: banOf(outsider) }])
  })

  it('kick of a member without voice, or with a kept disconnected state, emits only GUILD_MEMBER_REMOVE', async () => {
    await joinVoice(BOB, { channel_id: voice })
    await joinVoice(BOB, { channel_id: null })
    const client = await connect()
    for (const user of [ALICE, BOB]) {
      expect(await status(`/guilds/${guild}/members/${user}`, 'DELETE')).toBe(
        204
      )
    }
    const frames = await drain(client)
    expect(frames.map((frame) => frame.t)).toEqual([
      'GUILD_MEMBER_REMOVE',
      'GUILD_MEMBER_REMOVE',
    ])
  })

  it('kick of a member connected only in another guild leaves that voice state alone', async () => {
    const elsewhere = seedGuild(server.db, TOKEN, '222222222222222223')
    const elsewhereVoice = seedVoiceChannel(
      server.db,
      elsewhere,
      '555555555555555556'
    )
    seedMember(server.db, elsewhere, ALICE)
    const response = await request(
      `/_test/guilds/${elsewhere}/voice-states/${ALICE}`,
      'PATCH',
      { emit: false, channel_id: elsewhereVoice }
    )
    expect(response.status).toBe(200)
    const connected = getGuildVoiceState(server.db, elsewhere, ALICE)
    const client = await connect()

    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )

    expect(await eventTypes(client)).toEqual(['GUILD_MEMBER_REMOVE'])
    expect(getGuildVoiceState(server.db, elsewhere, ALICE)).toEqual(connected)
  })

  it('bulk ban emits per-user events in request order and skips voice for absent members', async () => {
    const alice = await joinVoice(ALICE, {
      channel_id: voice,
      self_stream: true,
    })
    const aliceMember = getGuildMember(server.db, guild, ALICE)
    expect(roleRows(ALICE, BOB)).toBe(2)
    const client = await connect()

    const response = await request(`/guilds/${guild}/bulk-ban`, 'POST', {
      user_ids: [ALICE, '799999999999999999', BOB],
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      banned_users: [ALICE, BOB],
      failed_users: ['799999999999999999'],
    })

    const frames = await drain(client)
    expect(frames.map((frame) => frame.t)).toEqual([
      'GUILD_BAN_ADD',
      'VOICE_STATE_UPDATE',
      'GUILD_MEMBER_REMOVE',
      'GUILD_BAN_ADD',
      'GUILD_MEMBER_REMOVE',
    ])
    expectConsecutive(frames)
    expect(frames[0].d).toEqual(banOf(ALICE))
    expect(frames[1].d).toEqual(disconnectOf(alice, aliceMember))
    expect(frames[1].d).toMatchObject({ member: { roles: [role] } })
    expect(frames[3].d).toEqual(banOf(BOB))
    expect(frames[4].d).toEqual({ guild_id: guild, user: userOf(BOB) })
    expect(roleRows(ALICE, BOB)).toBe(0)
    expect(roleRows(CAROL)).toBe(1)
  })

  it('bulk ban naming the bot publishes the human removal before the bot loses the guild', async () => {
    await joinVoice(ALICE, { channel_id: voice })
    const client = await connect(ALL_INTENTS | GatewayIntentBits.Guilds)
    // Fresh IDENTIFY with Guilds also sends the guild's GUILD_CREATE.
    expect(await eventTypes(client)).toEqual(['GUILD_CREATE'])

    const response = await request(`/guilds/${guild}/bulk-ban`, 'POST', {
      user_ids: [BOT_ID, ALICE],
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      banned_users: [BOT_ID, ALICE],
      failed_users: [],
    })

    const frames = await drain(client)
    expect(
      frames.map((frame) => [
        frame.t,
        (frame.d as { user?: { id: string }; user_id?: string }).user?.id ??
          (frame.d as { user_id?: string }).user_id,
      ])
    ).toEqual([
      ['GUILD_BAN_ADD', ALICE],
      ['VOICE_STATE_UPDATE', ALICE],
      ['GUILD_MEMBER_REMOVE', ALICE],
      ['GUILD_MEMBER_REMOVE', BOT_ID],
      ['GUILD_DELETE', undefined],
    ])
    expectConsecutive(frames)
  })

  it('GUILD_BAN_ADD carries the deletion window of single and bulk bans', async () => {
    const text = seedChannel(server.db, guild)
    const messages = [ALICE, BOB, CAROL, BOT_ID].map((author) =>
      seedMessage(server.db, text, author, TOKEN)
    )
    const client = await connect()

    expect(
      await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT', {
        delete_message_seconds: 3600,
      })
    ).toBe(204)
    expect(
      await status(`/guilds/${guild}/bans/${BOB}?delete_message_days=1`, 'PUT')
    ).toBe(204)
    const bulk = await request(`/guilds/${guild}/bulk-ban`, 'POST', {
      user_ids: [CAROL],
      delete_message_seconds: 60,
    })
    expect(bulk.status).toBe(200)

    const frames = await drain(client)
    const bans = frames.filter((frame) => frame.t === 'GUILD_BAN_ADD')
    expect(bans.map((frame) => frame.d)).toEqual([
      banOf(ALICE, 3600),
      banOf(BOB, 86_400),
      banOf(CAROL, 60),
    ])
    const remaining = server.db
      .prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY id')
      .all(text)
    expect(remaining).toEqual([{ id: messages[3] }])
  })

  it('bulk ban rejects an invalid deletion window without banning', async () => {
    const client = await connect()
    const response = await request(`/guilds/${guild}/bulk-ban`, 'POST', {
      user_ids: [ALICE],
      delete_message_seconds: 604_801,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 50_035 })
    expect(await drain(client)).toEqual([])
    expect(await status(`/guilds/${guild}/bans/${ALICE}`)).toBe(404)
  })

  it('bulk ban reports already banned users as failed without events', async () => {
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    const client = await connect()

    const mixed = await request(`/guilds/${guild}/bulk-ban`, 'POST', {
      user_ids: [ALICE, BOB],
    })
    expect(mixed.status).toBe(200)
    expect(await mixed.json()).toEqual({
      banned_users: [BOB],
      failed_users: [ALICE],
    })
    expect(await eventTypes(client)).toEqual([
      'GUILD_BAN_ADD',
      'GUILD_MEMBER_REMOVE',
    ])
  })

  it('bulk ban returns 500000 when no user could be banned', async () => {
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    const client = await connect()

    // Observed on real Discord for a request of only already banned users.
    const response = await request(`/guilds/${guild}/bulk-ban`, 'POST', {
      user_ids: [ALICE, '799999999999999999'],
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      message: 'Failed to ban users',
      code: 500_000,
    })
    expect(await drain(client)).toEqual([])
  })

  /** Each non-cleanup removal path and the events it publishes in voice. */
  const REMOVALS = [
    {
      name: 'kick',
      run: (): Promise<number> =>
        status(`/guilds/${guild}/members/${ALICE}`, 'DELETE'),
      expected: 204,
      events: ['VOICE_STATE_UPDATE', 'GUILD_MEMBER_REMOVE'],
    },
    {
      name: 'ban',
      run: (): Promise<number> =>
        status(`/guilds/${guild}/bans/${ALICE}`, 'PUT'),
      expected: 204,
      events: ['GUILD_BAN_ADD', 'VOICE_STATE_UPDATE', 'GUILD_MEMBER_REMOVE'],
    },
    {
      name: 'bulk ban',
      run: (): Promise<number> =>
        status(`/guilds/${guild}/bulk-ban`, 'POST', { user_ids: [ALICE] }),
      expected: 200,
      events: ['GUILD_BAN_ADD', 'VOICE_STATE_UPDATE', 'GUILD_MEMBER_REMOVE'],
    },
  ]

  it.each(REMOVALS)(
    '$name filters each event by intent, bot setup, token alias and database',
    async ({ run, expected, events }) => {
      await joinVoice(ALICE, { channel_id: voice })
      const voiceOnly = await connect(GatewayIntentBits.GuildVoiceStates)
      const membersOnly = await connect(GatewayIntentBits.GuildMembers)
      const moderationOnly = await connect(GatewayIntentBits.GuildModeration)
      const foreignToken = 'Bot other-setup'
      seedBot(server.db, foreignToken, '121212121212121212')
      seedGuild(server.db, foreignToken, '343434343434343434')
      // Same bot user ID as the owner, but a different setup token.
      const aliasToken = 'Bot alias-setup'
      seedBot(server.db, aliasToken, BOT_ID)
      seedGuild(server.db, aliasToken, '343434343434343435')
      // Same token, bot ID and guild ID in another app database.
      const other = await createTestGatewayServer()
      extraServers.push(other)
      seedBot(other.db, TOKEN, BOT_ID)
      seedGuild(other.db, TOKEN, guild)
      const excluded = [
        await connect(ALL_INTENTS, foreignToken),
        await connect(ALL_INTENTS, aliasToken),
        await connect(ALL_INTENTS, TOKEN, other.url),
      ]

      expect(await run()).toBe(expected)

      const filtered = (intent: string): string[] =>
        events.filter((event) => event === intent)
      expect(await eventTypes(voiceOnly)).toEqual(
        filtered('VOICE_STATE_UPDATE')
      )
      expect(await eventTypes(membersOnly)).toEqual(
        filtered('GUILD_MEMBER_REMOVE')
      )
      expect(await eventTypes(moderationOnly)).toEqual(
        filtered('GUILD_BAN_ADD')
      )
      for (const client of excluded) expect(await drain(client)).toEqual([])
    }
  )

  it.each(REMOVALS)(
    '$name lets VOICE_STATE_UPDATE capture controls hold and replay the disconnect',
    async ({ run, expected, events }) => {
      const previous = await joinVoice(ALICE, { channel_id: voice })
      const member = getGuildMember(server.db, guild, ALICE)
      const client = await connect()
      const armed = await request('/_test/gateway-event-controls', 'POST', {
        guild_id: guild,
        bot_id: BOT_ID,
        session_id: client.sessionId,
        events: ['VOICE_STATE_UPDATE'],
        hold: true,
      })
      expect(armed.status).toBe(201)
      const { id } = (await armed.json()) as { id: string }

      expect(await run()).toBe(expected)
      const held = await drain(client)
      expect(held.map((frame) => frame.t)).toEqual(
        events.filter((event) => event !== 'VOICE_STATE_UPDATE')
      )

      const inspected = await request(`/_test/gateway-event-controls/${id}`)
      const observation = (await inspected.json()) as {
        events_captured: { id: string; envelope: Frame; state: string }[]
      }
      expect(observation.events_captured).toHaveLength(1)
      const captured = observation.events_captured[0]
      expect(captured.envelope).toMatchObject({
        t: 'VOICE_STATE_UPDATE',
        d: disconnectOf(previous, member),
      })
      // The held envelope keeps its slot in the native sequence order.
      const sequenced = [...held, captured.envelope].toSorted(
        (left, right) => Number(left.s) - Number(right.s)
      )
      expectConsecutive(sequenced)
      expect(sequenced.map((frame) => frame.t)).toEqual(events)

      for (const action of ['release', 'replay']) {
        const response = await request(
          `/_test/gateway-event-controls/${id}/${action}`,
          'POST',
          { event_ids: [captured.id] }
        )
        expect(response.status).toBe(200)
        expect(await drain(client)).toMatchObject([
          { t: 'VOICE_STATE_UPDATE', d: disconnectOf(previous, member) },
        ])
      }
    }
  )

  it.each(REMOVALS)(
    '$name events are replayed in order on RESUME',
    async ({ run, expected, events }) => {
      await joinVoice(ALICE, { channel_id: voice })
      const client = await connect()
      const closed = new Promise<void>((resolve) => {
        client.ws.once('close', () => {
          resolve()
        })
      })
      client.ws.close()
      await closed

      expect(await run()).toBe(expected)
      const missed =
        server.sessionManager
          .get(client.sessionId)
          ?.replayBuffer.filter((entry) => entry.seq > client.sequence)
          .map((entry) => entry.event) ?? []
      expect(missed.map((event) => event.t)).toEqual(events)
      expect(missed.map((event) => event.s)).toEqual(
        events.map((_, index) => client.sequence + index + 1)
      )

      const resumed = new WebSocket(server.url)
      sockets.push(resumed)
      const next = createReader(resumed)
      const hello = await next()
      expect(hello.op).toBe(GatewayOp.Hello)
      resumed.send(
        JSON.stringify({
          op: GatewayOp.Resume,
          d: {
            token: TOKEN,
            session_id: client.sessionId,
            seq: client.sequence,
          },
        })
      )
      for (const event of missed) expect(await next()).toEqual(event)
      expect(await next()).toMatchObject({ t: 'RESUMED' })
    }
  )

  /** Event names a cleanup path must never publish. */
  function removalEvents(frames: Frame[]): Frame[] {
    return frames.filter((frame) =>
      ['VOICE_STATE_UPDATE', 'GUILD_MEMBER_REMOVE', 'GUILD_BAN_ADD'].includes(
        String(frame.t)
      )
    )
  }

  it.each([
    {
      name: 'scoped reset',
      run: (): Promise<number> =>
        status('/_test/reset', 'POST', { token: TOKEN }),
    },
    {
      name: 'global reset',
      run: (): Promise<number> => status('/_test/reset', 'POST'),
    },
    {
      name: 'guild deletion',
      run: (): Promise<number> => status(`/guilds/${guild}`, 'DELETE'),
    },
    {
      name: 'setup deletion',
      run: (): Promise<number> =>
        status(`/_test/setup/${encodeURIComponent(TOKEN)}`, 'DELETE'),
    },
  ])('$name stays silent for connected members', async ({ run }) => {
    await joinVoice(ALICE, { channel_id: voice, self_stream: true })
    const client = await connect()
    expect(await run()).toBe(204)
    expect(removalEvents(await drain(client))).toEqual([])
    expect(getGuildVoiceState(server.db, guild, ALICE)).toBeNull()
  })
})
