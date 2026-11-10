import assert from 'node:assert/strict'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedMember,
  seedRole,
  seedVoiceChannel,
} from '../test-helpers'
import { getGuildBan } from '../services/guild-bans'
import { getGuildMember } from '../services/guild-members'
import { getGuildVoiceState } from '../services/voice-states'
import type { GatewayPayload } from './protocol'

/** Wire client with all dispatches retained for ordered assertions. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Public delivery observation, independent from application execution. */
interface Delivery {
  id: string
  sequence: number | null
  source: string
  transport: string
  application: string
  ack_token?: string
}

/** Capture snapshots returned by the HTTP inspection endpoint. */
interface Observation {
  id: string
  member_id?: string
  skipped: number
  operations: number
  events_captured: {
    id: string
    envelope: GatewayPayload<Record<string, unknown>>
    state: string
    deliveries: number
    last_sequence: number | null
    delivery_records: Delivery[]
  }[]
}

const TOKEN = 'Bot member-remove-capture'
const ROOT = '/_test/gateway-event-controls'
const BOT = '111111111111111111'
const ALICE = '700000000000000001'
const BOB = '700000000000000002'
const CAROL = '700000000000000003'
const UNKNOWN = '799999999999999999'
const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildModeration |
  GatewayIntentBits.GuildVoiceStates

describe('native GUILD_MEMBER_REMOVE capture controls', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let client: Client
  const clients: Client[] = []
  const extraServers: (typeof server)[] = []

  /** Calls the assembled app through the live HTTP server. */
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

  /** Returns only the response status. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Fences preceding Gateway frames with an ordered heartbeat ACK. */
  async function drain(target = client): Promise<Client['frames']> {
    const ack = new Promise<void>((resolve) => {
      /** Resolves on the ordered heartbeat acknowledgement. */
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
    return target.frames.splice(0).filter((frame) => frame.op === 0)
  }

  /** Drains preceding dispatches and returns their event names. */
  async function eventTypes(
    target = client
  ): Promise<(string | null | undefined)[]> {
    const frames = await drain(target)
    return frames.map((frame) => frame.t)
  }

  /** Identifies a session, retaining every frame. */
  async function connect(intents = INTENTS, url = server.url): Promise<Client> {
    const ws = new WebSocket(url)
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
    await drain(target)
    return target
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    seedMember(server.db, guild, ALICE)
    seedMember(server.db, guild, BOB)
    client = await connect()
  })

  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    for (const extra of extraServers.splice(0)) await extra.close()
    await server.close()
  })

  /** Arms a member-removal capture pinned to the selected wire client. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_REMOVE'],
      hold: true,
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  /** Attempts to arm a capture and returns only the HTTP status. */
  async function armStatus(extra: Record<string, unknown>): Promise<number> {
    return status(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_REMOVE'],
      hold: true,
      ...extra,
    })
  }

  /** Reads the public immutable envelopes and delivery evidence. */
  async function observe(id: string): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }

  /** Reads just the captured event list for envelope assertions. */
  async function captures(id: string): Promise<Observation['events_captured']> {
    const observation = await observe(id)
    return observation.events_captured
  }

  /** Puts a member into a voice channel without emitting an event. */
  async function connectVoice(user: string): Promise<string> {
    const voice = seedVoiceChannel(server.db, guild)
    expect(
      await status(`/_test/guilds/${guild}/voice-states/${user}`, 'PATCH', {
        channel_id: voice,
        emit: false,
      })
    ).toBe(200)
    return voice
  }

  it('captures and holds a kick while its voice disconnect is delivered', async () => {
    await connectVoice(ALICE)
    const id = await arm({ member_id: ALICE })
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    const checkpoint = session.seq
    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )
    // The database change commits before capture; only the voice event flows.
    expect(getGuildMember(server.db, guild, ALICE)).toBeNull()
    expect(getGuildVoiceState(server.db, guild, ALICE)).toBeNull()
    expect(await eventTypes()).toEqual(['VOICE_STATE_UPDATE'])
    const captured = await captures(id)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      state: 'held',
      deliveries: 0,
      last_sequence: null,
      delivery_records: [],
      envelope: {
        op: 0,
        t: 'GUILD_MEMBER_REMOVE',
        s: checkpoint + 2,
        d: { guild_id: guild, user: { id: ALICE } },
      },
    })
    // Held originals consume their sequence but never enter RESUME history.
    expect(session.replayBuffer.map((entry) => entry.event.t)).not.toContain(
      'GUILD_MEMBER_REMOVE'
    )
    expect(
      await status(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [captured[0].id],
      })
    ).toBe(409)
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [captured[0].id],
      })
    ).toBe(200)
    const frames = await drain()
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      t: 'GUILD_MEMBER_REMOVE',
      s: session.seq,
      d: captured[0].envelope.d,
    })
    expect(getGuildMember(server.db, guild, ALICE)).toBeNull()
  })

  it('captures a bot-requested kick of a member that was not connected to voice', async () => {
    const id = await arm()
    expect(await status(`/guilds/${guild}/members/${BOB}`, 'DELETE')).toBe(204)
    expect(await drain()).toEqual([])
    expect(await captures(id)).toMatchObject([
      { envelope: { t: 'GUILD_MEMBER_REMOVE', d: { user: { id: BOB } } } },
    ])
  })

  it('captures the member removal of a ban and still delivers its other events', async () => {
    await connectVoice(ALICE)
    const id = await arm({ member_id: ALICE })
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    expect(getGuildBan(server.db, guild, ALICE)).not.toBeNull()
    expect(getGuildMember(server.db, guild, ALICE)).toBeNull()
    expect(await eventTypes()).toEqual(['GUILD_BAN_ADD', 'VOICE_STATE_UPDATE'])
    expect(await captures(id)).toMatchObject([
      {
        state: 'held',
        envelope: {
          t: 'GUILD_MEMBER_REMOVE',
          d: { guild_id: guild, user: { id: ALICE } },
        },
      },
    ])
  })

  it('captures the member removals of a bulk ban in user_ids order', async () => {
    await connectVoice(BOB)
    const id = await arm()
    const response = await request(`/guilds/${guild}/bulk-ban`, 'POST', {
      user_ids: [BOB, ALICE],
    })
    expect(response.status).toBe(200)
    expect(await eventTypes()).toEqual([
      'GUILD_BAN_ADD',
      'VOICE_STATE_UPDATE',
      'GUILD_BAN_ADD',
    ])
    const captured = await captures(id)
    expect(captured.map((entry) => entry.envelope.t)).toEqual([
      'GUILD_MEMBER_REMOVE',
      'GUILD_MEMBER_REMOVE',
    ])
    expect(
      captured.map((entry) => (entry.envelope.d.user as { id: string }).id)
    ).toEqual([BOB, ALICE])
    // A registered non-member has nothing to remove: only a ban event exists.
    expect(
      await status('/_test/users', 'POST', { id: CAROL, username: 'carol' })
    ).toBe(201)
    expect(
      await status(`/guilds/${guild}/bulk-ban`, 'POST', {
        user_ids: [CAROL],
      })
    ).toBe(200)
    expect(await eventTypes()).toEqual(['GUILD_BAN_ADD'])
    expect(await captures(id)).toHaveLength(2)
  })

  it('filters by d.user.id and lets other members pass through untouched', async () => {
    const id = await arm({ member_id: ALICE, hold: false })
    const armed = await observe(id)
    expect(armed.member_id).toBe(ALICE)
    expect(await status(`/guilds/${guild}/members/${BOB}`, 'DELETE')).toBe(204)
    expect(await eventTypes()).toEqual(['GUILD_MEMBER_REMOVE'])
    expect(await captures(id)).toEqual([])
    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )
    expect(await eventTypes()).toEqual(['GUILD_MEMBER_REMOVE'])
    expect(await captures(id)).toMatchObject([
      {
        state: 'delivered',
        deliveries: 1,
        envelope: { d: { user: { id: ALICE } } },
      },
    ])
  })

  it.each(['new', 'original'])(
    'releases a held removal with %s sequence after the user rejoined and was updated',
    async (sequence) => {
      const role = seedRole(server.db, guild)
      const id = await arm({ member_id: ALICE, allow_original_sequence: true })
      const session = server.sessionManager.get(client.sessionId)
      assert.ok(session)
      expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
        204
      )
      const [held] = await captures(id)
      // The member rejoins and receives a role while the leave stays held.
      expect(
        await status(`/_test/guilds/${guild}/members/${ALICE}`, 'POST', {})
      ).toBe(201)
      expect(
        await status(`/guilds/${guild}/members/${ALICE}/roles/${role}`, 'PUT')
      ).toBe(204)
      const later = await drain()
      expect(later.map((frame) => frame.t)).toEqual([
        'GUILD_MEMBER_ADD',
        'GUILD_MEMBER_UPDATE',
      ])
      expect(later.map((frame) => frame.s)).toEqual([
        (held.envelope.s ?? 0) + 1,
        (held.envelope.s ?? 0) + 2,
      ])
      const highWater = session.seq
      const history = session.replayBuffer.length
      expect(getGuildMember(server.db, guild, ALICE)?.roles).toEqual([role])
      expect(
        await status(`${ROOT}/${id}/release`, 'POST', {
          event_ids: [held.id],
          sequence,
        })
      ).toBe(200)
      const [frame] = await drain()
      // Delivered as captured, independent of the member's current state.
      expect(frame).toMatchObject({
        t: 'GUILD_MEMBER_REMOVE',
        d: { guild_id: guild, user: { id: ALICE } },
      })
      expect(frame.d).toEqual(held.envelope.d)
      if (sequence === 'original') {
        expect(frame.s).toBe(held.envelope.s)
        expect(session.seq).toBe(highWater)
        expect(session.replayBuffer).toHaveLength(history)
      } else {
        expect(frame.s).toBe(highWater + 1)
        expect(session.seq).toBe(highWater + 1)
        expect(session.replayBuffer).toHaveLength(history + 1)
      }
      // Release never repeats the removal or touches the rejoined membership.
      expect(getGuildMember(server.db, guild, ALICE)?.roles).toEqual([role])
      const [released] = await captures(id)
      expect(released).toMatchObject({
        state: 'released',
        deliveries: 1,
        last_sequence: frame.s,
      })
    }
  )

  it('rejects original sequence unless allowed and rejects unknown event IDs', async () => {
    const id = await arm()
    expect(await status(`/guilds/${guild}/members/${BOB}`, 'DELETE')).toBe(204)
    const [held] = await captures(id)
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [held.id],
        sequence: 'original',
      })
    ).toBe(409)
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: ['00000000-0000-4000-8000-000000000000'],
      })
    ).toBe(404)
    const [still] = await captures(id)
    expect(still.state).toBe('held')
  })

  it.each(['new', 'original'])(
    'replays a released removal with %s sequence and tracks application acknowledgements',
    async (sequence) => {
      const id = await arm({
        member_id: ALICE,
        hold: false,
        application_ack: true,
        allow_original_sequence: true,
      })
      expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
        204
      )
      expect(await eventTypes()).toEqual(['GUILD_MEMBER_REMOVE'])
      const [delivered] = await captures(id)
      expect(delivered.state).toBe('delivered')
      expect(
        await status(`${ROOT}/${id}/replay`, 'POST', {
          event_ids: [delivered.id],
          sequence,
        })
      ).toBe(200)
      const [replayed] = await drain()
      expect(replayed).toMatchObject({
        t: 'GUILD_MEMBER_REMOVE',
        d: delivered.envelope.d,
      })
      if (sequence === 'original') expect(replayed.s).toBe(delivered.envelope.s)
      else expect(replayed.s).toBeGreaterThan(delivered.envelope.s ?? 0)
      const [after] = await captures(id)
      expect(after.deliveries).toBe(2)
      expect(after.delivery_records.map((entry) => entry.source)).toEqual([
        'native',
        'replay',
      ])
      expect(after.delivery_records.map((entry) => entry.application)).toEqual([
        'pending',
        'pending',
      ])
      const record = after.delivery_records[1]
      expect(
        await status(`${ROOT}/${id}/ack`, 'POST', {
          delivery_id: record.id,
          ack_token: record.ack_token,
        })
      ).toBe(200)
      const [final] = await captures(id)
      const acknowledged = final.delivery_records
      expect(acknowledged.map((entry) => entry.application)).toEqual([
        'pending',
        'acknowledged',
      ])
    }
  )

  it('counts removals over the limit as skipped and delivers them normally', async () => {
    const id = await arm({ limit: 1 })
    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )
    expect(await status(`/guilds/${guild}/members/${BOB}`, 'DELETE')).toBe(204)
    expect(await eventTypes()).toEqual(['GUILD_MEMBER_REMOVE'])
    const observation = await observe(id)
    expect(observation.skipped).toBe(1)
    expect(observation.events_captured).toMatchObject([
      { envelope: { d: { user: { id: ALICE } } } },
    ])
  })

  it('discards held removals when the control is cancelled', async () => {
    const id = await arm()
    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )
    expect(await captures(id)).toHaveLength(1)
    expect(await status(`${ROOT}/${id}`, 'DELETE')).toBe(204)
    expect(await status(`${ROOT}/${id}`)).toBe(404)
    expect(await drain()).toEqual([])
  })

  it('arms for members, departed users and unknown users, but keeps the membership rule of mixed events', async () => {
    // A current member (the normal case: the leave happens after arming).
    expect(await armStatus({ member_id: ALICE })).toBe(201)
    // A user who already left, like bans and joins.
    expect(await status(`/guilds/${guild}/members/${BOB}`, 'DELETE')).toBe(204)
    expect(await armStatus({ member_id: BOB })).toBe(201)
    // Never a member, not even registered.
    expect(await armStatus({ member_id: UNKNOWN })).toBe(201)
    // Mixed with ban and join events, still no membership needed.
    expect(
      await armStatus({
        member_id: CAROL,
        events: ['GUILD_MEMBER_ADD', 'GUILD_BAN_ADD'],
      })
    ).toBe(201)
    // Mixed with update, voice or interaction events the user must be a member.
    for (const event of [
      'GUILD_MEMBER_UPDATE',
      'VOICE_STATE_UPDATE',
      'INTERACTION_CREATE',
    ]) {
      expect(
        await armStatus({
          member_id: BOB,
          events: ['GUILD_MEMBER_REMOVE', event],
        })
      ).toBe(404)
    }
    expect(
      await armStatus({
        member_id: ALICE,
        events: ['GUILD_MEMBER_REMOVE', 'GUILD_MEMBER_UPDATE'],
      })
    ).toBe(409)
    // Malformed selectors and unscoped events are still rejected.
    for (const member of [null, '', '0', 123, 'invalid'])
      expect(await armStatus({ member_id: member })).toBe(400)
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_REMOVE', 'MESSAGE_CREATE'],
      member_id: ALICE,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      message:
        'member_id requires every event to be one of GUILD_MEMBER_ADD, GUILD_MEMBER_UPDATE, GUILD_MEMBER_REMOVE, GUILD_BAN_ADD, GUILD_BAN_REMOVE, VOICE_STATE_UPDATE, INTERACTION_CREATE',
      code: 0,
    })
  })

  it('captures a user who left before arming when the user leaves again', async () => {
    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )
    await drain()
    const id = await arm({ member_id: ALICE })
    expect(
      await status(`/_test/guilds/${guild}/members/${ALICE}`, 'POST', {})
    ).toBe(201)
    await drain()
    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )
    expect(await drain()).toEqual([])
    expect(await captures(id)).toMatchObject([
      { state: 'held', envelope: { d: { user: { id: ALICE } } } },
    ])
  })

  it('conflicts on overlapping removal controls and lets disjoint ones coexist', async () => {
    const alice = await arm({ member_id: ALICE })
    // A different member and a disjoint event type coexist.
    const bob = await arm({ member_id: BOB })
    const bans = await arm({ events: ['GUILD_BAN_ADD', 'GUILD_BAN_REMOVE'] })
    const voice = await arm({
      member_id: ALICE,
      events: ['VOICE_STATE_UPDATE'],
    })
    expect(voice).not.toBe(alice)
    // The same member, or an all-member control, shares GUILD_MEMBER_REMOVE.
    expect(await armStatus({ member_id: ALICE })).toBe(409)
    expect(await armStatus({})).toBe(409)
    expect(
      await armStatus({
        member_id: BOB,
        events: ['GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE'],
      })
    ).toBe(409)
    // Each selected control holds only its own member.
    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )
    expect(await status(`/guilds/${guild}/members/${BOB}`, 'DELETE')).toBe(204)
    expect(await captures(alice)).toMatchObject([
      { envelope: { d: { user: { id: ALICE } } } },
    ])
    expect(await captures(bob)).toMatchObject([
      { envelope: { d: { user: { id: BOB } } } },
    ])
    expect(await captures(bans)).toEqual([])
    // An all-member control cannot be armed beside a selected one, and the
    // other way around.
    expect(await status(`${ROOT}/${alice}`, 'DELETE')).toBe(204)
    expect(await status(`${ROOT}/${bob}`, 'DELETE')).toBe(204)
    const all = await arm()
    expect(await armStatus({ member_id: ALICE })).toBe(409)
    expect(await status(`${ROOT}/${all}`, 'DELETE')).toBe(204)
  })

  it('includes member_id in the ownership-key policy for retries', async () => {
    const key = 'member-remove-retry-key'
    const policy = {
      ownership_key: key,
      events: ['GUILD_MEMBER_REMOVE'],
      member_id: ALICE,
      hold: true,
    }
    const first = await arm(policy)
    expect(await arm(policy)).toBe(first)
    expect(await armStatus({ ...policy, member_id: BOB })).toBe(409)
  })

  it('captures nothing without the Guild Members intent and leaves other sessions alone', async () => {
    const sibling = await connect()
    const noIntent = await connect(GatewayIntentBits.Guilds)
    const id = await arm()
    const filtered = await arm({
      session_id: noIntent.sessionId,
      member_id: ALICE,
    })
    expect(await status(`/guilds/${guild}/members/${ALICE}`, 'DELETE')).toBe(
      204
    )
    expect(await eventTypes(client)).toEqual([])
    expect(await eventTypes(sibling)).toEqual(['GUILD_MEMBER_REMOVE'])
    expect(await eventTypes(noIntent)).toEqual([])
    expect(await captures(id)).toHaveLength(1)
    expect(await captures(filtered)).toEqual([])
  })

  it('ignores removals produced by another app database that shares the same IDs', async () => {
    const other = await createTestGatewayServer()
    extraServers.push(other)
    seedBot(other.db, TOKEN, BOT)
    seedGuild(other.db, TOKEN, guild)
    seedMember(other.db, guild, ALICE)
    const id = await arm({ member_id: ALICE })
    const otherBase = other.url.replace('ws://', 'http://')
    const response = await fetch(
      `${otherBase}/guilds/${guild}/members/${ALICE}`,
      {
        method: 'DELETE',
        headers: { Authorization: TOKEN },
      }
    )
    expect(response.status).toBe(204)
    expect(await drain()).toEqual([])
    expect(await captures(id)).toEqual([])
    expect(getGuildMember(server.db, guild, ALICE)).not.toBeNull()
  })

  it('cancels the control when the bot itself is removed, so its own removal is not held', async () => {
    const id = await arm({ member_id: BOT })
    seedMember(server.db, guild, BOT)
    expect(await status(`/guilds/${guild}/members/${BOT}`, 'DELETE')).toBe(204)
    expect(await status(`${ROOT}/${id}`)).toBe(404)
    // Detaching a bot cancels every capture of the guild, as for other events;
    // nothing remains held and GUILD_DELETE is delivered.
    const types = await eventTypes()
    expect(types.at(-1)).toBe('GUILD_DELETE')
  })
})
