import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import assert from 'node:assert/strict'
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
  session_id: string
  awaiting_resume: boolean
  pause_resume: boolean
  pending_resume: boolean
  skipped: number
  operations: number
  bytes: number
  delivery_observations_skipped: number
  events_captured: {
    id: string
    envelope: GatewayPayload<GuildMemberObject & { guild_id: string }>
    state: string
    deliveries: number
    last_sequence: number | null
    delivery_records: Delivery[]
  }[]
}
const TOKEN = 'Bot member-controls'
const BOT = '111111111111111111'
const HUMAN = '888888888888888888'
const ROOT = '/_test/gateway-event-controls'
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers

describe('native member update controls HTTP/WS contract', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let guild: string
  let base: string
  let client: Client
  const clients: Client[] = []

  /** Performs a real HTTP request, including production nickname PATCHes. */
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
  /** Opens a wire client and identifies or resumes through the real protocol. */
  async function connect(
    token = TOKEN,
    intents = INTENTS,
    resume?: { session_id: string; seq: number }
  ): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(
      JSON.stringify(
        resume
          ? { op: 6, d: { token, ...resume } }
          : { op: 2, d: { token, intents } }
      )
    )
    await ready
    const target = {
      ws,
      frames,
      sessionId:
        resume?.session_id ??
        String(frames.find((frame) => frame.t === 'READY')?.d?.session_id),
    }
    clients.push(target)
    await fence(target)
    return target
  }
  /** Opens an unbound socket for pending RESUME and replacement scenarios. */
  async function openSocket(): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    const target = { ws, frames, sessionId: '' }
    clients.push(target)
    await once(ws, 'message')
    return target
  }

  /** Arms one member capture with optional exact selector and policy. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_UPDATE'],
      hold: true,
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }
  /** Pauses a native session with its own exact control and resume checkpoint. */
  async function pauseSession(
    target: Client,
    ttlMs = 30_000
  ): Promise<{ id: string; session_id: string; seq: number }> {
    const id = await arm({
      session_id: target.sessionId,
      hold: false,
      ttl_ms: ttlMs,
    })
    const closed = once(target.ws, 'close')
    const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      pause_resume: true,
    })
    expect(response.status).toBe(200)
    const checkpoint = (await response.json()) as { sequence: number }
    await closed
    return { id, session_id: target.sessionId, seq: checkpoint.sequence }
  }

  /** Sends a protocol RESUME and fences the response stream, including gated attempts. */
  async function resumeOn(
    target: Client,
    checkpoint: { session_id: string; seq: number }
  ): Promise<void> {
    target.ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: TOKEN,
          session_id: checkpoint.session_id,
          seq: checkpoint.seq,
        },
      })
    )
    await fence(target)
  }

  /** Reads a copy of the public observation. */
  async function observe(id: string): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }
  /** Mutates a nickname through production REST, asserting its HTTP contract. */
  async function patch(
    nick: string | null,
    user = HUMAN,
    targetGuild = guild
  ): Promise<GuildMemberObject> {
    const response = await request(
      `/api/v10/guilds/${targetGuild}/members/${user}`,
      'PATCH',
      { nick }
    )
    expect(response.status).toBe(200)
    return (await response.json()) as GuildMemberObject
  }
  /** Selects only member update dispatches from the wire. */
  function updates(target = client): Client['frames'] {
    return target.frames.filter((frame) => frame.t === 'GUILD_MEMBER_UPDATE')
  }
  /** Registers a human with real user and membership control routes. */
  async function human(id = HUMAN, targetGuild = guild): Promise<void> {
    const response = await request('/_test/users', 'POST', {
      id,
      username: 'Member human',
      global_name: 'Display name',
      avatar: 'a_original',
    })
    expect(response.status).toBe(201)
    const member = await request(
      `/_test/guilds/${targetGuild}/members/${id}`,
      'POST',
      { nick: 'Initial' }
    )
    expect(member.status).toBe(201)
  }
  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws:', 'http:')
    seedBot(server.db, TOKEN)
    guild = seedGuild(server.db, TOKEN)
    await human()
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

  it.each(['new', 'original'])(
    'holds changed, unchanged and cleared nicknames and replays immutable snapshots with %s sequences',
    async (sequence) => {
      const roleResponse = await request(`/guilds/${guild}/roles`, 'POST', {
        name: 'Captured role',
      })
      expect(roleResponse.status).toBe(200)
      const role = ((await roleResponse.json()) as { id: string }).id
      const result1 = await request(
        `/guilds/${guild}/members/${HUMAN}/roles/${role}`,
        'PUT'
      )
      expect(result1.status).toBe(204)
      await fence()
      client.frames.length = 0
      const peer = await connect()
      const id = await arm({
        member_id: HUMAN,
        allow_original_sequence: sequence === 'original',
      })
      const snapshots = [
        await patch('Changed'),
        await patch('Changed'),
        await patch(null),
      ]
      const captured = await observe(id)
      expect(captured.events_captured).toHaveLength(3)
      expect(captured.skipped).toBe(0)
      expect(captured.events_captured.map((event) => event.envelope.d)).toEqual(
        snapshots.map((member) => ({ ...member, guild_id: guild }))
      )
      for (const event of captured.events_captured) {
        expect(event.state).toBe('held')
        expect(event.delivery_records).toEqual([])
        expect(event.envelope.d.user).toMatchObject({
          id: HUMAN,
          bot: false,
          global_name: 'Display name',
          avatar: 'a_original',
        })
        expect(event.envelope.d.roles).toEqual([role])
      }
      await fence(peer)
      expect(updates(peer)).toHaveLength(3)
      expect(updates()).toHaveLength(0)
      // Change fixtures after capture; release/replay must never reload or mutate them.
      server.db
        .prepare('UPDATE users SET global_name = ?, avatar = ? WHERE id = ?')
        .run('Later', 'later', HUMAN)
      const result2 = await request(
        `/guilds/${guild}/members/${HUMAN}/roles/${role}`,
        'DELETE'
      )
      expect(result2.status).toBe(204)
      const selected = captured.events_captured.toReversed()
      const result3 = await request(`${ROOT}/${id}/release`, 'POST', {
        event_ids: selected.map((event) => event.id),
        sequence,
      })
      expect(result3.status).toBe(200)
      for (let i = 0; i < 2; i += 1) {
        const result4 = await request(`${ROOT}/${id}/replay`, 'POST', {
          event_ids: [selected[0].id],
          sequence,
        })
        expect(result4.status).toBe(200)
      }
      await fence()
      expect(updates().map((frame) => frame.d)).toEqual([
        ...selected.map((event) => event.envelope.d),
        selected[0].envelope.d,
        selected[0].envelope.d,
      ])
      const sequences = updates().map((frame) => Number(frame.s))
      if (sequence === 'original')
        expect(sequences).toEqual([
          ...selected.map((event) => event.envelope.s),
          selected[0].envelope.s,
          selected[0].envelope.s,
        ])
      else
        expect(
          sequences.every((seq, i) => i === 0 || seq > sequences[i - 1])
        ).toBe(true)
      const current = await request(`/guilds/${guild}/members/${HUMAN}`)
      expect(await current.json()).toMatchObject({
        nick: null,
        roles: [],
        user: { global_name: 'Later', avatar: 'later', bot: false },
      })
      const result5 = await observe(id)
      expect(result5.events_captured[2].deliveries).toBe(3)
    }
  )

  it('uses initial native GUILD_CREATE and REST member snapshots as cache inputs, including bot true', async () => {
    const initial = client.frames.find((frame) => frame.t === 'GUILD_CREATE')?.d
      ?.members as GuildMemberObject[]
    expect(initial.find((member) => member.user.id === HUMAN)).toMatchObject({
      nick: 'Initial',
      user: { bot: false, global_name: 'Display name', avatar: 'a_original' },
    })
    expect(initial.find((member) => member.user.id === BOT)?.user.bot).toBe(
      true
    )
    const listed = await request(`/guilds/${guild}/members?limit=1000`)
    expect(await listed.json()).toEqual(initial)
    const id = await arm({ member_id: BOT, hold: false })
    const response = await request(
      `/api/guilds/${guild}/members/@me`,
      'PATCH',
      { nick: 'Bot nick' }
    )
    expect(response.status).toBe(200)
    await fence()
    const result6 = await observe(id)
    expect(result6.events_captured[0].envelope.d.user.bot).toBe(true)
    expect(updates()[0].d?.nick).toBe('Bot nick')
    const noGuilds = await connect(TOKEN, GatewayIntentBits.GuildMembers)
    expect(noGuilds.frames.some((frame) => frame.t === 'GUILD_CREATE')).toBe(
      false
    )
    await patch('No initial cache')
    await fence(noGuilds)
    expect(updates(noGuilds)).toHaveLength(1)
  })

  it('isolates member selectors, guilds, tokens, intents and assembled app databases', async () => {
    const otherHuman = '888888888888888889'
    await human(otherHuman)
    const otherGuild = seedGuild(server.db, TOKEN, '333333333333333333')
    const result7 = await request(
      `/_test/guilds/${otherGuild}/members/${HUMAN}`,
      'POST',
      {}
    )
    expect(result7.status).toBe(201)
    seedBot(server.db, 'Bot alias', BOT)
    seedGuild(server.db, 'Bot alias', '444444444444444444')
    const alias = await connect('alias')
    seedBot(server.db, 'Bot foreign', '555555555555555555')
    const foreign = await connect('foreign')
    const noIntent = await connect(TOKEN, GatewayIntentBits.Guilds)
    const noIntentId = await arm({ session_id: noIntent.sessionId })
    const id = await arm({ member_id: HUMAN })
    const second = await arm({ member_id: otherHuman })
    const conflicting = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_UPDATE'],
    })
    expect(conflicting.status).toBe(409)
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
      await patch('First member')
      await patch('Second member', otherHuman)
      await patch('Other guild', HUMAN, otherGuild)
      await Promise.all([
        fence(),
        fence(alias),
        fence(foreign),
        fence(noIntent),
      ])
      ws.send(JSON.stringify({ op: 1, d: null }))
      await once(ws, 'message')
      expect(seen).not.toContain('GUILD_MEMBER_UPDATE')
      ws.terminate()
      for (const session of isolated.sessionManager.getAll())
        isolated.sessionManager.remove(session.sessionId)
    } finally {
      await isolated.close()
    }
    const result8 = await observe(id)
    expect(
      result8.events_captured.map((event) => event.envelope.d.nick)
    ).toEqual(['First member'])
    const result9 = await observe(second)
    expect(
      result9.events_captured.map((event) => event.envelope.d.nick)
    ).toEqual(['Second member'])
    const result10 = await observe(noIntentId)
    expect(result10.events_captured).toEqual([])
    expect(updates(alias)).toEqual([])
    expect(updates(foreign)).toEqual([])
    expect(updates()).toHaveLength(1)
    expect(updates()[0].d?.guild_id).toBe(otherGuild)
  })

  it('requires explicit acknowledgement for each unique delivery, including duplicate original sequences', async () => {
    const id = await arm({
      application_ack: true,
      allow_original_sequence: true,
    })
    await patch('Ack target')
    const result11 = await observe(id)
    const event = result11.events_captured[0]
    expect(event.delivery_records).toEqual([])
    const result12 = await request(`${ROOT}/${id}/ack`, 'POST', {
      delivery_id: event.id,
      ack_token: event.id,
    })
    expect(result12.status).toBe(404)
    const result13 = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [event.id],
      sequence: 'original',
    })
    expect(result13.status).toBe(200)
    await fence()
    const result14 = await observe(id)
    const first = result14.events_captured[0].delivery_records[0]
    expect(first.transport).toBe('sent')
    expect(first.application).toBe('pending')
    const result15 = await request(`${ROOT}/${id}/ack`, 'POST', {
      delivery_id: first.id,
      ack_token: event.id,
    })
    expect(result15.status).toBe(404)
    const ack = { delivery_id: first.id, ack_token: first.ack_token }
    const acknowledgements = await Promise.all([
      request(`${ROOT}/${id}/ack`, 'POST', ack),
      request(`${ROOT}/${id}/ack`, 'POST', ack),
    ])
    for (const response of acknowledgements) expect(response.status).toBe(200)
    for (let i = 0; i < 2; i += 1) {
      const result16 = await request(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [event.id],
        sequence: 'original',
      })
      expect(result16.status).toBe(200)
    }
    await fence()
    const result17 = await observe(id)
    const records = result17.events_captured[0].delivery_records
    expect(new Set(records.map((record) => record.id)).size).toBe(3)
    expect(new Set(records.map((record) => record.sequence)).size).toBe(1)
    expect(records.map((record) => record.application)).toEqual([
      'acknowledged',
      'pending',
      'pending',
    ])
    // A consuming harness explicitly correlates the last wire callback with this record.
    expect(updates()).toHaveLength(3)
    const result18 = await request(`${ROOT}/${id}/ack`, 'POST', {
      delivery_id: records[2].id,
      ack_token: records[2].ack_token,
    })
    expect(result18.status).toBe(200)
    const result19 = await observe(id)
    expect(result19.events_captured[0].delivery_records[1].application).toBe(
      'pending'
    )
    const result20 = await request(`${ROOT}/${id}`, 'DELETE')
    expect(result20.status).toBe(204)
    const result21 = await request(`${ROOT}/${id}/ack`, 'POST', ack)
    expect(result21.status).toBe(404)
    const fresh = await arm({ hold: false })
    await patch('Without barrier')
    await fence()
    const result22 = await observe(fresh)
    expect(result22.events_captured[0].delivery_records[0].application).toBe(
      'not_requested'
    )
    const result23 = await request(`${ROOT}/${fresh}/ack`, 'POST', ack)
    expect(result23.status).toBe(404)
  })

  it('buffers native updates during deterministic disconnect and observes replay on RESUME without re-mutating DB', async () => {
    const id = await arm({ hold: false, application_ack: true })
    const closed = once(client.ws, 'close')
    const disconnected = await request(`${ROOT}/${id}/disconnect`, 'POST', {})
    expect(disconnected.status).toBe(200)
    const resume = (await disconnected.json()) as {
      session_id: string
      sequence: number
    }
    await closed
    expect(client.frames.some((frame) => frame.op === 7)).toBe(true)
    await patch('Buffered')
    await patch(null)
    const waiting = await observe(id)
    expect(waiting.awaiting_resume).toBe(true)
    expect(waiting.events_captured).toHaveLength(2)
    expect(
      waiting.events_captured.every(
        (event) => event.delivery_records[0].transport === 'buffered'
      )
    ).toBe(true)
    const buffered = waiting.events_captured[0].delivery_records[0]
    const result24 = await request(`${ROOT}/${id}/ack`, 'POST', {
      delivery_id: buffered.id,
      ack_token: buffered.ack_token,
    })
    expect(result24.status).toBe(409)
    const result25 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [waiting.events_captured[0].id],
    })
    expect(result25.status).toBe(409)
    const result26 = await request(`${ROOT}/${id}/disconnect`, 'POST', {})
    expect(result26.status).toBe(409)
    // Bad credentials and an exhausted cursor must not steal or invalidate the control.
    const bad = await connect('wrong', INTENTS, {
      session_id: resume.session_id,
      seq: resume.sequence,
    })
    expect(bad.frames.some((frame) => frame.op === 9)).toBe(true)
    const result27 = await observe(id)
    expect(result27.awaiting_resume).toBe(true)
    client = await connect(TOKEN, INTENTS, {
      session_id: resume.session_id,
      seq: resume.sequence,
    })
    expect(client.frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
    expect(updates().map((frame) => frame.d?.nick)).toEqual(['Buffered', null])
    const resumed = await observe(id)
    expect(resumed.awaiting_resume).toBe(false)
    expect(
      resumed.events_captured[0].delivery_records.map((record) => record.source)
    ).toEqual(['native', 'resume'])
    const delivery = resumed.events_captured[0].delivery_records[1]
    expect(delivery.transport).toBe('sent')
    expect(delivery.application).toBe('pending')
    const result28 = await request(`${ROOT}/${id}/ack`, 'POST', {
      delivery_id: delivery.id,
      ack_token: delivery.ack_token,
    })
    expect(result28.status).toBe(200)
    const result29 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [resumed.events_captured[0].id],
    })
    expect(result29.status).toBe(200)
    await fence()
    expect(updates().map((frame) => frame.d?.nick)).toEqual([
      'Buffered',
      null,
      'Buffered',
    ])
    const result30 = await request(`/guilds/${guild}/members/${HUMAN}`)
    expect(await result30.json()).toMatchObject({ nick: null })
    await patch('Recovered')
    await fence()
    expect(updates().at(-1)?.d?.nick).toBe('Recovered')
  })

  it('validates policies and actions atomically and leaves native failures uncaptured', async () => {
    const policy = {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_MEMBER_UPDATE'],
    }
    for (const extra of [
      { member_id: null },
      { member_id: '*' },
      { member_id: 1 },
      { member_id: HUMAN, events: ['MESSAGE_CREATE'] },
      { member_id: HUMAN, events: ['GUILD_MEMBER_UPDATE', 'MESSAGE_CREATE'] },
      { application_ack: null },
      { application_ack: 1 },
      { limit: 0 },
      { limit: 101 },
      { ttl_ms: 0 },
      { ttl_ms: 60_001 },
    ]) {
      const result31 = await request(ROOT, 'POST', { ...policy, ...extra })
      expect(result31.status).toBe(400)
    }
    const result32 = await request(ROOT, 'POST', {
      ...policy,
      member_id: '999999999999999999',
    })
    expect(result32.status).toBe(404)
    const id = await arm()
    for (const [path, body, token, status] of [
      [`/guilds/${guild}/members/${HUMAN}`, { nick: 1 }, TOKEN, 400],
      [
        `/guilds/${guild}/members/${HUMAN}`,
        { nick: 'x'.repeat(33) },
        TOKEN,
        400,
      ],
      [
        `/guilds/${guild}/members/999999999999999999`,
        { nick: 'x' },
        TOKEN,
        404,
      ],
      [
        `/guilds/999999999999999999/members/${HUMAN}`,
        { nick: 'x' },
        TOKEN,
        404,
      ],
      [`/guilds/${guild}/members/${HUMAN}`, { nick: 'x' }, 'invalid', 401],
    ] as const) {
      const result33 = await request(path, 'PATCH', body, token)
      expect(result33.status).toBe(status)
    }
    const result34 = await observe(id)
    expect(result34.events_captured).toEqual([])
    await patch('x'.repeat(32))
    const result35 = await observe(id)
    const event = result35.events_captured[0]
    for (const action of ['release', 'replay', 'disconnect', 'resume', 'ack']) {
      for (const body of [null, [], 'bad']) {
        const result36 = await request(`${ROOT}/${id}/${action}`, 'POST', body)
        expect(result36.status).toBe(400)
      }
      const malformed = await fetch(base + `${ROOT}/${id}/${action}`, {
        method: 'POST',
        body: '{',
      })
      expect(malformed.status).toBe(400)
    }
    const result37 = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      bogus: true,
    })
    expect(result37.status).toBe(400)
    const result38 = await request(`${ROOT}/${id}/ack`, 'POST', {})
    expect(result38.status).toBe(400)
    for (const body of [
      { event_ids: [] },
      { event_ids: [event.id, event.id] },
      { event_ids: [event.id], sequence: 'bad' },
    ]) {
      const result39 = await request(`${ROOT}/${id}/release`, 'POST', body)
      expect(result39.status).toBe(400)
    }
    const result40 = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [event.id, 'a'.repeat(36)],
    })
    expect(result40.status).toBe(404)
    const result41 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [event.id],
    })
    expect(result41.status).toBe(409)
    const result42 = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [event.id],
      sequence: 'original',
    })
    expect(result42.status).toBe(409)
    const concurrent = await Promise.all([
      request(`${ROOT}/${id}/release`, 'POST', { event_ids: [event.id] }),
      request(`${ROOT}/${id}/release`, 'POST', { event_ids: [event.id] }),
    ])
    expect(
      concurrent.map((response) => response.status).toSorted((a, b) => a - b)
    ).toEqual([200, 409])
    await fence()
    expect(updates()).toHaveLength(1)
  })

  it('bounds native capture count and byte retention, failing open, and release/replay budgets', async () => {
    const id = await arm({ limit: 1, hold: false })
    await patch('First')
    await patch('Overflow')
    await fence()
    expect(updates()).toHaveLength(2)
    const result43 = await observe(id)
    expect(result43.skipped).toBe(1)
    const result44 = await observe(id)
    const event = result44.events_captured[0]
    for (let i = 0; i < 100; i += 1) {
      const result45 = await request(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [event.id],
      })
      expect(result45.status).toBe(200)
    }
    const result46 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [event.id],
    })
    expect(result46.status).toBe(429)
    const result47 = await request(`${ROOT}/${id}/disconnect`, 'POST', {})
    expect(result47.status).toBe(429)
    const result48 = await observe(id)
    expect(result48.operations).toBe(100)
    await request(`${ROOT}/${id}`, 'DELETE')
    const bytesId = await arm({ limit: 100 })
    // Oversized pre-existing identity exercises the real producer's byte budget.
    server.db
      .prepare('UPDATE users SET global_name = ? WHERE id = ?')
      .run('x'.repeat(262_144), HUMAN)
    await patch('Large native snapshot')
    const result49 = await observe(bytesId)
    expect(result49.events_captured).toEqual([])
    const result50 = await observe(bytesId)
    expect(result50.skipped).toBe(1)
    const result51 = await observe(bytesId)
    expect(result51.bytes).toBe(0)
    server.db
      .prepare('UPDATE users SET global_name = NULL WHERE id = ?')
      .run(HUMAN)
    await patch('Fits again')
    const result52 = await observe(bytesId)
    expect(result52.events_captured).toHaveLength(1)
    const result53 = await observe(bytesId)
    expect(result53.bytes).toBeLessThan(262_144)
  })

  it.each([
    'cancel',
    'expiry',
    'disconnect',
    'replace',
    'remove',
    'resume',
    'reset',
    'delete setup',
  ])(
    'cleans held events and pending barriers on %s and recovers with a fresh control',
    async (action) => {
      const id = await arm({
        application_ack: true,
        ttl_ms: action === 'expiry' ? 100 : 30_000,
      })
      await patch('First')
      const result54 = await observe(id)
      const first = result54.events_captured[0]
      const result55 = await request(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [first.id],
      })
      expect(result55.status).toBe(200)
      await fence()
      const result56 = await observe(id)
      const delivery = result56.events_captured[0].delivery_records[0]
      await patch('Held')
      const baseline = updates().length
      switch (action) {
        case 'cancel': {
          await request(`${ROOT}/${id}`, 'DELETE')
          break
        }
        case 'expiry': {
          await expect
            .poll(async () => {
              const result57 = await request(`${ROOT}/${id}`)
              return result57.status
            })
            .toBe(404)
          break
        }
        case 'disconnect': {
          const closed = once(client.ws, 'close')
          client.ws.close()
          await closed
          client = await connect()

          break
        }
        case 'replace': {
          client.ws.send(
            JSON.stringify({ op: 2, d: { token: TOKEN, intents: INTENTS } })
          )
          await fence()
          client.sessionId = String(
            client.frames.findLast((frame) => frame.t === 'READY')?.d
              ?.session_id
          )

          break
        }
        case 'remove': {
          server.sessionManager.remove(client.sessionId)
          client = await connect()

          break
        }
        case 'resume': {
          const session = server.sessionManager.get(client.sessionId)
          assert.ok(session)
          client = await connect(TOKEN, INTENTS, {
            session_id: client.sessionId,
            seq: session.seq,
          })

          break
        }
        case 'reset': {
          await request('/_test/reset', 'POST', { token: TOKEN })
          break
        }
        case 'delete setup': {
          await request('/_test/setup/Bot%20member-controls', 'DELETE')
          // No default

          break
        }
      }
      const result58 = await request(`${ROOT}/${id}`)
      expect(result58.status).toBe(404)
      const result59 = await request(`${ROOT}/${id}/ack`, 'POST', {
        delivery_id: delivery.id,
        ack_token: delivery.ack_token,
      })
      expect(result59.status).toBe(404)
      const result60 = await request(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [first.id],
      })
      expect(result60.status).toBe(404)
      await fence()
      expect(updates().some((frame) => frame.d?.nick === 'Held')).toBe(false)
      if (['cancel', 'expiry', 'replace', 'reset'].includes(action))
        expect(updates()).toHaveLength(baseline)
      if (action === 'delete setup') {
        seedBot(server.db, TOKEN)
        guild = seedGuild(server.db, TOKEN)
        const result61 = await request(
          `/_test/guilds/${guild}/members/${HUMAN}`,
          'POST',
          {}
        )
        expect(result61.status).toBe(201)
      }
      const fresh = await arm({ hold: false })
      await patch('Recovery')
      await fence()
      const result62 = await observe(fresh)
      expect(result62.events_captured).toHaveLength(1)
      expect(updates().at(-1)?.d?.nick).toBe('Recovery')
    }
  )

  it.each(['cancel', 'expiry', 'remove', 'reset'])(
    'cleans up a disconnected resume control on %s',
    async (action) => {
      const originalSession = server.sessionManager.get(client.sessionId)
      assert.ok(originalSession)
      const baselineListeners = originalSession.ws.listenerCount('close')
      const id = await arm({
        hold: false,
        application_ack: true,
        ttl_ms: action === 'expiry' ? 100 : 30_000,
      })
      const closed = once(client.ws, 'close')
      const result63 = await request(`${ROOT}/${id}/disconnect`, 'POST', {})
      expect(result63.status).toBe(200)
      await closed
      await patch('Buffered cleanup')
      const result64 = await observe(id)
      const buffered = result64.events_captured[0].delivery_records[0]
      switch (action) {
        case 'cancel': {
          await request(`${ROOT}/${id}`, 'DELETE')
          break
        }
        case 'expiry': {
          await expect
            .poll(async () => {
              const result65 = await request(`${ROOT}/${id}`)
              return result65.status
            })
            .toBe(404)
          break
        }
        case 'remove': {
          server.sessionManager.remove(client.sessionId)
          break
        }
        case 'reset': {
          await request('/_test/reset', 'POST', {})
          break
        }
      }
      const result66 = await request(`${ROOT}/${id}/ack`, 'POST', {
        delivery_id: buffered.id,
        ack_token: buffered.ack_token,
      })
      expect(result66.status).toBe(404)
      const session = server.sessionManager.get(client.sessionId)
      if (session)
        expect(session.ws.listenerCount('close')).toBe(baselineListeners)
      client = await connect()
      await arm({ hold: false })
      await patch('Reconnected')
      await fence()
      expect(updates().map((frame) => frame.d?.nick)).toEqual(['Reconnected'])
    }
  )
  it('gates an automatic RESUME until native HTTP mutations have been buffered', async () => {
    const id = await arm({ hold: false, application_ack: true })
    const other = await arm({
      guild_id: seedGuild(server.db, TOKEN, '333333333333333333'),
    })
    const closed = once(client.ws, 'close')
    const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      pause_resume: true,
    })
    expect(response.status).toBe(200)
    const checkpoint = (await response.json()) as { sequence: number }
    await closed
    const result67 = await request(`${ROOT}/${other}`)
    expect(result67.status).toBe(404)
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    clients.push({ ws, frames, sessionId: client.sessionId })
    await once(ws, 'message')
    ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: TOKEN,
          session_id: client.sessionId,
          seq: checkpoint.sequence,
        },
      })
    )
    await expect
      .poll(async () => {
        const result68 = await observe(id)
        return result68.pending_resume
      })
      .toBe(true)
    expect(frames.some((frame) => frame.t === 'RESUMED')).toBe(false)
    const competing = await connect(TOKEN, INTENTS, {
      session_id: client.sessionId,
      seq: checkpoint.sequence,
    })
    expect(competing.frames.some((frame) => frame.op === 9)).toBe(true)
    await patch('After automatic resume attempt')
    await patch(null)
    const before = await observe(id)
    expect(before.events_captured).toHaveLength(2)
    expect(
      before.events_captured.every(
        (event) => event.delivery_records[0].transport === 'buffered'
      )
    ).toBe(true)
    const result69 = await request(`${ROOT}/${id}/resume`, 'POST', {})
    expect(result69.status).toBe(200)
    client = { ws, frames, sessionId: client.sessionId }
    await fence()
    expect(updates().map((frame) => frame.d?.nick)).toEqual([
      'After automatic resume attempt',
      null,
    ])
    expect(
      frames.findLast((frame) => frame.t === 'RESUMED')?.s
    ).toBeGreaterThan(updates().at(-1)?.s ?? 0)
    const after = await observe(id)
    expect(after.pending_resume).toBe(false)
    expect(after.pause_resume).toBe(false)
    expect(after.awaiting_resume).toBe(false)
    expect(
      after.events_captured.every(
        (event) => event.delivery_records[1].application === 'pending'
      )
    ).toBe(true)
    const result70 = await request(`${ROOT}/${id}/resume`, 'POST', {})
    expect(result70.status).toBe(409)
    // A second gated disconnect can be opened before a client arrives.
    const closedAgain = once(ws, 'close')
    const result71 = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      pause_resume: true,
    })
    expect(result71.status).toBe(200)
    await closedAgain
    const result72 = await request(`${ROOT}/${id}/resume`, 'POST', {})
    expect(result72.status).toBe(200)
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    client = await connect(TOKEN, INTENTS, {
      session_id: client.sessionId,
      seq: session.seq,
    })
    await patch('Recovered gate')
    await fence()
    expect(updates().at(-1)?.d?.nick).toBe('Recovered gate')
  })

  it.each(['cancel', 'expiry', 'reset'])(
    'closes a pending gated RESUME on %s and allows recovery',
    async (action) => {
      const id = await arm({
        hold: false,
        ttl_ms: action === 'expiry' ? 300 : 30_000,
      })
      const closed = once(client.ws, 'close')
      const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
        pause_resume: true,
      })
      const checkpoint = (await response.json()) as { sequence: number }
      await closed
      const ws = new WebSocket(server.url)
      const frames: Client['frames'] = []
      clients.push({ ws, frames, sessionId: client.sessionId })
      await once(ws, 'message')
      ws.send(
        JSON.stringify({
          op: 6,
          d: {
            token: TOKEN,
            session_id: client.sessionId,
            seq: checkpoint.sequence,
          },
        })
      )
      await expect
        .poll(async () => {
          const result73 = await observe(id)
          return result73.pending_resume
        })
        .toBe(true)
      await patch('Before cancellation')
      const pendingClosed = once(ws, 'close')
      if (action === 'cancel') {
        const result74 = await request(`${ROOT}/${id}`, 'DELETE')
        expect(result74.status).toBe(204)
      } else if (action === 'reset') {
        const result75 = await request('/_test/reset', 'POST', {})
        expect(result75.status).toBe(204)
      }
      await pendingClosed
      const result76 = await request(`${ROOT}/${id}/resume`, 'POST', {})
      expect(result76.status).toBe(404)
      client = await connect()
      const fresh = await arm({ hold: false })
      await patch('New owner')
      await fence()
      const result77 = await observe(fresh)
      expect(result77.events_captured[0].envelope.d.nick).toBe('New owner')
    }
  )

  it('rejects malformed, future and unavailable resume cursors without stealing the retained owner', async () => {
    const id = await arm({ hold: false })
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    const closed = once(client.ws, 'close')
    await request(`${ROOT}/${id}/disconnect`, 'POST', {})
    await closed
    for (const seq of [-1, 0.5, session.seq + 1, 0]) {
      const invalid = await connect(TOKEN, INTENTS, {
        session_id: client.sessionId,
        seq,
      })
      expect(invalid.frames.some((frame) => frame.op === 9)).toBe(true)
      const result78 = await observe(id)
      expect(result78.awaiting_resume).toBe(true)
    }
    client = await connect(TOKEN, INTENTS, {
      session_id: client.sessionId,
      seq: session.seq,
    })
    expect(client.frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
    const result79 = await observe(id)
    expect(result79.awaiting_resume).toBe(false)
  })

  it('bounds resume delivery observations separately and reports overflow truthfully', async () => {
    const id = await arm({ hold: false, limit: 100 })
    for (let i = 0; i < 100; i += 1) await patch(String(i))
    const result80 = await observe(id)
    const event = result80.events_captured[0]
    for (let i = 0; i < 98; i += 1) {
      const result81 = await request(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [event.id],
      })
      expect(result81.status).toBe(200)
    }
    await fence()
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    const last = session.seq
    const closed = once(client.ws, 'close')
    await request(`${ROOT}/${id}/disconnect`, 'POST', {})
    await closed
    client = await connect(TOKEN, INTENTS, {
      session_id: client.sessionId,
      seq: last - 2,
    })
    const resumed = await observe(id)
    expect(
      resumed.events_captured.flatMap((entry) => entry.delivery_records)
    ).toHaveLength(200)
    expect(resumed.delivery_observations_skipped).toBe(0)
    const result82 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [event.id],
    })
    expect(result82.status).toBe(200)
    await fence()
    const overflow = await observe(id)
    expect(overflow.delivery_observations_skipped).toBe(1)
    expect(
      overflow.events_captured.flatMap((entry) => entry.delivery_records)
    ).toHaveLength(200)
    expect(updates()).toHaveLength(3)
    expect(overflow.operations).toBe(100)
    const result83 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [event.id],
    })
    expect(result83.status).toBe(429)
  })
  it('captures empty nicknames and repeated clearing, then replays after native member removal', async () => {
    const id = await arm({
      member_id: HUMAN,
      hold: false,
      limit: 100,
      ttl_ms: 60_000,
    })
    for (const nick of ['', null, null]) await patch(nick)
    await fence()
    const captured = await observe(id)
    expect(
      captured.events_captured.map((event) => event.envelope.d.nick)
    ).toEqual(['', null, null])
    const response = await request(
      `/guilds/${guild}/members/${HUMAN}`,
      'DELETE'
    )
    expect(response.status).toBe(204)
    const replayed = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [captured.events_captured[0].id],
    })
    expect(replayed.status).toBe(200)
    await fence()
    expect(updates().at(-1)?.d).toEqual(captured.events_captured[0].envelope.d)
    const missing = await request(`/guilds/${guild}/members/${HUMAN}`)
    expect(missing.status).toBe(404)
  })

  it('preserves held updates through a controlled resume and recovers after a pending socket closes', async () => {
    const id = await arm({ member_id: HUMAN })
    await patch('Held before disconnect')
    const before = await observe(id)
    const closed = once(client.ws, 'close')
    const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      pause_resume: true,
    })
    const checkpoint = (await response.json()) as { sequence: number }
    await closed
    const ws = new WebSocket(server.url)
    clients.push({ ws, frames: [], sessionId: client.sessionId })
    await once(ws, 'message')
    ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: TOKEN,
          session_id: client.sessionId,
          seq: checkpoint.sequence,
        },
      })
    )
    await expect
      .poll(async () => {
        const observation = await observe(id)
        return observation.pending_resume
      })
      .toBe(true)
    const pendingClosed = once(ws, 'close')
    ws.close()
    await pendingClosed
    await expect
      .poll(async () => {
        const observation = await observe(id)
        return observation.pending_resume
      })
      .toBe(false)
    await patch('Held during disconnect')
    const open = await request(`${ROOT}/${id}/resume`, 'POST', {})
    expect(open.status).toBe(200)
    client = await connect(TOKEN, INTENTS, {
      session_id: client.sessionId,
      seq: checkpoint.sequence + 1,
    })
    // The server high-water checkpoint deliberately includes the held gap.
    expect(client.frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
    expect(updates()).toEqual([])
    const after = await observe(id)
    expect(after.events_captured.map((event) => event.state)).toEqual([
      'held',
      'held',
    ])
    const release = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [after.events_captured[1].id, before.events_captured[0].id],
    })
    expect(release.status).toBe(200)
    await fence()
    expect(updates().map((frame) => frame.d?.nick)).toEqual([
      'Held during disconnect',
      'Held before disconnect',
    ])
  })

  it('captures concurrent production nickname PATCHes in actual native order without snapshot aliasing', async () => {
    const id = await arm({ member_id: HUMAN })
    await Promise.all([patch('Concurrent first'), patch('Concurrent second')])
    const captured = await observe(id)
    expect(captured.events_captured).toHaveLength(2)
    const names = captured.events_captured.map((event) => event.envelope.d.nick)
    expect(new Set(names)).toEqual(
      new Set(['Concurrent first', 'Concurrent second'])
    )
    const current = await request(`/guilds/${guild}/members/${HUMAN}`)
    expect(await current.json()).toMatchObject({ nick: names[1] })
    const released = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: captured.events_captured.map((event) => event.id),
    })
    expect(released.status).toBe(200)
    await fence()
    expect(updates().map((frame) => frame.d?.nick)).toEqual(names)
  })
  it('rejects future cursors before a resume gate even if native updates later reach them', async () => {
    const id = await arm({ hold: false })
    const closed = once(client.ws, 'close')
    const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      pause_resume: true,
    })
    const checkpoint = (await response.json()) as { sequence: number }
    await closed
    const pending = await openSocket()
    pending.ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: TOKEN,
          session_id: client.sessionId,
          seq: checkpoint.sequence + 1,
        },
      })
    )
    await fence(pending)
    const waiting = await observe(id)
    expect(waiting.pending_resume).toBe(false)
    expect(pending.frames.some((frame) => frame.op === 9)).toBe(true)
    await patch('Must not be skipped')
    const opened = await request(`${ROOT}/${id}/resume`, 'POST', {})
    expect(opened.status).toBe(200)
    await fence(pending)
    expect(pending.frames.some((frame) => frame.t === 'RESUMED')).toBe(false)
    pending.ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: TOKEN,
          session_id: client.sessionId,
          seq: checkpoint.sequence,
        },
      })
    )
    await fence(pending)
    expect(updates(pending).map((frame) => frame.d?.nick)).toEqual([
      'Must not be skipped',
    ])
    expect(pending.frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
  })

  it('revalidates a previously valid gated cursor after replay retention expires', async () => {
    const id = await arm({ hold: false, limit: 100 })
    const closed = once(client.ws, 'close')
    const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      pause_resume: true,
    })
    const checkpoint = (await response.json()) as { sequence: number }
    await closed
    const pending = await openSocket()
    pending.ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: TOKEN,
          session_id: client.sessionId,
          seq: checkpoint.sequence,
        },
      })
    )
    await fence(pending)
    const admitted = await observe(id)
    expect(admitted.pending_resume).toBe(true)
    for (let i = 0; i < 101; i += 1) await patch(String(i))
    const opened = await request(`${ROOT}/${id}/resume`, 'POST', {})
    expect(opened.status).toBe(200)
    await fence(pending)
    expect(pending.frames.some((frame) => frame.op === 9)).toBe(true)
    expect(pending.frames.some((frame) => frame.t === 'RESUMED')).toBe(false)
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    pending.ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq: session.seq },
      })
    )
    await fence(pending)
    expect(pending.frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
    const recovered = await observe(id)
    expect(recovered.awaiting_resume).toBe(false)
  })

  it.each([
    { replacement: 'identify', action: 'resume' },
    { replacement: 'identify', action: 'cancel' },
    { replacement: 'identify', action: 'expiry' },
    { replacement: 'resume', action: 'resume' },
    { replacement: 'resume', action: 'cancel' },
  ])(
    'preserves a pending socket after $replacement when the old gate is subject to $action',
    async ({ replacement, action }) => {
      const alternate = replacement === 'resume' ? await connect() : undefined
      const alternateSession =
        alternate && server.sessionManager.get(alternate.sessionId)
      const id = await arm({
        hold: false,
        ttl_ms: action === 'expiry' ? 300 : 30_000,
      })
      const closed = once(client.ws, 'close')
      const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
        pause_resume: true,
      })
      const checkpoint = (await response.json()) as { sequence: number }
      await closed
      const pending = await openSocket()
      pending.ws.send(
        JSON.stringify({
          op: 6,
          d: {
            token: TOKEN,
            session_id: client.sessionId,
            seq: checkpoint.sequence,
          },
        })
      )
      await fence(pending)
      const waiting = await observe(id)
      expect(waiting.pending_resume).toBe(true)
      pending.ws.send(
        JSON.stringify(
          replacement === 'identify'
            ? { op: 2, d: { token: TOKEN, intents: INTENTS } }
            : {
                op: 6,
                d: {
                  token: TOKEN,
                  session_id: alternate?.sessionId,
                  seq: alternateSession?.seq,
                },
              }
        )
      )
      await fence(pending)
      pending.sessionId = String(
        replacement === 'identify'
          ? pending.frames.findLast((frame) => frame.t === 'READY')?.d
              ?.session_id
          : alternate?.sessionId
      )
      const established = server.sessionManager.get(pending.sessionId)
      assert.ok(established)
      const rebound = await observe(id)
      expect(rebound.pending_resume).toBe(false)
      const newControl = await arm({
        session_id: pending.sessionId,
        hold: false,
      })
      await patch('One native update')
      await fence(pending)
      const resumedBefore = pending.frames.filter(
        (frame) => frame.t === 'RESUMED'
      ).length
      if (action === 'resume') {
        const opened = await request(`${ROOT}/${id}/resume`, 'POST', {})
        expect(opened.status).toBe(200)
      } else if (action === 'cancel') {
        const canceled = await request(`${ROOT}/${id}`, 'DELETE')
        expect(canceled.status).toBe(204)
      } else {
        await expect
          .poll(async () => {
            const result = await request(`${ROOT}/${id}`)
            return result.status
          })
          .toBe(404)
      }
      await fence(pending)
      expect(pending.ws.readyState).toBe(WebSocket.OPEN)
      expect(server.sessionManager.get(pending.sessionId)).toBe(established)
      expect(
        pending.frames.filter((frame) => frame.t === 'RESUMED')
      ).toHaveLength(resumedBefore)
      expect(updates(pending).map((frame) => frame.d?.nick)).toEqual([
        'One native update',
      ])
      const retained = await observe(newControl)
      expect(retained.events_captured).toHaveLength(1)
      if (action !== 'resume') return
      const recovered = await connect(TOKEN, INTENTS, {
        session_id: client.sessionId,
        seq: checkpoint.sequence,
      })
      expect(updates(recovered).map((frame) => frame.d?.nick)).toEqual([
        'One native update',
      ])
    }
  )
  it.each(['cancel', 'expiry', 'resume'])(
    'isolates an already-bound socket from another gated session on %s',
    async (action) => {
      const second = await connect()
      const secondSession = server.sessionManager.get(second.sessionId)
      assert.ok(secondSession)
      const secondControl = await arm({
        session_id: second.sessionId,
        hold: false,
      })
      const id = await arm({
        hold: false,
        ttl_ms: action === 'expiry' ? 300 : 30_000,
      })
      const closed = once(client.ws, 'close')
      const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
        pause_resume: true,
      })
      const checkpoint = (await response.json()) as { sequence: number }
      await closed
      second.ws.send(
        JSON.stringify({
          op: 6,
          d: {
            token: TOKEN,
            session_id: client.sessionId,
            seq: checkpoint.sequence,
          },
        })
      )
      await fence(second)
      const observation = await observe(id)
      expect(observation.pending_resume).toBe(false)
      expect(second.frames.some((frame) => frame.op === 9)).toBe(true)
      switch (action) {
        case 'cancel': {
          const canceled = await request(`${ROOT}/${id}`, 'DELETE')
          expect(canceled.status).toBe(204)
          break
        }
        case 'expiry': {
          await expect
            .poll(async () => {
              const result = await request(`${ROOT}/${id}`)
              return result.status
            })
            .toBe(404)
          break
        }
        case 'resume': {
          const opened = await request(`${ROOT}/${id}/resume`, 'POST', {})
          expect(opened.status).toBe(200)
          break
        }
      }
      await fence(second)
      expect(second.ws.readyState).toBe(WebSocket.OPEN)
      expect(server.sessionManager.get(second.sessionId)).toBe(secondSession)
      await patch('Still owned by second session')
      await fence(second)
      expect(updates(second).map((frame) => frame.d?.nick)).toEqual([
        'Still owned by second session',
      ])
      const retained = await observe(secondControl)
      expect(retained.events_captured).toHaveLength(1)
      if (action !== 'resume') return
      const recovered = await connect(TOKEN, INTENTS, {
        session_id: client.sessionId,
        seq: checkpoint.sequence,
      })
      expect(updates(recovered).map((frame) => frame.d?.nick)).toEqual([
        'Still owned by second session',
      ])
    }
  )
  it.each([
    { first: 'A', action: 'cancel', target: 'owner' },
    { first: 'A', action: 'cancel', target: 'other' },
    { first: 'A', action: 'expiry', target: 'owner' },
    { first: 'A', action: 'expiry', target: 'other' },
    { first: 'A', action: 'open', target: 'owner' },
    { first: 'A', action: 'open', target: 'other' },
    { first: 'B', action: 'cancel', target: 'owner' },
    { first: 'B', action: 'cancel', target: 'other' },
    { first: 'B', action: 'expiry', target: 'owner' },
    { first: 'B', action: 'expiry', target: 'other' },
    { first: 'B', action: 'open', target: 'owner' },
    { first: 'B', action: 'open', target: 'other' },
  ])(
    'owns one pending gate when $first resumes first and $target is subject to $action',
    async ({ first, action, target }) => {
      const secondClient = await connect()
      const ownerClient = first === 'A' ? client : secondClient
      const otherClient = first === 'A' ? secondClient : client
      const owner = await pauseSession(
        ownerClient,
        action === 'expiry' && target === 'owner' ? 750 : 30_000
      )
      const other = await pauseSession(
        otherClient,
        action === 'expiry' && target === 'other' ? 750 : 30_000
      )
      const socket = await openSocket()
      await resumeOn(socket, owner)
      await resumeOn(socket, other)
      const original = await observe(owner.id)
      const rejected = await observe(other.id)
      expect(original.pending_resume).toBe(true)
      expect(rejected.pending_resume).toBe(false)
      expect(rejected.awaiting_resume).toBe(true)
      expect(socket.frames.filter((frame) => frame.op === 9)).toHaveLength(1)
      expect(socket.frames.some((frame) => frame.t === 'RESUMED')).toBe(false)
      await patch('Single pending owner')
      const selected = target === 'owner' ? owner : other
      const ownerCloses = action !== 'open' && target === 'owner'
      const closed = ownerCloses ? once(socket.ws, 'close') : undefined
      switch (action) {
        case 'cancel': {
          const response = await request(`${ROOT}/${selected.id}`, 'DELETE')
          expect(response.status).toBe(204)
          break
        }
        case 'expiry': {
          await expect
            .poll(async () => {
              const response = await request(`${ROOT}/${selected.id}`)
              return response.status
            })
            .toBe(404)
          break
        }
        case 'open': {
          const response = await request(
            `${ROOT}/${selected.id}/resume`,
            'POST',
            {}
          )
          expect(response.status).toBe(200)
          break
        }
      }
      if (ownerCloses) {
        await closed
        const unaffected = await observe(other.id)
        expect(unaffected.pending_resume).toBe(false)
        expect(unaffected.awaiting_resume).toBe(true)
        const opened = await request(`${ROOT}/${other.id}/resume`, 'POST', {})
        expect(opened.status).toBe(200)
        const recovered = await connect(TOKEN, INTENTS, other)
        expect(updates(recovered).map((frame) => frame.d?.nick)).toEqual([
          'Single pending owner',
        ])
        const restored = await observe(other.id)
        expect(restored.awaiting_resume).toBe(false)
        return
      }
      await fence(socket)
      expect(socket.ws.readyState).toBe(WebSocket.OPEN)
      if (target === 'other') {
        const retained = await observe(owner.id)
        expect(retained.pending_resume).toBe(true)
        expect(socket.frames.some((frame) => frame.t === 'RESUMED')).toBe(false)
        const opened = await request(`${ROOT}/${owner.id}/resume`, 'POST', {})
        expect(opened.status).toBe(200)
        await fence(socket)
      }
      expect(
        socket.frames.filter((frame) => frame.t === 'RESUMED')
      ).toHaveLength(1)
      expect(updates(socket).map((frame) => frame.d?.nick)).toEqual([
        'Single pending owner',
      ])
      const restored = await observe(owner.id)
      expect(restored.awaiting_resume).toBe(false)
      expect(restored.pending_resume).toBe(false)
      if (action !== 'open') return
      // The unselected gate can open independently and still requires a fresh RESUME.
      if (target === 'owner') {
        const opened = await request(`${ROOT}/${other.id}/resume`, 'POST', {})
        expect(opened.status).toBe(200)
      }
      const otherWaiting = await observe(other.id)
      expect(otherWaiting.pending_resume).toBe(false)
      expect(otherWaiting.awaiting_resume).toBe(true)
      const recovered = await connect(TOKEN, INTENTS, other)
      expect(updates(recovered).map((frame) => frame.d?.nick)).toEqual([
        'Single pending owner',
      ])
    }
  )

  it.each(['identify', 'resume'])(
    'clears unique pending ownership on %s replacement after attempts for two gates',
    async (replacement) => {
      const secondClient = await connect()
      const a = await pauseSession(client)
      const b = await pauseSession(secondClient)
      const socket = await openSocket()
      await resumeOn(socket, a)
      await resumeOn(socket, b)
      const owned = await observe(a.id)
      const rejected = await observe(b.id)
      expect(owned.pending_resume).toBe(true)
      expect(rejected.pending_resume).toBe(false)
      if (replacement === 'identify') {
        socket.ws.send(
          JSON.stringify({ op: 2, d: { token: TOKEN, intents: INTENTS } })
        )
        await fence(socket)
        socket.sessionId = String(
          socket.frames.findLast((frame) => frame.t === 'READY')?.d?.session_id
        )
      } else {
        // Opening B must leave A's ownership intact until the successful protocol replacement.
        const opened = await request(`${ROOT}/${b.id}/resume`, 'POST', {})
        expect(opened.status).toBe(200)
        const stillOwned = await observe(a.id)
        expect(stillOwned.pending_resume).toBe(true)
        await resumeOn(socket, b)
        socket.sessionId = b.session_id
      }
      const established = server.sessionManager.get(socket.sessionId)
      assert.ok(established)
      const cleared = await observe(a.id)
      expect(cleared.pending_resume).toBe(false)
      const liveControl =
        replacement === 'identify'
          ? await arm({ session_id: socket.sessionId, hold: false })
          : b.id
      const resumedBefore = socket.frames.filter(
        (frame) => frame.t === 'RESUMED'
      ).length
      const opened = await request(`${ROOT}/${a.id}/resume`, 'POST', {})
      expect(opened.status).toBe(200)
      const canceled = await request(`${ROOT}/${a.id}`, 'DELETE')
      expect(canceled.status).toBe(204)
      await fence(socket)
      expect(socket.ws.readyState).toBe(WebSocket.OPEN)
      expect(server.sessionManager.get(socket.sessionId)).toBe(established)
      expect(
        socket.frames.filter((frame) => frame.t === 'RESUMED')
      ).toHaveLength(resumedBefore)
      await patch('Replacement scope')
      await fence(socket)
      expect(updates(socket).map((frame) => frame.d?.nick)).toEqual([
        'Replacement scope',
      ])
      const retained = await observe(liveControl)
      expect(retained.events_captured).toHaveLength(1)
    }
  )
  it('keeps two gates independent when each pending RESUME owns a distinct fresh socket', async () => {
    const secondClient = await connect()
    const a = await pauseSession(client)
    const b = await pauseSession(secondClient)
    const firstSocket = await openSocket()
    const secondSocket = await openSocket()
    await Promise.all([resumeOn(firstSocket, a), resumeOn(secondSocket, b)])
    const firstPending = await observe(a.id)
    const secondPending = await observe(b.id)
    expect(firstPending.pending_resume).toBe(true)
    expect(secondPending.pending_resume).toBe(true)
    await patch('Independent sockets')
    const firstClosed = once(firstSocket.ws, 'close')
    const canceled = await request(`${ROOT}/${a.id}`, 'DELETE')
    expect(canceled.status).toBe(204)
    await firstClosed
    await fence(secondSocket)
    const unaffected = await observe(b.id)
    expect(unaffected.pending_resume).toBe(true)
    expect(unaffected.awaiting_resume).toBe(true)
    expect(secondSocket.ws.readyState).toBe(WebSocket.OPEN)
    const opened = await request(`${ROOT}/${b.id}/resume`, 'POST', {})
    expect(opened.status).toBe(200)
    await fence(secondSocket)
    expect(updates(secondSocket).map((frame) => frame.d?.nick)).toEqual([
      'Independent sockets',
    ])
    const restored = await observe(b.id)
    expect(restored.awaiting_resume).toBe(false)
    expect(restored.pending_resume).toBe(false)
  })
})
