import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { Database } from '../db'
import {
  createTestGatewayServer,
  seedApplicationCommand,
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
  /** Guild IDs listed by READY. */
  readyGuilds: string[]
  /** GUILD_CREATE payloads received while connecting. */
  guildCreates: Record<string, unknown>[]
  /** Returns every dispatch received before an ordered heartbeat ACK. */
  drain: () => Promise<Frame[]>
}

const TOKEN = 'Bot live-join'
const OTHER_TOKEN = 'Bot live-join-other'
const BOT = '111111111111111111'
const OTHER_BOT = '111111111111111112'
const APPEAL = '222222222222222222'
const HOME = '222222222222222223'
const TEXT = '333333333333333333'
const HOME_TEXT = '333333333333333334'
const OWNER = '700000000000000001'
const BANNED = '700000000000000002'
const JOIN_OWN = { token: TOKEN }
const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildMessages

describe('adding the connected bot to an existing guild', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>> | undefined
  const sockets: WebSocket[] = []
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    await server?.close()
    server = undefined
  })

  /** Calls the live HTTP API. */
  async function http(
    path: string,
    method = 'GET',
    body?: unknown,
    token?: string
  ): Promise<Response> {
    if (!server) throw new Error('server not started')
    return fetch(server.url.replace('ws://', 'http://') + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: token }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Returns a live API call's status. */
  async function statusOf(
    path: string,
    method = 'GET',
    body?: unknown,
    token?: string
  ): Promise<number> {
    const response = await http(path, method, body, token)
    return response.status
  }

  /** Creates a role through the fixture route and returns its ID. */
  async function createRole(guildId: string, managed = false): Promise<string> {
    const response = await http(`/_test/guilds/${guildId}/roles`, 'POST', {
      name: managed ? 'integration' : 'helper',
      managed,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  /**
   * Boots a server whose bot lists a home guild and an appeal guild that it
   * has not joined yet, with human fixtures seeded through test controls.
   */
  async function start(): Promise<Database> {
    server = await createTestGatewayServer()
    for (const [id, username] of [
      [OWNER, 'owner'],
      [BANNED, 'banned'],
    ]) {
      expect(await statusOf('/_test/users', 'POST', { id, username })).toBe(201)
    }
    const setup = await http('/_test/setup', 'POST', {
      token: TOKEN,
      user: { id: BOT, username: 'Szymboot' },
      guilds: [
        {
          id: HOME,
          name: 'Home',
          channels: [{ id: HOME_TEXT, name: 'general' }],
        },
        {
          id: APPEAL,
          name: 'Appeal',
          owner_id: OWNER,
          bot_present: false,
          channels: [{ id: TEXT, name: 'appeals' }],
        },
      ],
    })
    expect(setup.status).toBe(201)
    expect(
      await statusOf(`/_test/guilds/${APPEAL}/members/${BANNED}`, 'POST', {})
    ).toBe(201)
    return server.db
  }

  /** Identifies a session and consumes READY plus its GUILD_CREATE frames. */
  async function connect(token = TOKEN, intents = INTENTS): Promise<Client> {
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
        d: { token: token.replace(/^Bot /, ''), intents },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    const data = ready.d as { session_id: string; guilds: { id: string }[] }
    let sequence = Number(ready.s)
    const guildCreates: Record<string, unknown>[] = []
    if ((intents & GatewayIntentBits.Guilds) !== 0)
      for (const stub of data.guilds) {
        const create = await next()
        expect(create.t).toBe('GUILD_CREATE')
        expect(create.d).toMatchObject({ id: stub.id })
        guildCreates.push(create.d as Record<string, unknown>)
        sequence = Number(create.s)
      }
    return {
      ws,
      sessionId: data.session_id,
      sequence,
      readyGuilds: data.guilds.map(({ id }) => id),
      guildCreates,
      drain: async () => {
        ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
        const frames: Frame[] = []
        for (;;) {
          const frame = await next()
          if (frame.op === GatewayOp.HeartbeatAck) return frames
          frames.push(frame)
        }
      },
    }
  }

  /** Adds a bot to the appeal guild through the test control. */
  function join(body: unknown): Promise<Response> {
    return http(`/_test/guilds/${APPEAL}/bot`, 'POST', body)
  }

  /** Adds the setup's own bot (or the one in `body`) and returns the status. */
  function joinStatus(body: unknown = null): Promise<number> {
    return statusOf(`/_test/guilds/${APPEAL}/bot`, 'POST', body ?? JOIN_OWN)
  }

  /** Lists the guild IDs `GET /users/@me/guilds` returns to the bot. */
  async function botGuildIds(): Promise<string[]> {
    const response = await http('/users/@me/guilds', 'GET', undefined, TOKEN)
    const guilds = (await response.json()) as { id: string }[]
    return guilds.map(({ id }) => id)
  }

  /** Lists the user IDs of the appeal guild's members as the bot sees them. */
  async function memberIds(): Promise<string[]> {
    const response = await http(
      `/guilds/${APPEAL}/members`,
      'GET',
      undefined,
      TOKEN
    )
    const members = (await response.json()) as { user: { id: string } }[]
    return members.map(({ user }) => user.id)
  }

  /** Names the dispatch events of drained frames. */
  const types = (frames: Frame[]): (string | null | undefined)[] =>
    frames.map(({ t }) => t)

  /** Orders IDs for stable comparisons. */
  const byId = (a: string, b: string): number => a.localeCompare(b)

  describe('preparing a guild without the bot', () => {
    it('keeps it out of READY, GUILD_CREATE and REST while seeding humans and channels', async () => {
      const db = await start()
      const client = await connect()
      expect(client.readyGuilds).toEqual([HOME])
      expect(client.guildCreates.map(({ id }) => id)).toEqual([HOME])

      expect(
        db.prepare('SELECT bot_present FROM guilds WHERE id = ?').get(APPEAL)
      ).toEqual({ bot_present: 0 })
      expect(
        db
          .prepare(
            'SELECT user_id FROM guild_members WHERE guild_id = ? ORDER BY user_id'
          )
          .all(APPEAL)
      ).toEqual([{ user_id: OWNER }, { user_id: BANNED }])

      const guilds = await botGuildIds()
      expect(guilds).toEqual([HOME])
      const send = await http(
        `/channels/${TEXT}/messages`,
        'POST',
        { content: 'hi' },
        TOKEN
      )
      expect(send.status).toBe(403)
      expect(
        await statusOf(`/guilds/${APPEAL}/incident-actions`, 'PUT', {}, TOKEN)
      ).toBe(403)
      // Fixture controls keep working, silently.
      await createRole(APPEAL)
      expect(await client.drain()).toEqual([])
    })

    it('rejects a non-boolean bot_present', async () => {
      server = await createTestGatewayServer()
      const response = await http('/_test/setup', 'POST', {
        token: TOKEN,
        guilds: [{ name: 'Bad', bot_present: 'no' }],
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: 'bot_present must be a boolean',
        code: 0,
      })
      expect(
        server.db.prepare('SELECT 1 FROM bots WHERE token = ?').get(TOKEN)
      ).toBeUndefined()
    })

    it('refuses interactions in the guild until the bot joins', async () => {
      const db = await start()
      seedApplicationCommand(db, BOT, null, 'ping')
      const interaction = (): Promise<number> =>
        statusOf('/_test/interactions', 'POST', {
          application_id: BOT,
          command_name: 'ping',
          guild_id: APPEAL,
          channel_id: TEXT,
        })
      expect(await interaction()).toBe(404)
      const client = await connect()
      expect(await joinStatus()).toBe(201)
      await client.drain()
      expect(await interaction()).toBe(201)
      expect(types(await client.drain())).toEqual(['INTERACTION_CREATE'])
    })
  })

  describe('joining live', () => {
    it('sends GUILD_CREATE with the seeded members, roles and channels', async () => {
      await start()
      const role = await createRole(APPEAL)
      const client = await connect()
      const response = await join(JOIN_OWN)
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({
        user: { id: BOT, bot: true },
        roles: [],
      })

      const frames = await client.drain()
      expect(frames.map(({ t, s }) => [t, s])).toEqual([
        ['GUILD_CREATE', client.sequence + 1],
      ])
      const guild = frames[0]?.d as {
        id: string
        owner_id: string
        member_count: number
        members: { user: { id: string } }[]
        channels: { id: string }[]
        roles: { id: string }[]
        unavailable: boolean
      }
      expect(guild).toMatchObject({
        id: APPEAL,
        name: 'Appeal',
        owner_id: OWNER,
        member_count: 3,
        unavailable: false,
      })
      expect(
        guild.members
          .map(({ user }) => user.id)
          .toSorted((a, b) => a.localeCompare(b))
      ).toEqual([BOT, OWNER, BANNED])
      expect(guild.channels.map(({ id }) => id)).toEqual([TEXT])
      expect(guild.roles.map(({ id }) => id)).toContain(role)
    })

    it('makes REST work and lists the guild in the next READY', async () => {
      await start()
      await connect()
      expect(await joinStatus()).toBe(201)

      const guilds = await botGuildIds()
      expect(guilds.toSorted(byId)).toEqual([HOME, APPEAL].toSorted(byId))
      const send = await http(
        `/channels/${TEXT}/messages`,
        'POST',
        { content: 'appeal opened' },
        TOKEN
      )
      expect(send.status).toBe(200)
      const members = await memberIds()
      expect(members).toContain(BOT)

      const fresh = await connect()
      expect(fresh.readyGuilds.toSorted(byId)).toEqual(
        [HOME, APPEAL].toSorted(byId)
      )
    })

    it('accepts the application ID and assigns roles, managed ones included', async () => {
      await start()
      const managed = await createRole(APPEAL, true)
      const plain = await createRole(APPEAL)
      const response = await join({
        application_id: BOT,
        roles: [managed, plain, managed],
      })
      expect(response.status).toBe(201)
      const member = (await response.json()) as { roles: string[] }
      expect(member.roles.toSorted(byId)).toEqual(
        [managed, plain].toSorted(byId)
      )
    })

    it('delivers GUILD_CREATE to every live session of the bot only', async () => {
      await start()
      expect(
        await statusOf('/_test/setup', 'POST', {
          token: OTHER_TOKEN,
          user: { id: OTHER_BOT, username: 'Other' },
        })
      ).toBe(201)
      const first = await connect()
      const second = await connect()
      const other = await connect(OTHER_TOKEN)
      const noGuilds = await connect(TOKEN, GatewayIntentBits.GuildMembers)
      expect(await joinStatus()).toBe(201)

      for (const client of [first, second]) {
        const frames = await client.drain()
        // The joining bot already sees itself inside GUILD_CREATE.
        expect(frames.map(({ t }) => t)).toEqual(['GUILD_CREATE'])
      }
      // Another setup observes only the new member, never the guild itself.
      expect(types(await other.drain())).toEqual(['GUILD_MEMBER_ADD'])
      expect(await noGuilds.drain()).toEqual([])
    })

    it('replays the join to a disconnected session on RESUME', async () => {
      await start()
      const first = await connect()
      first.ws.terminate()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(await joinStatus()).toBe(201)

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
      const dispatches = frames.filter(({ op }) => op === GatewayOp.Dispatch)
      expect(dispatches.map(({ t, s }) => [t, s])).toEqual([
        ['GUILD_CREATE', first.sequence + 1],
        ['RESUMED', first.sequence + 2],
      ])
      expect(dispatches[0]?.d).toMatchObject({ id: APPEAL })
    })
  })

  describe('rejoining', () => {
    /** Seeds a message and a voice-independent fixture to prove survival. */
    async function joinThenLose(path: string, method: string, body?: unknown) {
      const db = await start()
      const role = await createRole(APPEAL)
      const client = await connect()
      expect(await joinStatus({ token: TOKEN, roles: [role] })).toBe(201)
      await client.drain()
      const sent = await http(
        `/channels/${TEXT}/messages`,
        'POST',
        { content: 'kept' },
        TOKEN
      )
      expect(sent.status).toBe(200)
      expect(await statusOf(path, method, body, TOKEN)).toBeLessThan(300)
      const removal = await client.drain()
      expect(removal.map(({ t }) => t)).toContain('GUILD_DELETE')
      expect(
        db.prepare('SELECT bot_present FROM guilds WHERE id = ?').get(APPEAL)
      ).toEqual({ bot_present: 0 })
      return { db, client, role }
    }

    it.each([
      ['leave', `/users/@me/guilds/${APPEAL}`, 'DELETE', undefined],
      ['kick', `/guilds/${APPEAL}/members/${BOT}`, 'DELETE', undefined],
      ['ban', `/guilds/${APPEAL}/bans/${BOT}`, 'PUT', {}],
    ] as [string, string, string, unknown][])(
      're-adds the bot after a %s without losing fixtures',
      async (_name, path, method, body) => {
        const { db, client, role } = await joinThenLose(path, method, body)
        const rejoin = await join({ token: TOKEN, roles: [role] })
        expect(rejoin.status).toBe(201)

        const frames = await client.drain()
        expect(frames.map(({ t }) => t)).toEqual(['GUILD_CREATE'])
        expect(
          (frames[0]?.d as { members: { user: { id: string } }[] }).members
            .map(({ user }) => user.id)
            .toSorted((a, b) => a.localeCompare(b))
        ).toEqual([BOT, OWNER, BANNED])
        expect(
          db
            .prepare(
              'SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?'
            )
            .get(APPEAL, BOT)
        ).toBeUndefined()
        expect(
          db
            .prepare('SELECT 1 FROM guild_bot_removals WHERE guild_id = ?')
            .get(APPEAL)
        ).toBeUndefined()
        expect(
          db
            .prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?')
            .get(TEXT)
        ).toEqual({ n: 1 })
        const send = await http(
          `/channels/${TEXT}/messages`,
          'POST',
          { content: 'again' },
          TOKEN
        )
        expect(send.status).toBe(200)
        const reconnected = await connect()
        expect(reconnected.readyGuilds.toSorted(byId)).toEqual(
          [HOME, APPEAL].toSorted(byId)
        )
      }
    )
  })

  describe('errors', () => {
    it('answers 409 when the bot is already present, changing nothing', async () => {
      await start()
      expect(await joinStatus()).toBe(201)
      const client = await connect()
      const again = await join(JOIN_OWN)
      expect(again.status).toBe(409)
      expect(await again.json()).toEqual({
        message: 'Bot is already a member of the guild',
        code: 0,
      })
      expect(await client.drain()).toEqual([])
    })

    it('answers 404 for an unknown guild, bot or role without mutating', async () => {
      const db = await start()
      const client = await connect()
      const unknownGuild = await http('/_test/guilds/999/bot', 'POST', {
        token: TOKEN,
      })
      expect(unknownGuild.status).toBe(404)
      expect(await unknownGuild.json()).toEqual({
        message: 'Unknown Guild',
        code: 10_004,
      })
      expect(await joinStatus({ token: 'Bot nobody' })).toBe(404)
      expect(await joinStatus({ application_id: '1' })).toBe(404)
      const unknownRole = await join({ token: TOKEN, roles: ['404'] })
      expect(unknownRole.status).toBe(404)
      expect(await unknownRole.json()).toMatchObject({ code: 10_011 })
      // @everyone is implicit and cannot be assigned.
      expect(await joinStatus({ token: TOKEN, roles: [APPEAL] })).toBe(404)
      expect(
        db.prepare('SELECT bot_present FROM guilds WHERE id = ?').get(APPEAL)
      ).toEqual({ bot_present: 0 })
      expect(
        db
          .prepare(
            'SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?'
          )
          .get(APPEAL, BOT)
      ).toBeUndefined()
      expect(await client.drain()).toEqual([])
    })

    it('rejects malformed bodies and mismatched identities', async () => {
      await start()
      for (const body of [
        {},
        { token: 1 },
        { token: ' ' },
        { token: TOKEN, roles: 'x' },
        { token: TOKEN, roles: [1] },
        { token: TOKEN, extra: true },
      ])
        expect(await joinStatus(body)).toBe(400)
      const malformed = await http(`/_test/guilds/${APPEAL}/bot`, 'POST')
      expect(malformed.status).toBe(400)
      expect(
        await statusOf('/_test/setup', 'POST', {
          token: OTHER_TOKEN,
          user: { id: OTHER_BOT, username: 'Other' },
        })
      ).toBe(201)
      const mismatch = await join({
        token: TOKEN,
        application_id: OTHER_BOT,
      })
      expect(mismatch.status).toBe(400)
      expect(await mismatch.json()).toMatchObject({ code: 50_035 })
    })

    it('never takes over a guild owned by another setup', async () => {
      const db = await start()
      expect(
        await statusOf('/_test/setup', 'POST', {
          token: OTHER_TOKEN,
          user: { id: OTHER_BOT, username: 'Other' },
        })
      ).toBe(201)
      for (const body of [
        { token: OTHER_TOKEN },
        { application_id: OTHER_BOT },
      ]) {
        const response = await join(body)
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
          message: 'Guild belongs to another setup',
          code: 0,
        })
      }
      expect(
        db
          .prepare('SELECT bot_token, bot_present FROM guilds WHERE id = ?')
          .get(APPEAL)
      ).toEqual({ bot_token: TOKEN, bot_present: 0 })
    })
  })

  describe('reset', () => {
    it('keeps a prepared guild absent and still joinable', async () => {
      const db = await start()
      expect(await statusOf('/_test/reset', 'POST', {})).toBe(204)
      expect(
        db.prepare('SELECT bot_present FROM guilds WHERE id = ?').get(APPEAL)
      ).toEqual({ bot_present: 0 })
      expect(await statusOf('/_test/reset', 'POST', { token: TOKEN })).toBe(204)
      expect(await joinStatus()).toBe(201)
    })

    it('keeps a joined guild attached with its fixtures', async () => {
      const db = await start()
      expect(await joinStatus()).toBe(201)
      expect(await statusOf('/_test/reset', 'POST', { token: TOKEN })).toBe(204)
      expect(
        db.prepare('SELECT bot_present FROM guilds WHERE id = ?').get(APPEAL)
      ).toEqual({ bot_present: 1 })
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?')
          .get(APPEAL)
      ).toEqual({ n: 3 })
      expect(await joinStatus()).toBe(409)
    })

    it('rejoins a left guild after reset', async () => {
      await start()
      expect(await joinStatus()).toBe(201)
      expect(
        await statusOf(
          `/users/@me/guilds/${APPEAL}`,
          'DELETE',
          undefined,
          TOKEN
        )
      ).toBe(204)
      expect(await statusOf('/_test/reset', 'POST', {})).toBe(204)
      expect(await joinStatus()).toBe(201)
      expect(
        await statusOf(`/guilds/${APPEAL}/members`, 'GET', undefined, TOKEN)
      ).toBe(200)
    })
  })
})
