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

/** Capture snapshots returned by the HTTP inspection endpoint. */
interface Observation {
  id: string
  skipped: number
  expires_at: number
  events_captured: {
    id: string
    envelope: GatewayPayload<Record<string, unknown>>
    state: string
    deliveries: number
    last_sequence: number | null
    delivery_records: { source: string }[]
  }[]
}

const TOKEN = 'Bot ban-capture'
const ROOT = '/_test/gateway-event-controls'
const BOB = '700000000000000002'
const BOT = '111111111111111111'
const ALICE = '700000000000000001'
const UNKNOWN = '799999999999999999'
const INTENTS =
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildModeration |
  GatewayIntentBits.GuildVoiceStates

describe('native guild ban capture controls', () => {
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
    client = await connect()
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    for (const extra of extraServers.splice(0)) await extra.close()
    await server.close()
  })

  /** Arms a ban capture pinned to the selected wire client. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: client.sessionId,
      events: ['GUILD_BAN_ADD', 'GUILD_BAN_REMOVE'],
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
    'holds only ban envelopes and releases/replays with %s sequences after departure',
    async (sequence) => {
      const voice = seedVoiceChannel(server.db, guild)
      expect(
        await status(`/_test/guilds/${guild}/voice-states/${ALICE}`, 'PATCH', {
          channel_id: voice,
          emit: false,
        })
      ).toBe(200)
      const id = await arm({ member_id: ALICE, allow_original_sequence: true })
      const session = server.sessionManager.get(client.sessionId)
      assert.ok(session)
      const checkpoint = session.seq
      const path = `/guilds/${guild}/bans/${ALICE}`
      expect(await status(path, 'PUT')).toBe(204)
      const ban = getGuildBan(server.db, guild, ALICE)
      expect(getGuildMember(server.db, guild, ALICE)).toBeNull()
      expect(getGuildVoiceState(server.db, guild, ALICE)).toBeNull()
      expect(await eventTypes(client)).toEqual([
        'VOICE_STATE_UPDATE',
        'GUILD_MEMBER_REMOVE',
      ])
      expect(await status(path, 'DELETE')).toBe(204)
      expect(await drain(client)).toEqual([])
      const captured = await captures(id)
      expect(captured.map((entry) => entry.envelope.t)).toEqual([
        'GUILD_BAN_ADD',
        'GUILD_BAN_REMOVE',
      ])
      expect(captured.map((entry) => entry.envelope.s)).toEqual([
        checkpoint + 1,
        checkpoint + 4,
      ])
      for (const event of captured) {
        expect(event).toMatchObject({
          state: 'held',
          deliveries: 0,
          last_sequence: null,
          delivery_records: [],
          envelope: { d: { guild_id: guild, user: ban?.user } },
        })
      }
      expect(session.replayBuffer.map((entry) => entry.event.t)).not.toContain(
        'GUILD_BAN_ADD'
      )
      expect(session.replayBuffer.map((entry) => entry.event.t)).not.toContain(
        'GUILD_BAN_REMOVE'
      )
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
          event_ids: [captured[0].id],
          sequence,
        })
      ).toBe(200)
      const frames = await drain(client)
      expect(frames.map((frame) => frame.t)).toEqual([
        'GUILD_BAN_REMOVE',
        'GUILD_BAN_ADD',
        'GUILD_BAN_ADD',
      ])
      expect(frames.map((frame) => frame.d)).toEqual([
        captured[1].envelope.d,
        captured[0].envelope.d,
        captured[0].envelope.d,
      ])
      expect(frames.map((frame) => frame.s)).toEqual(
        sequence === 'new'
          ? [highWater + 1, highWater + 2, highWater + 3]
          : [
              captured[1].envelope.s,
              captured[0].envelope.s,
              captured[0].envelope.s,
            ]
      )
      expect(session.seq).toBe(highWater + (sequence === 'new' ? 3 : 0))
      expect(session.replayBuffer).toHaveLength(
        history + (sequence === 'new' ? 3 : 0)
      )
      const released = await captures(id)
      expect(released[0]).toMatchObject({
        envelope: captured[0].envelope,
        state: 'released',
        deliveries: 2,
        delivery_records: [{ source: 'release' }, { source: 'replay' }],
      })
      expect(getGuildBan(server.db, guild, ALICE)).toBeNull()
      expect(getGuildMember(server.db, guild, ALICE)).toBeNull()
    }
  )

  it('observes single and bulk bans without hold and filters both ban events by user.id', async () => {
    seedMember(server.db, guild, BOB)
    const id = await arm({ member_id: ALICE, hold: false })
    expect(await status(`/guilds/${guild}/bans/${BOB}`, 'PUT')).toBe(204)
    expect(
      await status(`/guilds/${guild}/bulk-ban`, 'POST', {
        user_ids: [BOB, ALICE],
      })
    ).toBe(200)
    const ban = getGuildBan(server.db, guild, ALICE)
    for (const user of [BOB, ALICE])
      expect(await status(`/guilds/${guild}/bans/${user}`, 'DELETE')).toBe(204)
    const frames = await drain(client)
    expect(
      frames
        .filter((frame) => frame.t?.startsWith('GUILD_BAN_'))
        .map((frame) => frame.d?.user)
    ).toMatchObject([{ id: BOB }, { id: ALICE }, { id: BOB }, { id: ALICE }])
    const observation = await observe(id)
    expect(observation.events_captured).toHaveLength(2)
    expect(
      observation.events_captured.map((event) => event.envelope.t)
    ).toEqual(['GUILD_BAN_ADD', 'GUILD_BAN_REMOVE'])
    for (const event of observation.events_captured)
      expect(event).toMatchObject({
        state: 'delivered',
        deliveries: 1,
        envelope: { d: { user: ban?.user } },
      })
    expect(observation.skipped).toBe(0)
  })

  it.each([ALICE, UNKNOWN])(
    'arms ban-only non-member selectors for %s, including after membership removal',
    async (user) => {
      expect(await status(`/guilds/${guild}/bans/${user}`, 'PUT')).toBe(204)
      await drain(client)
      expect(getGuildMember(server.db, guild, user)).toBeNull()
      const id = await arm({ events: ['GUILD_BAN_REMOVE'], member_id: user })
      expect(await status(`/guilds/${guild}/bans/${user}`, 'DELETE')).toBe(204)
      expect(await drain(client)).toEqual([])
      expect(await captures(id)).toMatchObject([
        { envelope: { t: 'GUILD_BAN_REMOVE', d: { user: { id: user } } } },
      ])
    }
  )

  it('accepts never-member ban targets but requires membership for mixed member/voice policies', async () => {
    for (const events of [
      ['GUILD_BAN_ADD'],
      ['GUILD_BAN_REMOVE'],
      ['GUILD_BAN_ADD', 'GUILD_BAN_REMOVE'],
    ]) {
      const id = await arm({ events, member_id: UNKNOWN })
      expect(await status(`${ROOT}/${id}`, 'DELETE')).toBe(204)
    }
    for (const event of ['GUILD_MEMBER_UPDATE', 'VOICE_STATE_UPDATE']) {
      const policy = {
        guild_id: guild,
        bot_id: BOT,
        session_id: client.sessionId,
        events: ['GUILD_BAN_ADD', 'GUILD_BAN_REMOVE', event],
      }
      expect(
        await status(ROOT, 'POST', { ...policy, member_id: UNKNOWN })
      ).toBe(404)
      const id = await arm({ ...policy, member_id: ALICE })
      expect(await status(`${ROOT}/${id}`, 'DELETE')).toBe(204)
    }
    for (const member of [null, '', '0', 123, 'invalid'])
      expect(
        await status(ROOT, 'POST', {
          guild_id: guild,
          bot_id: BOT,
          events: ['GUILD_BAN_ADD'],
          member_id: member,
        })
      ).toBe(400)
    const id = await arm({ member_id: UNKNOWN })
    expect(await status(`/guilds/${guild}/bans/${UNKNOWN}`, 'PUT')).toBe(204)
    expect(await captures(id)).toMatchObject([
      { envelope: { t: 'GUILD_BAN_ADD', d: { user: { id: UNKNOWN } } } },
    ])
  })

  it('lets independent user controls coexist and separately holds the following voice disconnect', async () => {
    seedMember(server.db, guild, BOB)
    const voice = seedVoiceChannel(server.db, guild)
    expect(
      await status(`/_test/guilds/${guild}/voice-states/${ALICE}`, 'PATCH', {
        channel_id: voice,
        emit: false,
      })
    ).toBe(200)
    const alice = await arm({ member_id: ALICE })
    const bob = await arm({ member_id: BOB })
    const disconnect = await arm({
      member_id: ALICE,
      events: ['VOICE_STATE_UPDATE'],
    })
    expect(
      await status(ROOT, 'POST', {
        guild_id: guild,
        bot_id: BOT,
        events: ['GUILD_BAN_ADD'],
      })
    ).toBe(409)
    expect(
      await status(`/guilds/${guild}/bulk-ban`, 'POST', {
        user_ids: [ALICE, BOB],
      })
    ).toBe(200)
    expect(await eventTypes(client)).toEqual([
      'GUILD_MEMBER_REMOVE',
      'GUILD_MEMBER_REMOVE',
    ])
    for (const [id, user] of [
      [alice, ALICE],
      [bob, BOB],
    ])
      expect(await captures(id)).toMatchObject([
        { envelope: { t: 'GUILD_BAN_ADD', d: { user: { id: user } } } },
      ])
    const voiceEvents = await captures(disconnect)
    const held = voiceEvents[0]
    expect(held.envelope).toMatchObject({
      t: 'VOICE_STATE_UPDATE',
      d: { user_id: ALICE, channel_id: null },
    })
    expect(
      await status(`${ROOT}/${disconnect}/release`, 'POST', {
        event_ids: [held.id],
      })
    ).toBe(200)
    expect(await eventTypes(client)).toEqual(['VOICE_STATE_UPDATE'])
  })

  it('keeps a mixed ban/voice selector active after the ban deletes membership', async () => {
    const voice = seedVoiceChannel(server.db, guild)
    expect(
      await status(`/_test/guilds/${guild}/voice-states/${ALICE}`, 'PATCH', {
        channel_id: voice,
        emit: false,
      })
    ).toBe(200)
    const id = await arm({
      member_id: ALICE,
      events: ['GUILD_BAN_ADD', 'GUILD_BAN_REMOVE', 'VOICE_STATE_UPDATE'],
    })
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    expect(getGuildMember(server.db, guild, ALICE)).toBeNull()
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'DELETE')).toBe(204)
    expect(await eventTypes(client)).toEqual(['GUILD_MEMBER_REMOVE'])
    const captured = await captures(id)
    expect(captured.map((event) => event.envelope.t)).toEqual([
      'GUILD_BAN_ADD',
      'VOICE_STATE_UPDATE',
      'GUILD_BAN_REMOVE',
    ])
    expect(captured.map((event) => event.state)).toEqual([
      'held',
      'held',
      'held',
    ])
    expect(
      await status(`${ROOT}/${id}/release`, 'POST', {
        event_ids: captured.map((event) => event.id),
      })
    ).toBe(200)
    expect(await eventTypes(client)).toEqual([
      'GUILD_BAN_ADD',
      'VOICE_STATE_UPDATE',
      'GUILD_BAN_REMOVE',
    ])
    expect(getGuildBan(server.db, guild, ALICE)).toBeNull()
    expect(getGuildVoiceState(server.db, guild, ALICE)).toBeNull()
  })

  it('captures neither re-bans, failed bulk targets, absent bans nor rejected requests', async () => {
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    await drain(client)
    const id = await arm()
    const seq = server.sessionManager.get(client.sessionId)?.seq
    expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
    expect(
      await status(`/guilds/${guild}/bulk-ban`, 'POST', {
        user_ids: [ALICE, UNKNOWN],
      })
    ).toBe(400)
    expect(await status(`/guilds/${guild}/bans/${UNKNOWN}`, 'DELETE')).toBe(404)
    expect(
      await status(`/guilds/${guild}/bans/${UNKNOWN}`, 'PUT', {
        delete_message_seconds: -1,
      })
    ).toBe(400)
    expect(
      await status(
        `/guilds/${guild}/bans/${UNKNOWN}`,
        'PUT',
        undefined,
        'Bot invalid'
      )
    ).toBe(401)
    expect(await drain(client)).toEqual([])
    expect(await captures(id)).toEqual([])
    expect(server.sessionManager.get(client.sessionId)?.seq).toBe(seq)
  })

  it('isolates intent, owning bot, exact token, selected session, guild and app database', async () => {
    const sibling = await connect()
    const noIntent = await connect(GatewayIntentBits.GuildMembers)
    seedBot(server.db, 'Bot alias', BOT)
    seedBot(server.db, 'Bot foreign', '121212121212121212')
    const alias = await connect(INTENTS, 'Bot alias')
    const foreign = await connect(INTENTS, 'Bot foreign')
    const other = await createTestGatewayServer()
    extraServers.push(other)
    seedBot(other.db, TOKEN, BOT)
    seedGuild(other.db, TOKEN, guild)
    const otherClient = await connect(INTENTS, TOKEN, other.url)
    const otherBase = other.url.replace('ws://', 'http://')
    const otherResponse = await fetch(otherBase + ROOT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guild_id: guild,
        bot_id: BOT,
        events: ['GUILD_BAN_ADD', 'GUILD_BAN_REMOVE'],
        session_id: otherClient.sessionId,
      }),
    })
    expect(otherResponse.status).toBe(201)
    const otherId = ((await otherResponse.json()) as { id: string }).id
    const id = await arm()
    const filtered = await arm({ session_id: noIntent.sessionId })
    expect(
      await status(ROOT, 'POST', {
        guild_id: guild,
        bot_id: BOT,
        session_id: alias.sessionId,
        events: ['GUILD_BAN_ADD'],
      })
    ).toBe(404)
    const siblingGuild = seedGuild(server.db, TOKEN, '333333333333333333')
    for (const guildId of [guild, siblingGuild]) {
      expect(await status(`/guilds/${guildId}/bans/${UNKNOWN}`, 'PUT')).toBe(
        204
      )
      expect(await status(`/guilds/${guildId}/bans/${UNKNOWN}`, 'DELETE')).toBe(
        204
      )
    }
    const captured = await captures(id)
    expect(captured.map((entry) => entry.envelope.t)).toEqual([
      'GUILD_BAN_ADD',
      'GUILD_BAN_REMOVE',
    ])
    expect(await captures(filtered)).toEqual([])
    const frames = await drain(client)
    expect(frames.map((frame) => frame.d?.guild_id)).toEqual([
      siblingGuild,
      siblingGuild,
    ])
    expect(await eventTypes(sibling)).toEqual([
      'GUILD_BAN_ADD',
      'GUILD_BAN_REMOVE',
      'GUILD_BAN_ADD',
      'GUILD_BAN_REMOVE',
    ])
    for (const excluded of [noIntent, alias, foreign, otherClient])
      expect(await drain(excluded)).toEqual([])
    const evidence = await fetch(`${otherBase}${ROOT}/${otherId}`)
    expect(evidence.status).toBe(200)
    expect(await evidence.json()).toMatchObject({ events_captured: [] })
  })

  it('fails open at the capture limit and recovers and retires exact keyed ownership', async () => {
    const policy = { ownership_key: 'ban-owner', member_id: UNKNOWN, limit: 1 }
    const id = await arm(policy)
    const query = new URLSearchParams({
      bot_id: BOT,
      guild_id: guild,
      session_id: client.sessionId,
    })
    const address = `${ROOT}/by-key/ban-owner?${query}`
    expect(await status(`/guilds/${guild}/bans/${UNKNOWN}`, 'PUT')).toBe(204)
    expect(await status(`/guilds/${guild}/bans/${UNKNOWN}`, 'DELETE')).toBe(204)
    expect(await eventTypes(client)).toEqual(['GUILD_BAN_REMOVE'])
    const snapshot = await observe(id)
    expect(snapshot).toMatchObject({
      skipped: 1,
      events_captured: [{ state: 'held' }],
    })
    const recovered = await request(address)
    expect(await recovered.json()).toEqual(snapshot)
    expect(await arm(policy)).toBe(id)
    expect(await status(address, 'DELETE')).toBe(204)
    expect(await status(address)).toBe(404)
    expect(await status(address, 'DELETE')).toBe(204)
    expect(
      await status(ROOT, 'POST', {
        guild_id: guild,
        bot_id: BOT,
        session_id: client.sessionId,
        events: ['GUILD_BAN_ADD', 'GUILD_BAN_REMOVE'],
        hold: true,
        ...policy,
      })
    ).toBe(409)
    expect(await status(`/guilds/${guild}/bans/${UNKNOWN}`, 'PUT')).toBe(204)
    expect(await eventTypes(client)).toEqual(['GUILD_BAN_ADD'])
  })

  it.each([
    'expiry',
    'cancel',
    'disconnect',
    'reset',
    'global-reset',
    'setup',
    'guild',
    'detach',
  ])(
    'discards held ban snapshots on %s without emitting cleanup ban events',
    async (cleanup) => {
      const id = await arm(cleanup === 'expiry' ? { ttl_ms: 100 } : {})
      expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'PUT')).toBe(204)
      await drain(client)
      const captured = await captures(id)
      const held = captured[0]
      switch (cleanup) {
        case 'expiry': {
          await expect.poll(() => status(`${ROOT}/${id}`)).toBe(404)
          break
        }
        case 'cancel': {
          expect(await status(`${ROOT}/${id}`, 'DELETE')).toBe(204)
          break
        }
        case 'disconnect': {
          const closed = once(client.ws, 'close')
          client.ws.close()
          await closed
          break
        }
        case 'reset':
        case 'global-reset': {
          expect(
            await status(
              '/_test/reset',
              'POST',
              cleanup === 'reset' ? { token: TOKEN } : {}
            )
          ).toBe(204)
          break
        }
        case 'setup': {
          expect(
            await status(`/_test/setup/${encodeURIComponent(TOKEN)}`, 'DELETE')
          ).toBe(204)
          break
        }
        case 'guild': {
          expect(await status(`/guilds/${guild}`, 'DELETE')).toBe(204)
          break
        }
        default: {
          expect(await status(`/guilds/${guild}/bans/${BOT}`, 'PUT')).toBe(204)
          await drain(client)
          const seq = server.sessionManager.get(client.sessionId)?.seq
          expect(await status(`/guilds/${guild}/bans/${ALICE}`, 'DELETE')).toBe(
            204
          )
          expect(await status(`/guilds/${guild}/bans/${UNKNOWN}`, 'PUT')).toBe(
            204
          )
          expect(
            await status(`/guilds/${guild}/bans/${UNKNOWN}`, 'DELETE')
          ).toBe(204)
          expect(server.sessionManager.get(client.sessionId)?.seq).toBe(seq)
        }
      }
      expect(await status(`${ROOT}/${id}`)).toBe(404)
      expect(
        await status(`${ROOT}/${id}/release`, 'POST', { event_ids: [held.id] })
      ).toBe(404)
      if (cleanup === 'disconnect') return
      const frames = await drain(client)
      expect(
        frames.filter((frame) => frame.t?.startsWith('GUILD_BAN_'))
      ).toEqual([])
    }
  )
})
