import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { createTestGatewayServer, seedBot, seedGuild } from '../test-helpers'
import type { GatewayPayload } from './protocol'
import type { GuildMemberObject } from '../services/guild-members'

/** Wire client retaining every observed frame. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}
/** Public capture observation subset. */
interface Observation {
  events_captured: {
    id: string
    envelope: GatewayPayload<GuildMemberObject & { guild_id: string }>
    state: string
  }[]
}
const TOKEN = 'Bot live-boost'
const BOT = '111111111111111111'
const HUMAN = '888888888888888888'
const OTHER = '888888888888888889'
const ROOT = '/_test/gateway-event-controls'
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers
const STARTED = '2020-02-29T14:00:00.123456+02:00'
const STARTED_UTC = '2020-02-29T12:00:00.123000+00:00'

describe('live member boost over the Gateway', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let guild: string
  let base: string
  let client: Client
  const clients: Client[] = []

  /** Performs a real HTTP request. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }
  /** Fences socket frames with a heartbeat round trip. */
  async function fence(target = client): Promise<void> {
    const ack = new Promise<void>((resolve) => {
      /** Waits for this socket's heartbeat response. */
      const listener = (raw: Buffer): void => {
        if ((JSON.parse(raw.toString()) as GatewayPayload<unknown>).op !== 11)
          return
        target.ws.off('message', listener)
        resolve()
      }
      target.ws.on('message', listener)
    })
    target.ws.send(JSON.stringify({ op: 1, d: null }))
    await ack
  }
  /** Opens a wire client and identifies through the real protocol. */
  async function connect(intents = INTENTS, token = TOKEN): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token, intents } }))
    await ready
    const target = {
      ws,
      frames,
      sessionId: String(
        frames.find((frame) => frame.t === 'READY')?.d?.session_id
      ),
    }
    clients.push(target)
    await fence(target)
    return target
  }
  /** Changes a live boost through the test-control route. */
  async function boost(
    value: string | null,
    user = HUMAN
  ): Promise<GuildMemberObject> {
    const response = await request(
      `/_test/guilds/${guild}/members/${user}/premium`,
      'POST',
      { premium_since: value }
    )
    expect(response.status).toBe(200)
    return (await response.json()) as GuildMemberObject
  }
  /** Selects member update dispatches. */
  function updates(target = client): Client['frames'] {
    return target.frames.filter((frame) => frame.t === 'GUILD_MEMBER_UPDATE')
  }
  /** Arms a member-selected capture for the main client's session. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_UPDATE'],
      member_id: HUMAN,
      hold: true,
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }
  /** Reads a copy of the public observation. */
  async function observe(id: string): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws:', 'http:')
    seedBot(server.db, TOKEN)
    guild = seedGuild(server.db, TOKEN)
    for (const id of [HUMAN, OTHER]) {
      const user = await request('/_test/users', 'POST', {
        id,
        username: `Human ${id}`,
        global_name: 'Display name',
      })
      expect(user.status).toBe(201)
      const member = await request(
        `/_test/guilds/${guild}/members/${id}`,
        'POST',
        { nick: 'Initial' }
      )
      expect(member.status).toBe(201)
    }
    server.db
      .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
      .run(guild, BOT)
    client = await connect()
  })
  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('delivers one full native update per change and ignores no-ops', async () => {
    const started = await boost(STARTED)
    await fence()
    expect(updates()).toHaveLength(1)
    expect(updates()[0].d).toEqual({ ...started, guild_id: guild })
    expect(updates()[0].d).toMatchObject({
      nick: 'Initial',
      premium_since: STARTED_UTC,
      user: { id: HUMAN, bot: false },
    })

    // Same instant in another notation: stored value is unchanged.
    await boost('2020-02-29T12:00:00.123Z')
    await fence()
    expect(updates()).toHaveLength(1)

    const ended = await boost(null)
    await boost(null)
    await fence()
    expect(updates()).toHaveLength(2)
    expect(updates()[1].d).toEqual({ ...ended, guild_id: guild })
    expect(updates()[1].d?.premium_since).toBeNull()
  })

  it('requires the Guild Members intent and the guild owner setup', async () => {
    const noIntent = await connect(GatewayIntentBits.Guilds)
    seedBot(server.db, 'Bot foreign', '555555555555555555')
    const foreign = await connect(INTENTS, 'foreign')
    const id = await arm({ session_id: noIntent.sessionId })
    await boost(STARTED)
    await Promise.all([fence(), fence(noIntent), fence(foreign)])
    expect(updates()).toHaveLength(1)
    expect(updates(noIntent)).toEqual([])
    expect(updates(foreign)).toEqual([])
    const observed = await observe(id)
    expect(observed.events_captured).toEqual([])

    // A separately assembled app/database never receives this server's update.
    const isolated = await createTestGatewayServer()
    try {
      seedBot(isolated.db, TOKEN)
      seedGuild(isolated.db, TOKEN, guild)
      const ws = new WebSocket(isolated.url)
      const seen: string[] = []
      ws.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as GatewayPayload<unknown>
        if (frame.t) seen.push(frame.t)
      })
      await once(ws, 'message')
      const ready = once(ws, 'message')
      ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: INTENTS } }))
      await ready
      await boost(null)
      ws.send(JSON.stringify({ op: 1, d: null }))
      await once(ws, 'message')
      expect(seen).not.toContain('GUILD_MEMBER_UPDATE')
      ws.terminate()
      for (const session of isolated.sessionManager.getAll())
        isolated.sessionManager.remove(session.sessionId)
    } finally {
      await isolated.close()
    }
  })

  it('holds, releases and replays the update like a nickname change', async () => {
    const id = await arm()
    const started = await boost(STARTED)
    await boost(STARTED_UTC, OTHER) // other member passes through
    await fence()
    expect(updates().map((frame) => frame.d?.user)).toMatchObject([
      { id: OTHER },
    ])
    const held = await observe(id)
    expect(held.events_captured).toHaveLength(1)
    expect(held.events_captured[0].state).toBe('held')
    expect(held.events_captured[0].envelope.d).toEqual({
      ...started,
      guild_id: guild,
    })

    // The stored value changes after capture; release must use the snapshot.
    await boost(null)
    const eventId = held.events_captured[0].id
    for (const path of ['release', 'replay']) {
      const response = await request(`${ROOT}/${id}/${path}`, 'POST', {
        event_ids: [eventId],
      })
      expect(response.status).toBe(200)
    }
    await fence()
    const delivered = updates().filter(
      (frame) => (frame.d?.user as { id: string }).id === HUMAN
    )
    expect(delivered.map((frame) => frame.d)).toEqual([
      { ...started, guild_id: guild },
      { ...started, guild_id: guild },
    ])
    expect(delivered[0].d?.premium_since).toBe(STARTED_UTC)
  })

  it('is reflected by REST reads and the next GUILD_CREATE members', async () => {
    await boost(STARTED)
    const rest = await request(`/api/v10/guilds/${guild}/members/${HUMAN}`)
    expect(await rest.json()).toMatchObject({ premium_since: STARTED_UTC })
    const reconnect = await connect()
    const members = reconnect.frames.find((frame) => frame.t === 'GUILD_CREATE')
      ?.d?.members as GuildMemberObject[]
    expect(
      members.find((member) => member.user.id === HUMAN)?.premium_since
    ).toBe(STARTED_UTC)
    expect(
      members.find((member) => member.user.id === OTHER)?.premium_since
    ).toBeNull()
    await boost(null)
    await fence(reconnect)
    expect(updates(reconnect).at(-1)?.d?.premium_since).toBeNull()
  })
})
