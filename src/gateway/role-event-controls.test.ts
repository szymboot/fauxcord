import assert from 'node:assert/strict'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedRole,
} from '../test-helpers'
import { getRole } from '../services/guild-roles'
import type { GatewayPayload } from './protocol'

/** Wire client with all dispatches retained for ordered assertions. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Capture snapshots returned by the HTTP inspection endpoint. */
interface Observation {
  id: string
  role_id?: string
  skipped: number
  events_captured: {
    id: string
    envelope: GatewayPayload<Record<string, unknown>>
    state: string
    deliveries: number
    last_sequence: number | null
    delivery_records: { source: string }[]
  }[]
}

const TOKEN = 'Bot role-capture'
const ROOT = '/_test/gateway-event-controls'
const BOT = '111111111111111111'
const UNKNOWN_ROLE = '799999999999999999'
const ROLE_EVENTS = [
  'GUILD_ROLE_CREATE',
  'GUILD_ROLE_UPDATE',
  'GUILD_ROLE_DELETE',
]
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers

describe('native guild role capture controls', () => {
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
    body?: unknown,
    token = TOKEN
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Returns only the response status. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Creates a role through the native REST route and returns its ID. */
  async function createRole(
    name: string,
    guildId = guild
  ): Promise<Record<string, unknown>> {
    const response = await request(`/guilds/${guildId}/roles`, 'POST', { name })
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }

  /** Fences preceding Gateway frames with an ordered heartbeat ACK. */
  async function drain(client: Client): Promise<Client['frames']> {
    const ack = new Promise<void>((resolve) => {
      /** Resolves on the ordered heartbeat acknowledgement. */
      const listener = (raw: Buffer): void => {
        if ((JSON.parse(raw.toString()) as GatewayPayload<unknown>).op !== 11)
          return
        client.ws.off('message', listener)
        resolve()
      }
      client.ws.on('message', listener)
    })
    client.ws.send(JSON.stringify({ op: 1, d: null }))
    await ack
    return client.frames.splice(0).filter((frame) => frame.op === 0)
  }

  /** Drains preceding dispatches and returns their event names. */
  async function eventTypes(
    client: Client
  ): Promise<(string | null | undefined)[]> {
    const frames = await drain(client)
    return frames.map((frame) => frame.t)
  }

  /** Identifies a session, retaining every frame. */
  async function connect(
    intents = INTENTS,
    token = TOKEN,
    url = server.url
  ): Promise<Client> {
    const ws = new WebSocket(url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token, intents } }))
    await ready
    const client = {
      ws,
      frames,
      sessionId: String(
        frames.find((frame) => frame.t === 'READY')?.d?.session_id
      ),
    }
    clients.push(client)
    await drain(client)
    return client
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    client = await connect()
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    for (const extra of extraServers.splice(0)) await extra.close()
    await server.close()
  })

  /** Arms a role capture pinned to the selected wire client. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ROLE_EVENTS,
      hold: true,
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
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

  it.each(['new', 'original'])(
    'holds create, update and delete envelopes and releases/replays them with %s sequences',
    async (sequence) => {
      const id = await arm({ allow_original_sequence: true })
      const session = server.sessionManager.get(client.sessionId)
      assert.ok(session)
      const checkpoint = session.seq
      const role = await createRole('first')
      const roleId = String(role.id)
      expect(
        await status(`/guilds/${guild}/roles/${roleId}`, 'PATCH', {
          name: 'second',
        })
      ).toBe(200)
      expect(await status(`/guilds/${guild}/roles/${roleId}`, 'DELETE')).toBe(
        204
      )
      expect(getRole(server.db, guild, roleId)).toBeNull()
      expect(await drain(client)).toEqual([])
      const captured = await captures(id)
      expect(captured.map((entry) => entry.envelope.t)).toEqual(ROLE_EVENTS)
      expect(captured.map((entry) => entry.envelope.s)).toEqual([
        checkpoint + 1,
        checkpoint + 2,
        checkpoint + 3,
      ])
      expect(captured.map((entry) => entry.envelope.d)).toEqual([
        { guild_id: guild, role },
        { guild_id: guild, role: { ...role, name: 'second' } },
        { guild_id: guild, role_id: roleId },
      ])
      for (const event of captured) {
        expect(event).toMatchObject({
          state: 'held',
          deliveries: 0,
          last_sequence: null,
          delivery_records: [],
        })
      }
      const tags = session.replayBuffer.map((entry) => entry.event.t)
      for (const event of ROLE_EVENTS) expect(tags).not.toContain(event)
      expect(
        await status(`${ROOT}/${id}/replay`, 'POST', {
          event_ids: [captured[0].id],
        })
      ).toBe(409)
      const history = session.replayBuffer.length
      const highWater = session.seq
      expect(
        await status(`${ROOT}/${id}/release`, 'POST', {
          event_ids: captured.toReversed().map((entry) => entry.id),
          sequence,
        })
      ).toBe(200)
      expect(
        await status(`${ROOT}/${id}/replay`, 'POST', {
          event_ids: [captured[1].id],
          sequence,
        })
      ).toBe(200)
      const frames = await drain(client)
      expect(frames.map((frame) => frame.t)).toEqual([
        'GUILD_ROLE_DELETE',
        'GUILD_ROLE_UPDATE',
        'GUILD_ROLE_CREATE',
        'GUILD_ROLE_UPDATE',
      ])
      expect(frames.map((frame) => frame.d)).toEqual([
        captured[2].envelope.d,
        captured[1].envelope.d,
        captured[0].envelope.d,
        captured[1].envelope.d,
      ])
      expect(frames.map((frame) => frame.s)).toEqual(
        sequence === 'new'
          ? [highWater + 1, highWater + 2, highWater + 3, highWater + 4]
          : [
              captured[2].envelope.s,
              captured[1].envelope.s,
              captured[0].envelope.s,
              captured[1].envelope.s,
            ]
      )
      expect(session.seq).toBe(highWater + (sequence === 'new' ? 4 : 0))
      expect(session.replayBuffer).toHaveLength(
        history + (sequence === 'new' ? 4 : 0)
      )
      const released = await captures(id)
      expect(released[1]).toMatchObject({
        state: 'released',
        deliveries: 2,
        delivery_records: [{ source: 'release' }, { source: 'replay' }],
      })
      // Neither operation re-applies or reverts the role change.
      expect(getRole(server.db, guild, roleId)).toBeNull()
    }
  )

  it('captures the integration-managed role fixture and observes without hold', async () => {
    const id = await arm({ hold: false })
    const response = await request(`/_test/guilds/${guild}/roles`, 'POST', {
      name: 'Integration',
      managed: true,
    })
    expect(response.status).toBe(201)
    const role = (await response.json()) as Record<string, unknown>
    const frames = await drain(client)
    expect(frames).toMatchObject([
      { t: 'GUILD_ROLE_CREATE', d: { guild_id: guild, role } },
    ])
    expect(await captures(id)).toMatchObject([
      {
        state: 'delivered',
        deliveries: 1,
        last_sequence: frames[0].s,
        envelope: { t: 'GUILD_ROLE_CREATE', d: { role: { managed: true } } },
      },
    ])
  })

  it('captures every update of a bulk position change independently', async () => {
    const first = seedRole(server.db, guild, 'one')
    const second = seedRole(server.db, guild, 'two')
    const id = await arm({ events: ['GUILD_ROLE_UPDATE'] })
    const scoped = await arm({ events: ['GUILD_ROLE_CREATE'] })
    expect(
      await status(`/guilds/${guild}/roles`, 'PATCH', [
        { id: first, position: 7 },
        { id: second, position: 8 },
        { id: UNKNOWN_ROLE, position: 9 },
      ])
    ).toBe(200)
    expect(await drain(client)).toEqual([])
    expect(await captures(scoped)).toEqual([])
    const captured = await captures(id)
    expect(captured).toMatchObject([
      { envelope: { d: { role: { id: first, position: 7 } } } },
      { envelope: { d: { role: { id: second, position: 8 } } } },
    ])
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [captured[1].id],
      })
    ).toBe(200)
    expect(await drain(client)).toMatchObject([
      { t: 'GUILD_ROLE_UPDATE', d: { role: { id: second, position: 8 } } },
    ])
  })

  it('holds update A, delivers update B past the capture limit, then releases A with its original sequence', async () => {
    const role = await createRole('base')
    const roleId = String(role.id)
    await drain(client)
    const id = await arm({
      role_id: roleId,
      events: ['GUILD_ROLE_UPDATE'],
      allow_original_sequence: true,
      limit: 1,
    })
    const patch = (name: string): Promise<number> =>
      status(`/guilds/${guild}/roles/${roleId}`, 'PATCH', { name })
    expect(await patch('A')).toBe(200)
    // The capture limit is exhausted, so B passes through while A stays held.
    expect(await patch('B')).toBe(200)
    expect(await drain(client)).toMatchObject([
      { t: 'GUILD_ROLE_UPDATE', d: { role: { name: 'B' } } },
    ])
    const observation = await observe(id)
    expect(observation.skipped).toBe(1)
    const [held] = observation.events_captured
    const sequenceB = server.sessionManager.get(client.sessionId)?.seq
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [held.id],
        sequence: 'original',
      })
    ).toBe(200)
    const [released] = await drain(client)
    expect(released).toMatchObject({
      t: 'GUILD_ROLE_UPDATE',
      s: held.envelope.s,
      d: { role: { name: 'A' } },
    })
    expect(held.envelope.s).toBeLessThan(sequenceB ?? 0)
    // The database still holds B: release never re-applied A.
    expect(getRole(server.db, guild, roleId)?.name).toBe('B')
  })

  it('holds updates A and B, releases B with a new sequence, then A with its original sequence', async () => {
    const role = await createRole('base')
    const roleId = String(role.id)
    await drain(client)
    const id = await arm({
      role_id: roleId,
      events: ['GUILD_ROLE_UPDATE'],
      allow_original_sequence: true,
    })
    for (const name of ['A', 'B'])
      expect(
        await status(`/guilds/${guild}/roles/${roleId}`, 'PATCH', { name })
      ).toBe(200)
    const [a, b] = await captures(id)
    expect(a.envelope.s).toBeLessThan(b.envelope.s ?? 0)
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', { event_ids: [b.id] })
    ).toBe(200)
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [a.id],
        sequence: 'original',
      })
    ).toBe(200)
    const frames = await drain(client)
    expect(frames.map((frame) => frame.d?.role)).toMatchObject([
      { name: 'B' },
      { name: 'A' },
    ])
    expect(frames[1].s).toBe(a.envelope.s)
    expect(frames[0].s).toBeGreaterThan(b.envelope.s ?? 0)
    expect(getRole(server.db, guild, roleId)?.name).toBe('B')
  })

  it('matches role_id against role.id for create/update and role_id for delete and passes other roles through', async () => {
    const target = seedRole(server.db, guild, 'target')
    const other = seedRole(server.db, guild, 'other')
    const id = await arm({ role_id: target })
    expect(
      await status(`/guilds/${guild}/roles/${other}`, 'PATCH', { name: 'x' })
    ).toBe(200)
    expect(await status(`/guilds/${guild}/roles/${other}`, 'DELETE')).toBe(204)
    const created = await createRole('unrelated')
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    const frames = await drain(client)
    expect(frames.map((frame) => frame.t)).toEqual([
      'GUILD_ROLE_UPDATE',
      'GUILD_ROLE_DELETE',
      'GUILD_ROLE_CREATE',
    ])
    expect(frames.map((frame) => frame.s)).toEqual([
      session.seq - 2,
      session.seq - 1,
      session.seq,
    ])
    expect(frames[2].d).toMatchObject({ role: { id: created.id } })
    expect(await captures(id)).toEqual([])
    expect(
      await status(`/guilds/${guild}/roles/${target}`, 'PATCH', { name: 'y' })
    ).toBe(200)
    expect(await status(`/guilds/${guild}/roles/${target}`, 'DELETE')).toBe(204)
    expect(await drain(client)).toEqual([])
    expect(await captures(id)).toMatchObject([
      { envelope: { t: 'GUILD_ROLE_UPDATE', d: { role: { id: target } } } },
      { envelope: { t: 'GUILD_ROLE_DELETE', d: { role_id: target } } },
    ])
    const observation = await observe(id)
    expect(observation.role_id).toBe(target)
  })

  it('arms a role_id selector for a role that does not exist yet', async () => {
    const id = await arm({ role_id: UNKNOWN_ROLE })
    expect(await status(`${ROOT}/${id}`)).toBe(200)
  })

  it('delivers the captured snapshot after the role changed again or was deleted', async () => {
    const role = await createRole('before')
    const roleId = String(role.id)
    await drain(client)
    const id = await arm({ events: ['GUILD_ROLE_UPDATE'], role_id: roleId })
    expect(
      await status(`/guilds/${guild}/roles/${roleId}`, 'PATCH', {
        name: 'held',
      })
    ).toBe(200)
    expect(await status(`/guilds/${guild}/roles/${roleId}`, 'DELETE')).toBe(204)
    // The delete is outside the selected events and is delivered at once.
    expect(await eventTypes(client)).toEqual(['GUILD_ROLE_DELETE'])
    const [held] = await captures(id)
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', { event_ids: [held.id] })
    ).toBe(200)
    expect(await drain(client)).toMatchObject([
      { t: 'GUILD_ROLE_UPDATE', d: { role: { id: roleId, name: 'held' } } },
    ])
    expect(getRole(server.db, guild, roleId)).toBeNull()
  })

  it('applies overlap rules to role_id selectors', async () => {
    const policy = (extra: Record<string, unknown>): Promise<number> =>
      status(ROOT, 'POST', {
        guild_id: guild,
        bot_id: BOT,
        session_id: client.sessionId,
        ...extra,
      })
    const first = await arm({ role_id: '10', events: ['GUILD_ROLE_UPDATE'] })
    // Different roles, and the same role with a disjoint event type, coexist.
    expect(await policy({ role_id: '11', events: ['GUILD_ROLE_UPDATE'] })).toBe(
      201
    )
    expect(await policy({ role_id: '10', events: ['GUILD_ROLE_DELETE'] })).toBe(
      201
    )
    // The same role and event type, or an unscoped control, conflicts.
    expect(await policy({ role_id: '10', events: ['GUILD_ROLE_UPDATE'] })).toBe(
      409
    )
    expect(
      await policy({ events: ['GUILD_ROLE_UPDATE', 'GUILD_ROLE_CREATE'] })
    ).toBe(409)
    expect(await policy({ events: ['GUILD_ROLE_CREATE'] })).toBe(201)
    // A scoped control conflicts with an existing unscoped one.
    expect(await policy({ role_id: '12', events: ['GUILD_ROLE_CREATE'] })).toBe(
      409
    )
    // Unrelated event types never overlap role controls.
    expect(await policy({ events: ['MESSAGE_CREATE'] })).toBe(201)
    expect(await status(`${ROOT}/${first}`, 'DELETE')).toBe(204)
    expect(await policy({ role_id: '10', events: ['GUILD_ROLE_UPDATE'] })).toBe(
      201
    )
  })

  it('keeps independent role controls separate', async () => {
    const one = seedRole(server.db, guild, 'one')
    const two = seedRole(server.db, guild, 'two')
    const first = await arm({ role_id: one, events: ['GUILD_ROLE_UPDATE'] })
    const second = await arm({ role_id: two, events: ['GUILD_ROLE_UPDATE'] })
    for (const role of [two, one])
      expect(
        await status(`/guilds/${guild}/roles/${role}`, 'PATCH', { name: 'n' })
      ).toBe(200)
    expect(await captures(first)).toMatchObject([
      { envelope: { d: { role: { id: one } } } },
    ])
    expect(await captures(second)).toMatchObject([
      { envelope: { d: { role: { id: two } } } },
    ])
  })

  it('validates role_id and its allowed events', async () => {
    const policy = {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
    }
    for (const role of [null, '', '0', '-1', 123, 'abc', '1'.repeat(21), ' 1'])
      expect(
        await status(ROOT, 'POST', {
          ...policy,
          events: ['GUILD_ROLE_UPDATE'],
          role_id: role,
        })
      ).toBe(400)
    const message =
      'role_id requires every event to be one of GUILD_ROLE_CREATE, GUILD_ROLE_UPDATE, GUILD_ROLE_DELETE'
    for (const events of [
      ['MESSAGE_CREATE'],
      ['GUILD_ROLE_UPDATE', 'GUILD_BAN_ADD'],
      ['GUILD_MEMBER_UPDATE'],
    ]) {
      const response = await request(ROOT, 'POST', {
        ...policy,
        events,
        role_id: '123',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ message, code: 0 })
    }
    // member_id keeps rejecting role events with its own message.
    const memberResponse = await request(ROOT, 'POST', {
      ...policy,
      events: ['GUILD_ROLE_UPDATE'],
      member_id: '123',
    })
    expect(memberResponse.status).toBe(400)
    expect(await memberResponse.json()).toMatchObject({
      message: expect.stringContaining('member_id requires every event'),
    })
    expect(
      await status(ROOT, 'POST', {
        ...policy,
        events: ['GUILD_ROLE_UPDATE'],
        member_id: '123',
        role_id: '123',
      })
    ).toBe(400)
    for (const role of ['1', '12345678901234567890'])
      expect(
        await status(ROOT, 'POST', {
          ...policy,
          events: ['GUILD_ROLE_UPDATE'],
          role_id: role,
        })
      ).toBe(201)
  })

  it('requires the Guilds intent for role captures', async () => {
    const noIntent = await connect(GatewayIntentBits.GuildMembers)
    const filtered = await arm({ session_id: noIntent.sessionId })
    const id = await arm()
    const role = await createRole('seen')
    expect(await captures(filtered)).toEqual([])
    expect(await drain(noIntent)).toEqual([])
    expect(await captures(id)).toMatchObject([
      { envelope: { d: { role: { id: role.id } } } },
    ])
  })

  it('isolates selected session, guild, token, bot and app database', async () => {
    const sibling = await connect()
    seedBot(server.db, 'Bot alias', BOT)
    const alias = await connect(INTENTS, 'Bot alias')
    const other = await createTestGatewayServer()
    extraServers.push(other)
    seedBot(other.db, TOKEN, BOT)
    seedGuild(other.db, TOKEN, guild)
    const otherClient = await connect(INTENTS, TOKEN, other.url)
    const otherResponse = await fetch(
      other.url.replace('ws://', 'http://') + ROOT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guild_id: guild,
          bot_id: BOT,
          events: ROLE_EVENTS,
          session_id: otherClient.sessionId,
          hold: true,
        }),
      }
    )
    expect(otherResponse.status).toBe(201)
    const otherId = ((await otherResponse.json()) as { id: string }).id
    const id = await arm()
    expect(
      await status(ROOT, 'POST', {
        guild_id: guild,
        bot_id: BOT,
        session_id: alias.sessionId,
        events: ROLE_EVENTS,
      })
    ).toBe(404)
    const siblingGuild = seedGuild(server.db, TOKEN, '333333333333333333')
    const role = await createRole('mine')
    await createRole('elsewhere', siblingGuild)
    const mine = await captures(id)
    expect(mine.map((entry) => entry.envelope.d)).toEqual([
      { guild_id: guild, role },
    ])
    expect(await drain(client)).toMatchObject([
      { t: 'GUILD_ROLE_CREATE', d: { guild_id: siblingGuild } },
    ])
    expect(await drain(sibling)).toMatchObject([
      { t: 'GUILD_ROLE_CREATE', d: { guild_id: guild } },
      { t: 'GUILD_ROLE_CREATE', d: { guild_id: siblingGuild } },
    ])
    // The other app's session keeps the ordinary dispatch, uncaptured and unheld.
    expect(await eventTypes(otherClient)).toEqual([
      'GUILD_ROLE_CREATE',
      'GUILD_ROLE_CREATE',
    ])
    const evidence = await fetch(
      `${other.url.replace('ws://', 'http://')}${ROOT}/${otherId}`
    )
    expect(evidence.status).toBe(200)
    expect(await evidence.json()).toMatchObject({ events_captured: [] })
  })

  it('treats role_id as part of keyed ownership policy', async () => {
    const policy = {
      ownership_key: 'role-owner',
      role_id: '5',
      events: ['GUILD_ROLE_UPDATE'],
    }
    const id = await arm(policy)
    expect(await arm(policy)).toBe(id)
    expect(
      await status(ROOT, 'POST', {
        guild_id: guild,
        bot_id: BOT,
        session_id: client.sessionId,
        ...policy,
        role_id: '6',
      })
    ).toBe(409)
    expect(
      await status(ROOT, 'POST', {
        guild_id: guild,
        bot_id: BOT,
        session_id: client.sessionId,
        ...policy,
        role_id: undefined,
      })
    ).toBe(409)
  })

  it.each(['expiry', 'cancel', 'disconnect'])(
    'discards held role snapshots on %s without emitting role events',
    async (cleanup) => {
      const id = await arm(cleanup === 'expiry' ? { ttl_ms: 100 } : {})
      await createRole('held')
      await drain(client)
      const [held] = await captures(id)
      switch (cleanup) {
        case 'expiry': {
          await expect.poll(() => status(`${ROOT}/${id}`)).toBe(404)
          break
        }
        case 'cancel': {
          expect(await status(`${ROOT}/${id}`, 'DELETE')).toBe(204)
          break
        }
        default: {
          const closed = once(client.ws, 'close')
          client.ws.close()
          await closed
        }
      }
      expect(await status(`${ROOT}/${id}`)).toBe(404)
      expect(
        await status(`${ROOT}/${id}/release`, 'POST', { event_ids: [held.id] })
      ).toBe(404)
      if (cleanup !== 'disconnect') expect(await eventTypes(client)).toEqual([])
    }
  )
})
