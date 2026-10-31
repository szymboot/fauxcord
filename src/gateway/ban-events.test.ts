import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedMember,
  seedVoiceChannel,
} from '../test-helpers'
import { getGuildBan } from '../services/guild-bans'
import { getGuildMember } from '../services/guild-members'
import { getGuildVoiceState } from '../services/voice-states'
import type { GatewayPayload } from './protocol'
import { gatewayBus } from './bus'

/** Wire client with all dispatches retained for ordered assertions. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

const TOKEN = 'Bot ban-events'
const BOT = '111111111111111111'
const ALICE = '700000000000000001'
const UNKNOWN = '799999999999999999'
const INTENTS =
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildModeration |
  GatewayIntentBits.GuildVoiceStates

describe('native guild ban removal events', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
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

  /** Identifies or resumes a session, retaining every frame. */
  async function connect(
    intents = INTENTS,
    token = TOKEN,
    url = server.url,
    resume?: { session_id: string; seq: number }
  ): Promise<Client> {
    const ws = new WebSocket(url)
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
    const client = {
      ws,
      frames,
      sessionId:
        resume?.session_id ??
        String(frames.find((frame) => frame.t === 'READY')?.d?.session_id),
    }
    clients.push(client)
    if (!resume) await drain(client)
    return client
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    seedMember(server.db, guild, ALICE)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    for (const extra of extraServers.splice(0)) await extra.close()
    await server.close()
  })

  it.each([ALICE, UNKNOWN])(
    'unban publishes exactly the ban read user for %s after deletion',
    async (user) => {
      const path = `/guilds/${guild}/bans/${user}`
      if (user === ALICE) {
        const voice = seedVoiceChannel(server.db, guild)
        expect(
          await status(`/_test/guilds/${guild}/voice-states/${user}`, 'PATCH', {
            channel_id: voice,
            emit: false,
          })
        ).toBe(200)
      }
      expect(await status(path, 'PUT')).toBe(204)
      const ban = getGuildBan(server.db, guild, user)
      const client = await connect()
      const sequence = server.sessionManager.get(client.sessionId)?.seq
      expect(await status(path, 'DELETE')).toBe(204)
      expect(getGuildBan(server.db, guild, user)).toBeNull()
      expect(getGuildMember(server.db, guild, user)).toBeNull()
      expect(getGuildVoiceState(server.db, guild, user)).toBeNull()
      expect(await drain(client)).toEqual([
        {
          op: 0,
          t: 'GUILD_BAN_REMOVE',
          s: Number(sequence) + 1,
          d: { guild_id: guild, user: ban?.user },
        },
      ])
      const missing = await request(path, 'DELETE')
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({
        message: 'Unknown Ban',
        code: 10_026,
      })
      expect(await status(`/guilds/123/bans/${user}`, 'DELETE')).toBe(404)
      expect(await drain(client)).toEqual([])
    }
  )

  it('publishes only after the ban deletion commits', async () => {
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    const observed: { inTransaction: boolean; banExists: boolean }[] = []
    /** Reads SQLite at publication time, before the route returns. */
    const observe = (): void => {
      observed.push({
        inTransaction: server.db.inTransaction,
        banExists: getGuildBan(server.db, guild, ALICE) !== null,
      })
    }
    gatewayBus.on('guild.ban.remove', observe)
    try {
      expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'DELETE')).toBe(204)
    } finally {
      gatewayBus.off('guild.ban.remove', observe)
    }
    expect(observed).toEqual([{ inTransaction: false, banExists: false }])
  })

  it('filters unban delivery by moderation intent, bot, exact token and database', async () => {
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    const owner = await connect(GatewayIntentBits.GuildModeration)
    const noIntent = await connect(GatewayIntentBits.GuildMembers)
    seedBot(server.db, 'Bot foreign', '121212121212121212')
    seedBot(server.db, 'Bot alias', BOT)
    const other = await createTestGatewayServer()
    extraServers.push(other)
    seedBot(other.db, TOKEN, BOT)
    seedGuild(other.db, TOKEN, guild)
    const excluded = [
      noIntent,
      await connect(INTENTS, 'Bot foreign'),
      await connect(INTENTS, 'Bot alias'),
      await connect(INTENTS, TOKEN, other.url),
    ]
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'DELETE')).toBe(204)
    expect(await eventTypes(owner)).toEqual(['GUILD_BAN_REMOVE'])
    for (const client of excluded) expect(await drain(client)).toEqual([])
  })

  it('replays a missed unban with its original sequence on RESUME', async () => {
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    const client = await connect()
    const sequence = Number(server.sessionManager.get(client.sessionId)?.seq)
    const closed = once(client.ws, 'close')
    client.ws.close()
    await closed
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'DELETE')).toBe(204)
    const resumed = await connect(INTENTS, TOKEN, server.url, {
      session_id: client.sessionId,
      seq: sequence,
    })
    const frames = await drain(resumed)
    expect(frames.map((frame) => frame.t)).toEqual([
      'GUILD_BAN_REMOVE',
      'RESUMED',
    ])
    expect(frames[0].s).toBe(sequence + 1)
    expect(frames[0].d).toMatchObject({ guild_id: guild, user: { id: ALICE } })
  })

  it('unbanning the owning bot or other users while detached delivers nothing', async () => {
    const client = await connect()
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    expect(await status(`/guilds/${guild}/bans/${BOT}`, 'PUT')).toBe(204)
    await drain(client)
    const sequence = server.sessionManager.get(client.sessionId)?.seq
    expect(await status(`/guilds/${guild}/bans/${BOT}`, 'DELETE')).toBe(204)
    expect(getGuildBan(server.db, guild, BOT)).toBeNull()
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'DELETE')).toBe(204)
    expect(getGuildBan(server.db, guild, ALICE)).toBeNull()
    expect(
      server.db
        .prepare('SELECT bot_present FROM guilds WHERE id = ?')
        .get(guild)
    ).toEqual({ bot_present: 0 })
    expect(await drain(client)).toEqual([])
    expect(server.sessionManager.get(client.sessionId)?.seq).toBe(sequence)
    const reconnected = await connect()
    expect(await drain(reconnected)).toEqual([])
  })

  it.each(['reset', 'setup', 'guild'])(
    '%s cleanup emits no ban removal',
    async (cleanup) => {
      expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
      const client = await connect()
      const published: unknown[] = []
      /** Records even events that could be suppressed after guild deletion. */
      const observe = (event: unknown): void => {
        published.push(event)
      }
      gatewayBus.on('guild.ban.remove', observe)
      try {
        if (cleanup === 'reset')
          expect(await status('/_test/reset', 'POST', {})).toBe(204)
        else if (cleanup === 'setup')
          expect(
            await status(`/_test/setup/${encodeURIComponent(TOKEN)}`, 'DELETE')
          ).toBe(204)
        else expect(await status(`/guilds/${guild}`, 'DELETE')).toBe(204)
      } finally {
        gatewayBus.off('guild.ban.remove', observe)
      }
      expect(published).toEqual([])
      // Reset preserves bans; setup/guild deletion removes them silently.
      expect(getGuildBan(server.db, guild, ALICE) === null).toBe(
        cleanup !== 'reset'
      )
      expect(await drain(client)).toEqual([])
    }
  )
})
