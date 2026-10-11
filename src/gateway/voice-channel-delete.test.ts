import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { GatewayVoiceStateUpdateDispatchData } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedStageChannel,
  seedVoiceChannel,
} from '../test-helpers'
import { getGuildMember } from '../services/guild-members'
import { getGuildVoiceState } from '../services/voice-states'
import type { GuildVoiceState } from '../services/voice-states'
import type { GatewayPayload } from './protocol'

/** Real Gateway connection and every frame received by the test client. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Captured voice envelope as reported by the event-control inspection API. */
interface CapturedVoice {
  id: string
  state: string
  envelope: GatewayPayload<GatewayVoiceStateUpdateDispatchData>
}

const TOKEN = 'Bot voice-delete'
const OTHER_TOKEN = 'Bot voice-delete-other'
const BOT_ID = '111111111111111111'
const OTHER_BOT_ID = '222222222222222222'
// Numeric snowflake order (17 digits first) differs from lexicographic order.
const LOW_ID = '99999999999999999'
const HIGH_ID = '100000000000000000'
const OTHER_ID = '300000000000000000'
const IDLE_ID = '400000000000000000'
const ROOT = '/_test/gateway-event-controls'
const ALL_INTENTS =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates

describe('voice disconnects when a voice or stage channel is deleted', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let voice: string
  let otherVoice: string
  const clients: Client[] = []

  /** Calls a live HTTP route of the test server with the bot token. */
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

  /** Prepares a voice state silently through the typed fixture route. */
  async function prepare(
    userId: string,
    body: Record<string, unknown>,
    guildId = guild
  ): Promise<GuildVoiceState> {
    const response = await request(
      `/_test/guilds/${guildId}/voice-states/${userId}`,
      'PATCH',
      { emit: false, ...body }
    )
    expect(response.status).toBe(200)
    return (await response.json()) as GuildVoiceState
  }

  /** Deletes a channel through the ordinary authenticated REST route. */
  async function deleteChannel(channelId: string): Promise<void> {
    const response = await request(`/channels/${channelId}`, 'DELETE')
    expect(response.status).toBe(200)
  }

  /** Waits for a heartbeat ACK to fence all frames sent before it. */
  async function fence(target: Client): Promise<void> {
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

  /** Opens a socket that records every frame and waits for HELLO. */
  async function open(): Promise<Pick<Client, 'ws' | 'frames'>> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    return { ws, frames }
  }

  /** Identifies a fresh Gateway session and fences its startup frames. */
  async function connect(
    intents: number = ALL_INTENTS,
    token = TOKEN
  ): Promise<Client> {
    const { ws, frames } = await open()
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
    await fence(client)
    return client
  }

  /** Returns the dispatch frames received after the startup sequence. */
  function dispatches(client: Client): Client['frames'] {
    return client.frames.filter(
      (frame) =>
        frame.op === 0 && frame.t !== 'READY' && frame.t !== 'GUILD_CREATE'
    )
  }

  /** Builds the expected native disconnect payload for a prepared state. */
  function disconnected(
    prepared: GuildVoiceState,
    guildId = guild
  ): GatewayVoiceStateUpdateDispatchData {
    return {
      ...prepared,
      channel_id: null,
      self_stream: false,
      self_video: false,
      request_to_speak_timestamp: null,
      member: getGuildMember(
        server.db,
        guildId,
        prepared.user_id
      ) as NonNullable<GatewayVoiceStateUpdateDispatchData['member']>,
    }
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT_ID)
    guild = seedGuild(server.db, TOKEN)
    voice = seedVoiceChannel(server.db, guild, '555555555555555551')
    otherVoice = seedVoiceChannel(server.db, guild, '555555555555555552')
    for (const id of [LOW_ID, HIGH_ID, OTHER_ID, IDLE_ID])
      seedMember(server.db, guild, id)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('disconnects every member of the deleted voice channel before CHANNEL_DELETE', async () => {
    const high = await prepare(HIGH_ID, {
      channel_id: voice,
      self_stream: true,
      self_video: true,
      self_mute: true,
      deaf: true,
    })
    const low = await prepare(LOW_ID, { channel_id: voice, self_deaf: true })
    const other = await prepare(OTHER_ID, {
      channel_id: otherVoice,
      self_stream: true,
    })
    const idle = await prepare(IDLE_ID, { channel_id: voice })
    await prepare(IDLE_ID, { channel_id: null })
    const idleBefore = getGuildVoiceState(server.db, guild, IDLE_ID)

    seedBot(server.db, OTHER_TOKEN, OTHER_BOT_ID)
    const otherGuild = seedGuild(server.db, OTHER_TOKEN, '666666666666666666')
    const foreignVoice = seedVoiceChannel(
      server.db,
      otherGuild,
      '555555555555555553'
    )
    seedMember(server.db, otherGuild, LOW_ID)
    const foreign = await prepare(
      LOW_ID,
      { channel_id: foreignVoice, self_stream: true },
      otherGuild
    )

    const client = await connect()
    const foreignClient = await connect(ALL_INTENTS, OTHER_TOKEN)
    const startSequence = Math.max(
      ...client.frames.map((frame) => frame.s ?? 0)
    )

    await deleteChannel(voice)
    await fence(client)
    await fence(foreignClient)

    const events = dispatches(client)
    expect(events.map((frame) => frame.t)).toEqual([
      'VOICE_STATE_UPDATE',
      'VOICE_STATE_UPDATE',
      'CHANNEL_DELETE',
    ])
    expect(events.map((frame) => frame.s)).toEqual([
      startSequence + 1,
      startSequence + 2,
      startSequence + 3,
    ])
    expect(events[0].d).toEqual(disconnected(low))
    expect(events[1].d).toEqual(disconnected(high))
    expect(events[1].d).toMatchObject({
      session_id: high.session_id,
      self_mute: true,
      deaf: true,
      self_stream: false,
      self_video: false,
    })
    expect(events[2].d).toMatchObject({ id: voice, type: 2 })
    // CHANNEL_DELETE is (pre-existingly) broadcast to every bot; voice
    // disconnects stay scoped to the owning bot's sessions.
    expect(
      dispatches(foreignClient).filter(
        (frame) => frame.t === 'VOICE_STATE_UPDATE'
      )
    ).toEqual([])

    // Stored states are retained as disconnected, exactly like a fixture.
    expect(getGuildVoiceState(server.db, guild, LOW_ID)).toEqual({
      ...low,
      channel_id: null,
    })
    expect(getGuildVoiceState(server.db, guild, HIGH_ID)).toEqual({
      ...high,
      channel_id: null,
      self_stream: false,
      self_video: false,
    })
    expect(getGuildVoiceState(server.db, guild, OTHER_ID)).toEqual(other)
    expect(getGuildVoiceState(server.db, guild, IDLE_ID)).toEqual(idleBefore)
    expect(idleBefore?.session_id).toBe(idle.session_id)
    expect(getGuildVoiceState(server.db, otherGuild, LOW_ID)).toEqual(foreign)

    // A fresh IDENTIFY only reports the member still connected elsewhere.
    const fresh = await connect()
    const { guild_id: otherGuildId, ...otherSnapshot } = other
    expect(otherGuildId).toBe(guild)
    expect(
      fresh.frames.find((frame) => frame.t === 'GUILD_CREATE')?.d?.voice_states
    ).toEqual([otherSnapshot])
  })

  it('disconnects stage members and clears request-to-speak', async () => {
    const { stageChannelId } = seedStageChannel(server.db, guild)
    const speaker = await prepare(LOW_ID, {
      channel_id: stageChannelId,
      suppress: false,
    })
    const audience = await prepare(HIGH_ID, {
      channel_id: stageChannelId,
      suppress: true,
      request_to_speak_timestamp: '2026-01-01T00:00:00.000000+00:00',
    })
    const client = await connect()

    await deleteChannel(stageChannelId)
    await fence(client)

    const events = dispatches(client)
    expect(events.map((frame) => frame.t)).toEqual([
      'VOICE_STATE_UPDATE',
      'VOICE_STATE_UPDATE',
      'CHANNEL_DELETE',
    ])
    expect(events[0].d).toEqual(disconnected(speaker))
    expect(events[1].d).toEqual(disconnected(audience))
    expect(events[1].d).toMatchObject({
      suppress: true,
      request_to_speak_timestamp: null,
    })
    expect(events[2].d).toMatchObject({ id: stageChannelId, type: 13 })
    expect(getGuildVoiceState(server.db, guild, HIGH_ID)).toMatchObject({
      channel_id: null,
      session_id: audience.session_id,
      request_to_speak_timestamp: null,
    })
  })

  it('emits only CHANNEL_DELETE for a text channel and an empty voice channel', async () => {
    const text = seedChannel(server.db, guild, '555555555555555554')
    const connected = await prepare(LOW_ID, { channel_id: voice })
    const client = await connect()

    await deleteChannel(text)
    await deleteChannel(otherVoice)
    await fence(client)

    expect(dispatches(client).map((frame) => [frame.t, frame.d?.id])).toEqual([
      ['CHANNEL_DELETE', text],
      ['CHANNEL_DELETE', otherVoice],
    ])
    expect(getGuildVoiceState(server.db, guild, LOW_ID)).toEqual(connected)
  })

  it('filters disconnects by GuildVoiceStates and CHANNEL_DELETE by Guilds', async () => {
    await prepare(LOW_ID, { channel_id: voice })
    await prepare(HIGH_ID, { channel_id: voice })
    const voiceOnly = await connect(GatewayIntentBits.GuildVoiceStates)
    const guildsOnly = await connect(GatewayIntentBits.Guilds)

    await deleteChannel(voice)
    await fence(voiceOnly)
    await fence(guildsOnly)

    expect(dispatches(voiceOnly).map((frame) => frame.t)).toEqual([
      'VOICE_STATE_UPDATE',
      'VOICE_STATE_UPDATE',
    ])
    expect(dispatches(voiceOnly).map((frame) => frame.d?.user_id)).toEqual([
      LOW_ID,
      HIGH_ID,
    ])
    expect(dispatches(guildsOnly).map((frame) => frame.t)).toEqual([
      'CHANNEL_DELETE',
    ])
  })

  it('holds captured disconnects and replays their original snapshots', async () => {
    const streaming = await prepare(LOW_ID, {
      channel_id: voice,
      self_stream: true,
    })
    await prepare(HIGH_ID, { channel_id: voice })
    const client = await connect()
    const armed = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT_ID,
      session_id: client.sessionId,
      events: ['VOICE_STATE_UPDATE'],
      hold: true,
    })
    expect(armed.status).toBe(201)
    const { id } = (await armed.json()) as { id: string }

    await deleteChannel(voice)
    await fence(client)
    expect(dispatches(client).map((frame) => frame.t)).toEqual([
      'CHANNEL_DELETE',
    ])

    const inspected = await request(`${ROOT}/${id}`)
    const captured = (
      (await inspected.json()) as { events_captured: CapturedVoice[] }
    ).events_captured
    expect(captured.map((event) => event.state)).toEqual(['held', 'held'])
    expect(captured[0].envelope).toMatchObject({
      t: 'VOICE_STATE_UPDATE',
      d: disconnected(streaming),
    })
    expect(captured[1].envelope.d).toMatchObject({
      user_id: HIGH_ID,
      channel_id: null,
    })

    const released = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: captured.map((event) => event.id),
    })
    expect(released.status).toBe(200)
    const replayed = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [captured[0].id],
    })
    expect(replayed.status).toBe(200)
    await fence(client)
    expect(
      dispatches(client)
        .slice(1)
        .map((frame) => frame.d)
    ).toEqual([
      captured[0].envelope.d,
      captured[1].envelope.d,
      captured[0].envelope.d,
    ])
  })

  it('replays missed disconnects and CHANNEL_DELETE in order on RESUME', async () => {
    await prepare(LOW_ID, { channel_id: voice })
    await prepare(HIGH_ID, { channel_id: voice })
    const client = await connect()
    const session = server.sessionManager.get(client.sessionId)
    const seq = session?.seq ?? 0
    client.ws.close()
    await once(client.ws, 'close')

    await deleteChannel(voice)

    const { ws, frames } = await open()
    const resumed = once(ws, 'message')
    ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq },
      })
    )
    await resumed
    const target = { ws, frames, sessionId: client.sessionId }
    clients.push(target)
    await fence(target)
    expect(
      frames
        .filter((frame) => frame.op === 0 && frame.t !== 'RESUMED')
        .map((frame) => [frame.t, frame.s, frame.d?.user_id ?? frame.d?.id])
    ).toEqual([
      ['VOICE_STATE_UPDATE', seq + 1, LOW_ID],
      ['VOICE_STATE_UPDATE', seq + 2, HIGH_ID],
      ['CHANNEL_DELETE', seq + 3, voice],
    ])
    expect(frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
  })

  it('keeps reset and guild deletion cleanup silent', async () => {
    await prepare(LOW_ID, { channel_id: voice })
    const client = await connect()

    const reset = await request('/_test/reset', 'POST', { token: TOKEN })
    expect(reset.status).toBeLessThan(300)
    await fence(client)
    expect(dispatches(client)).toEqual([])
    expect(getGuildVoiceState(server.db, guild, LOW_ID)).toBeNull()

    await prepare(HIGH_ID, { channel_id: voice })
    const deleted = await request(`/guilds/${guild}`, 'DELETE')
    expect(deleted.status).toBeLessThan(300)
    await fence(client)
    expect(
      dispatches(client).filter((frame) => frame.t === 'VOICE_STATE_UPDATE')
    ).toEqual([])
    expect(getGuildVoiceState(server.db, guild, HIGH_ID)).toBeNull()
  })
})
