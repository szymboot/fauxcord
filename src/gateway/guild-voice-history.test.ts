import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { APIBaseVoiceState } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedStageChannel,
  seedVoiceChannel,
} from '../test-helpers'
import type { GuildMemberObject } from '../services/guild-members'
import { getGuildMember } from '../services/guild-members'
import { GatewayOp } from './opcodes'

/** Guild fields relevant to historical voice discovery. */
interface VoiceGuild {
  id: string
  voice_states: APIBaseVoiceState[]
  members: GuildMemberObject[]
}

/** Buffers bursts of Gateway frames and bounds each read. */
function frameReader(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  return () => {
    const frame = queue.shift()
    if (frame) return Promise.resolve(frame)
    const { promise, resolve, reject } =
      Promise.withResolvers<Record<string, unknown>>()
    const timer = setTimeout(() => {
      reject(new Error('Gateway frame timed out'))
    }, 2000)
    waiters.push((next) => {
      clearTimeout(timer)
      resolve(next)
    })
    return promise
  }
}

describe('GUILD_CREATE historical voice states', () => {
  let close: (() => Promise<void>) | undefined
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await close?.()
    close = undefined
  })

  /** Sends true IDENTIFY and consumes READY plus the expected guild snapshots. */
  async function identify(url: string, token: string, guildCount = 1) {
    const socket = new WebSocket(url)
    sockets.push(socket)
    const next = frameReader(socket)
    expect(await next()).toMatchObject({ op: GatewayOp.Hello })
    socket.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: {
          token,
          intents:
            GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates,
        },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    const guilds: VoiceGuild[] = []
    for (let index = 0; index < guildCount; index++) {
      const frame = await next()
      expect(frame).toMatchObject({
        op: GatewayOp.Dispatch,
        t: 'GUILD_CREATE',
        s: Number(ready.s) + index + 1,
      })
      guilds.push(frame.d as VoiceGuild)
    }
    return { socket, next, guilds, ready }
  }

  /** Prepares a saved voice fixture through the shared test API, silently. */
  async function fixture(
    url: string,
    guildId: string,
    userId: string,
    body: Record<string, unknown>
  ): Promise<APIBaseVoiceState> {
    const response = await fetch(
      `${url.replace('ws://', 'http://')}/_test/guilds/${guildId}/voice-states/${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, emit: false }),
        signal: AbortSignal.timeout(2000),
      }
    )
    expect(response.status).toBe(200)
    const state = (await response.json()) as APIBaseVoiceState & {
      guild_id?: string
    }
    // GUILD_CREATE uses the shared voice serializer without the guild ID.
    const { guild_id: guildIdField, ...partial } = state
    expect(guildIdField).toBe(guildId)
    return partial
  }

  it('starts with an empty voice_states array when no states were prepared', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db)
    seedGuild(server.db, token)
    const { guilds } = await identify(server.url, token)
    expect(guilds[0].voice_states).toEqual([])
  })

  it('discovers human streams and bot voice-only sessions across voice and stage channels at startup', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const human = seedMember(server.db, guildId)
    const bot = seedMember(server.db, guildId, '111111111111111111')
    const voice = seedVoiceChannel(server.db, guildId)
    const { stageChannelId: stage } = seedStageChannel(server.db, guildId)
    const stream = await fixture(server.url, guildId, human, {
      channel_id: voice,
      self_stream: true,
      self_video: true,
      self_mute: true,
      self_deaf: true,
      mute: true,
      deaf: true,
      suppress: true,
      request_to_speak_timestamp: '2025-01-01T12:00:00+00:00',
    })
    const voiceOnly = await fixture(server.url, guildId, bot, {
      channel_id: stage,
      self_stream: false,
    })
    expect(stream).toMatchObject({
      channel_id: voice,
      user_id: human,
      self_stream: true,
      self_video: true,
      self_mute: true,
      self_deaf: true,
      mute: true,
      deaf: true,
      suppress: true,
      request_to_speak_timestamp: '2025-01-01T12:00:00.000000+00:00',
    })
    expect(voiceOnly).toMatchObject({
      channel_id: stage,
      user_id: bot,
      self_stream: false,
      self_video: false,
    })
    expect(stream.session_id).toEqual(expect.any(String))
    expect(stream.session_id.length).toBeGreaterThan(0)
    expect(voiceOnly.session_id).not.toBe(stream.session_id)
    const { guilds } = await identify(server.url, token)
    expect(guilds[0].voice_states).toHaveLength(2)
    expect(guilds[0].voice_states).toEqual(
      expect.arrayContaining([stream, voiceOnly])
    )
    expect(guilds[0].members).toEqual(
      expect.arrayContaining([
        getGuildMember(server.db, guildId, human),
        getGuildMember(server.db, guildId, bot),
      ])
    )
    expect(guilds[0].members.find((m) => m.user.id === human)?.user.bot).toBe(
      false
    )
    expect(guilds[0].members.find((m) => m.user.id === bot)?.user.bot).toBe(
      true
    )
  })

  it('reads current saved state on fresh IDENTIFY after disconnect without live voice events', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const human = seedMember(server.db, guildId)
    const voice = seedVoiceChannel(server.db, guildId)
    const moved = seedVoiceChannel(server.db, guildId, '666666666666666666')
    const original = await fixture(server.url, guildId, human, {
      channel_id: voice,
      self_stream: true,
    })
    const first = await identify(server.url, token)
    expect(first.guilds[0].voice_states).toEqual([original])
    const updated = await fixture(server.url, guildId, human, {
      channel_id: moved,
      self_stream: false,
      self_mute: true,
    })
    // A heartbeat ACK is a barrier proving the fixture sent no dispatch first.
    first.socket.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
    expect(await first.next()).toMatchObject({ op: GatewayOp.HeartbeatAck })
    const closed = new Promise<void>((resolve) => {
      first.socket.once('close', () => {
        resolve()
      })
    })
    first.socket.close()
    await closed
    const second = await identify(server.url, token)
    expect((second.ready.d as { session_id: string }).session_id).not.toBe(
      (first.ready.d as { session_id: string }).session_id
    )
    expect(second.guilds[0].voice_states).toEqual([updated])
    expect(updated.session_id).toBe(original.session_id)
  })

  it('keeps voice fixtures isolated between guilds and bot setups', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const firstToken = seedBot(server.db)
    const secondToken = seedBot(server.db, 'Bot other', '777777777777777777')
    const guildIds = [
      seedGuild(server.db, firstToken),
      seedGuild(server.db, firstToken, '888888888888888888'),
      seedGuild(server.db, secondToken, '999999999999999999'),
    ]
    const human = seedMember(server.db, guildIds[0])
    const states = []
    for (const [index, guildId] of guildIds.entries()) {
      seedMember(server.db, guildId, human)
      const channel = seedVoiceChannel(
        server.db,
        guildId,
        String(555_555_555_555_555_555n + BigInt(index))
      )
      states.push(
        await fixture(server.url, guildId, human, {
          channel_id: channel,
          self_stream: index === 0,
        })
      )
    }
    const first = await identify(server.url, firstToken, 2)
    for (const [index, guildId] of guildIds.slice(0, 2).entries()) {
      expect(first.guilds.find((g) => g.id === guildId)?.voice_states).toEqual([
        states[index],
      ])
    }
    const second = await identify(server.url, secondToken)
    expect(second.guilds[0].id).toBe(guildIds[2])
    expect(second.guilds[0].voice_states).toEqual([states[2]])
  })

  it('omits disconnected, removed, deleted, foreign-channel and stale text-channel states', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const voice = seedVoiceChannel(server.db, guildId)
    const text = seedChannel(server.db, guildId)
    const foreignGuild = seedGuild(server.db, token, '888888888888888888')
    const foreign = seedVoiceChannel(
      server.db,
      foreignGuild,
      '666666666666666666'
    )
    const users = Array.from({ length: 6 }, () =>
      seedMember(server.db, guildId)
    )
    for (const userId of users) {
      await fixture(server.url, guildId, userId, { channel_id: voice })
    }
    const deletedChannel = seedVoiceChannel(
      server.db,
      guildId,
      '777777777777777777'
    )
    const deletedChannelUser = seedMember(server.db, guildId)
    await fixture(server.url, guildId, deletedChannelUser, {
      channel_id: deletedChannel,
      self_stream: true,
    })
    server.db.prepare('DELETE FROM channels WHERE id = ?').run(deletedChannel)
    await fixture(server.url, guildId, users[0], { channel_id: null })
    server.db
      .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
      .run(guildId, users[1])
    server.db
      .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
      .run(guildId, users[2])
    server.db.prepare('DELETE FROM users WHERE id = ?').run(users[2])
    server.db
      .prepare(
        'UPDATE guild_voice_states SET channel_id = ? WHERE guild_id = ? AND user_id = ?'
      )
      .run(foreign, guildId, users[3])
    server.db
      .prepare(
        'UPDATE guild_voice_states SET channel_id = ? WHERE guild_id = ? AND user_id = ?'
      )
      .run(text, guildId, users[4])
    const retained = await fixture(server.url, guildId, users[5], {})
    const { guilds } = await identify(server.url, token, 2)
    expect(guilds.find((g) => g.id === guildId)?.voice_states).toEqual([
      retained,
    ])
    expect(guilds.find((g) => g.id === foreignGuild)?.voice_states).toEqual([])
  })

  it('includes the identity of voice users beyond the usual member page', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const voice = seedVoiceChannel(server.db, guildId)
    for (let index = 0; index < 1000; index++) {
      seedMember(
        server.db,
        guildId,
        String(200_000_000_000_000_000n + BigInt(index))
      )
    }
    const human = seedMember(server.db, guildId, '999999999999999999')
    const state = await fixture(server.url, guildId, human, {
      channel_id: voice,
      self_stream: true,
    })
    const { guilds } = await identify(server.url, token)
    expect(guilds[0].voice_states).toEqual([state])
    expect(guilds[0].members).toContainEqual(
      getGuildMember(server.db, guildId, human)
    )
    const ids = guilds[0].members.map((member) => member.user.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('serializes previously stored voice rows with nullable self_stream defaults', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const human = seedMember(server.db, guildId)
    const voice = seedVoiceChannel(server.db, guildId)
    server.db
      .prepare(
        `INSERT INTO guild_voice_states
         (guild_id, user_id, channel_id, session_id)
       VALUES (?, ?, ?, 'saved-session')`
      )
      .run(guildId, human, voice)
    const { guilds } = await identify(server.url, token)
    expect(guilds[0].voice_states).toEqual([
      {
        channel_id: voice,
        user_id: human,
        session_id: 'saved-session',
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: false,
        self_stream: false,
        self_video: false,
        suppress: false,
        request_to_speak_timestamp: null,
      },
    ])
  })

  it.each(['token-reset', 'full-reset', 'setup-delete'])(
    'keeps cleanup visible in the next IDENTIFY snapshot (%s)',
    async (action) => {
      const server = await createTestGatewayServer()
      close = server.close
      const token = seedBot(server.db)
      const otherToken = seedBot(server.db, 'Bot other', '777777777777777777')
      const guildId = seedGuild(server.db, token)
      const otherGuild = seedGuild(server.db, otherToken, '888888888888888888')
      const voice = seedVoiceChannel(server.db, guildId)
      const otherVoice = seedVoiceChannel(
        server.db,
        otherGuild,
        '666666666666666666'
      )
      const human = seedMember(server.db, guildId)
      seedMember(server.db, otherGuild, human)
      await fixture(server.url, guildId, human, {
        channel_id: voice,
        self_stream: true,
      })
      const otherState = await fixture(server.url, otherGuild, human, {
        channel_id: otherVoice,
        self_stream: true,
      })
      const httpUrl = server.url.replace('ws://', 'http://')
      const response = await fetch(
        action === 'setup-delete'
          ? `${httpUrl}/_test/setup/${encodeURIComponent(token)}`
          : `${httpUrl}/_test/reset`,
        {
          method: action === 'setup-delete' ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(action !== 'setup-delete' && {
            body: JSON.stringify(action === 'token-reset' ? { token } : {}),
          }),
          signal: AbortSignal.timeout(2000),
        }
      )
      expect(response.status).toBe(204)
      if (action === 'setup-delete') {
        // Reusing the same setup IDs must not resurrect deleted voice fixtures.
        seedBot(server.db, token)
        seedGuild(server.db, token, guildId)
        seedVoiceChannel(server.db, guildId, voice)
        seedMember(server.db, guildId, human)
      }
      const first = await identify(server.url, token)
      expect(first.guilds[0].voice_states).toEqual([])
      const other = await identify(server.url, otherToken)
      expect(other.guilds[0].voice_states).toEqual(
        action === 'full-reset' ? [] : [otherState]
      )
    }
  )
})
