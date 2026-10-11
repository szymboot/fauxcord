import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { GatewayVoiceStateUpdateDispatchData } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedMember,
  seedVoiceChannel,
} from '../test-helpers'
import { getGuildMember } from '../services/guild-members'
import { getGuildVoiceState } from '../services/voice-states'
import type { GuildVoiceState } from '../services/voice-states'
import type { GatewayPayload } from './protocol'

/** Real Gateway connection and every frame received by the test client. */
interface Client {
  ws: WebSocket
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

const TOKEN = 'Bot voice-displacement'
const BOT_ID = '111111111111111111'
const HUMAN_ID = '300000000000000000'
const GUILD_A = '222222222222222221'
const GUILD_B = '222222222222222222'
const ALL_INTENTS =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates

describe('cross-guild voice displacement', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let voiceA: string
  let voiceB: string
  const clients: Client[] = []

  /** Writes a voice state through the typed fixture route. */
  async function patchVoice(
    guildId: string,
    userId: string,
    body: Record<string, unknown>
  ): Promise<GuildVoiceState> {
    const response = await fetch(
      `${base}/_test/guilds/${guildId}/voice-states/${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
    expect(response.status).toBe(200)
    return (await response.json()) as GuildVoiceState
  }

  /** Makes the stored row contradict the member's server mute/deaf. */
  function divergeStoredFlags(guildId: string, userId: string): void {
    const member = getGuildMember(server.db, guildId, userId)
    server.db
      .prepare(
        'UPDATE guild_voice_states SET mute = ?, deaf = ? WHERE guild_id = ? AND user_id = ?'
      )
      .run(Number(!member?.mute), Number(!member?.deaf), guildId, userId)
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

  /** Identifies a fresh Gateway session and fences its startup frames. */
  async function connect(): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(
      JSON.stringify({ op: 2, d: { token: TOKEN, intents: ALL_INTENTS } })
    )
    await ready
    const client = { ws, frames }
    clients.push(client)
    await fence(client)
    return client
  }

  /** Returns the voice dispatches received after the startup sequence. */
  function voiceDispatches(
    client: Client
  ): GatewayVoiceStateUpdateDispatchData[] {
    return client.frames
      .filter((frame) => frame.op === 0 && frame.t === 'VOICE_STATE_UPDATE')
      .map((frame) => frame.d as unknown as GatewayVoiceStateUpdateDispatchData)
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT_ID)
    seedGuild(server.db, TOKEN, GUILD_A)
    seedGuild(server.db, TOKEN, GUILD_B)
    voiceA = seedVoiceChannel(server.db, GUILD_A, '555555555555555551')
    voiceB = seedVoiceChannel(server.db, GUILD_B, '555555555555555552')
    for (const guildId of [GUILD_A, GUILD_B]) {
      seedMember(server.db, guildId, HUMAN_ID)
      seedMember(server.db, guildId, BOT_ID)
    }
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('publishes the member mute/deaf for a divergent legacy row before the join', async () => {
    const prepared = await patchVoice(GUILD_A, HUMAN_ID, {
      channel_id: voiceA,
      mute: true,
      self_video: true,
      emit: false,
    })
    divergeStoredFlags(GUILD_A, HUMAN_ID)
    expect(getGuildVoiceState(server.db, GUILD_A, HUMAN_ID)).toMatchObject({
      mute: false,
      deaf: true,
    })
    const client = await connect()

    const joined = await patchVoice(GUILD_B, HUMAN_ID, { channel_id: voiceB })
    await fence(client)

    const disconnected = {
      ...prepared,
      channel_id: null,
      self_video: false,
      mute: true,
      deaf: false,
    }
    const [leave, join] = voiceDispatches(client)
    expect(voiceDispatches(client)).toHaveLength(2)
    expect(leave).toMatchObject({
      ...disconnected,
      member: { mute: true, deaf: false },
    })
    expect(leave.mute).toBe(leave.member?.mute)
    expect(leave.deaf).toBe(leave.member?.deaf)
    expect(join).toMatchObject({ ...joined, member: { mute: false } })
    expect(getGuildVoiceState(server.db, GUILD_A, HUMAN_ID)).toEqual(
      disconnected
    )
    expect(getGuildMember(server.db, GUILD_A, HUMAN_ID)).toMatchObject({
      mute: true,
      deaf: false,
    })
  })

  it('keeps the ordinary displacement payload when the row matches the member', async () => {
    const prepared = await patchVoice(GUILD_A, HUMAN_ID, {
      channel_id: voiceA,
      deaf: true,
      self_mute: true,
      self_stream: true,
      emit: false,
    })
    const client = await connect()

    const joined = await patchVoice(GUILD_B, HUMAN_ID, { channel_id: voiceB })
    await fence(client)

    expect(voiceDispatches(client)).toEqual([
      {
        ...prepared,
        channel_id: null,
        self_stream: false,
        member: getGuildMember(server.db, GUILD_A, HUMAN_ID),
      },
      { ...joined, member: getGuildMember(server.db, GUILD_B, HUMAN_ID) },
    ])
    expect(voiceDispatches(client)[0]).toMatchObject({
      deaf: true,
      member: { deaf: true },
    })
  })

  it('applies the member flags silently for emit: false', async () => {
    await patchVoice(GUILD_A, HUMAN_ID, {
      channel_id: voiceA,
      deaf: true,
      emit: false,
    })
    divergeStoredFlags(GUILD_A, HUMAN_ID)
    const client = await connect()

    await patchVoice(GUILD_B, HUMAN_ID, { channel_id: voiceB, emit: false })
    await fence(client)

    expect(voiceDispatches(client)).toEqual([])
    expect(getGuildVoiceState(server.db, GUILD_A, HUMAN_ID)).toMatchObject({
      channel_id: null,
      mute: false,
      deaf: true,
    })
  })

  it('keeps a bot connected in each guild, even with a divergent row', async () => {
    const stayed = await patchVoice(GUILD_A, BOT_ID, {
      channel_id: voiceA,
      emit: false,
    })
    divergeStoredFlags(GUILD_A, BOT_ID)
    const client = await connect()

    const joined = await patchVoice(GUILD_B, BOT_ID, { channel_id: voiceB })
    await fence(client)

    expect(voiceDispatches(client)).toEqual([
      { ...joined, member: getGuildMember(server.db, GUILD_B, BOT_ID) },
    ])
    expect(getGuildVoiceState(server.db, GUILD_A, BOT_ID)).toEqual({
      ...stayed,
      mute: true,
      deaf: true,
    })
  })
})
