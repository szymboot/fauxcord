import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
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
import type { GatewayPayload } from './protocol'
import { broadcastToBot } from './dispatch'

/** Real Gateway connection and every frame it received. */
interface Client {
  ws: WebSocket
  sessionId: string
  resumeUrl: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
  closed: Promise<number>
}

/** Public reconnect hold evidence. */
interface Hold {
  held_since: number
  expires_at: number
  attempts: number
  last_attempt_at: number | null
  pending: number
  released_at: number | null
  released_by: string | null
}

/** Public zombie record (subset used here). */
interface Zombie {
  id: string
  status: string
  hold_reconnect: boolean
  reconnect_hold_ttl_ms: number | null
  expires_at: number
  ended_by: string | null
  close: { code: number; initiated_by: string } | null
  resume: {
    client_sequence: number
    replayed: { count: number; first_sequence: number | null }
    resumed_sequence: number
  } | null
  resume_rejected: { at: number; client_sequence: number } | null
  reconnect_hold: Hold | null
}

const TOKEN = 'Bot zombie-hold'
const OTHER_TOKEN = 'Bot zombie-hold-other'
const BOT_ID = '111111111111111111'
const OTHER_BOT_ID = '121212121212121212'
const GUILD = '222222222222222222'
const OTHER_GUILD = '242424242424242424'
const VOICE = '555555555555555555'
const OTHER_VOICE = '575757575757575757'
const HUMAN = '888888888888888888'
const OTHER_HUMAN = '898989898989898989'
const ZOMBIES = '/_test/gateway-zombie-connections'
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates

describe('zombie connection reconnect hold', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let client: Client
  const clients: Client[] = []
  const stops: (() => void)[] = []

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

  /**
   * Opens a socket on the given URL (resolving once it is open, not on
   * HELLO), recording every frame.
   */
  async function dial(url: string): Promise<Client> {
    const ws = new WebSocket(url)
    const frames: Client['frames'] = []
    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => {
        resolve(code)
      })
    })
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    ws.on('error', () => {
      // Surfaced through `closed`.
    })
    await once(ws, 'open')
    const result = { ws, frames, sessionId: '', resumeUrl: '', closed }
    clients.push(result)
    return result
  }

  /** Whether HELLO arrives within the window. */
  async function helloWithin(target: Client, ms: number): Promise<boolean> {
    return Promise.race([
      frame(target, (entry) => entry.op === 10).then(() => true),
      delay(ms).then(() => false),
    ])
  }

  /** Connects and IDENTIFYs, waiting for READY and the GUILD_CREATE. */
  async function connect(token = TOKEN, guild = GUILD): Promise<Client> {
    const result = await dial(server.url)
    await frame(result, (entry) => entry.op === 10)
    result.ws.send(JSON.stringify({ op: 2, d: { token, intents: INTENTS } }))
    const ready = await frame(result, (entry) => entry.t === 'READY')
    result.sessionId = String(ready.d?.session_id)
    // The advertised URL uses BASE_URL's host; keep its path on this server.
    const advertised = new URL(String(ready.d?.resume_gateway_url))
    result.resumeUrl = server.url + advertised.pathname
    await frame(
      result,
      (entry) => entry.t === 'GUILD_CREATE' && entry.d?.id === guild
    )
    return result
  }

  /** Dials the session's resume URL the way DiscordGo does. */
  async function dialResume(target: Client = client): Promise<Client> {
    const result = await dial(`${target.resumeUrl}?v=10&encoding=json`)
    result.sessionId = target.sessionId
    return result
  }

  /** Sends RESUME and waits for RESUMED. */
  async function sendResume(
    target: Client,
    seq: number,
    token = TOKEN
  ): Promise<Client['frames'][number]> {
    target.ws.send(
      JSON.stringify({
        op: 6,
        d: { token, session_id: target.sessionId, seq },
      })
    )
    return frame(target, (entry) => entry.t === 'RESUMED' || entry.op === 9)
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

  /** Starts a zombie with a reconnect hold on the client's session. */
  async function zombie(
    extra: Record<string, unknown> = {},
    target: Client = client
  ): Promise<Zombie> {
    return json<Zombie>(ZOMBIES, 201, 'POST', {
      bot_id: BOT_ID,
      guild_id: GUILD,
      session_id: target.sessionId,
      hold_reconnect: true,
      ...extra,
    })
  }

  /** Reads a zombie record. */
  async function inspect(id: string, query = ''): Promise<Zombie> {
    return json<Zombie>(`${ZOMBIES}/${id}${query}`, 200)
  }

  /** Long-polls until the predicate holds (no sleeps). */
  async function until(
    id: string,
    predicate: (record: Zombie) => boolean
  ): Promise<Zombie> {
    let record = await inspect(id)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate(record)) return record
      record = await inspect(id, '?wait_ms=2000')
    }
    throw new Error('Condition not reached')
  }

  /** Releases the hold through the API. */
  async function release(id: string, expected = 200): Promise<Zombie> {
    return json<Zombie>(
      `${ZOMBIES}/${id}/release-reconnect`,
      expected,
      'POST',
      {}
    )
  }

  /** The client detects the zombie and closes, as DiscordGo does (1012). */
  async function detect(target: Client = client): Promise<void> {
    target.ws.close(1012)
    await target.closed
  }

  /** Starts the server with the given heartbeat interval and connects. */
  async function start(heartbeatIntervalMs?: number): Promise<void> {
    server = await createTestGatewayServer({ heartbeatIntervalMs })
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
  }

  beforeEach(async () => {
    await start()
  })

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop()
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('advertises a per-session path-based resume_gateway_url', () => {
    expect(client.resumeUrl).toBe(
      `${server.url}/_gateway/resume/${client.sessionId}`
    )
  })

  it('holds HELLO after detection until released, then RESUME replays withheld dispatches with original sequences', async () => {
    const received = lastSequence(client)
    const started = await zombie({ ownership_key: 'hold-1' })
    expect(started).toMatchObject({
      status: 'zombie',
      hold_reconnect: true,
      reconnect_hold_ttl_ms: 180_000,
      reconnect_hold: null,
    })
    await voice({ self_mute: true })
    await detect()
    const held = await inspect(started.id)
    expect(held).toMatchObject({
      status: 'reconnect_held',
      ended_by: 'client_close',
      close: { code: 1012, initiated_by: 'client' },
      reconnect_hold: {
        attempts: 0,
        last_attempt_at: null,
        pending: 0,
        released_at: null,
        released_by: null,
      },
    })
    const hold = held.reconnect_hold
    expect(hold?.expires_at).toBe((hold?.held_since ?? 0) + 180_000)
    expect(held.expires_at).toBe((hold?.expires_at ?? 0) + 120_000)

    // Dispatches generated during the hold are buffered too.
    await voice({ self_deaf: true })
    const pending = await dialResume()
    const blocked = await until(
      started.id,
      (record) => (record.reconnect_hold?.attempts ?? 0) >= 1
    )
    expect(blocked.reconnect_hold).toMatchObject({ attempts: 1, pending: 1 })
    expect(blocked.reconnect_hold?.last_attempt_at).toEqual(expect.any(Number))
    expect(await helloWithin(pending, 100)).toBe(false)
    // Frames sent before HELLO are ignored rather than processed.
    pending.ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq: received },
      })
    )
    expect(await helloWithin(pending, 50)).toBe(false)
    expect(pending.frames).toEqual([])

    const released = await release(started.id)
    expect(released).toMatchObject({
      status: 'awaiting_resume',
      reconnect_hold: { attempts: 1, pending: 0, released_by: 'release' },
    })
    // The waiting connection gets HELLO at once, no backoff needed.
    await frame(pending, (entry) => entry.op === 10)
    const done = await sendResume(pending, received)
    expect(done.t).toBe('RESUMED')
    const replayed = pending.frames.filter(
      (entry) => entry.t === 'VOICE_STATE_UPDATE'
    )
    expect(replayed.map((entry) => entry.s)).toEqual([
      received + 1,
      received + 2,
    ])
    expect(done.s).toBe(received + 3)
    expect(
      await until(started.id, (record) => record.status === 'resumed')
    ).toMatchObject({
      resume: {
        client_sequence: received,
        replayed: { count: 2, first_sequence: received + 1 },
        resumed_sequence: received + 3,
      },
    })
    // Releasing again is idempotent.
    expect(await release(started.id)).toMatchObject({
      status: 'resumed',
      reconnect_hold: { released_by: 'release' },
    })
  })

  it('keeps a DiscordGo-like client (HELLO timeout, doubling backoff) waiting across attempts, then lets it RESUME promptly', async () => {
    const received = lastSequence(client)
    const started = await zombie()
    await voice({ self_mute: true })
    await detect()

    let resumed: Client | undefined
    let dials = 0
    const loopState = { stopped: false }
    stops.push(() => {
      loopState.stopped = true
    })
    // DiscordGo: dial resume URL + "?v=10&encoding=json", wait for HELLO
    // with the handshake timeout, close and retry after 1, 2, 4… units.
    const loop = (async () => {
      let backoff = 10
      while (!loopState.stopped) {
        const attempt = await dialResume()
        dials += 1
        if (await helloWithin(attempt, 300)) {
          await sendResume(attempt, received)
          resumed = attempt
          return
        }
        attempt.ws.terminate()
        await delay(backoff)
        backoff *= 2
      }
    })()

    const blocked = await until(
      started.id,
      (record) => (record.reconnect_hold?.attempts ?? 0) >= 2
    )
    expect(blocked.status).toBe('reconnect_held')
    expect(resumed).toBeUndefined()
    // Wait for the next attempt to be pending, so release is immediate.
    await until(started.id, (record) => record.reconnect_hold?.pending === 1)
    const dialsAtRelease = dials
    const released = await release(started.id)
    await loop
    // The connection waiting at release time got HELLO: no further dial.
    expect(dials).toBe(dialsAtRelease)
    expect(released.reconnect_hold?.attempts).toBe(dialsAtRelease)
    expect(
      resumed?.frames.find((entry) => entry.t === 'VOICE_STATE_UPDATE')?.s
    ).toBe(received + 1)
    expect(
      await until(started.id, (record) => record.status === 'resumed')
    ).toMatchObject({ resume: { replayed: { count: 1 } } })
  })

  it('does not affect other bots, other sessions or IDENTIFY on the plain URL', async () => {
    const sibling = await connect()
    const other = await connect(OTHER_TOKEN, OTHER_GUILD)
    const started = await zombie()
    await detect()
    const pending = await dialResume()
    await until(started.id, (record) => record.reconnect_hold?.pending === 1)

    // Plain URL: HELLO and IDENTIFY as usual.
    const fresh = await connect()
    expect(fresh.sessionId).not.toBe(client.sessionId)
    // Another session's resume URL (same bot) and another bot's are not held.
    for (const target of [sibling, other]) {
      const resume = await dialResume(target)
      expect(await helloWithin(resume, 1000)).toBe(true)
    }
    // Other sessions keep receiving dispatches.
    await voice({}, OTHER_GUILD, OTHER_VOICE, OTHER_HUMAN)
    await frame(other, (entry) => entry.t === 'VOICE_STATE_UPDATE')
    await voice({})
    await frame(sibling, (entry) => entry.t === 'VOICE_STATE_UPDATE')
    expect(await helloWithin(pending, 50)).toBe(false)
    expect(await inspect(started.id)).toMatchObject({
      status: 'reconnect_held',
      reconnect_hold: { attempts: 1 },
    })
  })

  it('defers a RESUME sent on the plain URL until release', async () => {
    const received = lastSequence(client)
    const started = await zombie()
    await voice({})
    await detect()
    const plain = await dial(server.url)
    await frame(plain, (entry) => entry.op === 10)
    plain.sessionId = client.sessionId
    const outcome = sendResume(plain, received)
    await until(started.id, (record) => record.reconnect_hold?.attempts === 1)
    expect(plain.frames.some((entry) => entry.t === 'RESUMED')).toBe(false)
    await release(started.id)
    expect(await outcome).toMatchObject({ t: 'RESUMED' })
    expect(
      plain.frames.find((entry) => entry.t === 'VOICE_STATE_UPDATE')?.s
    ).toBe(received + 1)
  })

  it('holds a reconnect that arrives before the zombie socket closes', async () => {
    const started = await zombie()
    const pending = await dialResume()
    expect(await client.closed).toBe(4000)
    expect(
      await until(started.id, (record) => record.reconnect_hold !== null)
    ).toMatchObject({
      status: 'reconnect_held',
      ended_by: 'reconnect',
      close: { code: 4000, initiated_by: 'server' },
      reconnect_hold: { attempts: 1, pending: 1 },
    })
    expect(await helloWithin(pending, 50)).toBe(false)
    await release(started.id)
    await frame(pending, (entry) => entry.op === 10)
  })

  it('holds after an explicit end, but not after the zombie ttl_ms', async () => {
    const started = await zombie()
    expect(
      await json<Zombie>(`${ZOMBIES}/${started.id}/end`, 200, 'POST', {})
    ).toMatchObject({ status: 'reconnect_held', ended_by: 'end' })
    expect(await client.closed).toBe(4000)
    const pending = await dialResume()
    expect(await helloWithin(pending, 50)).toBe(false)

    const second = await connect()
    const expiring = await zombie({ ttl_ms: 20 }, second)
    expect(await second.closed).toBe(4000)
    expect(await inspect(expiring.id)).toMatchObject({
      status: 'awaiting_resume',
      ended_by: 'ttl',
      reconnect_hold: null,
    })
    const resume = await dialResume(second)
    expect(await helloWithin(resume, 1000)).toBe(true)
  })

  it('auto-releases when reconnect_hold_ttl_ms elapses', async () => {
    const received = lastSequence(client)
    const started = await zombie({ reconnect_hold_ttl_ms: 200 })
    await detect()
    const pending = await dialResume()
    const released = await until(
      started.id,
      (record) => record.reconnect_hold?.released_at != null
    )
    expect(released).toMatchObject({
      status: 'awaiting_resume',
      reconnect_hold: { attempts: 1, released_by: 'ttl' },
    })
    expect(released.reconnect_hold?.released_at).toBeGreaterThanOrEqual(
      released.reconnect_hold?.expires_at ?? 0
    )
    await frame(pending, (entry) => entry.op === 10)
    expect(await sendResume(pending, received)).toMatchObject({ t: 'RESUMED' })
  })

  it('keeps the session resumable past the heartbeat timeout while held, and re-arms the timeout on release', async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    await server.close()
    await start(100)
    const received = lastSequence(client)
    const started = await zombie()
    await detect()
    // Far beyond the 200 ms heartbeat timeout.
    await delay(500)
    expect(server.sessionManager.get(client.sessionId)).toBeDefined()
    const pending = await dialResume()
    await until(started.id, (record) => record.reconnect_hold?.pending === 1)
    await release(started.id)
    await frame(pending, (entry) => entry.op === 10)
    expect(await sendResume(pending, received)).toMatchObject({ t: 'RESUMED' })

    // Without a RESUME after release, the session is reaped again.
    const another = await connect()
    const reaped = await zombie({}, another)
    await detect(another)
    await delay(300)
    await release(reaped.id)
    expect(
      await until(reaped.id, (record) => record.status === 'session_lost')
    ).toMatchObject({ reconnect_hold: { released_by: 'release' } })
  })

  it('ignores a heartbeat still in flight on the dropped zombie socket', async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    await server.close()
    await start(100)
    const received = lastSequence(client)
    const started = await zombie()
    // The client has not yet read the server's close frame and still sends.
    client.ws.pause()
    await json(`${ZOMBIES}/${started.id}/end`, 200, 'POST', {})
    client.ws.send(JSON.stringify({ op: 1, d: received }))
    // Far beyond the 200 ms heartbeat timeout the late heartbeat would arm.
    await delay(500)
    expect(server.sessionManager.get(client.sessionId)).toBeDefined()
    const pending = await dialResume()
    expect(await helloWithin(pending, 50)).toBe(false)
    expect(await inspect(started.id)).toMatchObject({
      status: 'reconnect_held',
      reconnect_hold: { released_at: null },
    })
    client.ws.resume()
    await release(started.id)
    await frame(pending, (entry) => entry.op === 10)
    expect(await sendResume(pending, received)).toMatchObject({
      t: 'RESUMED',
    })
  })

  it('keeps the session through the client backoff when released between attempts', async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    await server.close()
    await start(100)
    const received = lastSequence(client)
    const started = await zombie()
    await voice({})
    await detect()
    const attempt = await dialResume()
    await until(started.id, (record) => record.reconnect_hold?.pending === 1)
    // The attempt times out on the client, which then backs off.
    attempt.ws.terminate()
    await until(started.id, (record) => record.reconnect_hold?.pending === 0)
    await delay(400)
    await release(started.id)
    // Longer than the 200 ms heartbeat timeout, shorter than the time held.
    await delay(300)
    const retry = await dialResume()
    await frame(retry, (entry) => entry.op === 10)
    expect(await sendResume(retry, received)).toMatchObject({ t: 'RESUMED' })
    expect(
      retry.frames.find((entry) => entry.t === 'VOICE_STATE_UPDATE')?.s
    ).toBe(received + 1)
  })

  it('keeps the session through the first 1 s backoff after a short hold with a short HELLO deadline', async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    await server.close()
    await start(100)
    const received = lastSequence(client)
    const started = await zombie()
    await detect()
    // A 100 ms HELLO deadline expires; DiscordGo still waits 1 s to retry.
    const attempt = await dialResume()
    await until(started.id, (record) => record.reconnect_hold?.pending === 1)
    attempt.ws.terminate()
    await until(started.id, (record) => record.reconnect_hold?.pending === 0)
    await release(started.id)
    await delay(1000)
    const retry = await dialResume()
    await frame(retry, (entry) => entry.op === 10)
    expect(await sendResume(retry, received)).toMatchObject({ t: 'RESUMED' })
  })

  it('records an unreplayable RESUME after the replay buffer overflowed during the hold, then loses the session at the end of its grace', async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    await server.close()
    await start(100)
    const received = lastSequence(client)
    const started = await zombie()
    await detect()
    for (let index = 0; index < 101; index += 1)
      broadcastToBot(server.sessionManager, BOT_ID, 'TEST_EVENT', { index })
    const pending = await dialResume()
    await until(started.id, (record) => record.reconnect_hold?.pending === 1)
    const released = await release(started.id)
    expect(released.resume_rejected).toBeNull()
    // Retention counts from the end of the RESUME grace.
    const hold = released.reconnect_hold
    const grace =
      (hold?.released_at ?? 0) - (hold?.held_since ?? 0) + 1000 + 200
    expect(released.expires_at).toBeGreaterThanOrEqual(
      (hold?.released_at ?? 0) + grace + 120_000
    )
    await frame(pending, (entry) => entry.op === 10)
    const rejection = inspect(started.id, '?wait_ms=5000')
    await delay(50)
    expect(await sendResume(pending, received)).toMatchObject({
      op: 9,
      d: false,
    })
    expect(await rejection).toMatchObject({
      status: 'awaiting_resume',
      resume_rejected: { client_sequence: received },
    })
    expect(
      await until(started.id, (record) => record.status === 'session_lost')
    ).toMatchObject({ resume_rejected: { client_sequence: received } })
  })

  it('forgets a deferred RESUME whose connection IDENTIFYs instead', async () => {
    const started = await zombie()
    await detect()
    const plain = await dial(server.url)
    await frame(plain, (entry) => entry.op === 10)
    plain.sessionId = client.sessionId
    plain.ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq: 0 },
      })
    )
    await until(started.id, (record) => record.reconnect_hold?.pending === 1)
    plain.ws.send(
      JSON.stringify({ op: 2, d: { token: OTHER_TOKEN, intents: INTENTS } })
    )
    const ready = await frame(plain, (entry) => entry.t === 'READY')
    expect(
      await until(started.id, (record) => record.reconnect_hold?.pending === 0)
    ).toMatchObject({ reconnect_hold: { attempts: 1 } })
    await release(started.id)
    await delay(50)
    // The release does not resume the client's session on that connection.
    expect(plain.frames.some((entry) => entry.t === 'RESUMED')).toBe(false)
    expect(plain.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.sessionManager.get(String(ready.d?.session_id))?.botId).toBe(
      OTHER_BOT_ID
    )
  })

  it('releases blocked connections when the session is removed', async () => {
    const started = await zombie()
    await detect()
    const pending = await dialResume()
    await until(started.id, (record) => record.reconnect_hold?.pending === 1)
    server.sessionManager.remove(client.sessionId)
    expect(await inspect(started.id)).toMatchObject({
      status: 'session_lost',
      reconnect_hold: { released_by: 'session_removed' },
    })
    await frame(pending, (entry) => entry.op === 10)
    expect(await sendResume(pending, 0)).toMatchObject({ op: 9 })
  })

  it('wakes long-polls when the hold starts, blocks an attempt and is released', async () => {
    const started = await zombie()
    /** Starts a long-poll and gives its request time to register. */
    const poll = async (): Promise<() => Promise<Zombie>> => {
      const since = Date.now()
      const pending = inspect(started.id, '?wait_ms=5000')
      await delay(50)
      return async () => {
        const record = await pending
        // Woken by the change, not by the 5 s timeout.
        expect(Date.now() - since).toBeLessThan(4000)
        return record
      }
    }
    const begun = await poll()
    await detect()
    expect(await begun()).toMatchObject({
      status: 'reconnect_held',
      reconnect_hold: { attempts: 0 },
    })
    const attempt = await poll()
    await dialResume()
    expect(await attempt()).toMatchObject({ reconnect_hold: { attempts: 1 } })
    const released = await poll()
    await release(started.id)
    expect(await released()).toMatchObject({
      status: 'awaiting_resume',
      reconnect_hold: { released_by: 'release' },
    })
  }, 20_000)

  it('releases through the by-key route and validates release requests', async () => {
    const key = 'hold-key'
    const query = `?bot_id=${BOT_ID}&guild_id=${GUILD}&session_id=${client.sessionId}`
    const started = await zombie({ ownership_key: key })
    // Nothing is held yet.
    await release(started.id, 409)
    await json(
      `${ZOMBIES}/by-key/${key}/release-reconnect${query}`,
      409,
      'POST',
      {}
    )
    await detect()
    await json(`${ZOMBIES}/${started.id}/release-reconnect`, 400, 'POST', {
      extra: 1,
    })
    await json(`${ZOMBIES}/${started.id}/release-reconnect`, 400, 'POST')
    await json(
      `${ZOMBIES}/by-key/${key}/release-reconnect${query}&extra=1`,
      400,
      'POST',
      {}
    )
    await json(
      `${ZOMBIES}/by-key/other/release-reconnect${query}`,
      404,
      'POST',
      {}
    )
    await json(`${ZOMBIES}/unknown/release-reconnect`, 404, 'POST', {})
    expect(
      await json<Zombie>(
        `${ZOMBIES}/by-key/${key}/release-reconnect${query}`,
        200,
        'POST',
        {}
      )
    ).toMatchObject({
      id: started.id,
      reconnect_hold: { released_by: 'release' },
    })
    // A keyed retry must repeat the same hold options.
    expect(
      await zombie({ ownership_key: key, hold_reconnect: true })
    ).toMatchObject({ id: started.id })
    await json(ZOMBIES, 409, 'POST', {
      ownership_key: key,
      bot_id: BOT_ID,
      guild_id: GUILD,
      session_id: client.sessionId,
    })
    await json(ZOMBIES, 409, 'POST', {
      ownership_key: key,
      bot_id: BOT_ID,
      guild_id: GUILD,
      session_id: client.sessionId,
      hold_reconnect: true,
      reconnect_hold_ttl_ms: 1000,
    })

    // A record without a hold has nothing to release.
    const other = await connect()
    const plain = await zombie({ hold_reconnect: false }, other)
    await detect(other)
    await release(plain.id, 409)
  })

  it('validates hold fields', async () => {
    const valid = {
      bot_id: BOT_ID,
      guild_id: GUILD,
      session_id: client.sessionId,
    }
    for (const body of [
      { ...valid, hold_reconnect: 'true' },
      { ...valid, hold_reconnect: 1 },
      { ...valid, hold_reconnect: null },
      { ...valid, reconnect_hold_ttl_ms: 1000 },
      { ...valid, hold_reconnect: false, reconnect_hold_ttl_ms: 1000 },
      { ...valid, hold_reconnect: true, reconnect_hold_ttl_ms: 0 },
      { ...valid, hold_reconnect: true, reconnect_hold_ttl_ms: 300_001 },
      { ...valid, hold_reconnect: true, reconnect_hold_ttl_ms: 1.5 },
      { ...valid, hold_reconnect: true, reconnect_hold_ttl_ms: '1000' },
    ]) {
      const response = await request(ZOMBIES, 'POST', body)
      expect(response.status).toBe(400)
    }
    expect(await zombie({ reconnect_hold_ttl_ms: 300_000 })).toMatchObject({
      hold_reconnect: true,
      reconnect_hold_ttl_ms: 300_000,
    })
  })

  it('keeps the existing behavior without hold_reconnect', async () => {
    const received = lastSequence(client)
    const started = await zombie({ hold_reconnect: false })
    expect(started).toMatchObject({
      hold_reconnect: false,
      reconnect_hold_ttl_ms: null,
      reconnect_hold: null,
      resume_rejected: null,
    })
    await voice({})
    await detect()
    expect(await inspect(started.id)).toMatchObject({
      status: 'awaiting_resume',
      ended_by: 'client_close',
      reconnect_hold: null,
    })
    const resume = await dialResume()
    expect(await helloWithin(resume, 1000)).toBe(true)
    expect(await sendResume(resume, received)).toMatchObject({ t: 'RESUMED' })
  })

  it('serves the Gateway on the resume path with a trailing slash, and on the plain URL for RESUME', async () => {
    const received = lastSequence(client)
    client.ws.close(4000)
    await client.closed
    const slashed = await dial(`${client.resumeUrl}/?v=10&encoding=json`)
    await frame(slashed, (entry) => entry.op === 10)
    slashed.sessionId = client.sessionId
    expect(await sendResume(slashed, received)).toMatchObject({ t: 'RESUMED' })
    // Without an upgrade the resume path is no Gateway (REST auth applies).
    const response = await fetch(`${base}/_gateway/resume/${client.sessionId}`)
    expect(response.status).toBe(401)
  })

  it('releases blocked connections on DELETE, /_test/reset and guild deletion', async () => {
    const first = await zombie()
    await detect()
    const pendingFirst = await dialResume()
    await until(first.id, (record) => record.reconnect_hold?.pending === 1)
    expect(await request(`${ZOMBIES}/${first.id}`, 'DELETE')).toMatchObject({
      status: 204,
    })
    await frame(pendingFirst, (entry) => entry.op === 10)
    await json(`${ZOMBIES}/${first.id}`, 404)

    const second = await connect()
    const viaReset = await zombie({}, second)
    await detect(second)
    const pendingSecond = await dialResume(second)
    await until(viaReset.id, (record) => record.reconnect_hold?.pending === 1)
    expect(
      await request('/_test/reset', 'POST', { token: TOKEN })
    ).toMatchObject({ status: 204 })
    await frame(pendingSecond, (entry) => entry.op === 10)
    await json(`${ZOMBIES}/${viaReset.id}`, 404)

    const third = await connect()
    const viaGuild = await zombie({}, third)
    await detect(third)
    const pendingThird = await dialResume(third)
    await until(viaGuild.id, (record) => record.reconnect_hold?.pending === 1)
    const deleted = await fetch(`${base}/api/v10/guilds/${GUILD}`, {
      method: 'DELETE',
      headers: { Authorization: TOKEN },
    })
    expect(deleted.status).toBe(204)
    await frame(pendingThird, (entry) => entry.op === 10)
    await json(`${ZOMBIES}/${viaGuild.id}`, 404)
  })
})
