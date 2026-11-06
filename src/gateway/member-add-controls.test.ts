import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'
import type { GuildMemberObject } from '../services/guild-members'

/** Wire client retaining every observed frame. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}
/** Public delivery observation, independent from application execution. */
interface Delivery {
  id: string
  sequence: number
  source: string
  transport: string
  application: string
  ack_token?: string
}
/** Public capture contract exercised over HTTP. */
interface Observation {
  id: string
  member_id?: string
  skipped: number
  operations: number
  events_captured: {
    id: string
    envelope: GatewayPayload<GuildMemberObject & { guild_id: string }>
    state: string
    deliveries: number
    last_sequence: number | null
    delivery_records: Delivery[]
  }[]
}

const TOKEN = 'Bot member-add-controls'
const BOT = '111111111111111111'
const INVITER = '888888888888888880'
const EXISTING = '888888888888888881'
const JOINER = '888888888888888882'
const OTHER = '888888888888888883'
const UNREGISTERED = '888888888888888884'
const ROOT = '/_test/gateway-event-controls'
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers

describe('native GUILD_MEMBER_ADD capture controls', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let guild: string
  let channel: string
  let base: string
  let client: Client
  const clients: Client[] = []

  /** Performs a real HTTP request against the assembled server. */
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
  /** Fences socket frames only; this is never an application completion signal. */
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
  async function connect(intents = INTENTS): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents } }))
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
  /** Arms one capture with an optional member selector and policy. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_ADD'],
      hold: true,
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }
  /** Attempts to arm a capture and returns only the HTTP status. */
  async function armStatus(extra: Record<string, unknown>): Promise<number> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_ADD'],
      hold: true,
      ...extra,
    })
    return response.status
  }
  /** Reads a copy of the public observation. */
  async function observe(id: string): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }
  /** Registers a human user without joining it to the guild. */
  async function register(id: string, username = `user-${id}`): Promise<void> {
    const response = await request('/_test/users', 'POST', { id, username })
    expect(response.status).toBe(201)
  }
  /** Joins a registered human through the production join control. */
  async function join(
    id: string,
    body: Record<string, unknown> = {}
  ): Promise<GuildMemberObject> {
    const response = await request(
      `/_test/guilds/${guild}/members/${id}`,
      'POST',
      body
    )
    expect(response.status).toBe(201)
    return (await response.json()) as GuildMemberObject
  }
  /** Creates a human invite for the seeded channel and returns its code. */
  async function invite(): Promise<string> {
    const response = await request(
      `/_test/channels/${channel}/invites`,
      'POST',
      {
        inviter_id: INVITER,
      }
    )
    expect(response.status).toBe(201)
    return ((await response.json()) as { code: string }).code
  }
  /** Reads the `uses` counter of an invite through the bot REST API. */
  async function usesOf(code: string): Promise<number | undefined> {
    const response = await request(`/api/v10/guilds/${guild}/invites`)
    expect(response.status).toBe(200)
    const invites = (await response.json()) as { code: string; uses: number }[]
    return invites.find((entry) => entry.code === code)?.uses
  }
  /** Selects only member-add dispatches from the wire. */
  function adds(target = client): Client['frames'] {
    return target.frames.filter((frame) => frame.t === 'GUILD_MEMBER_ADD')
  }
  /** Names the dispatches a client observed, in wire order. */
  function dispatches(target = client): (string | null | undefined)[] {
    return target.frames.filter((frame) => frame.op === 0).map((f) => f.t)
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws:', 'http:')
    seedBot(server.db, TOKEN)
    guild = seedGuild(server.db, TOKEN)
    channel = seedChannel(server.db, guild)
    await register(INVITER)
    await register(EXISTING)
    await register(JOINER)
    await register(OTHER)
    await join(INVITER)
    await join(EXISTING)
    client = await connect()
  })
  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it.each([false, true])(
    'holds a join (invite_code: %s) until another event is processed, then releases it',
    async (viaInvite) => {
      const code = viaInvite ? await invite() : undefined
      const id = await arm({ member_id: JOINER, allow_original_sequence: true })
      client.frames.length = 0

      const member = await join(JOINER, {
        nick: 'Joined',
        ...(code !== undefined && { invite_code: code }),
      })
      // The join itself committed: REST sees the member (and the invite use)
      // while the bot has been told nothing yet.
      const stored = await request(`/guilds/${guild}/members/${JOINER}`)
      expect(stored.status).toBe(200)
      if (code !== undefined) expect(await usesOf(code)).toBe(1)
      await fence()
      expect(adds()).toHaveLength(0)

      const held = await observe(id)
      expect(held.skipped).toBe(0)
      expect(held.events_captured).toHaveLength(1)
      const [event] = held.events_captured
      expect(event.state).toBe('held')
      expect(event.delivery_records).toEqual([])
      expect(event.envelope.t).toBe('GUILD_MEMBER_ADD')
      expect(event.envelope.d).toEqual({ ...member, guild_id: guild })
      expect(event.envelope.d.user.id).toBe(JOINER)

      // Another event is processed by the bot first.
      const patched = await request(
        `/api/v10/guilds/${guild}/members/${EXISTING}`,
        'PATCH',
        { nick: 'Earlier' }
      )
      expect(patched.status).toBe(200)
      await fence()
      expect(dispatches()).toEqual(['GUILD_MEMBER_UPDATE'])
      const updateSequence = Number(
        client.frames.find((frame) => frame.t === 'GUILD_MEMBER_UPDATE')?.s
      )

      const released = await request(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [event.id],
      })
      expect(released.status).toBe(200)
      await fence()
      expect(dispatches()).toEqual(['GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_ADD'])
      expect(adds()[0].d).toEqual(event.envelope.d)
      expect(Number(adds()[0].s)).toBeGreaterThan(updateSequence)

      const after = await observe(id)
      expect(after.events_captured[0].state).toBe('released')
      expect(after.events_captured[0].deliveries).toBe(1)
      expect(after.events_captured[0].delivery_records).toMatchObject([
        { source: 'release', transport: 'sent', application: 'not_requested' },
      ])
      // Releasing neither reapplies nor reverts the membership.
      const current = await request(`/guilds/${guild}/members/${JOINER}`)
      expect(await current.json()).toMatchObject({ nick: 'Joined' })
    }
  )

  it('releases several held joins in the requested (native) order and keeps unlisted ones held', async () => {
    const id = await arm()
    await join(JOINER)
    await join(OTHER)
    const captured = await observe(id)
    expect(
      captured.events_captured.map((event) => event.envelope.d.user.id)
    ).toEqual([JOINER, OTHER])
    const [first, second] = captured.events_captured
    expect(first.envelope.s).toBeLessThan(Number(second.envelope.s))

    const partial = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [first.id],
    })
    expect(partial.status).toBe(200)
    await fence()
    expect(adds().map((frame) => (frame.d?.user as { id: string }).id)).toEqual(
      [JOINER]
    )
    const rest = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [second.id],
    })
    expect(rest.status).toBe(200)
    await fence()
    expect(adds().map((frame) => (frame.d?.user as { id: string }).id)).toEqual(
      [JOINER, OTHER]
    )
    // Releasing a delivered event again is rejected.
    const again = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [first.id],
    })
    expect(again.status).toBe(409)
  })

  it('narrows by member_id, which may name a user that has not joined or even registered yet', async () => {
    // JOINER is registered but not a member; UNREGISTERED does not exist.
    const joinerId = await arm({ member_id: JOINER })
    const ghostId = await arm({ member_id: UNREGISTERED })
    const armed = await observe(joinerId)
    expect(armed.member_id).toBe(JOINER)

    await join(OTHER)
    await fence()
    // Another member's join is delivered at once and is not captured.
    expect(adds().map((frame) => (frame.d?.user as { id: string }).id)).toEqual(
      [OTHER]
    )
    const untouched = await observe(joinerId)
    expect(untouched.events_captured).toEqual([])

    await join(JOINER)
    await register(UNREGISTERED)
    await join(UNREGISTERED)
    await fence()
    expect(adds()).toHaveLength(1)
    const joiner = await observe(joinerId)
    expect(
      joiner.events_captured.map((event) => event.envelope.d.user.id)
    ).toEqual([JOINER])
    const ghost = await observe(ghostId)
    expect(
      ghost.events_captured.map((event) => event.envelope.d.user.id)
    ).toEqual([UNREGISTERED])
    expect(ghost.skipped).toBe(0)
  })

  it('applies the member selector overlap rules to join controls', async () => {
    await arm({ member_id: JOINER })
    // Different members coexist; the same member or an all-member control conflict.
    await arm({ member_id: OTHER })
    expect(await armStatus({ member_id: JOINER })).toBe(409)
    expect(await armStatus({})).toBe(409)
    // A disjoint event type for the same member coexists.
    expect(
      await armStatus({ member_id: JOINER, events: ['GUILD_BAN_ADD'] })
    ).toBe(201)
  })

  it('follows the existing combination rules for member_id', async () => {
    // Join events never need current membership when arming.
    expect(
      await armStatus({ member_id: JOINER, events: ['GUILD_MEMBER_ADD'] })
    ).toBe(201)
    // Mixed with bans, a non-member is still allowed.
    expect(
      await armStatus({
        member_id: UNREGISTERED,
        events: ['GUILD_MEMBER_ADD', 'GUILD_BAN_ADD', 'GUILD_BAN_REMOVE'],
      })
    ).toBe(201)
    // Mixed with updates, voice or interactions, the user must be a member.
    for (const other of [
      'GUILD_MEMBER_UPDATE',
      'VOICE_STATE_UPDATE',
      'INTERACTION_CREATE',
    ]) {
      expect(
        await armStatus({
          member_id: OTHER,
          events: ['GUILD_MEMBER_ADD', other],
        })
      ).toBe(404)
    }
    expect(
      await armStatus({
        member_id: EXISTING,
        events: ['GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE'],
      })
    ).toBe(201)
    // Events without a subject user still reject the selector.
    const rejected = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_ADD', 'MESSAGE_CREATE'],
      member_id: JOINER,
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({
      message:
        'member_id requires every event to be one of GUILD_MEMBER_ADD, GUILD_MEMBER_UPDATE, GUILD_BAN_ADD, GUILD_BAN_REMOVE, VOICE_STATE_UPDATE, INTERACTION_CREATE',
      code: 0,
    })
    // role_id is still reserved for role events.
    expect(await armStatus({ role_id: '999999999999999999' })).toBe(400)
  })

  it('holds joins and nickname updates together in one control and releases them in native order', async () => {
    const id = await arm({
      events: ['GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE'],
    })
    client.frames.length = 0
    await join(JOINER)
    const patched = await request(
      `/api/v10/guilds/${guild}/members/${EXISTING}`,
      'PATCH',
      { nick: 'Later' }
    )
    expect(patched.status).toBe(200)
    await fence()
    expect(dispatches()).toEqual([])
    const captured = await observe(id)
    expect(captured.events_captured.map((event) => event.envelope.t)).toEqual([
      'GUILD_MEMBER_ADD',
      'GUILD_MEMBER_UPDATE',
    ])
    const released = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: captured.events_captured.map((event) => event.id),
    })
    expect(released.status).toBe(200)
    await fence()
    expect(dispatches()).toEqual(['GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE'])
  })

  it('observes joins without holding them and replays a released snapshot, with acknowledgements', async () => {
    const id = await arm({
      hold: false,
      application_ack: true,
      allow_original_sequence: true,
    })
    const member = await join(JOINER, { nick: 'Observed' })
    await fence()
    expect(adds()).toHaveLength(1)
    const observed = await observe(id)
    const [event] = observed.events_captured
    expect(event.state).toBe('delivered')
    expect(event.deliveries).toBe(1)
    expect(event.delivery_records).toMatchObject([
      { source: 'native', transport: 'sent', application: 'pending' },
    ])
    expect(event.envelope.d).toEqual({ ...member, guild_id: guild })

    // The member leaves and changes; replay still uses the immutable snapshot.
    const removed = await request(
      `/guilds/${guild}/members/${JOINER}`,
      'DELETE'
    )
    expect(removed.status).toBe(204)
    for (const sequence of ['new', 'original']) {
      const replayed = await request(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [event.id],
        sequence,
      })
      expect(replayed.status).toBe(200)
    }
    await fence()
    expect(adds().map((frame) => frame.d)).toEqual([
      event.envelope.d,
      event.envelope.d,
      event.envelope.d,
    ])
    expect(Number(adds()[1].s)).toBeGreaterThan(Number(adds()[0].s))
    expect(adds()[2].s).toBe(event.envelope.s)
    const replayed = await observe(id)
    expect(replayed.events_captured[0].deliveries).toBe(3)
    expect(
      replayed.events_captured[0].delivery_records.map((entry) => entry.source)
    ).toEqual(['native', 'replay', 'replay'])

    const delivery = replayed.events_captured[0].delivery_records[0]
    const acknowledged = await request(`${ROOT}/${id}/ack`, 'POST', {
      delivery_id: delivery.id,
      ack_token: delivery.ack_token,
    })
    expect(acknowledged.status).toBe(200)
    const final = await observe(id)
    expect(
      final.events_captured[0].delivery_records.map(
        (entry) => entry.application
      )
    ).toEqual(['acknowledged', 'pending', 'pending'])
  })

  it('refuses to replay a held join and keeps other sessions on their ordinary dispatch', async () => {
    const peer = await connect()
    const id = await arm()
    await join(JOINER)
    await fence(peer)
    expect(adds(peer)).toHaveLength(1)
    expect(adds()).toHaveLength(0)
    const held = await observe(id)
    const [event] = held.events_captured
    const replay = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [event.id],
    })
    expect(replay.status).toBe(409)
    const released = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [event.id],
    })
    expect(released.status).toBe(200)
    await fence()
    expect(adds()).toHaveLength(1)
    expect(adds(peer)).toHaveLength(1)
  })

  it('captures nothing without the Guild Members intent', async () => {
    const noIntent = await connect(GatewayIntentBits.Guilds)
    const id = await arm({ session_id: noIntent.sessionId })
    await join(JOINER)
    await fence(noIntent)
    await fence()
    expect(adds(noIntent)).toHaveLength(0)
    const nothing = await observe(id)
    expect(nothing.events_captured).toEqual([])
    // The session that does hold the intent receives its ordinary dispatch.
    expect(adds()).toHaveLength(1)
  })

  it('ignores joins produced by another app database that shares the same IDs', async () => {
    const other = await createTestGatewayServer()
    try {
      const otherBase = other.url.replace('ws:', 'http:')
      seedBot(other.db, TOKEN)
      seedGuild(other.db, TOKEN, guild)
      /** Calls the other app's HTTP API. */
      const otherRequest = (path: string, body: unknown): Promise<Response> =>
        fetch(otherBase + path, {
          method: 'POST',
          headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      const registered = await otherRequest('/_test/users', {
        id: JOINER,
        username: 'foreign',
      })
      expect(registered.status).toBe(201)
      const ws = new WebSocket(other.url)
      await once(ws, 'message')
      const ready = once(ws, 'message')
      ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: INTENTS } }))
      const [readyFrame] = await ready
      const otherSession = (
        JSON.parse(String(readyFrame)) as { d: { session_id: string } }
      ).d.session_id
      const foreignControl = await otherRequest(ROOT, {
        guild_id: guild,
        bot_id: BOT,
        session_id: otherSession,
        events: ['GUILD_MEMBER_ADD'],
        hold: true,
        limit: 1,
      })
      expect(foreignControl.status).toBe(201)
      const foreignId = ((await foreignControl.json()) as { id: string }).id

      const id = await arm({ limit: 1 })
      // A join in the other app is neither captured nor spends this budget.
      const foreignJoin = await otherRequest(
        `/_test/guilds/${guild}/members/${JOINER}`,
        {}
      )
      expect(foreignJoin.status).toBe(201)
      const untouched = await observe(id)
      expect(untouched.events_captured).toEqual([])
      expect(untouched.skipped).toBe(0)
      // This app's own join is still held, and is not captured by the other app.
      await join(OTHER)
      const own = await observe(id)
      expect(own.events_captured).toHaveLength(1)
      expect(own.events_captured[0].envelope.d.user.id).toBe(OTHER)
      const foreign = await fetch(`${otherBase}${ROOT}/${foreignId}`)
      const foreignObservation = (await foreign.json()) as Observation
      expect(
        foreignObservation.events_captured.map(
          (event) => event.envelope.d.user.id
        )
      ).toEqual([JOINER])
      ws.terminate()
      for (const session of other.sessionManager.getAll())
        other.sessionManager.remove(session.sessionId)
    } finally {
      await other.close()
    }
  })

  it('does not capture rejected joins or joins of other guilds', async () => {
    const otherGuild = seedGuild(server.db, TOKEN, '333333333333333333')
    const id = await arm()
    // Already a member: 409 and nothing is emitted.
    const conflict = await request(
      `/_test/guilds/${guild}/members/${EXISTING}`,
      'POST',
      {}
    )
    expect(conflict.status).toBe(409)
    const unknown = await request(
      `/_test/guilds/${guild}/members/${JOINER}`,
      'POST',
      { invite_code: 'missing' }
    )
    expect(unknown.status).toBe(404)
    const elsewhere = await request(
      `/_test/guilds/${otherGuild}/members/${JOINER}`,
      'POST',
      {}
    )
    expect(elsewhere.status).toBe(201)
    await fence()
    const nothing = await observe(id)
    expect(nothing.events_captured).toEqual([])
    expect(adds().map((frame) => frame.d?.guild_id)).toEqual([otherGuild])
  })
})
