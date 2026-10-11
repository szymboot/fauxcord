import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedVoiceChannel,
  seedMember,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'
import type { GuildVoiceState } from '../services/voice-states'

/** Real Gateway connection and frames received by the test client. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Captured envelope and delivery evidence returned by inspection. */
interface CapturedEntry {
  id: string
  envelope: GatewayPayload<Record<string, unknown>>
  state: string
  deliveries: number
  last_sequence: number | null
  delivery_records: {
    id: string
    transport: string
    application: string
    ack_token?: string
  }[]
}

/** Public observation of one control. */
interface Observation {
  id: string
  member_id?: string
  events: string[]
  skipped: number
  awaiting_resume: boolean
  events_captured: CapturedEntry[]
}

const TOKEN = 'Bot voice-filter'
const BOT_ID = '111111111111111111'
const USER_A = '888888888888888888'
const USER_B = '999999999999999999'
const ROOT = '/_test/gateway-event-controls'
const VOICE_INTENTS =
  GatewayIntentBits.GuildVoiceStates | GatewayIntentBits.GuildMembers

describe('member-scoped voice capture controls', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let channel: string
  let client: Client
  const clients: Client[] = []

  /** Calls the test-control and REST APIs over the live HTTP server. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: TOKEN },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Returns only the HTTP status of a request. */
  async function status(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<number> {
    const response = await request(path, method, body)
    return response.status
  }

  /** Waits for a heartbeat ACK to fence preceding frames on a socket. */
  async function fence(target = client): Promise<void> {
    const ack = new Promise<void>((resolve) => {
      /** Resolves once the ordered heartbeat acknowledgement arrives. */
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

  /** Opens a socket and records every frame it receives. */
  async function open(): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const result = { ws, frames, sessionId: '' }
    clients.push(result)
    return result
  }

  /** Opens a connection and identifies with voice and member intents. */
  async function connect(): Promise<Client> {
    const result = await open()
    const ready = once(result.ws, 'message')
    result.ws.send(
      JSON.stringify({ op: 2, d: { token: TOKEN, intents: VOICE_INTENTS } })
    )
    await ready
    result.sessionId = String(
      result.frames.find((frame) => frame.t === 'READY')?.d?.session_id
    )
    return result
  }

  /** Builds a control policy for the default session and guild. */
  function policy(
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      guild_id: guild,
      bot_id: BOT_ID,
      session_id: client.sessionId,
      events: ['VOICE_STATE_UPDATE'],
      hold: true,
      ...extra,
    }
  }

  /** Arms a control and returns its ID. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', policy(extra))
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  /** Inspects a control's captured envelopes. */
  async function observe(id: string): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }

  /** Drives a native voice transition through the typed fixture route. */
  async function transition(
    userId: string,
    body: Record<string, unknown>
  ): Promise<GuildVoiceState> {
    const response = await request(
      `/_test/guilds/${guild}/voice-states/${userId}`,
      'PATCH',
      body
    )
    expect(response.status).toBe(200)
    return (await response.json()) as GuildVoiceState
  }

  /** Returns received voice dispatches as `[user_id, channel_id, s]` tuples. */
  function voices(target = client): [unknown, unknown, number | null][] {
    return target.frames
      .filter((frame) => frame.t === 'VOICE_STATE_UPDATE')
      .map((frame) => [frame.d?.user_id, frame.d?.channel_id, frame.s ?? null])
  }

  /** Returns every dispatch sequence received by a client, in order. */
  function sequences(target = client): number[] {
    return target.frames
      .filter((frame) => frame.op === 0 && frame.t !== 'READY')
      .map((frame) => Number(frame.s))
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN)
    guild = seedGuild(server.db, TOKEN)
    channel = seedVoiceChannel(server.db, guild)
    seedMember(server.db, guild, USER_A)
    seedMember(server.db, guild, USER_B)
    client = await connect()
  })

  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it.each(['new', 'original'] as const)(
    'holds only the selected user and releases with %s sequences while others pass through',
    async (sequence) => {
      const id = await arm({
        member_id: USER_A,
        allow_original_sequence: sequence === 'original',
      })
      const created = await observe(id)
      expect(created.member_id).toBe(USER_A)
      await transition(USER_A, { channel_id: channel })
      await transition(USER_B, { channel_id: channel })
      await transition(USER_A, { channel_id: null })
      await transition(USER_B, { self_stream: true })
      await fence()
      expect(voices().map(([user, chan]) => [user, chan])).toEqual([
        [USER_B, channel],
        [USER_B, channel],
      ])
      const observation = await observe(id)
      expect(observation.skipped).toBe(0)
      expect(
        observation.events_captured.map((event) => [
          event.envelope.d.user_id,
          event.envelope.d.channel_id,
          event.state,
        ])
      ).toEqual([
        [USER_A, channel, 'held'],
        [USER_A, null, 'held'],
      ])
      const [join, leave] = observation.events_captured
      // Other users' events keep their native sequences (held events consume theirs).
      expect(voices().map((entry) => entry[2])).toEqual([
        Number(join.envelope.s) + 1,
        Number(leave.envelope.s) + 1,
      ])
      expect(
        await status(`${ROOT}/${id}/release`, 'POST', {
          event_ids: [leave.id, join.id],
          sequence,
        })
      ).toBe(200)
      await fence()
      const released = voices().slice(2)
      expect(released.map(([user, chan]) => [user, chan])).toEqual([
        [USER_A, null],
        [USER_A, channel],
      ])
      expect(released.map((entry) => entry[2])).toEqual(
        sequence === 'original'
          ? [leave.envelope.s, join.envelope.s]
          : [Number(leave.envelope.s) + 2, Number(leave.envelope.s) + 3]
      )
      expect(
        await status(`${ROOT}/${id}/replay`, 'POST', {
          event_ids: [join.id],
          sequence,
        })
      ).toBe(200)
      await fence()
      expect(voices().at(-1)?.slice(0, 2)).toEqual([USER_A, channel])
      const final = await observe(id)
      expect(final.events_captured.map((event) => event.deliveries)).toEqual([
        2, 1,
      ])
      expect(final.events_captured).toHaveLength(2)
    }
  )

  it('runs independent controls for two users in one guild and session', async () => {
    const holdA = await arm({ member_id: USER_A })
    const observeB = await arm({
      member_id: USER_B,
      hold: false,
      application_ack: true,
    })
    await transition(USER_A, { channel_id: channel })
    await transition(USER_B, { channel_id: channel })
    await transition(USER_A, { self_stream: true })
    await fence()
    expect(voices().map(([user]) => user)).toEqual([USER_B])
    const a = await observe(holdA)
    const b = await observe(observeB)
    expect(a.events_captured.map((event) => event.envelope.d.user_id)).toEqual([
      USER_A,
      USER_A,
    ])
    expect(b.events_captured.map((event) => event.envelope.d.user_id)).toEqual([
      USER_B,
    ])
    expect(b.events_captured[0]).toMatchObject({
      state: 'delivered',
      deliveries: 1,
    })
    const record = b.events_captured[0].delivery_records[0]
    expect(record).toMatchObject({ transport: 'sent', application: 'pending' })
    const acked = await request(`${ROOT}/${observeB}/ack`, 'POST', {
      delivery_id: record.id,
      ack_token: record.ack_token,
    })
    expect(acked.status).toBe(200)
    // A's control cannot address B's capture and vice versa.
    expect(
      await status(`${ROOT}/${holdA}/release`, 'POST', {
        event_ids: [b.events_captured[0].id],
      })
    ).toBe(404)
    expect(
      await status(`${ROOT}/${observeB}/replay`, 'POST', {
        event_ids: [a.events_captured[0].id],
      })
    ).toBe(404)
    // Cancelling A discards its held events without touching B's control.
    expect(await status(`${ROOT}/${holdA}`, 'DELETE')).toBe(204)
    await transition(USER_A, { channel_id: null })
    await transition(USER_B, { channel_id: null })
    await fence()
    expect(voices().map(([user, chan]) => [user, chan])).toEqual([
      [USER_B, channel],
      [USER_A, null],
      [USER_B, null],
    ])
    const remaining = await observe(observeB)
    expect(remaining.events_captured).toHaveLength(2)
    expect(remaining.events_captured[1].envelope.d).toMatchObject({
      user_id: USER_B,
      channel_id: null,
    })
    expect(
      await status(`${ROOT}/${observeB}/replay`, 'POST', {
        event_ids: [remaining.events_captured[0].id],
      })
    ).toBe(200)
    await fence()
    expect(voices().at(-1)?.slice(0, 2)).toEqual([USER_B, channel])
    expect(sequences()).toEqual(
      sequences().toSorted((left, right) => left - right)
    )
  })

  it('scopes member updates and voice states together for one user', async () => {
    const id = await arm({
      member_id: USER_A,
      events: ['VOICE_STATE_UPDATE', 'GUILD_MEMBER_UPDATE'],
    })
    for (const user of [USER_A, USER_B]) {
      expect(
        await status(`/guilds/${guild}/members/${user}`, 'PATCH', {
          nick: `nick-${user}`,
        })
      ).toBe(200)
      await transition(user, { channel_id: channel })
    }
    await fence()
    expect(
      client.frames
        .filter((frame) => frame.op === 0 && frame.t !== 'READY')
        .map((frame) => [
          frame.t,
          frame.d?.user_id ??
            (frame.d?.user as { id?: string } | undefined)?.id,
        ])
        .filter(([event]) => event !== 'GUILD_CREATE')
    ).toEqual([
      ['GUILD_MEMBER_UPDATE', USER_B],
      ['VOICE_STATE_UPDATE', USER_B],
    ])
    const observation = await observe(id)
    expect(
      observation.events_captured.map((event) => event.envelope.t)
    ).toEqual(['GUILD_MEMBER_UPDATE', 'VOICE_STATE_UPDATE'])
  })

  it('validates member selector combinations and overlap with clear errors', async () => {
    for (const events of [
      ['MESSAGE_CREATE'],
      ['VOICE_STATE_UPDATE', 'MESSAGE_REACTION_ADD'],
      ['GUILD_MEMBER_UPDATE', 'VOICE_STATE_UPDATE', 'MESSAGE_DELETE'],
    ]) {
      const response = await request(
        ROOT,
        'POST',
        policy({ member_id: USER_A, events })
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message:
          'member_id requires every event to be one of GUILD_MEMBER_UPDATE, VOICE_STATE_UPDATE',
        code: 0,
      })
    }
    for (const extra of [
      { member_id: null },
      { member_id: '0' },
      { member_id: USER_A, events: ['VOICE_STATE_UPDATE', 'UNKNOWN'] },
      { member_id: USER_A, events: [] },
      {
        member_id: USER_A,
        events: ['VOICE_STATE_UPDATE', 'VOICE_STATE_UPDATE'],
      },
    ]) {
      const response = await request(ROOT, 'POST', policy(extra))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: '400: Bad Request',
        code: 0,
      })
    }
    expect(
      await status(ROOT, 'POST', policy({ member_id: '777777777777777777' }))
    ).toBe(404)
    const voiceA = await arm({ member_id: USER_A })
    // Same member with an overlapping event, or an all-member selector, conflicts.
    expect(await status(ROOT, 'POST', policy({ member_id: USER_A }))).toBe(409)
    expect(
      await status(
        ROOT,
        'POST',
        policy({
          member_id: USER_A,
          events: ['GUILD_MEMBER_UPDATE', 'VOICE_STATE_UPDATE'],
        })
      )
    ).toBe(409)
    expect(await status(ROOT, 'POST', policy())).toBe(409)
    // Disjoint event sets for the same member, and other members, coexist.
    const memberA = await arm({
      member_id: USER_A,
      events: ['GUILD_MEMBER_UPDATE'],
    })
    const voiceB = await arm({ member_id: USER_B })
    for (const id of [voiceA, memberA, voiceB])
      expect(await status(`${ROOT}/${id}`, 'DELETE')).toBe(204)
    const all = await arm()
    expect(await status(ROOT, 'POST', policy({ member_id: USER_A }))).toBe(409)
    expect(await status(`${ROOT}/${all}`, 'DELETE')).toBe(204)
    expect(await status(ROOT, 'POST', policy({ member_id: USER_A }))).toBe(201)
  })

  it('enforces the global control limit with member-scoped controls', async () => {
    const ids: string[] = []
    for (let index = 0; index < 32; index++) {
      const user = seedMember(server.db, guild, String(7_000_000_000 + index))
      ids.push(await arm({ member_id: user }))
    }
    const extra = seedMember(server.db, guild, '7100000000')
    expect(await status(ROOT, 'POST', policy({ member_id: extra }))).toBe(429)
    await transition('7000000005', { channel_id: channel })
    await transition(USER_A, { channel_id: channel })
    await fence()
    expect(voices().map(([user]) => user)).toEqual([USER_A])
    const observation = await observe(ids[5])
    expect(observation.events_captured).toHaveLength(1)
    expect(await status(`${ROOT}/${ids[0]}`, 'DELETE')).toBe(204)
    expect(await status(ROOT, 'POST', policy({ member_id: extra }))).toBe(201)
  })

  it('keys ownership by member policy and closes it by key', async () => {
    const keyed = { ownership_key: 'voice-a', member_id: USER_A }
    const created = await request(ROOT, 'POST', policy(keyed))
    expect(created.status).toBe(201)
    const first = (await created.json()) as Observation
    expect(first.member_id).toBe(USER_A)
    const retried = await request(ROOT, 'POST', policy(keyed))
    expect(retried.status).toBe(201)
    expect(((await retried.json()) as Observation).id).toBe(first.id)
    expect(
      await status(
        ROOT,
        'POST',
        policy({ ownership_key: 'voice-a', member_id: USER_B })
      )
    ).toBe(409)
    await transition(USER_A, { channel_id: channel })
    await transition(USER_B, { channel_id: channel })
    await fence()
    const address = `${ROOT}/by-key/voice-a?bot_id=${BOT_ID}&guild_id=${guild}&session_id=${client.sessionId}`
    const byKey = await request(address)
    expect(byKey.status).toBe(200)
    const observation = (await byKey.json()) as Observation
    expect(
      observation.events_captured.map((event) => event.envelope.d.user_id)
    ).toEqual([USER_A])
    expect(await status(address, 'DELETE')).toBe(204)
    expect(await status(`${ROOT}/${first.id}`)).toBe(404)
    await transition(USER_A, { self_stream: true })
    await fence()
    expect(voices().map(([user]) => user)).toEqual([USER_B, USER_A])
  })

  it('expires a member-scoped control and lets that user pass through again', async () => {
    const id = await arm({ member_id: USER_A, ttl_ms: 200 })
    await transition(USER_A, { channel_id: channel })
    await fence()
    expect(voices()).toHaveLength(0)
    await expect
      .poll(async () => await status(`${ROOT}/${id}`), { timeout: 5000 })
      .toBe(404)
    await transition(USER_A, { self_stream: true })
    await fence()
    expect(voices().map(([user]) => user)).toEqual([USER_A])
  })

  it('keeps held events of the selected user through a gated resume while others replay normally', async () => {
    const id = await arm({ member_id: USER_A })
    await transition(USER_A, { channel_id: channel })
    const closed = once(client.ws, 'close')
    const disconnected = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      pause_resume: true,
    })
    expect(disconnected.status).toBe(200)
    const checkpoint = (await disconnected.json()) as { sequence: number }
    await closed
    // While disconnected, B's event is buffered for resume; A's is held.
    await transition(USER_B, { channel_id: channel })
    await transition(USER_A, { self_stream: true })
    const next = await open()
    next.ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: TOKEN,
          session_id: client.sessionId,
          seq: checkpoint.sequence,
        },
      })
    )
    await fence(next)
    expect(next.frames.some((frame) => frame.t === 'RESUMED')).toBe(false)
    const gated = await observe(id)
    expect(gated.awaiting_resume).toBe(true)
    expect(
      gated.events_captured.map((event) => [
        event.envelope.d.user_id,
        event.state,
      ])
    ).toEqual([
      [USER_A, 'held'],
      [USER_A, 'held'],
    ])
    expect(await status(`${ROOT}/${id}/resume`, 'POST', {})).toBe(200)
    await fence(next)
    expect(next.frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
    expect(voices(next).map(([user]) => user)).toEqual([USER_B])
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: gated.events_captured.map((event) => event.id),
      })
    ).toBe(200)
    await transition(USER_B, { channel_id: null })
    await fence(next)
    expect(voices(next).map(([user, chan]) => [user, chan])).toEqual([
      [USER_B, channel],
      [USER_A, channel],
      [USER_A, channel],
      [USER_B, null],
    ])
    expect(sequences(next)).toEqual(
      sequences(next).toSorted((left, right) => left - right)
    )
  })
})
