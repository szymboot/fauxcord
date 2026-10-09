import { once } from 'node:events'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { GatewayVoiceStateUpdateDispatchData } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedVoiceChannel,
  seedMember,
  seedChannel,
  seedMessage,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'
import type { GuildVoiceState } from '../services/voice-states'

/** Real Gateway connection and frames received by the test client. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Native voice snapshot and server delivery evidence returned by inspection. */
interface Observation {
  id: string
  session_id: string
  skipped: number
  operations: number
  events_captured: {
    id: string
    envelope: GatewayPayload<GatewayVoiceStateUpdateDispatchData>
    state: string
    deliveries: number
    last_sequence: number | null
  }[]
}

const TOKEN = 'Bot voice-capture'
const BOT_ID = '111111111111111111'
const HUMAN_ID = '888888888888888888'
const ROOT = '/_test/gateway-event-controls'

describe('native voice capture controls over HTTP and WebSockets', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let channel: string
  let client: Client
  const clients: Client[] = []

  /** Calls the existing test-control API over its live HTTP server. */
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

  /** Returns a live HTTP response status for bounded validation assertions. */
  async function status(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<number> {
    const response = await request(path, method, body)
    return response.status
  }

  /** Waits for a heartbeat round trip to fence preceding frames on this socket. */
  async function fence(target = client): Promise<void> {
    const ack = new Promise<void>((resolve) => {
      /** Removes the listener when the ordered heartbeat acknowledgement arrives. */
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

  /** Opens a real connection and identifies with the selected setup and intents. */
  async function connect(
    token = TOKEN,
    intents: number = GatewayIntentBits.GuildVoiceStates
  ): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token, intents } }))
    await ready
    const result = {
      ws,
      frames,
      sessionId: String(
        frames.find((frame) => frame.t === 'READY')?.d?.session_id
      ),
    }
    clients.push(result)
    return result
  }

  /** Arms the existing narrow capture API for native voice transitions. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT_ID,
      session_id: client.sessionId,
      events: ['VOICE_STATE_UPDATE'],
      hold: true,
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  /** Inspects immutable captured envelopes and delivery attempt counters. */
  async function observe(id: string): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }

  /** Produces a native transition through the typed voice fixture route. */
  async function transition(
    body: Record<string, unknown>,
    userId = HUMAN_ID,
    guildId = guild
  ): Promise<GuildVoiceState> {
    const response = await request(
      `/_test/guilds/${guildId}/voice-states/${userId}`,
      'PATCH',
      body
    )
    expect(response.status).toBe(200)
    return (await response.json()) as GuildVoiceState
  }

  /** Reads current persisted state through the ordinary authenticated route. */
  async function current(): Promise<unknown> {
    const response = await request(`/guilds/${guild}/voice-states/${HUMAN_ID}`)
    expect(response.status).toBe(200)
    return response.json()
  }

  /** Returns only received native voice dispatches for a client. */
  function voices(target = client): Client['frames'] {
    return target.frames.filter((frame) => frame.t === 'VOICE_STATE_UPDATE')
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN)
    guild = seedGuild(server.db, TOKEN)
    channel = seedVoiceChannel(server.db, guild)
    seedMember(server.db, guild, HUMAN_ID)
    client = await connect()
  })

  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('discovers prepared startup state, delivers live updates and replays held snapshots without stale state on reconnect', async () => {
    const prepared = await transition({
      channel_id: channel,
      self_stream: true,
      emit: false,
    })
    await fence()
    expect(voices()).toHaveLength(0)
    const initiallyClosed = once(client.ws, 'close')
    client.ws.close()
    await initiallyClosed

    const intents =
      GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates
    client = await connect(TOKEN, intents)
    await fence()
    const startup = client.frames.find((frame) => frame.t === 'GUILD_CREATE')
    const { guild_id: preparedGuild, ...startupState } = prepared
    expect(preparedGuild).toBe(guild)
    expect(startup).toMatchObject({ d: { id: guild } })
    expect(startup?.d?.voice_states).toEqual([startupState])
    expect(voices()).toHaveLength(0)
    const selectedSession = client.sessionId

    const stopped = await transition({ self_stream: false })
    await fence()
    expect(stopped.session_id).toBe(prepared.session_id)
    expect(voices()).toHaveLength(1)
    expect(voices()[0].d).toMatchObject(stopped)
    const id = await arm()
    const streaming = await transition({ self_stream: true })
    const movedChannel = seedVoiceChannel(
      server.db,
      guild,
      '777777777777777777'
    )
    const moved = await transition({
      channel_id: movedChannel,
      self_stream: false,
    })
    await fence()
    expect(voices()).toHaveLength(1)
    expect(await current()).toEqual(moved)
    const observation = await observe(id)
    expect(observation.session_id).toBe(selectedSession)
    expect(observation.skipped).toBe(0)
    expect(observation.events_captured).toHaveLength(2)
    const snapshot = observation.events_captured[0]
    expect(snapshot).toMatchObject({
      state: 'held',
      deliveries: 0,
      envelope: { t: 'VOICE_STATE_UPDATE', d: streaming },
    })
    expect(snapshot.envelope.d.session_id).toBe(prepared.session_id)
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [snapshot.id],
      })
    ).toBe(200)
    expect(
      await status(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [snapshot.id],
      })
    ).toBe(200)
    await fence()
    expect(
      voices()
        .slice(1)
        .map((frame) => frame.d)
    ).toEqual([snapshot.envelope.d, snapshot.envelope.d])
    expect(await current()).toEqual(moved)

    const disconnected = await transition({ channel_id: null })
    expect(disconnected.channel_id).toBeNull()
    expect(disconnected.self_stream).toBe(false)
    expect(
      await status(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [snapshot.id],
      })
    ).toBe(200)
    await fence()
    expect(voices()).toHaveLength(4)
    expect(voices().at(-1)?.d).toEqual(snapshot.envelope.d)
    expect(await current()).toEqual(disconnected)
    const finalObservation = await observe(id)
    expect(finalObservation.session_id).toBe(selectedSession)
    expect(finalObservation.events_captured).toHaveLength(3)
    expect(finalObservation.events_captured[0]).toMatchObject({
      envelope: snapshot.envelope,
      state: 'released',
      deliveries: 3,
    })
    expect(
      finalObservation.events_captured.slice(1).map((event) => event.state)
    ).toEqual(['held', 'held'])

    const closed = once(client.ws, 'close')
    client.ws.close()
    await closed
    expect(await status(`${ROOT}/${id}`)).toBe(404)
    expect(
      await status(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [snapshot.id],
      })
    ).toBe(404)
    client = await connect(TOKEN, intents)
    await fence()
    expect(client.sessionId).not.toBe(selectedSession)
    const reconnected = client.frames.find(
      (frame) => frame.t === 'GUILD_CREATE'
    )
    expect(reconnected).toMatchObject({ d: { id: guild, voice_states: [] } })
    expect(voices()).toHaveLength(0)
    expect(await current()).toEqual(disconnected)

    const recovered = await arm({ hold: false })
    const rejoined = await transition({ channel_id: channel })
    await fence()
    expect(rejoined.session_id).not.toBe(prepared.session_id)
    expect(rejoined.self_stream).toBe(false)
    const recoveredObservation = await observe(recovered)
    expect(recoveredObservation.session_id).toBe(client.sessionId)
    expect(recoveredObservation.events_captured).toHaveLength(1)
    expect(recoveredObservation.events_captured[0].envelope.d).toMatchObject(
      rejoined
    )
    expect(voices()).toHaveLength(1)
    expect(voices()[0].d).toEqual(
      recoveredObservation.events_captured[0].envelope.d
    )
  })

  it('captures without hold and replays the original streaming snapshot after later changes', async () => {
    const id = await arm({ hold: false })
    const streaming = await transition({
      channel_id: channel,
      self_stream: true,
    })
    const stopped = await transition({ self_stream: false })
    await fence()
    const observation = await observe(id)
    expect(observation.skipped).toBe(0)
    expect(observation.events_captured).toHaveLength(2)
    const first = observation.events_captured[0]
    expect(first).toMatchObject({
      state: 'delivered',
      deliveries: 1,
      envelope: { t: 'VOICE_STATE_UPDATE', d: streaming },
    })
    expect(voices().map((frame) => frame.d)).toMatchObject([streaming, stopped])
    expect(first.envelope.d.member?.user).toMatchObject({
      id: HUMAN_ID,
      bot: false,
    })
    expect(
      await status(`/guilds/${guild}/members/${HUMAN_ID}`, 'PATCH', {
        nick: 'Changed after capture',
      })
    ).toBe(200)
    for (let i = 0; i < 2; i += 1) {
      const replay = await request(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [first.id],
      })
      expect(replay.status).toBe(200)
    }
    await fence()
    expect(voices().map((frame) => frame.d)).toEqual([
      first.envelope.d,
      observation.events_captured[1].envelope.d,
      first.envelope.d,
      first.envelope.d,
    ])
    expect(await current()).toEqual(stopped)
    const observation1 = await observe(id)
    expect(observation1.events_captured[0]).toMatchObject({
      envelope: first.envelope,
      deliveries: 3,
      state: 'delivered',
      last_sequence: voices().at(-1)?.s,
    })
  })

  it('captures only emitted transitions, excluding silent, unchanged and rejected writes', async () => {
    const id = await arm({ hold: false })
    await transition({ channel_id: channel, emit: false })
    const streaming = await transition({ self_stream: true })
    await transition({ self_stream: true })
    await transition({ self_stream: false, emit: false })
    expect(
      await status(`/_test/guilds/${guild}/voice-states/${HUMAN_ID}`, 'PATCH', {
        self_stream: 1,
      })
    ).toBe(400)
    expect(
      await status(`/_test/guilds/${guild}/voice-states/123`, 'PATCH', {
        channel_id: channel,
      })
    ).toBe(404)
    await fence()
    const observation = await observe(id)
    expect(observation.skipped).toBe(0)
    expect(observation.events_captured).toHaveLength(1)
    expect(observation.events_captured[0].envelope.d).toMatchObject(streaming)
    expect(voices()).toHaveLength(1)
    expect(voices()[0].d).toEqual(observation.events_captured[0].envelope.d)
    expect(await current()).toMatchObject({ self_stream: false })
  })

  it.each(['new', 'original'])(
    'releases multiple users, moves and disconnect in chosen order with %s sequences',
    async (sequence) => {
      const secondChannel = seedVoiceChannel(
        server.db,
        guild,
        '777777777777777777'
      )
      const secondUser = seedMember(server.db, guild, '999999999999999999')
      const id = await arm({ allow_original_sequence: true })
      const streaming = await transition({
        channel_id: channel,
        self_stream: true,
      })
      const moved = await transition({
        channel_id: secondChannel,
        self_stream: false,
      })
      const otherUser = await transition({ channel_id: channel }, secondUser)
      const disconnected = await transition({ channel_id: null })
      await fence()
      expect(voices()).toHaveLength(0)
      expect(await current()).toEqual(disconnected)
      const observation = await observe(id)
      expect(observation.skipped).toBe(0)
      expect(
        observation.events_captured.map((event) => event.envelope.d)
      ).toMatchObject([streaming, moved, otherUser, disconnected])
      expect(disconnected.channel_id).toBeNull()
      const session = server.sessionManager.get(client.sessionId)
      assert.ok(session)
      expect(
        session.replayBuffer.some(
          (entry) => entry.event.t === 'VOICE_STATE_UPDATE'
        )
      ).toBe(false)
      const highWater = session.seq
      const historySize = session.replayBuffer.length
      const reversed = observation.events_captured.toReversed()
      const release = await request(`${ROOT}/${id}/release`, 'POST', {
        event_ids: reversed.map((event) => event.id),
        sequence,
      })
      expect(release.status).toBe(200)
      for (let i = 0; i < 2; i += 1) {
        const replay = await request(`${ROOT}/${id}/replay`, 'POST', {
          event_ids: [observation.events_captured[0].id],
          sequence,
        })
        expect(replay.status).toBe(200)
      }
      await fence()
      expect(voices().map((frame) => frame.d)).toEqual([
        ...reversed.map((event) => event.envelope.d),
        observation.events_captured[0].envelope.d,
        observation.events_captured[0].envelope.d,
      ])
      expect(await current()).toEqual(disconnected)
      expect(session.seq).toBe(highWater + (sequence === 'new' ? 6 : 0))
      expect(session.replayBuffer.length).toBe(
        historySize + (sequence === 'new' ? 6 : 0)
      )
      expect(voices().map((frame) => frame.s)).toEqual(
        sequence === 'new'
          ? Array.from({ length: 6 }, (_, i) => highWater + i + 1)
          : [
              ...reversed.map((event) => event.envelope.s),
              observation.events_captured[0].envelope.s,
              observation.events_captured[0].envelope.s,
            ]
      )
      const observation2 = await observe(id)
      expect(observation2.events_captured[0]).toMatchObject({
        envelope: observation.events_captured[0].envelope,
        deliveries: 3,
        state: 'released',
      })
    }
  )

  it('isolates guild, bot setup, selected session and intent before capture', async () => {
    const otherSession = await connect()
    const noIntent = await connect(TOKEN, 0)
    seedBot(server.db, 'Bot alias', BOT_ID)
    const alias = await connect('Bot alias')
    seedBot(server.db, 'Bot other', '444444444444444444')
    const otherBot = await connect('Bot other')
    const otherGuild = seedGuild(server.db, 'Bot other', '666666666666666666')
    const otherChannel = seedVoiceChannel(
      server.db,
      otherGuild,
      '777777777777777777'
    )
    seedMember(server.db, otherGuild, HUMAN_ID)
    const siblingGuild = seedGuild(server.db, TOKEN, '999999999999999999')
    const siblingChannel = seedVoiceChannel(
      server.db,
      siblingGuild,
      '777777777777777778'
    )
    seedMember(server.db, siblingGuild, HUMAN_ID)
    const id = await arm()
    const filtered = await arm({ session_id: noIntent.sessionId })
    const otherControl = await arm({
      guild_id: otherGuild,
      bot_id: '444444444444444444',
      session_id: otherBot.sessionId,
    })
    const owned = await transition({ channel_id: channel, self_stream: true })
    const sibling = await transition(
      { channel_id: siblingChannel },
      HUMAN_ID,
      siblingGuild
    )
    const unrelated = await transition(
      { channel_id: otherChannel },
      HUMAN_ID,
      otherGuild
    )
    for (const target of clients) await fence(target)
    const observation3 = await observe(id)
    expect(
      observation3.events_captured.map((event) => event.envelope.d)
    ).toMatchObject([owned])
    const observation4 = await observe(filtered)
    expect(observation4.events_captured).toHaveLength(0)
    expect(voices().map((frame) => frame.d)).toMatchObject([sibling])
    expect(voices(otherSession).map((frame) => frame.d)).toMatchObject([
      owned,
      sibling,
    ])
    expect(voices(noIntent)).toHaveLength(0)
    expect(voices(alias)).toHaveLength(0)
    expect(voices(otherBot)).toHaveLength(0)
    const otherObservation = await observe(otherControl)
    expect(otherObservation.events_captured).toHaveLength(1)
    expect(otherObservation.events_captured[0].envelope.d).toMatchObject(
      unrelated
    )
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [otherObservation.events_captured[0].id],
      })
    ).toBe(404)
    const observation5 = await observe(id)
    const release = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [observation5.events_captured[0].id],
    })
    expect(release.status).toBe(200)
    for (const target of clients) await fence(target)
    expect(voices(otherSession)).toHaveLength(2)
    expect(voices(otherBot)).toHaveLength(0)
    expect(voices(alias)).toHaveLength(0)
    expect(voices().map((frame) => frame.d)).toMatchObject([sibling, owned])
  })

  it('clears only the reset setup and clears all voice controls on global reset', async () => {
    seedBot(server.db, 'Bot other', '444444444444444444')
    const otherBot = await connect('Bot other')
    const otherGuild = seedGuild(server.db, 'Bot other', '666666666666666666')
    const otherChannel = seedVoiceChannel(
      server.db,
      otherGuild,
      '777777777777777777'
    )
    seedMember(server.db, otherGuild, HUMAN_ID)
    const own = await arm()
    const other = await arm({
      guild_id: otherGuild,
      bot_id: '444444444444444444',
      session_id: otherBot.sessionId,
    })
    await transition({ channel_id: channel, self_stream: true })
    const retained = await transition(
      { channel_id: otherChannel, self_stream: true },
      HUMAN_ID,
      otherGuild
    )
    expect(await status('/_test/reset', 'POST', { token: TOKEN })).toBe(204)
    expect(await status(`${ROOT}/${own}`)).toBe(404)
    const observation = await observe(other)
    expect(observation.events_captured[0].envelope.d).toMatchObject(retained)
    expect(
      await status(`${ROOT}/${other}/release`, 'POST', {
        event_ids: [observation.events_captured[0].id],
      })
    ).toBe(200)
    for (const target of clients) await fence(target)
    expect(voices()).toHaveLength(0)
    expect(voices(otherBot).map((frame) => frame.d)).toEqual([
      observation.events_captured[0].envelope.d,
    ])
    expect(await status('/_test/reset', 'POST', {})).toBe(204)
    expect(await status(`${ROOT}/${other}`)).toBe(404)
  })

  it('validates selectors and delivery selections atomically with original opt-in', async () => {
    const policy = {
      guild_id: guild,
      bot_id: BOT_ID,
      events: ['VOICE_STATE_UPDATE'],
      session_id: client.sessionId,
    }
    for (const extra of [
      { events: ['VOICE_STATE_UPDATE', 'VOICE_STATE_UPDATE'] },
      { events: ['VOICE_SERVER_UPDATE'] },
      { events: ['VOICE_STATE_UPDATE', 'READY'] },
      { guild_id: '*' },
      { session_id: null },
      { limit: 0 },
      { limit: 101 },
      { ttl_ms: 0 },
      { ttl_ms: 60_001 },
    ]) {
      expect(await status(ROOT, 'POST', { ...policy, ...extra })).toBe(400)
    }
    for (const extra of [
      { bot_id: '444444444444444444' },
      { session_id: 'a'.repeat(32) },
      { guild_id: '123' },
    ]) {
      expect(await status(ROOT, 'POST', { ...policy, ...extra })).toBe(404)
    }
    const id = await arm()
    expect(await status(ROOT, 'POST', policy)).toBe(409)
    await transition({ channel_id: channel, self_stream: true })
    const observation6 = await observe(id)
    const event = observation6.events_captured[0]
    for (const [action, body, expectedStatus] of [
      ['release', { event_ids: [event.id, 'a'.repeat(36)] }, 404],
      ['release', { event_ids: [event.id, event.id] }, 400],
      ['release', { event_ids: [event.id], sequence: 'original' }, 409],
      ['replay', { event_ids: [event.id] }, 409],
    ] as const) {
      expect(await status(`${ROOT}/${id}/${action}`, 'POST', body)).toBe(
        expectedStatus
      )
    }
    await fence()
    expect(voices()).toHaveLength(0)
    const observation7 = await observe(id)
    expect(observation7.events_captured[0]).toMatchObject({
      state: 'held',
      deliveries: 0,
    })
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [event.id],
      })
    ).toBe(200)
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [event.id],
      })
    ).toBe(409)
  })

  it('fails open at the capture limit and bounds duplicate deliveries', async () => {
    const id = await arm({ limit: 1 })
    const streaming = await transition({
      channel_id: channel,
      self_stream: true,
    })
    const stopped = await transition({ self_stream: false })
    await fence()
    expect(voices().map((frame) => frame.d)).toMatchObject([stopped])
    const observation = await observe(id)
    expect(observation.skipped).toBe(1)
    expect(observation.events_captured).toHaveLength(1)
    const eventIds = [observation.events_captured[0].id]
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', { event_ids: eventIds })
    ).toBe(200)
    for (let i = 0; i < 99; i += 1) {
      expect(
        await status(`${ROOT}/${id}/replay`, 'POST', { event_ids: eventIds })
      ).toBe(200)
    }
    expect(
      await status(`${ROOT}/${id}/replay`, 'POST', { event_ids: eventIds })
    ).toBe(429)
    await fence()
    expect(voices()).toHaveLength(101)
    expect(observation.events_captured[0].envelope.d).toMatchObject(streaming)
    expect(voices().at(-1)?.d).toEqual(
      observation.events_captured[0].envelope.d
    )
    expect(await current()).toEqual(stopped)
    const observation8 = await observe(id)
    expect(observation8.operations).toBe(100)
  })

  it.each([
    'cancel',
    'expire',
    'disconnect',
    'remove',
    'replace',
    'reset',
    'delete setup',
  ])(
    'discards held voice snapshots on %s and recovers with a fresh control',
    async (action) => {
      const id = await arm({ ...(action === 'expire' && { ttl_ms: 1000 }) })
      await transition({ channel_id: channel, self_stream: true })
      const observation9 = await observe(id)
      const event = observation9.events_captured[0]
      switch (action) {
        case 'cancel': {
          await request(`${ROOT}/${id}`, 'DELETE')
          break
        }
        case 'expire': {
          await expect
            .poll(async () => await status(`${ROOT}/${id}`), { timeout: 5000 })
            .toBe(404)

          break
        }
        case 'disconnect': {
          client.ws.close()
          await once(client.ws, 'close')

          break
        }
        case 'remove': {
          server.sessionManager.remove(client.sessionId)
          break
        }
        case 'replace': {
          const ready = once(client.ws, 'message')
          client.ws.send(
            JSON.stringify({
              op: 2,
              d: { token: TOKEN, intents: GatewayIntentBits.GuildVoiceStates },
            })
          )
          await ready
          client.sessionId = String(
            client.frames.findLast((frame) => frame.t === 'READY')?.d
              ?.session_id
          )

          break
        }
        case 'reset': {
          await request('/_test/reset', 'POST', { token: TOKEN })
          break
        }
        case 'delete setup': {
          await request('/_test/setup/Bot%20voice-capture', 'DELETE')
          break
        }
      }
      expect(await status(`${ROOT}/${id}`)).toBe(404)
      expect(
        await status(`${ROOT}/${id}/release`, 'POST', {
          event_ids: [event.id],
        })
      ).toBe(404)
      expect(voices()).toHaveLength(0)
      if (action === 'disconnect' || action === 'remove')
        client = await connect()
      else if (action === 'delete setup') {
        seedBot(server.db, TOKEN)
        seedGuild(server.db, TOKEN)
        seedVoiceChannel(server.db, guild)
        seedMember(server.db, guild, HUMAN_ID)
      }
      const recovered = await arm({ hold: false })
      const state = await transition({
        channel_id: channel,
        self_stream: false,
      })
      await fence()
      const observation10 = await observe(recovered)
      expect(observation10.events_captured[0].envelope.d).toMatchObject(state)
      expect(voices().at(-1)?.d).toEqual(
        observation10.events_captured[0].envelope.d
      )
    }
  )

  it('keeps legacy message and reaction controls working alongside voice capture', async () => {
    client = await connect(
      TOKEN,
      GatewayIntentBits.GuildVoiceStates |
        GatewayIntentBits.GuildMessages |
        GatewayIntentBits.GuildMessageReactions
    )
    const voice = await arm()
    const legacy = await arm({
      events: ['MESSAGE_REACTION_ADD', 'MESSAGE_DELETE'],
    })
    const text = seedChannel(server.db, guild)
    const message = seedMessage(server.db, text, BOT_ID, TOKEN)
    await transition({ channel_id: channel, self_stream: true })
    expect(
      await status(
        `/channels/${text}/messages/${message}/reactions/x/@me`,
        'PUT'
      )
    ).toBe(204)
    expect(
      await status(`/channels/${text}/messages/${message}`, 'DELETE')
    ).toBe(204)
    const captured = await observe(legacy)
    expect(captured.events_captured.map((event) => event.envelope.t)).toEqual([
      'MESSAGE_REACTION_ADD',
      'MESSAGE_DELETE',
    ])
    const observation11 = await observe(voice)
    expect(observation11.events_captured).toHaveLength(1)
    expect(
      await status(`${ROOT}/${legacy}/release`, 'POST', {
        event_ids: captured.events_captured.map((event) => event.id),
      })
    ).toBe(200)
    await fence()
    expect(
      client.frames
        .filter((frame) => frame.t?.startsWith('MESSAGE_'))
        .map((frame) => frame.t)
    ).toEqual(['MESSAGE_REACTION_ADD', 'MESSAGE_DELETE'])
    expect(voices()).toHaveLength(0)
  })
})
