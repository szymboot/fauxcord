import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedMember,
  seedVoiceChannel,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'
import { broadcastToBot } from './dispatch'

/** Real Gateway connection and every frame it received. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
  closed: Promise<number>
}

/** Sequence range reported by the controls. */
interface Range {
  count: number
  first_sequence: number | null
  last_sequence: number | null
}

/** Public zombie record. */
interface Zombie {
  id: string
  ownership_key?: string
  session_id: string
  status: string
  ttl_ms: number
  sequence: number
  started_at: number
  zombie_expires_at: number
  expires_at: number
  last_ack_at: number | null
  heartbeats_unacknowledged: number
  last_heartbeat_at: number | null
  last_heartbeat_sequence: number | null
  dispatches_withheld: Range
  ended_at: number | null
  ended_by: string | null
  close: { at: number; code: number; initiated_by: string } | null
  resume: {
    at: number
    client_sequence: number
    replayed: Range
    resumed_sequence: number
  } | null
  session_removed_at: number | null
}

/** Public invalidation observation (subset used here). */
interface Invalidation {
  id: string
  trigger: string
  session_id: string
  sequence: number | null
  close_code: number | null
  transport: string | null
  status: string
  invalidated_at: number | null
  resume_rejection: {
    reason: string
    client_sequence: number | null
    replay_available: boolean | null
    discarded: Range | null
  } | null
  replacement: {
    session_id: string
    guild_creates: {
      guild_id: string
      voice_states: { user_id: string; self_mute?: boolean }[]
    }[]
    complete: boolean
  } | null
  resumes_rejected: number
}

const TOKEN = 'Bot zombie'
const OTHER_TOKEN = 'Bot zombie-other'
const BOT_ID = '111111111111111111'
const OTHER_BOT_ID = '121212121212121212'
const GUILD = '222222222222222222'
const OTHER_GUILD = '242424242424242424'
const VOICE = '555555555555555555'
const OTHER_VOICE = '575757575757575757'
const HUMAN = '888888888888888888'
const OTHER_HUMAN = '898989898989898989'
const ZOMBIES = '/_test/gateway-zombie-connections'
const INVALIDATIONS = '/_test/gateway-session-invalidations'
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates

describe('Gateway connection faults (zombie connection, failed RESUME)', () => {
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

  /** Calls the API, asserts the status and returns the decoded JSON body. */
  async function json<T>(
    path: string,
    expected: number,
    method = 'GET',
    body?: unknown
  ): Promise<T> {
    const response = await request(path, method, body)
    expect(response.status).toBe(expected)
    return (await response.json()) as T
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

  /** Highest dispatch sequence the client has received. */
  function lastSequence(target: Client): number {
    return Math.max(0, ...target.frames.map((entry) => entry.s ?? 0))
  }

  /** Sends a heartbeat and waits for its ACK (an ordered frame fence). */
  async function heartbeat(target: Client): Promise<void> {
    const before = target.frames.filter((entry) => entry.op === 11).length
    target.ws.send(JSON.stringify({ op: 1, d: lastSequence(target) }))
    await frame(
      target,
      (entry) =>
        entry.op === 11 &&
        target.frames.filter((seen) => seen.op === 11).length > before
    )
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

  /** Connects and IDENTIFYs, waiting for READY and the GUILD_CREATE. */
  async function connect(
    token = TOKEN,
    guild = GUILD,
    target?: Client
  ): Promise<Client> {
    const result = target ?? (await open())
    result.ws.send(JSON.stringify({ op: 2, d: { token, intents: INTENTS } }))
    const ready = await frame(
      result,
      (entry) => entry.t === 'READY' && entry.d?.session_id !== result.sessionId
    )
    result.sessionId = String(ready.d?.session_id)
    await frame(
      result,
      (entry) =>
        entry.t === 'GUILD_CREATE' &&
        entry.d?.id === guild &&
        (entry.s ?? 0) > (ready.s ?? 0)
    )
    return result
  }

  /** Sends RESUME on a fresh socket for the given session. */
  async function resume(
    sessionId: string,
    seq: number,
    token = TOKEN
  ): Promise<Client> {
    const target = await open()
    target.sessionId = sessionId
    target.ws.send(
      JSON.stringify({ op: 6, d: { token, session_id: sessionId, seq } })
    )
    return target
  }

  /** Changes the human's voice state, producing one VOICE_STATE_UPDATE. */
  async function voice(
    body: Record<string, unknown>,
    guild = GUILD,
    channel = VOICE,
    user = HUMAN
  ): Promise<void> {
    const response = await request(
      `/_test/guilds/${guild}/voice-states/${user}`,
      'PATCH',
      { channel_id: channel, ...body }
    )
    expect(response.status).toBe(200)
  }

  /** Starts a zombie on the client's session and returns its record. */
  async function zombie(
    extra: Record<string, unknown> = {},
    target: Client = client
  ): Promise<Zombie> {
    return json<Zombie>(ZOMBIES, 201, 'POST', {
      bot_id: BOT_ID,
      guild_id: GUILD,
      session_id: target.sessionId,
      ...extra,
    })
  }

  /** Reads a zombie record. */
  async function inspect(id: string, query = ''): Promise<Zombie> {
    return json<Zombie>(`${ZOMBIES}/${id}${query}`, 200)
  }

  /** Polls a record until the predicate holds (server-side counters only). */
  async function until(
    id: string,
    predicate: (record: Zombie) => boolean
  ): Promise<Zombie> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const record = await inspect(id)
      if (predicate(record)) return record
      await delay(5)
    }
    throw new Error('Condition not reached')
  }

  /** Arms a failed-RESUME invalidation for the client's session. */
  async function armRejection(
    extra: Record<string, unknown> = {}
  ): Promise<Invalidation> {
    return json<Invalidation>(INVALIDATIONS, 201, 'POST', {
      ownership_key: 'reject-resume-1',
      bot_id: BOT_ID,
      guild_id: GUILD,
      session_id: client.sessionId,
      trigger: 'resume',
      ...extra,
    })
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT_ID)
    seedGuild(server.db, TOKEN, GUILD)
    seedVoiceChannel(server.db, GUILD, VOICE)
    seedMember(server.db, GUILD, HUMAN)
    seedBot(server.db, OTHER_TOKEN, OTHER_BOT_ID)
    seedGuild(server.db, OTHER_TOKEN, OTHER_GUILD)
    seedVoiceChannel(server.db, OTHER_GUILD, OTHER_VOICE)
    seedMember(server.db, OTHER_GUILD, OTHER_HUMAN)
    client = await connect()
  })

  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  describe('zombie connection', () => {
    it('withholds ACKs and dispatches until the client closes, then RESUME replays them with original sequences', async () => {
      await voice({})
      await frame(client, (entry) => entry.t === 'VOICE_STATE_UPDATE')
      await heartbeat(client)
      const received = lastSequence(client)

      const started = await zombie({ ownership_key: 'zombie-1' })
      expect(started).toMatchObject({
        ownership_key: 'zombie-1',
        session_id: client.sessionId,
        status: 'zombie',
        ttl_ms: 180_000,
        sequence: received,
        heartbeats_unacknowledged: 0,
        dispatches_withheld: { count: 0 },
        close: null,
        resume: null,
      })
      expect(started.last_ack_at).toEqual(expect.any(Number))
      const framesBefore = client.frames.length

      // Native events generated while the connection is a zombie.
      await voice({ self_mute: true })
      await voice({ self_deaf: true })
      // Advance the clock on every read, so separate reads can never agree.
      const realNow = Date.now.bind(Date)
      let tick = 0
      const clock = vi
        .spyOn(Date, 'now')
        .mockImplementation(() => realNow() + ++tick)
      client.ws.send(JSON.stringify({ op: 1, d: received }))
      const silent = await until(
        started.id,
        (record) => record.heartbeats_unacknowledged === 1
      ).finally(() => {
        clock.mockRestore()
      })
      expect(silent).toMatchObject({
        status: 'zombie',
        last_heartbeat_sequence: received,
        last_ack_at: started.last_ack_at,
        dispatches_withheld: {
          count: 2,
          first_sequence: received + 1,
          last_sequence: received + 2,
        },
      })
      // Heartbeats still reach the server and keep the session alive.
      expect(server.sessionManager.get(client.sessionId)?.lastHeartbeatAt).toBe(
        silent.last_heartbeat_at
      )

      // The client detects the missing ACK and closes with a resumable code.
      client.ws.close(1012)
      expect(await client.closed).toBe(1012)
      // Every server write precedes its close frame: nothing was written.
      expect(client.frames.slice(framesBefore)).toEqual([])
      const closed = await inspect(started.id)
      expect(closed).toMatchObject({
        status: 'awaiting_resume',
        ended_by: 'client_close',
        close: { code: 1012, initiated_by: 'client' },
      })
      expect(closed.close?.at).toBeGreaterThanOrEqual(started.started_at)

      const resumed = await resume(client.sessionId, received)
      const done = await frame(resumed, (entry) => entry.t === 'RESUMED')
      const replayed = resumed.frames.filter(
        (entry) => entry.t === 'VOICE_STATE_UPDATE'
      )
      expect(replayed.map((entry) => entry.s)).toEqual([
        received + 1,
        received + 2,
      ])
      expect(replayed[1]?.d).toMatchObject({ self_mute: true, self_deaf: true })
      expect(done.s).toBe(received + 3)

      const evidence = await inspect(started.id, '?wait_ms=1000')
      expect(evidence).toMatchObject({
        status: 'resumed',
        resume: {
          client_sequence: received,
          replayed: {
            count: 2,
            first_sequence: received + 1,
            last_sequence: received + 2,
          },
          resumed_sequence: received + 3,
        },
      })
      // The resumed connection is answered normally again.
      await heartbeat(resumed)
      await voice({ self_mute: false })
      await frame(
        resumed,
        (entry) => entry.t === 'VOICE_STATE_UPDATE' && entry.s === received + 4
      )
    })

    it('ends explicitly by dropping the socket with 4000 so the client can RESUME', async () => {
      const received = lastSequence(client)
      const started = await zombie()
      await voice({})
      const ended = await json<Zombie>(
        `${ZOMBIES}/${started.id}/end`,
        200,
        'POST',
        {}
      )
      expect(ended).toMatchObject({
        status: 'awaiting_resume',
        ended_by: 'end',
        close: { code: 4000, initiated_by: 'server' },
      })
      expect(await client.closed).toBe(4000)
      expect(
        client.frames.some((entry) => entry.t === 'VOICE_STATE_UPDATE')
      ).toBe(false)
      await json(`${ZOMBIES}/${started.id}/end`, 409, 'POST', {})

      const resumed = await resume(client.sessionId, received)
      await frame(resumed, (entry) => entry.t === 'RESUMED')
      expect(
        resumed.frames.find((entry) => entry.t === 'VOICE_STATE_UPDATE')?.s
      ).toBe(received + 1)
      expect(await inspect(started.id, '?wait_ms=1000')).toMatchObject({
        status: 'resumed',
      })
    })

    it('expires after ttl_ms by dropping the socket, keeping the evidence', async () => {
      const started = await zombie({ ttl_ms: 50 })
      expect(started.zombie_expires_at - started.started_at).toBe(50)
      expect(await client.closed).toBe(4000)
      const expired = await inspect(started.id)
      expect(expired).toMatchObject({
        status: 'awaiting_resume',
        ended_by: 'ttl',
        close: { code: 4000, initiated_by: 'server' },
      })
      expect(expired.expires_at).toBeGreaterThan(Date.now())
      expect(server.sessionManager.get(client.sessionId)).toBeDefined()
    })

    it('drops the zombie socket when the client RESUMEs on a new connection without closing it', async () => {
      const received = lastSequence(client)
      const started = await zombie()
      await voice({})
      const resumed = await resume(client.sessionId, received)
      await frame(resumed, (entry) => entry.t === 'RESUMED')
      expect(await client.closed).toBe(4000)
      expect(await inspect(started.id)).toMatchObject({
        status: 'resumed',
        ended_by: 'resume',
        resume: { replayed: { count: 1, first_sequence: received + 1 } },
      })
    })

    it('affects only the exact connection: other sessions and bots keep ACKs and dispatches', async () => {
      const sibling = await connect()
      const other = await connect(OTHER_TOKEN, OTHER_GUILD)
      const started = await zombie()
      await voice({})
      await voice({}, OTHER_GUILD, OTHER_VOICE, OTHER_HUMAN)
      await frame(sibling, (entry) => entry.t === 'VOICE_STATE_UPDATE')
      await frame(other, (entry) => entry.t === 'VOICE_STATE_UPDATE')
      await heartbeat(sibling)
      await heartbeat(other)
      expect(await inspect(started.id)).toMatchObject({
        dispatches_withheld: { count: 1 },
      })
      expect(
        client.frames.some((entry) => entry.t === 'VOICE_STATE_UPDATE')
      ).toBe(false)
    })

    it('loses the session when it is removed while silenced (e.g. heartbeat timeout)', async () => {
      const started = await zombie()
      server.sessionManager.remove(client.sessionId)
      expect(await inspect(started.id, '?wait_ms=1000')).toMatchObject({
        status: 'session_lost',
        ended_by: 'session_removed',
      })
      expect(server.sessionManager.isSilenced(client.ws as never)).toBe(false)
      // The orphaned socket is closed instead of being ACKed indefinitely.
      expect(await client.closed).toBe(4009)
      expect(await inspect(started.id)).toMatchObject({
        close: { code: 4009, initiated_by: 'server' },
      })
    })

    it('keeps the socket open when the zombie socket itself re-IDENTIFYs', async () => {
      const started = await zombie()
      const previous = client.sessionId
      await connect(TOKEN, GUILD, client)
      expect(client.sessionId).not.toBe(previous)
      expect(await inspect(started.id)).toMatchObject({
        status: 'session_lost',
        ended_by: 'session_removed',
        close: null,
      })
      await heartbeat(client)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
    })

    it('rejects conflicting controls on a silenced connection', async () => {
      await zombie()
      await json(ZOMBIES, 409, 'POST', {
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: client.sessionId,
      })
      await json(INVALIDATIONS, 409, 'POST', {
        ownership_key: 'reidentify-zombie',
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: client.sessionId,
      })
      const control = await json<{ id: string }>(
        '/_test/gateway-event-controls',
        201,
        'POST',
        {
          bot_id: BOT_ID,
          guild_id: GUILD,
          session_id: client.sessionId,
          events: ['VOICE_STATE_UPDATE'],
        }
      )
      await json(
        `/_test/gateway-event-controls/${control.id}/disconnect`,
        409,
        'POST',
        {}
      )
    })

    it('validates requests and scope', async () => {
      const valid = {
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: client.sessionId,
      }
      for (const body of [
        'not-json',
        [],
        { ...valid, extra: true },
        { ...valid, ttl_ms: 0 },
        { ...valid, ttl_ms: 300_001 },
        { ...valid, ttl_ms: 1.5 },
        { ...valid, session_id: 'nope' },
        { ...valid, ownership_key: 'bad key' },
      ]) {
        expect(await status(ZOMBIES, 'POST', body)).toBe(400)
      }
      // Another bot's guild and an unknown session are out of scope.
      await json(ZOMBIES, 404, 'POST', { ...valid, guild_id: OTHER_GUILD })
      await json(ZOMBIES, 404, 'POST', {
        ...valid,
        session_id: '0'.repeat(32),
      })
      await json(`${ZOMBIES}/unknown`, 404)
      await json(`${ZOMBIES}/unknown/end`, 404, 'POST', {})
      await json(`${ZOMBIES}/unknown/end`, 400, 'POST', { extra: 1 })
      expect(await status(`${ZOMBIES}/unknown`, 'DELETE')).toBe(404)
      // A dropped socket retained for RESUME cannot become a zombie.
      client.ws.terminate()
      await client.closed
      let code = 0
      for (let attempt = 0; code !== 409 && attempt < 200; attempt += 1) {
        code = await status(ZOMBIES, 'POST', valid)
        if (code === 201) throw new Error('Closed socket became a zombie')
        if (code !== 409) await delay(5)
      }
      expect(code).toBe(409)
    })

    it('supports keyed retry, recovery and tombstones', async () => {
      const key = 'zombie-key'
      const query = `?bot_id=${BOT_ID}&guild_id=${GUILD}&session_id=${client.sessionId}`
      const first = await zombie({ ownership_key: key })
      const retry = await zombie({ ownership_key: key })
      expect(retry.id).toBe(first.id)
      await json(ZOMBIES, 409, 'POST', {
        ownership_key: key,
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: client.sessionId,
        ttl_ms: 1000,
      })
      expect(
        await json<Zombie>(`${ZOMBIES}/by-key/${key}${query}`, 200)
      ).toMatchObject({ id: first.id })
      await json(`${ZOMBIES}/by-key/${key}${query}&extra=1`, 400)
      expect(await status(`${ZOMBIES}/by-key/${key}${query}`, 'DELETE')).toBe(
        204
      )
      // DELETE ends the zombie (socket dropped for RESUME) and retires it.
      expect(await client.closed).toBe(4000)
      await json(`${ZOMBIES}/${first.id}`, 404)
      await json(`${ZOMBIES}/by-key/${key}${query}`, 404)

      // An unused key can be tombstoned before its POST arrives.
      const fresh = await connect()
      const freshQuery = `?bot_id=${BOT_ID}&guild_id=${GUILD}&session_id=${fresh.sessionId}`
      expect(
        await status(`${ZOMBIES}/by-key/late${freshQuery}`, 'DELETE')
      ).toBe(204)
      await json(ZOMBIES, 409, 'POST', {
        ownership_key: 'late',
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: fresh.sessionId,
      })
      expect(server.sessionManager.isSilenced(fresh.ws as never)).toBe(false)
    })

    it('is canceled by /_test/reset, setup deletion and guild deletion', async () => {
      const first = await zombie()
      expect(await status('/_test/reset', 'POST', { token: OTHER_TOKEN })).toBe(
        204
      )
      expect(await inspect(first.id)).toMatchObject({ status: 'zombie' })
      expect(await status('/_test/reset', 'POST', { token: TOKEN })).toBe(204)
      await json(`${ZOMBIES}/${first.id}`, 404)
      expect(await client.closed).toBe(4000)

      const second = await connect()
      const viaGuild = await zombie({}, second)
      const response = await fetch(`${base}/api/v10/guilds/${GUILD}`, {
        method: 'DELETE',
        headers: { Authorization: TOKEN },
      })
      expect(response.status).toBe(204)
      await json(`${ZOMBIES}/${viaGuild.id}`, 404)
      expect(await second.closed).toBe(4000)

      const other = await connect(OTHER_TOKEN, OTHER_GUILD)
      const viaSetup = await json<Zombie>(ZOMBIES, 201, 'POST', {
        bot_id: OTHER_BOT_ID,
        guild_id: OTHER_GUILD,
        session_id: other.sessionId,
      })
      const removed = await request(
        `/_test/setup/${encodeURIComponent(OTHER_TOKEN)}`,
        'DELETE'
      )
      expect(removed.status).toBeLessThan(300)
      await json(`${ZOMBIES}/${viaSetup.id}`, 404)
      expect(await other.closed).toBe(4000)
    })
  })

  describe('failed RESUME (trigger: "resume")', () => {
    it('rejects the RESUME after a disconnect gap, discards buffered events and observes a fresh snapshot', async () => {
      await voice({})
      await frame(client, (entry) => entry.t === 'VOICE_STATE_UPDATE')
      const received = lastSequence(client)
      const armed = await armRejection()
      expect(armed).toMatchObject({
        trigger: 'resume',
        status: 'armed',
        sequence: null,
        transport: null,
        close_code: null,
        invalidated_at: null,
        resume_rejection: null,
      })

      // Existing disconnect control: op 7, socket closed, awaiting RESUME.
      const control = await json<{ id: string }>(
        '/_test/gateway-event-controls',
        201,
        'POST',
        {
          bot_id: BOT_ID,
          guild_id: GUILD,
          session_id: client.sessionId,
          events: ['VOICE_STATE_UPDATE'],
        }
      )
      await json(
        `/_test/gateway-event-controls/${control.id}/disconnect`,
        200,
        'POST',
        {}
      )
      await client.closed

      // Events generated during the gap are buffered for the session...
      await voice({ self_mute: true })
      await voice({ self_deaf: true })

      // ...but its RESUME is rejected and they are never delivered.
      const resumed = await resume(client.sessionId, received)
      const invalid = await frame(resumed, (entry) => entry.op === 9)
      expect(invalid.d).toBe(false)
      expect(server.sessionManager.get(client.sessionId)).toBeUndefined()
      const rejected = await json<Invalidation>(
        `${INVALIDATIONS}/${armed.id}`,
        200
      )
      expect(rejected).toMatchObject({
        status: 'awaiting_identify',
        sequence: received + 2,
        transport: 'sent',
        resumes_rejected: 1,
        resume_rejection: {
          reason: 'forced',
          client_sequence: received,
          replay_available: true,
          discarded: {
            count: 2,
            first_sequence: received + 1,
            last_sequence: received + 2,
          },
        },
      })
      expect(rejected.invalidated_at).toEqual(expect.any(Number))

      // DiscordGo-style re-IDENTIFY gets a GUILD_CREATE with current state.
      const replacement = await connect()
      const snapshot = replacement.frames.find(
        (entry) => entry.t === 'GUILD_CREATE'
      )
      expect(snapshot?.d?.voice_states).toEqual([
        expect.objectContaining({
          user_id: HUMAN,
          self_mute: true,
          self_deaf: true,
        }),
      ])
      expect(
        resumed.frames.some((entry) => entry.t === 'VOICE_STATE_UPDATE')
      ).toBe(false)
      const observed = await json<Invalidation>(
        `${INVALIDATIONS}/${armed.id}?wait_ms=2000`,
        200
      )
      expect(observed.status).toBe('identified')
      expect(observed.replacement?.session_id).toBe(replacement.sessionId)
      expect(observed.replacement?.guild_creates[0]?.guild_id).toBe(GUILD)
    })

    it('also observes a re-IDENTIFY on the socket that carried the rejected RESUME', async () => {
      const received = lastSequence(client)
      const armed = await armRejection()
      client.ws.terminate()
      await client.closed
      const resumed = await resume(client.sessionId, received)
      await frame(resumed, (entry) => entry.op === 9)
      await connect(TOKEN, GUILD, resumed)
      const observed = await json<Invalidation>(
        `${INVALIDATIONS}/${armed.id}?wait_ms=2000`,
        200
      )
      expect(observed.replacement?.session_id).toBe(resumed.sessionId)
    })

    it('combines with a zombie connection: detection, rejected RESUME, fresh snapshot', async () => {
      const received = lastSequence(client)
      const armed = await armRejection()
      const started = await zombie()
      await voice({})
      client.ws.close(1012)
      await client.closed
      const resumed = await resume(client.sessionId, received)
      expect(await frame(resumed, (entry) => entry.op === 9)).toMatchObject({
        d: false,
      })
      expect(await inspect(started.id, '?wait_ms=1000')).toMatchObject({
        status: 'session_lost',
        ended_by: 'client_close',
        dispatches_withheld: { count: 1 },
      })
      const replacement = await connect()
      const observed = await json<Invalidation>(
        `${INVALIDATIONS}/${armed.id}?wait_ms=2000`,
        200
      )
      expect(observed).toMatchObject({
        status: 'identified',
        resume_rejection: {
          reason: 'forced',
          discarded: { count: 1, first_sequence: received + 1 },
        },
      })
      expect(observed.replacement?.session_id).toBe(replacement.sessionId)
    })

    it('closes a still-open zombie socket when the RESUME on a new socket is rejected', async () => {
      const received = lastSequence(client)
      const armed = await armRejection()
      const started = await zombie()
      const framesBefore = client.frames.length
      await voice({})
      const resumed = await resume(client.sessionId, received)
      expect(await frame(resumed, (entry) => entry.op === 9)).toMatchObject({
        d: false,
      })
      expect(await client.closed).toBe(4009)
      expect(client.frames.slice(framesBefore)).toEqual([])
      expect(await inspect(started.id)).toMatchObject({
        status: 'session_lost',
        ended_by: 'session_removed',
        close: { code: 4009, initiated_by: 'server' },
      })
      expect(
        await json<Invalidation>(`${INVALIDATIONS}/${armed.id}`, 200)
      ).toMatchObject({ resume_rejection: { reason: 'forced' } })
    })

    it('defaults the resume trigger TTL beyond zombie detection (180 s, max 300 s)', async () => {
      expect(await armRejection()).toMatchObject({ ttl_ms: 180_000 })
      await json(INVALIDATIONS, 400, 'POST', {
        ownership_key: 'reject-resume-long',
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: client.sessionId,
        trigger: 'resume',
        ttl_ms: 300_001,
      })
      expect(
        await status(
          `${INVALIDATIONS}/by-key/reject-resume-1?bot_id=${BOT_ID}&guild_id=${GUILD}&session_id=${client.sessionId}`,
          'DELETE'
        )
      ).toBe(204)
      expect(
        await armRejection({
          ownership_key: 'reject-resume-max',
          ttl_ms: 300_000,
        })
      ).toMatchObject({ ttl_ms: 300_000 })
    })

    it('reports replay-buffer overflow as replay_available: false', async () => {
      const received = lastSequence(client)
      const armed = await armRejection()
      client.ws.terminate()
      await client.closed
      for (let index = 0; index < 101; index += 1)
        broadcastToBot(server.sessionManager, BOT_ID, 'TEST_EVENT', {
          index,
        })
      const resumed = await resume(client.sessionId, received)
      await frame(resumed, (entry) => entry.op === 9)
      const rejected = await json<Invalidation>(
        `${INVALIDATIONS}/${armed.id}`,
        200
      )
      expect(rejected.resume_rejection).toMatchObject({
        reason: 'forced',
        replay_available: false,
        discarded: { count: 100, last_sequence: received + 101 },
      })
    })

    it('applies when the session disappears before the RESUME (e.g. heartbeat timeout)', async () => {
      const received = lastSequence(client)
      const armed = await armRejection()
      client.ws.terminate()
      await client.closed
      server.sessionManager.remove(client.sessionId)
      const resumed = await resume(client.sessionId, received)
      await frame(resumed, (entry) => entry.op === 9)
      const replacement = await connect()
      const observed = await json<Invalidation>(
        `${INVALIDATIONS}/${armed.id}?wait_ms=2000`,
        200
      )
      expect(observed).toMatchObject({
        status: 'identified',
        transport: null,
        resumes_rejected: 1,
        resume_rejection: {
          reason: 'session_removed',
          client_sequence: null,
          discarded: null,
        },
      })
      expect(observed.replacement?.session_id).toBe(replacement.sessionId)
    })

    it('waits behind a paused resume gate and rejects once it opens', async () => {
      const received = lastSequence(client)
      const armed = await armRejection()
      const control = await json<{ id: string }>(
        '/_test/gateway-event-controls',
        201,
        'POST',
        {
          bot_id: BOT_ID,
          guild_id: GUILD,
          session_id: client.sessionId,
          events: ['VOICE_STATE_UPDATE'],
        }
      )
      await json(
        `/_test/gateway-event-controls/${control.id}/disconnect`,
        200,
        'POST',
        { pause_resume: true }
      )
      await client.closed
      const resumed = await resume(client.sessionId, received)
      await voice({})
      expect(
        await json<Invalidation>(`${INVALIDATIONS}/${armed.id}`, 200)
      ).toMatchObject({ status: 'armed' })
      await json(
        `/_test/gateway-event-controls/${control.id}/resume`,
        200,
        'POST',
        {}
      )
      expect(await frame(resumed, (entry) => entry.op === 9)).toMatchObject({
        d: false,
      })
      expect(
        await json<Invalidation>(`${INVALIDATIONS}/${armed.id}`, 200)
      ).toMatchObject({ resume_rejection: { discarded: { count: 1 } } })
    })

    it('rejects an overflowed cursor immediately even behind a paused resume gate', async () => {
      const received = lastSequence(client)
      const armed = await armRejection()
      const control = await json<{ id: string }>(
        '/_test/gateway-event-controls',
        201,
        'POST',
        {
          bot_id: BOT_ID,
          guild_id: GUILD,
          session_id: client.sessionId,
          events: ['VOICE_STATE_UPDATE'],
        }
      )
      await json(
        `/_test/gateway-event-controls/${control.id}/disconnect`,
        200,
        'POST',
        { pause_resume: true }
      )
      await client.closed
      for (let index = 0; index < 101; index += 1)
        broadcastToBot(server.sessionManager, BOT_ID, 'TEST_EVENT', { index })
      const resumed = await resume(client.sessionId, received)
      expect(await frame(resumed, (entry) => entry.op === 9)).toMatchObject({
        d: false,
      })
      expect(
        await json<Invalidation>(`${INVALIDATIONS}/${armed.id}`, 200)
      ).toMatchObject({
        resume_rejection: { reason: 'forced', replay_available: false },
      })
      await json(
        `/_test/gateway-event-controls/${control.id}/resume`,
        404,
        'POST',
        {}
      )
    })

    it('ignores RESUMEs with the wrong token and other sessions, and disarms on TTL', async () => {
      const received = lastSequence(client)
      const other = await connect(OTHER_TOKEN, OTHER_GUILD)
      const armed = await armRejection({ ttl_ms: 300 })
      client.ws.terminate()
      other.ws.terminate()
      await client.closed
      await other.closed
      const forged = await resume(client.sessionId, received, OTHER_TOKEN)
      await frame(forged, (entry) => entry.op === 9)
      const otherResume = await resume(
        other.sessionId,
        lastSequence(other),
        OTHER_TOKEN
      )
      await frame(otherResume, (entry) => entry.t === 'RESUMED')
      expect(
        await json<Invalidation>(`${INVALIDATIONS}/${armed.id}`, 200)
      ).toMatchObject({ status: 'armed' })
      // After TTL expiry the rejection is disarmed and RESUME succeeds.
      await json(`${INVALIDATIONS}/${armed.id}?wait_ms=1000`, 404)
      const resumed = await resume(client.sessionId, received)
      await frame(resumed, (entry) => entry.t === 'RESUMED')
    })

    it('validates the trigger and keyed retries', async () => {
      await json(INVALIDATIONS, 400, 'POST', {
        ownership_key: 'bad-trigger',
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: client.sessionId,
        trigger: 'later',
      })
      const armed = await armRejection()
      expect(await armRejection()).toMatchObject({ id: armed.id })
      await json(INVALIDATIONS, 409, 'POST', {
        ownership_key: 'reject-resume-1',
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: client.sessionId,
      })
      // One open observation per setup token keeps attribution exact.
      await json(INVALIDATIONS, 409, 'POST', {
        ownership_key: 'reject-resume-2',
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: client.sessionId,
        trigger: 'resume',
      })
      // An armed rejection is retired by reset and never applies afterwards.
      expect(await status('/_test/reset', 'POST', { token: TOKEN })).toBe(204)
      await json(`${INVALIDATIONS}/${armed.id}`, 404)
      const received = lastSequence(client)
      client.ws.terminate()
      await client.closed
      const resumed = await resume(client.sessionId, received)
      await frame(resumed, (entry) => entry.t === 'RESUMED')
    })
  })
})
