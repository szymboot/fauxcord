import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedVoiceChannel,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'
import { initializeDatabase } from '../db'
import { SessionManager, type Session } from './session'
import { GatewayGuildOutages, RETAIN_MS } from './guild-outages'

/** Real Gateway connection and every frame it received. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
  closed: Promise<number>
}

/** One recorded GUILD_DELETE or GUILD_CREATE write. */
interface DispatchObservation {
  session_id: string
  trigger: string
  unavailable?: boolean
  sequence: number
  ready_sequence?: number | null
  transport: string
  dispatched_at: number
  member_count?: number
  channel_count?: number
  voice_states?: {
    user_id: string
    channel_id: string | null
    self_stream: boolean
  }[]
  voice_states_total?: number
}

/** Public outage record returned by the control. */
interface Outage {
  id: string
  ownership_key: string | null
  bot_id: string
  guild_id: string
  status: string
  ended_by: string | null
  ttl_ms: number
  identify_dispatch: string
  started_at: number
  expires_at: number
  ended_at: number | null
  retained_until: number | null
  recovery_snapshot: boolean | null
  guild_deletes: DispatchObservation[]
  guild_deletes_skipped: number
  guild_creates: DispatchObservation[]
  guild_creates_skipped: number
  suppressed_dispatches: number
  suppressed_by_event: Record<string, number>
}

const TOKEN = 'Bot outage'
const OTHER_TOKEN = 'Bot outage-other'
const BOT_ID = '111111111111111111'
const OTHER_BOT_ID = '121212121212121212'
const GUILD_A = '222222222222222222'
const GUILD_B = '232323232323232323'
const OTHER_GUILD = '242424242424242424'
const TEXT_A = '333333333333333333'
const TEXT_B = '343434343434343434'
const VOICE_A = '555555555555555555'
const VOICE_B = '565656565656565656'
const OTHER_VOICE = '575757575757575757'
const HUMAN_A = '888888888888888888'
const HUMAN_B = '898989898989898989'
const LATE_HUMAN = '909090909090909090'
const ROOT = '/_test/gateway-guild-outages'
const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildVoiceStates |
  GatewayIntentBits.GuildMessages

describe('Gateway guild outage control', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let client: Client
  const clients: Client[] = []

  /** Calls the unauthenticated test-control API over the live HTTP server. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined && {
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    })
  }

  /** Returns only the HTTP status of a test-control call. */
  async function status(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<number> {
    const response = await request(path, method, body)
    return response.status
  }

  /** Resolves once a frame matching the predicate has arrived (no sleeps). */
  async function frame(
    target: Client,
    predicate: (payload: Client['frames'][number]) => boolean
  ): Promise<Client['frames'][number]> {
    const existing = target.frames.find((entry) => predicate(entry))
    return (
      existing ??
      new Promise((resolve) => {
        /** Resolves on the first matching frame and detaches itself. */
        const listener = (raw: Buffer): void => {
          const payload = JSON.parse(raw.toString()) as Client['frames'][number]
          if (!predicate(payload)) return
          target.ws.off('message', listener)
          resolve(payload)
        }
        target.ws.on('message', listener)
      })
    )
  }

  /** Fences previously written frames with an ordered heartbeat round trip. */
  async function fence(target: Client): Promise<void> {
    const before = target.frames.filter((entry) => entry.op === 11).length
    const ack = new Promise<void>((resolve) => {
      /** Resolves on the next heartbeat acknowledgement. */
      const listener = (): void => {
        if (target.frames.filter((entry) => entry.op === 11).length <= before)
          return
        target.ws.off('message', listener)
        resolve()
      }
      target.ws.on('message', listener)
    })
    target.ws.send(JSON.stringify({ op: 1, d: null }))
    await ack
  }

  /** Opens a socket and returns it after HELLO, without identifying. */
  async function open(): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => {
        resolve(code)
      })
    })
    const hello = once(ws, 'message')
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await hello
    const result = { ws, frames, sessionId: '', closed }
    clients.push(result)
    return result
  }

  /** Connects and IDENTIFYs, waiting for READY and one frame per READY guild. */
  async function connect(
    token = TOKEN,
    intents: number = INTENTS,
    guilds = [GUILD_A, GUILD_B]
  ): Promise<Client> {
    const result = await open()
    result.ws.send(JSON.stringify({ op: 2, d: { token, intents } }))
    const ready = await frame(result, (entry) => entry.t === 'READY')
    result.sessionId = String(ready.d?.session_id)
    if (intents & GatewayIntentBits.Guilds) {
      for (const guild of guilds) {
        await frame(
          result,
          (entry) =>
            (entry.t === 'GUILD_CREATE' || entry.t === 'GUILD_DELETE') &&
            entry.d?.id === guild
        )
      }
    }
    return result
  }

  /** Starts an outage and returns its decoded record. */
  async function start(extra: Record<string, unknown> = {}): Promise<Outage> {
    const response = await request(ROOT, 'POST', {
      bot_id: BOT_ID,
      guild_id: GUILD_A,
      ...extra,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as Outage
  }

  /** Ends an outage by ID and returns its decoded record. */
  async function end(id: string): Promise<Outage> {
    const response = await request(`${ROOT}/${id}/end`, 'POST')
    expect(response.status).toBe(200)
    return (await response.json()) as Outage
  }

  /** Reads an outage by ID, optionally long-polling for recovery. */
  async function inspect(id: string, waitMs?: number): Promise<Outage> {
    const response = await request(
      `${ROOT}/${id}${waitMs === undefined ? '' : `?wait_ms=${waitMs}`}`
    )
    expect(response.status).toBe(200)
    return (await response.json()) as Outage
  }

  /** Prepares a voice state through the fixture route (emits by default). */
  async function voice(
    guild: string,
    user: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const response = await request(
      `/_test/guilds/${guild}/voice-states/${user}`,
      'PATCH',
      body
    )
    expect(response.status).toBe(200)
  }

  /** Injects a human message into a channel. */
  async function message(channel: string, author: string): Promise<void> {
    const response = await request(
      `/_test/channels/${channel}/messages`,
      'POST',
      { content: 'hello', author: { id: author } }
    )
    expect(response.status).toBe(201)
  }

  /** Dispatch frames of one guild received by a client. */
  function guildFrames(target: Client, guild: string): Client['frames'] {
    return target.frames.filter(
      (entry) =>
        entry.op === 0 &&
        (entry.d?.guild_id === guild ||
          (typeof entry.t === 'string' &&
            entry.t.startsWith('GUILD_') &&
            entry.d?.id === guild))
    )
  }

  /** Highest sequence a client has received so far. */
  function lastSequence(target: Client): number {
    return Math.max(...target.frames.map((entry) => entry.s ?? 0))
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT_ID)
    seedGuild(server.db, TOKEN, GUILD_A)
    seedGuild(server.db, TOKEN, GUILD_B)
    seedChannel(server.db, GUILD_A, TEXT_A)
    seedChannel(server.db, GUILD_B, TEXT_B)
    seedVoiceChannel(server.db, GUILD_A, VOICE_A)
    seedVoiceChannel(server.db, GUILD_B, VOICE_B)
    seedMember(server.db, GUILD_A, HUMAN_A)
    seedMember(server.db, GUILD_B, HUMAN_B)
    seedBot(server.db, OTHER_TOKEN, OTHER_BOT_ID)
    seedGuild(server.db, OTHER_TOKEN, OTHER_GUILD)
    seedVoiceChannel(server.db, OTHER_GUILD, OTHER_VOICE)
    seedMember(server.db, OTHER_GUILD, HUMAN_B)
    client = await connect()
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('sends GUILD_DELETE unavailable, silences the guild and recovers with a current GUILD_CREATE snapshot', async () => {
    const second = await connect()
    const before = lastSequence(client)

    const outage = await start({ ttl_ms: 60_000 })
    expect(outage).toMatchObject({
      ownership_key: null,
      bot_id: BOT_ID,
      guild_id: GUILD_A,
      status: 'unavailable',
      ended_by: null,
      ttl_ms: 60_000,
      identify_dispatch: 'guild_delete',
      ended_at: null,
      retained_until: null,
      guild_creates: [],
      suppressed_dispatches: 0,
    })
    expect(outage.expires_at - outage.started_at).toBe(60_000)

    // GUILD_DELETE is a normally sequenced dispatch on every live session.
    for (const target of [client, second]) {
      const deleted = await frame(target, (entry) => entry.t === 'GUILD_DELETE')
      expect(deleted.d).toEqual({ id: GUILD_A, unavailable: true })
      const observed = outage.guild_deletes.find(
        (entry) => entry.session_id === target.sessionId
      )
      expect(observed).toMatchObject({
        trigger: 'outage_start',
        sequence: deleted.s,
        ready_sequence: null,
      })
      expect(observed?.dispatched_at).toBeGreaterThanOrEqual(outage.started_at)
    }
    expect(outage.guild_deletes).toHaveLength(2)
    const deleteSequence = Number(
      client.frames.find((entry) => entry.t === 'GUILD_DELETE')?.s
    )
    expect(deleteSequence).toBe(before + 1)

    // State changes of the unavailable guild persist but are not dispatched.
    await voice(GUILD_A, HUMAN_A, { channel_id: VOICE_A, self_stream: true })
    await message(TEXT_A, HUMAN_A)
    seedMember(server.db, GUILD_A, LATE_HUMAN)
    await voice(GUILD_A, LATE_HUMAN, { channel_id: VOICE_A })
    // REST for the guild keeps working.
    const rest = await fetch(`${base}/api/v10/guilds/${GUILD_A}`, {
      headers: { Authorization: TOKEN },
    })
    expect(rest.status).toBe(200)

    // Other guilds of the same bot keep flowing, sequenced without gaps.
    await voice(GUILD_B, HUMAN_B, { channel_id: VOICE_B })
    const other = await frame(
      client,
      (entry) =>
        entry.t === 'VOICE_STATE_UPDATE' && entry.d?.guild_id === GUILD_B
    )
    expect(other.s).toBe(deleteSequence + 1)
    await fence(client)
    await fence(second)
    for (const target of [client, second]) {
      const silent = guildFrames(target, GUILD_A).filter(
        (entry) => Number(entry.s) > deleteSequence
      )
      expect(silent).toEqual([])
    }

    const during = await inspect(outage.id)
    expect(during.suppressed_dispatches).toBe(6)
    expect(during.suppressed_by_event).toEqual({
      VOICE_STATE_UPDATE: 4,
      MESSAGE_CREATE: 2,
    })

    const ended = await end(outage.id)
    expect(ended).toMatchObject({
      status: 'recovered',
      ended_by: 'request',
      recovery_snapshot: true,
    })
    expect(ended.ended_at).toBeGreaterThanOrEqual(outage.started_at)
    expect(ended.retained_until).toBe(Number(ended.ended_at) + RETAIN_MS)
    for (const target of [client, second]) {
      const created = await frame(
        target,
        (entry) =>
          entry.t === 'GUILD_CREATE' && Number(entry.s) > deleteSequence
      )
      expect(created.d).toMatchObject({ id: GUILD_A, unavailable: false })
      expect(created.d?.voice_states).toMatchObject([
        { user_id: HUMAN_A, channel_id: VOICE_A, self_stream: true },
        { user_id: LATE_HUMAN, channel_id: VOICE_A },
      ])
      expect(
        (created.d?.members as { user: { id: string } }[]).map(
          (member) => member.user.id
        )
      ).toEqual(expect.arrayContaining([HUMAN_A, LATE_HUMAN]))
    }

    const settled = await inspect(outage.id, 5000)
    expect(settled.guild_creates).toHaveLength(2)
    const firstCreate = settled.guild_creates.find(
      (entry) => entry.session_id === client.sessionId
    )
    expect(firstCreate).toMatchObject({
      trigger: 'recovery',
      sequence: client.frames.findLast((entry) => entry.t === 'GUILD_CREATE')
        ?.s,
      transport: 'sent',
      member_count: 2,
      channel_count: 2,
      voice_states_total: 2,
    })
    expect(firstCreate?.dispatched_at).toBeGreaterThanOrEqual(
      Number(ended.ended_at)
    )

    // Events flow normally again.
    await voice(GUILD_A, HUMAN_A, { self_stream: false })
    const update = await frame(
      client,
      (entry) =>
        entry.t === 'VOICE_STATE_UPDATE' &&
        entry.d?.guild_id === GUILD_A &&
        entry.d.self_stream === false
    )
    expect(update.d).toMatchObject({ user_id: HUMAN_A })
    const after = await inspect(outage.id)
    expect(after.suppressed_dispatches).toBe(6)

    // Ending again is idempotent and dispatches nothing new.
    const again = await end(outage.id)
    expect(again.guild_creates).toHaveLength(2)
    expect(again.ended_at).toBe(ended.ended_at)
  })

  it('isolates the outage to one guild and one bot setup', async () => {
    const other = await connect(OTHER_TOKEN, INTENTS, [OTHER_GUILD])
    const outage = await start()
    await frame(client, (entry) => entry.t === 'GUILD_DELETE')

    await voice(OTHER_GUILD, HUMAN_B, { channel_id: OTHER_VOICE })
    const otherUpdate = await frame(
      other,
      (entry) => entry.t === 'VOICE_STATE_UPDATE'
    )
    expect(otherUpdate.d).toMatchObject({ guild_id: OTHER_GUILD })
    await fence(other)
    expect(other.frames.some((entry) => entry.t === 'GUILD_DELETE')).toBe(false)

    // Starting another outage of the same guild is BUSY; other guilds are not.
    const busy = await request(ROOT, 'POST', {
      bot_id: BOT_ID,
      guild_id: GUILD_A,
    })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({ message: 'BUSY', code: 0 })
    const otherOutage = await start({
      bot_id: OTHER_BOT_ID,
      guild_id: OTHER_GUILD,
    })
    await frame(other, (entry) => entry.t === 'GUILD_DELETE')
    await fence(client)
    expect(
      client.frames.filter((entry) => entry.t === 'GUILD_DELETE')
    ).toHaveLength(1)
    expect(otherOutage.guild_deletes.map((entry) => entry.session_id)).toEqual([
      other.sessionId,
    ])

    // A bot cannot start an outage of a guild owned by another setup.
    expect(
      await status(ROOT, 'POST', { bot_id: BOT_ID, guild_id: OTHER_GUILD })
    ).toBe(404)
    expect(
      await status(ROOT, 'POST', { bot_id: OTHER_BOT_ID, guild_id: GUILD_B })
    ).toBe(404)

    await end(outage.id)
    await frame(
      client,
      (entry) => entry.t === 'GUILD_CREATE' && Number(entry.s) > 3
    )
    await fence(other)
    expect(
      other.frames.filter(
        (entry) => entry.t === 'GUILD_CREATE' && entry.d?.id === GUILD_A
      )
    ).toEqual([])
  })

  it('RESUME during an outage replays GUILD_DELETE but never suppressed events', async () => {
    const lastBefore = lastSequence(client)
    const outage = await start()
    const deleted = await frame(client, (entry) => entry.t === 'GUILD_DELETE')

    // The client drops before reading GUILD_DELETE; events happen meanwhile.
    client.ws.terminate()
    await client.closed
    await voice(GUILD_A, HUMAN_A, { channel_id: VOICE_A })
    await voice(GUILD_B, HUMAN_B, { channel_id: VOICE_B })

    const resumed = await open()
    resumed.ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq: lastBefore },
      })
    )
    const marker = await frame(resumed, (entry) => entry.t === 'RESUMED')
    const replayed = resumed.frames.filter(
      (entry) => entry.op === 0 && entry.t !== 'RESUMED'
    )
    expect(replayed.map((entry) => [entry.t, entry.s])).toEqual([
      ['GUILD_DELETE', deleted.s],
      ['VOICE_STATE_UPDATE', Number(deleted.s) + 1],
    ])
    expect(replayed[1]?.d).toMatchObject({ guild_id: GUILD_B })
    expect(marker.s).toBe(Number(deleted.s) + 2)
    expect(
      server.sessionManager
        .get(client.sessionId)
        ?.replayBuffer.some(
          (entry) =>
            (entry.event.d as { guild_id?: string } | null)?.guild_id ===
            GUILD_A
        )
    ).toBe(false)

    // Still unavailable after RESUME; recovery reaches the resumed socket.
    await voice(GUILD_A, HUMAN_A, { self_mute: true })
    await end(outage.id)
    const created = await frame(resumed, (entry) => entry.t === 'GUILD_CREATE')
    expect(created.s).toBe(Number(marker.s) + 1)
    expect(created.d?.voice_states).toMatchObject([
      { user_id: HUMAN_A, channel_id: VOICE_A, self_mute: true },
    ])
    const record = await inspect(outage.id, 5000)
    expect(record.guild_creates).toMatchObject([
      { session_id: client.sessionId, sequence: created.s, transport: 'sent' },
    ])
  })

  it('buffers GUILD_DELETE for a session awaiting RESUME and replays it', async () => {
    const lastBefore = lastSequence(client)
    client.ws.terminate()
    await client.closed
    const outage = await start()
    expect(outage.guild_deletes).toMatchObject([
      {
        session_id: client.sessionId,
        sequence: lastBefore + 1,
        transport: 'buffered',
      },
    ])

    const resumed = await open()
    resumed.ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq: lastBefore },
      })
    )
    await frame(resumed, (entry) => entry.t === 'RESUMED')
    expect(
      resumed.frames.filter((entry) => entry.t === 'GUILD_DELETE')
    ).toMatchObject([
      { s: lastBefore + 1, d: { id: GUILD_A, unavailable: true } },
    ])
  })

  it('IDENTIFY during an outage lists the guild unavailable and sends GUILD_DELETE instead of GUILD_CREATE', async () => {
    const outage = await start()
    await voice(GUILD_A, HUMAN_A, { channel_id: VOICE_A })

    const late = await connect()
    const ready = late.frames.find((entry) => entry.t === 'READY')
    expect(ready?.d?.guilds).toEqual(
      expect.arrayContaining([
        { id: GUILD_A, unavailable: true },
        { id: GUILD_B, unavailable: true },
      ])
    )
    await fence(late)
    const dispatched = late.frames
      .filter(
        (entry) => entry.t === 'GUILD_CREATE' || entry.t === 'GUILD_DELETE'
      )
      .map((entry) => [entry.t, entry.d?.id])
    expect(dispatched).toEqual(
      expect.arrayContaining([
        ['GUILD_DELETE', GUILD_A],
        ['GUILD_CREATE', GUILD_B],
      ])
    )
    expect(dispatched).toHaveLength(2)
    expect(late.frames.find((entry) => entry.t === 'GUILD_DELETE')?.d).toEqual({
      id: GUILD_A,
      unavailable: true,
    })

    const record = await inspect(outage.id)
    expect(
      record.guild_deletes.find((entry) => entry.session_id === late.sessionId)
    ).toMatchObject({
      trigger: 'identify',
      ready_sequence: ready?.s,
      sequence: late.frames.find((entry) => entry.t === 'GUILD_DELETE')?.s,
    })

    await end(outage.id)
    const created = await frame(
      late,
      (entry) => entry.t === 'GUILD_CREATE' && entry.d?.id === GUILD_A
    )
    expect(created.d?.voice_states).toMatchObject([
      { user_id: HUMAN_A, channel_id: VOICE_A },
    ])
  })

  it('IDENTIFY during an outage can receive the unavailable stub as GUILD_CREATE instead', async () => {
    const outage = await start({ identify_dispatch: 'guild_create' })
    expect(outage.identify_dispatch).toBe('guild_create')
    // Sessions live at the start still get GUILD_DELETE (guild became unavailable).
    await frame(client, (entry) => entry.t === 'GUILD_DELETE')
    await voice(GUILD_A, HUMAN_A, { channel_id: VOICE_A })

    const late = await connect()
    const ready = late.frames.find((entry) => entry.t === 'READY')
    expect(ready?.d?.guilds).toEqual(
      expect.arrayContaining([{ id: GUILD_A, unavailable: true }])
    )
    await fence(late)
    expect(late.frames.some((entry) => entry.t === 'GUILD_DELETE')).toBe(false)
    const stubs = late.frames.filter(
      (entry) => entry.t === 'GUILD_CREATE' && entry.d?.id === GUILD_A
    )
    // Exactly the unavailable guild object, never guild data.
    expect(stubs.map((entry) => entry.d)).toEqual([
      { id: GUILD_A, unavailable: true },
    ])
    expect(
      late.frames.find(
        (entry) => entry.t === 'GUILD_CREATE' && entry.d?.id === GUILD_B
      )?.d
    ).toMatchObject({ unavailable: false })

    const during = await inspect(outage.id)
    expect(during.guild_deletes.map((entry) => entry.session_id)).toEqual([
      client.sessionId,
    ])
    expect(during.guild_creates).toMatchObject([
      {
        session_id: late.sessionId,
        trigger: 'identify',
        unavailable: true,
        sequence: stubs[0]?.s,
        ready_sequence: ready?.s,
        member_count: 0,
        voice_states_total: 0,
      },
    ])

    await end(outage.id)
    const recovered = await frame(
      late,
      (entry) =>
        entry.t === 'GUILD_CREATE' &&
        entry.d?.id === GUILD_A &&
        entry.d.unavailable === false
    )
    expect(recovered.d?.voice_states).toMatchObject([
      { user_id: HUMAN_A, channel_id: VOICE_A },
    ])
    const settled = await inspect(outage.id, 5000)
    const recoveries = settled.guild_creates.filter(
      (entry) => entry.trigger === 'recovery'
    )
    expect(recoveries).toHaveLength(2)
    expect(recoveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: client.sessionId,
          unavailable: false,
        }),
        expect.objectContaining({
          session_id: late.sessionId,
          unavailable: false,
        }),
      ])
    )
  })

  it('keeps suppressing for sessions without the Guilds intent but sends them no GUILD_DELETE', async () => {
    const voiceOnly = await connect(
      TOKEN,
      GatewayIntentBits.GuildVoiceStates,
      []
    )
    const outage = await start()
    expect(outage.guild_deletes.map((entry) => entry.session_id)).toEqual([
      client.sessionId,
    ])
    await voice(GUILD_A, HUMAN_A, { channel_id: VOICE_A })
    await voice(GUILD_B, HUMAN_B, { channel_id: VOICE_B })
    await frame(voiceOnly, (entry) => entry.t === 'VOICE_STATE_UPDATE')
    await fence(voiceOnly)
    expect(
      voiceOnly.frames
        .filter((entry) => entry.op === 0 && entry.t !== 'READY')
        .map((entry) => [entry.t, entry.d?.guild_id])
    ).toEqual([['VOICE_STATE_UPDATE', GUILD_B]])
    const ended = await end(outage.id)
    expect(ended.guild_creates.map((entry) => entry.session_id)).toEqual([
      client.sessionId,
    ])
  })

  it('ends the outage with a recovery GUILD_CREATE when its TTL expires', async () => {
    const outage = await start({ ttl_ms: 50 })
    await frame(client, (entry) => entry.t === 'GUILD_DELETE')
    const recovered = await inspect(outage.id, 5000)
    expect(recovered).toMatchObject({ status: 'recovered', ended_by: 'ttl' })
    expect(recovered.guild_creates).toMatchObject([
      { session_id: client.sessionId, transport: 'sent' },
    ])
    const created = await frame(
      client,
      (entry) =>
        entry.t === 'GUILD_CREATE' &&
        entry.s === recovered.guild_creates[0]?.sequence
    )
    expect(created.d).toMatchObject({ id: GUILD_A })
  })

  it('supports keyed idempotent creation, recovery by key, ending and tombstones', async () => {
    const key = 'outage-1'
    const address = `${ROOT}/by-key/${key}?bot_id=${BOT_ID}&guild_id=${GUILD_A}`
    const first = await start({ ownership_key: key })
    expect(first.ownership_key).toBe(key)
    const retry = await start({ ownership_key: key })
    expect(retry.id).toBe(first.id)
    await fence(client)
    expect(
      client.frames.filter((entry) => entry.t === 'GUILD_DELETE')
    ).toHaveLength(1)

    // Different owner or TTL with the same key conflicts.
    expect(
      await status(ROOT, 'POST', {
        ownership_key: key,
        bot_id: BOT_ID,
        guild_id: GUILD_A,
        ttl_ms: 1000,
      })
    ).toBe(409)
    expect(
      await status(ROOT, 'POST', {
        ownership_key: key,
        bot_id: BOT_ID,
        guild_id: GUILD_B,
      })
    ).toBe(409)
    expect(
      await status(ROOT, 'POST', {
        ownership_key: key,
        bot_id: BOT_ID,
        guild_id: GUILD_A,
        identify_dispatch: 'guild_create',
      })
    ).toBe(409)
    // The explicit default is the same request.
    expect(
      await status(ROOT, 'POST', {
        ownership_key: key,
        bot_id: BOT_ID,
        guild_id: GUILD_A,
        identify_dispatch: 'guild_delete',
      })
    ).toBe(201)

    const byKey = await request(address)
    expect(byKey.status).toBe(200)
    expect(byKey.headers.get('cache-control')).toBe('no-store')
    expect(((await byKey.json()) as Outage).id).toBe(first.id)
    expect(
      await status(`${ROOT}/by-key/${key}?bot_id=${BOT_ID}&guild_id=${GUILD_B}`)
    ).toBe(404)

    const ended = await request(
      `${ROOT}/by-key/${key}/end?bot_id=${BOT_ID}&guild_id=${GUILD_A}`,
      'POST'
    )
    expect(ended.status).toBe(200)
    expect(((await ended.json()) as Outage).status).toBe('recovered')
    await frame(
      client,
      (entry) => entry.t === 'GUILD_CREATE' && Number(entry.s) > 3
    )

    expect(await status(address, 'DELETE')).toBe(204)
    expect(await status(address)).toBe(404)
    expect(await status(`${ROOT}/${first.id}`)).toBe(404)
    // A closed key never starts another outage.
    expect(
      await status(ROOT, 'POST', {
        ownership_key: key,
        bot_id: BOT_ID,
        guild_id: GUILD_A,
      })
    ).toBe(409)

    // Unused keys can be tombstoned only within a valid scope.
    expect(
      await status(
        `${ROOT}/by-key/unused?bot_id=${BOT_ID}&guild_id=${OTHER_GUILD}`,
        'DELETE'
      )
    ).toBe(404)
    expect(
      await status(
        `${ROOT}/by-key/unused?bot_id=${BOT_ID}&guild_id=${GUILD_A}`,
        'DELETE'
      )
    ).toBe(204)
    expect(
      await status(ROOT, 'POST', {
        ownership_key: 'unused',
        bot_id: BOT_ID,
        guild_id: GUILD_A,
      })
    ).toBe(409)
    await fence(client)
    expect(
      client.frames.filter((entry) => entry.t === 'GUILD_DELETE')
    ).toHaveLength(1)
  })

  it('DELETE of an active outage recovers the guild and discards evidence', async () => {
    const outage = await start()
    await frame(client, (entry) => entry.t === 'GUILD_DELETE')
    expect(await status(`${ROOT}/${outage.id}`, 'DELETE')).toBe(204)
    const created = await frame(
      client,
      (entry) => entry.t === 'GUILD_CREATE' && Number(entry.s) > 3
    )
    expect(created.d).toMatchObject({ id: GUILD_A })
    expect(await status(`${ROOT}/${outage.id}`)).toBe(404)
    expect(await status(`${ROOT}/${outage.id}`, 'DELETE')).toBe(404)
    expect(await status(`${ROOT}/${outage.id}/end`, 'POST')).toBe(404)
    // Events flow again.
    await voice(GUILD_A, HUMAN_A, { channel_id: VOICE_A })
    await frame(
      client,
      (entry) =>
        entry.t === 'VOICE_STATE_UPDATE' && entry.d?.guild_id === GUILD_A
    )
  })

  it('/_test/reset recovers active outages and discards their records', async () => {
    const outage = await start()
    await voice(GUILD_A, HUMAN_A, { channel_id: VOICE_A, emit: false })
    await frame(client, (entry) => entry.t === 'GUILD_DELETE')
    expect(await status('/_test/reset', 'POST', { token: TOKEN })).toBe(204)
    const created = await frame(
      client,
      (entry) => entry.t === 'GUILD_CREATE' && Number(entry.s) > 3
    )
    // The snapshot reflects reset state (voice states are cleared by reset).
    expect(created.d).toMatchObject({ id: GUILD_A, voice_states: [] })
    expect(await status(`${ROOT}/${outage.id}`)).toBe(404)
  })

  it('losing the guild during an outage still delivers the removal GUILD_DELETE and discards the outage', async () => {
    const outage = await start()
    const unavailable = await frame(
      client,
      (entry) => entry.t === 'GUILD_DELETE'
    )
    const deleted = await fetch(`${base}/api/v10/guilds/${GUILD_A}`, {
      method: 'DELETE',
      headers: { Authorization: TOKEN },
    })
    expect(deleted.status).toBe(204)
    const removed = await frame(
      client,
      (entry) =>
        entry.t === 'GUILD_DELETE' && Number(entry.s) > Number(unavailable.s)
    )
    // Without `unavailable` the bot was removed (Discord Guild Delete docs).
    expect(removed).toMatchObject({
      s: Number(unavailable.s) + 1,
      d: { id: GUILD_A },
    })
    expect(removed.d).not.toHaveProperty('unavailable')
    expect(await status(`${ROOT}/${outage.id}`)).toBe(404)

    // Leaving through REST behaves the same; the bot's own
    // GUILD_MEMBER_REMOVE is an event of the unavailable guild.
    const members = await connect(
      TOKEN,
      GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
      [GUILD_B]
    )
    const second = await start({ guild_id: GUILD_B })
    const left = await fetch(`${base}/api/v10/users/@me/guilds/${GUILD_B}`, {
      method: 'DELETE',
      headers: { Authorization: TOKEN },
    })
    expect(left.status).toBe(204)
    await frame(
      client,
      (entry) =>
        entry.t === 'GUILD_DELETE' &&
        entry.d?.id === GUILD_B &&
        entry.d.unavailable === undefined
    )
    expect(await status(`${ROOT}/${second.id}`)).toBe(404)
    await frame(
      members,
      (entry) =>
        entry.t === 'GUILD_DELETE' && entry.d?.unavailable === undefined
    )
    await fence(members)
    expect(
      members.frames.filter((entry) => entry.t === 'GUILD_MEMBER_REMOVE')
    ).toEqual([])
    await fence(client)
    expect(
      client.frames.filter(
        (entry) => entry.t === 'GUILD_CREATE' && Number(entry.s) > 3
      )
    ).toEqual([])
  })

  it('setup deletion discards outages without dispatching', async () => {
    seedGuild(server.db, TOKEN, '252525252525252525')

    const second = await start({ guild_id: GUILD_B })
    const third = await start({ guild_id: '252525252525252525' })
    expect(
      await status(`/_test/setup/${encodeURIComponent(TOKEN)}`, 'DELETE')
    ).toBe(204)
    expect(await status(`${ROOT}/${second.id}`)).toBe(404)
    expect(await status(`${ROOT}/${third.id}`)).toBe(404)
    await fence(client)
    expect(
      client.frames.filter(
        (entry) => entry.t === 'GUILD_CREATE' && Number(entry.s) > 3
      )
    ).toEqual([])
  })

  it('never recovers with a snapshot of a guild another setup took over', async () => {
    const other = await connect(OTHER_TOKEN, INTENTS, [OTHER_GUILD])
    const outage = await start()
    await frame(client, (entry) => entry.t === 'GUILD_DELETE')
    expect(
      await status('/_test/setup', 'POST', {
        token: 'Bot outage-takeover',
        user: { id: '131313131313131313' },
        guilds: [{ id: GUILD_A, name: 'Taken over', channels: [] }],
      })
    ).toBe(201)
    // Setup's own GUILD_CREATE broadcast predates the end of the outage.
    await fence(other)
    const otherBefore = lastSequence(other)

    const ended = await end(outage.id)
    expect(ended).toMatchObject({
      status: 'recovered',
      recovery_snapshot: false,
      guild_creates: [],
    })
    await fence(client)
    await fence(other)
    expect(
      client.frames.filter(
        (entry) => entry.t === 'GUILD_CREATE' && entry.d?.name === 'Taken over'
      )
    ).toEqual([])
    expect(
      other.frames.filter(
        (entry) => entry.t === 'GUILD_CREATE' && Number(entry.s) > otherBefore
      )
    ).toEqual([])
  })

  it('validates requests and query parameters', async () => {
    for (const body of [
      'not json',
      [],
      {},
      { bot_id: BOT_ID },
      { bot_id: BOT_ID, guild_id: GUILD_A, extra: true },
      { bot_id: '0', guild_id: GUILD_A },
      { bot_id: BOT_ID, guild_id: GUILD_A, ttl_ms: 0 },
      { bot_id: BOT_ID, guild_id: GUILD_A, ttl_ms: 600_001 },
      { bot_id: BOT_ID, guild_id: GUILD_A, ttl_ms: 1.5 },
      { bot_id: BOT_ID, guild_id: GUILD_A, ownership_key: 'bad key' },
      { bot_id: BOT_ID, guild_id: GUILD_A, identify_dispatch: 'bogus' },
      { bot_id: BOT_ID, guild_id: GUILD_A, identify_dispatch: null },
    ]) {
      const response = await request(ROOT, 'POST', body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: '400: Bad Request',
        code: 0,
      })
    }
    expect(await status(ROOT, 'POST', 'x'.repeat(20_000))).toBe(413)
    expect(
      await status(ROOT, 'POST', { bot_id: BOT_ID, guild_id: '999999999999' })
    ).toBe(404)

    const outage = await start()
    expect(await status(`${ROOT}/${outage.id}?wait_ms=30001`)).toBe(400)
    expect(await status(`${ROOT}/${outage.id}?other=1`)).toBe(400)
    expect(await status(`${ROOT}/${outage.id}/end?x=1`, 'POST')).toBe(400)
    expect(await status(`${ROOT}/by-key/k?bot_id=${BOT_ID}`)).toBe(400)
    expect(
      await status(
        `${ROOT}/by-key/k?bot_id=${BOT_ID}&guild_id=${GUILD_A}&guild_id=${GUILD_A}`
      )
    ).toBe(400)
    expect(
      await status(
        `${ROOT}/by-key/k?bot_id=${BOT_ID}&guild_id=${GUILD_A}&wait_ms=1`,
        'DELETE'
      )
    ).toBe(400)
    expect(await status(`${ROOT}/unknown`)).toBe(404)
    // A wait that elapses returns the still-active record.
    const waited = await inspect(outage.id, 20)
    expect(waited.status).toBe('unavailable')
  })

  it('invalidation replacement IDENTIFY completes without a GUILD_CREATE for the unavailable guild', async () => {
    await start()
    await frame(client, (entry) => entry.t === 'GUILD_DELETE')
    const response = await request(
      '/_test/gateway-session-invalidations',
      'POST',
      {
        ownership_key: 'reidentify-outage',
        bot_id: BOT_ID,
        guild_id: GUILD_B,
        session_id: client.sessionId,
      }
    )
    expect(response.status).toBe(201)
    await client.closed
    const replacement = await connect()
    const observed = await request(
      `/_test/gateway-session-invalidations/by-key/reidentify-outage?bot_id=${BOT_ID}&guild_id=${GUILD_B}&session_id=${client.sessionId}&wait_ms=5000`
    )
    const body = (await observed.json()) as {
      status: string
      replacement: {
        session_id: string
        unavailable_guild_ids: string[]
        guild_creates_sent: number
      } | null
    }
    expect(body.status).toBe('identified')
    expect(body.replacement).toMatchObject({
      session_id: replacement.sessionId,
      unavailable_guild_ids: [GUILD_A],
      guild_creates_sent: 1,
    })
  })
})

describe('GatewayGuildOutages limits', () => {
  /** Builds an isolated control with a single-guild setup and fake sessions. */
  function setup(guilds = 40) {
    const db = initializeDatabase(':memory:')
    seedBot(db, 'Bot limits', '111111111111111111')
    const ids = Array.from(
      { length: guilds },
      (_, index) => `30000000000000000${String(index).padStart(2, '0')}`
    )
    for (const id of ids) seedGuild(db, 'Bot limits', id)
    const manager = new SessionManager()
    const controls = new GatewayGuildOutages(db, manager)
    return { db, manager, controls, ids }
  }

  /** Registers a fake open session that records written frames. */
  function session(manager: SessionManager, intents = 1): Session {
    const sent: string[] = []
    return manager.create({
      botId: '111111111111111111',
      token: 'limits',
      intents,
      ws: {
        readyState: 1,
        send: (data: string, callback?: (error?: Error) => void) => {
          sent.push(data)
          callback?.()
        },
      } as never,
    })
  }

  it('caps live records at 32 and frees capacity when they retire', () => {
    vi.useFakeTimers()
    try {
      const { controls, ids } = setup()
      for (const id of ids.slice(0, 32)) {
        expect(
          typeof controls.create({
            bot_id: '111111111111111111',
            guild_id: id,
            ttl_ms: 1000,
          })
        ).toBe('object')
      }
      expect(
        controls.create({
          bot_id: '111111111111111111',
          guild_id: ids[32] ?? '',
          ttl_ms: 1000,
        })
      ).toBe('LIMIT')
      // TTL recovery keeps evidence; capacity frees once retention elapses.
      vi.advanceTimersByTime(1000)
      expect(
        controls.create({
          bot_id: '111111111111111111',
          guild_id: ids[32] ?? '',
          ttl_ms: 1000,
        })
      ).toBe('LIMIT')
      vi.advanceTimersByTime(RETAIN_MS)
      expect(
        typeof controls.create({
          bot_id: '111111111111111111',
          guild_id: ids[32] ?? '',
          ttl_ms: 1000,
        })
      ).toBe('object')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds per-outage dispatch evidence at 50 entries', () => {
    const { manager, controls, ids } = setup(1)
    for (let index = 0; index < 55; index += 1) session(manager)
    const record = controls.create({
      bot_id: '111111111111111111',
      guild_id: ids[0] ?? '',
      ttl_ms: 1000,
    }) as {
      id: string
      guild_deletes: unknown[]
      guild_deletes_skipped: number
    }
    expect(record.guild_deletes).toHaveLength(50)
    expect(record.guild_deletes_skipped).toBe(5)
    const ended = controls.end(record.id) as {
      guild_creates: unknown[]
      guild_creates_skipped: number
      recovery_snapshot: boolean
    }
    expect(ended.guild_creates).toHaveLength(50)
    expect(ended.guild_creates_skipped).toBe(5)
    expect(ended.recovery_snapshot).toBe(true)
    // Every session still received both frames.
    for (const target of manager.getAll()) expect(target.seq).toBe(2)
    controls.reset(undefined, false)
  })

  it('caps concurrent long-poll waiters at 64', async () => {
    const { controls, ids } = setup(1)
    const record = controls.create({
      bot_id: '111111111111111111',
      guild_id: ids[0] ?? '',
      ttl_ms: 60_000,
    }) as { id: string }
    const waits = Array.from({ length: 64 }, () =>
      controls.wait(record.id, 30_000)
    )
    expect(await controls.wait(record.id, 30_000)).toBe('LIMIT')
    controls.end(record.id)
    const results = await Promise.all(waits)
    expect(
      results.every(
        (result) =>
          typeof result === 'object' &&
          (result as { status: string }).status === 'recovered'
      )
    ).toBe(true)
    controls.reset(undefined, false)
  })

  it('keeps waiters blocked until every recovery write settled', async () => {
    const { manager, controls, ids } = setup(1)
    // A session awaiting RESUME reports `buffered` synchronously first.
    const dropped = session(manager)
    ;(dropped.ws as unknown as { readyState: number }).readyState = 3
    const callbacks: ((error?: Error) => void)[] = []
    manager.create({
      botId: '111111111111111111',
      token: 'limits',
      intents: 1,
      ws: {
        readyState: 1,
        send: (_data: string, callback?: (error?: Error) => void) => {
          if (callback) callbacks.push(callback)
        },
      } as never,
    })
    const record = controls.create({
      bot_id: '111111111111111111',
      guild_id: ids[0] ?? '',
      ttl_ms: 60_000,
    }) as { id: string }
    for (const callback of callbacks.splice(0)) callback()
    let settled = false
    const waiting = controls.wait(record.id, 30_000).then((result) => {
      settled = true
      return result
    })
    controls.end(record.id)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(callbacks).toHaveLength(1)
    callbacks[0]?.()
    const result = (await waiting) as {
      guild_creates: { transport: string }[]
    }
    expect(result.guild_creates.map((entry) => entry.transport)).toEqual([
      'buffered',
      'sent',
    ])
    controls.reset(undefined, false)
  })

  it('reports recovery_snapshot only when a snapshot was dispatched', () => {
    const { manager, controls, ids } = setup(2)
    // No registered session holds the Guilds intent.
    const voiceOnly = session(manager, 1 << 7)
    const none = controls.create({
      bot_id: '111111111111111111',
      guild_id: ids[0] ?? '',
      ttl_ms: 60_000,
    }) as { id: string }
    expect(controls.end(none.id)).toMatchObject({
      status: 'recovered',
      recovery_snapshot: false,
      guild_creates: [],
    })
    expect(voiceOnly.seq).toBe(0)

    session(manager)
    const one = controls.create({
      bot_id: '111111111111111111',
      guild_id: ids[1] ?? '',
      ttl_ms: 60_000,
    }) as { id: string }
    expect(controls.end(one.id)).toMatchObject({
      recovery_snapshot: true,
      guild_creates: [{ trigger: 'recovery', transport: 'sent' }],
    })
    controls.reset(undefined, false)
  })

  it('keeps a GUILD_DELETE whose socket write failed in the replay buffer', () => {
    const { manager, controls, ids } = setup(1)
    const broken = manager.create({
      botId: '111111111111111111',
      token: 'limits',
      intents: 1,
      ws: {
        readyState: 1,
        send: (_data: string, callback?: (error?: Error) => void) => {
          callback?.(new Error('socket broke'))
        },
      } as never,
    })
    const record = controls.create({
      bot_id: '111111111111111111',
      guild_id: ids[0] ?? '',
      ttl_ms: 60_000,
    }) as { guild_deletes: { transport: string; sequence: number }[] }
    expect(record.guild_deletes).toMatchObject([
      { transport: 'failed', sequence: 1 },
    ])
    // RESUME from before the outage replays the outage signal.
    expect(manager.replayFrom(broken, 0)?.map((entry) => entry.event)).toEqual([
      {
        op: 0,
        t: 'GUILD_DELETE',
        s: 1,
        d: { id: ids[0], unavailable: true },
      },
    ])
    controls.reset(undefined, false)
  })

  it('buffers the outage GUILD_DELETE for a silenced (zombie) connection', () => {
    const { manager, controls, ids } = setup(1)
    const zombie = session(manager)
    manager.silence(zombie.ws)
    const record = controls.create({
      bot_id: '111111111111111111',
      guild_id: ids[0] ?? '',
      ttl_ms: 60_000,
    }) as { guild_deletes: { transport: string; sequence: number }[] }
    expect(record.guild_deletes).toMatchObject([
      { transport: 'buffered', sequence: 1 },
    ])
    expect(
      manager.replayFrom(zombie, 0)?.map((entry) => entry.event.t)
    ).toEqual(['GUILD_DELETE'])
    controls.reset(undefined, false)
  })

  it('shutdown reset discards without dispatching recovery', () => {
    const { manager, controls, ids } = setup(1)
    const target = session(manager)
    controls.create({
      bot_id: '111111111111111111',
      guild_id: ids[0] ?? '',
      ttl_ms: 60_000,
    })
    expect(target.seq).toBe(1)
    controls.reset(undefined, false)
    expect(target.seq).toBe(1)
  })
})
