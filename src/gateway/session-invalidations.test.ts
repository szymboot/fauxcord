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
import type { GatewayPayload } from './protocol'

/** Real Gateway connection and every frame it received. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
  closed: Promise<number>
}

/** Public observation of one replacement IDENTIFY. */
interface IdentifyObservation {
  session_id: string
  intents: number
  guilds_intent: boolean
  ready: { sequence: number; guild_ids: string[]; transport: string }
  guild_creates: {
    guild_id: string
    sequence: number
    transport: string
    member_count: number
    channel_count: number
    voice_states: {
      user_id: string
      channel_id: string | null
      self_stream: boolean
      self_video: boolean
    }[]
    voice_states_total: number
  }[]
  guild_creates_skipped: number
  complete: boolean
}

/** Public inspection object returned by the invalidation control. */
interface Invalidation {
  id: string
  ownership_key: string
  bot_id: string
  guild_id: string
  session_id: string
  sequence: number
  op: number
  resumable: boolean
  close_code: number
  transport: string
  status: string
  ttl_ms: number
  expires_at: number
  invalidated_at: number
  identifies: IdentifyObservation[]
  identifies_skipped: number
  resumes_rejected: number
}

const TOKEN = 'Bot reidentify'
const OTHER_TOKEN = 'Bot reidentify-other'
const BOT_ID = '111111111111111111'
const OTHER_BOT_ID = '121212121212121212'
const GUILD_A = '222222222222222222'
const GUILD_B = '232323232323232323'
const OTHER_GUILD = '242424242424242424'
const VOICE_A = '555555555555555555'
const VOICE_B = '565656565656565656'
const OTHER_VOICE = '575757575757575757'
const HUMAN_A = '888888888888888888'
const HUMAN_B = '898989898989898989'
const LATE_MEMBER = '909090909090909090'
const ROOT = '/_test/gateway-session-invalidations'
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates

describe('Gateway session invalidation (forced re-IDENTIFY)', () => {
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
        if (
          !(target.frames.filter((entry) => entry.op === 11).length > before)
        ) {
          return
        }

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

  /** Connects and IDENTIFYs, waiting for READY and each expected GUILD_CREATE. */
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
          (entry) => entry.t === 'GUILD_CREATE' && entry.d?.id === guild
        )
      }
    }
    return result
  }

  /** Builds an exact address whose complete identity is known before POST. */
  function address(
    key = 'reidentify-1',
    session = client.sessionId,
    bot = BOT_ID,
    guild = GUILD_A,
    extra = ''
  ): string {
    return `${ROOT}/by-key/${key}?bot_id=${bot}&guild_id=${guild}&session_id=${session}${extra}`
  }

  /** Builds a keyed invalidation request for the current client. */
  function payload(extra: Record<string, unknown> = {}) {
    return {
      ownership_key: 'reidentify-1',
      bot_id: BOT_ID,
      guild_id: GUILD_A,
      session_id: client.sessionId,
      ...extra,
    }
  }

  /** Posts an invalidation and returns its decoded observation. */
  async function invalidate(
    extra: Record<string, unknown> = {}
  ): Promise<Invalidation> {
    const response = await request(ROOT, 'POST', payload(extra))
    expect(response.status).toBe(201)
    return (await response.json()) as Invalidation
  }

  /** Prepares a voice state through the existing fixture route. */
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

  /** Returns only the HTTP status of a test-control call. */
  async function status(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<number> {
    const response = await request(path, method, body)
    return response.status
  }

  /** Reads one observation through its exact key address. */
  async function observe(path = address()): Promise<Invalidation> {
    const response = await request(path)
    expect(response.status).toBe(200)
    return (await response.json()) as Invalidation
  }

  /** Waits for INVALID_SESSION on a socket and returns its resumable flag. */
  async function invalidSession(target: Client): Promise<unknown> {
    const payload = await frame(target, (entry) => entry.op === 9)
    return payload.d
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT_ID)
    seedGuild(server.db, TOKEN, GUILD_A)
    seedGuild(server.db, TOKEN, GUILD_B)
    seedVoiceChannel(server.db, GUILD_A, VOICE_A)
    seedVoiceChannel(server.db, GUILD_B, VOICE_B)
    seedMember(server.db, GUILD_A, HUMAN_A)
    seedMember(server.db, GUILD_B, HUMAN_B)
    seedBot(server.db, OTHER_TOKEN, OTHER_BOT_ID)
    seedGuild(server.db, OTHER_TOKEN, OTHER_GUILD)
    seedVoiceChannel(server.db, OTHER_GUILD, OTHER_VOICE)
    seedMember(server.db, OTHER_GUILD, HUMAN_A)
    client = await connect()
  })

  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('sends INVALID_SESSION(false), closes 4009 and observes a fresh IDENTIFY with current per-guild state', async () => {
    // Prepared silently before invalidation and changed live afterwards.
    await voice(GUILD_A, HUMAN_A, {
      channel_id: VOICE_A,
      self_stream: true,
      emit: false,
    })
    await voice(GUILD_B, HUMAN_B, { channel_id: VOICE_B })
    await frame(client, (entry) => entry.t === 'VOICE_STATE_UPDATE')
    const lastSequence = Math.max(...client.frames.map((entry) => entry.s ?? 0))

    const result = await invalidate()
    expect(result).toMatchObject({
      ownership_key: 'reidentify-1',
      bot_id: BOT_ID,
      guild_id: GUILD_A,
      session_id: client.sessionId,
      sequence: lastSequence,
      op: 9,
      resumable: false,
      close_code: 4009,
      status: 'awaiting_identify',
      identifies: [],
      resumes_rejected: 0,
    })
    expect(result.id).toMatch(/^[\da-f-]{36}$/)

    const invalid = await frame(client, (entry) => entry.op === 9)
    expect(invalid).toEqual({ op: 9, d: false, s: null, t: null })
    expect(await client.closed).toBe(4009)
    expect(server.sessionManager.get(client.sessionId)).toBeUndefined()

    // Changes between invalidation and IDENTIFY are part of the snapshot.
    await voice(GUILD_B, HUMAN_B, { self_stream: true, self_video: true })
    seedMember(server.db, GUILD_A, LATE_MEMBER)

    // The stale session can never be resumed.
    const stale = await open()
    stale.ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq: lastSequence },
      })
    )
    expect(await invalidSession(stale)).toBe(false)

    const replacement = await connect()
    expect(replacement.sessionId).not.toBe(client.sessionId)
    const creates = replacement.frames.filter(
      (entry) => entry.t === 'GUILD_CREATE'
    )
    const byId = new Map(creates.map((entry) => [entry.d?.id, entry.d]))
    expect(
      (byId.get(GUILD_A)?.members as { user: { id: string } }[]).map(
        (member) => member.user.id
      )
    ).toContain(LATE_MEMBER)
    expect(byId.get(GUILD_A)?.voice_states).toMatchObject([
      { user_id: HUMAN_A, channel_id: VOICE_A, self_stream: true },
    ])
    expect(byId.get(GUILD_B)?.voice_states).toMatchObject([
      {
        user_id: HUMAN_B,
        channel_id: VOICE_B,
        self_stream: true,
        self_video: true,
      },
    ])

    const observed = await request(
      address(undefined, undefined, undefined, undefined, '&wait_ms=5000')
    )
    expect(observed.status).toBe(200)
    expect(observed.headers.get('cache-control')).toBe('no-store')
    const body = (await observed.json()) as Invalidation
    expect(body.status).toBe('identified')
    expect(body.resumes_rejected).toBe(1)
    expect(body.identifies).toHaveLength(1)
    const [identify] = body.identifies
    expect(identify).toMatchObject({
      session_id: replacement.sessionId,
      intents: INTENTS,
      guilds_intent: true,
      complete: true,
      guild_creates_skipped: 0,
      ready: { sequence: 1, transport: 'sent' },
    })
    expect(
      identify.ready.guild_ids.toSorted((left, right) =>
        left.localeCompare(right)
      )
    ).toEqual([GUILD_A, GUILD_B])
    const observedById = new Map(
      identify.guild_creates.map((entry) => [entry.guild_id, entry])
    )
    expect(observedById.get(GUILD_A)).toMatchObject({
      transport: 'sent',
      sequence: creates.find((entry) => entry.d?.id === GUILD_A)?.s,
      member_count: 2,
      channel_count: 1,
      voice_states_total: 1,
      voice_states: [
        {
          user_id: HUMAN_A,
          channel_id: VOICE_A,
          self_stream: true,
          self_video: false,
        },
      ],
    })
    expect(observedById.get(GUILD_B)).toMatchObject({
      transport: 'sent',
      voice_states: [
        {
          user_id: HUMAN_B,
          channel_id: VOICE_B,
          self_stream: true,
          self_video: true,
        },
      ],
    })

    // Live changes reach only the replacement session.
    await voice(GUILD_A, HUMAN_A, { self_stream: false })
    const update = await frame(
      replacement,
      (entry) =>
        entry.t === 'VOICE_STATE_UPDATE' && entry.d?.user_id === HUMAN_A
    )
    expect(update.d).toMatchObject({ self_stream: false })
  })

  it('retries the same key idempotently without invalidating the replacement', async () => {
    const first = await invalidate()
    await client.closed
    const replacement = await connect()

    const retry = await request(ROOT, 'POST', payload())
    expect(retry.status).toBe(201)
    const second = (await retry.json()) as Invalidation
    expect(second.id).toBe(first.id)
    expect(second.sequence).toBe(first.sequence)
    expect(second.expires_at).toBe(first.expires_at)
    expect(second.identifies[0]?.session_id).toBe(replacement.sessionId)

    await fence(replacement)
    expect(replacement.frames.some((entry) => entry.op === 9)).toBe(false)
    expect(server.sessionManager.get(replacement.sessionId)).toBeDefined()
  })

  it('cannot invalidate a replacement through a new key naming the stale session', async () => {
    await invalidate()
    await client.closed
    const replacement = await connect()

    const late = await request(
      ROOT,
      'POST',
      payload({ ownership_key: 'reidentify-2' })
    )
    expect(late.status).toBe(404)
    expect(await late.json()).toEqual({ message: 'UNKNOWN_SCOPE', code: 0 })
    await fence(replacement)
    expect(replacement.frames.some((entry) => entry.op === 9)).toBe(false)
    expect(server.sessionManager.get(replacement.sessionId)).toBeDefined()
    // The failed POST reserved nothing: its key is still unused.
    expect(await status(address('reidentify-2'))).toBe(404)
  })

  it('closes an unused key before a delayed POST can invalidate anything', async () => {
    const cleanup = await request(address(), 'DELETE')
    expect(cleanup.status).toBe(204)
    expect(await status(address(), 'DELETE')).toBe(204)

    const late = await request(ROOT, 'POST', payload())
    expect(late.status).toBe(409)
    expect(await late.json()).toEqual({ message: 'CONFLICT', code: 0 })
    await fence(client)
    expect(client.frames.some((entry) => entry.op === 9)).toBe(false)
    expect(server.sessionManager.get(client.sessionId)?.ws.readyState).toBe(
      WebSocket.OPEN
    )
    expect(await status(address())).toBe(404)
  })

  it('recovers and closes an applied invalidation by key', async () => {
    const created = await invalidate()
    const recovered = await observe()
    expect(recovered.id).toBe(created.id)
    expect(await status(`${ROOT}/${created.id}`)).toBe(200)

    expect(await status(address(), 'DELETE')).toBe(204)
    expect(await status(address())).toBe(404)
    expect(await status(`${ROOT}/${created.id}`)).toBe(404)
    expect(await status(ROOT, 'POST', payload())).toBe(409)
  })

  it('tombstones an unused key for a session that no longer exists', async () => {
    await invalidate()
    await client.closed
    expect(await status(address('reidentify-gone'), 'DELETE')).toBe(204)
    expect(
      await status(ROOT, 'POST', payload({ ownership_key: 'reidentify-gone' }))
    ).toBe(409)
  })

  it('rejects a mismatched cleanup scope without changing anything', async () => {
    await invalidate()
    expect(
      await status(address(undefined, undefined, OTHER_BOT_ID), 'DELETE')
    ).toBe(404)
    expect(
      await status(
        address(undefined, undefined, undefined, OTHER_GUILD),
        'DELETE'
      )
    ).toBe(404)
    expect(await status(address(undefined, 'f'.repeat(32)), 'DELETE')).toBe(404)
    expect(await status(address())).toBe(200)
    expect(
      await status(
        address('fresh', undefined, undefined, OTHER_GUILD),
        'DELETE'
      )
    ).toBe(404)
  })

  it('returns a pending observation when no IDENTIFY arrives within wait_ms', async () => {
    await invalidate()
    const pending = await observe(
      address(undefined, undefined, undefined, undefined, '&wait_ms=25')
    )
    expect(pending.status).toBe('awaiting_identify')
  })

  it('wakes a waiting observer with 404 when the observation expires', async () => {
    await invalidate({ ttl_ms: 50 })
    const response = await request(
      address(undefined, undefined, undefined, undefined, '&wait_ms=5000')
    )
    expect(response.status).toBe(404)
    expect(await status(ROOT, 'POST', payload({ ttl_ms: 50 }))).toBe(409)
  })

  it('records READY without GUILD_CREATE for a replacement lacking Guilds', async () => {
    await invalidate()
    await client.closed
    const replacement = await connect(TOKEN, GatewayIntentBits.GuildVoiceStates)
    const response = await request(
      address(undefined, undefined, undefined, undefined, '&wait_ms=5000')
    )
    const body = (await response.json()) as Invalidation
    expect(body.identifies[0]).toMatchObject({
      session_id: replacement.sessionId,
      guilds_intent: false,
      guild_creates: [],
      complete: true,
    })
  })

  it('leaves other sessions, bots and guilds untouched', async () => {
    const sibling = await connect()
    const other = await connect(OTHER_TOKEN, INTENTS, [OTHER_GUILD])

    await invalidate()
    await client.closed
    await fence(sibling)
    await fence(other)
    expect(sibling.frames.some((entry) => entry.op === 9)).toBe(false)
    expect(other.frames.some((entry) => entry.op === 9)).toBe(false)
    expect(server.sessionManager.get(sibling.sessionId)).toBeDefined()
    expect(server.sessionManager.get(other.sessionId)).toBeDefined()

    await voice(GUILD_A, HUMAN_A, { channel_id: VOICE_A })
    await voice(OTHER_GUILD, HUMAN_A, { channel_id: OTHER_VOICE })
    await frame(
      sibling,
      (entry) =>
        entry.t === 'VOICE_STATE_UPDATE' && entry.d?.guild_id === GUILD_A
    )
    await frame(
      other,
      (entry) =>
        entry.t === 'VOICE_STATE_UPDATE' && entry.d?.guild_id === OTHER_GUILD
    )

    // Another bot's IDENTIFY is not a replacement for this session.
    await connect(OTHER_TOKEN, INTENTS, [OTHER_GUILD])
    const body = await observe()
    expect(body.status).toBe('awaiting_identify')
    expect(body.identifies).toEqual([])
  })

  it('rejects unknown, foreign and malformed scopes', async () => {
    const other = await connect(OTHER_TOKEN, INTENTS, [OTHER_GUILD])
    const cases: [Record<string, unknown>, number][] = [
      [{ session_id: 'f'.repeat(32) }, 404],
      [{ bot_id: OTHER_BOT_ID }, 404],
      [{ guild_id: OTHER_GUILD }, 404],
      [{ session_id: other.sessionId }, 404],
      [{ guild_id: '999999999999999999' }, 404],
      [{ session_id: undefined }, 400],
      [{ ownership_key: undefined }, 400],
      [{ ownership_key: 'bad key' }, 400],
      [{ ownership_key: 'x'.repeat(129) }, 400],
      [{ bot_id: '0' }, 400],
      [{ guild_id: ' 1' }, 400],
      [{ session_id: client.sessionId.toUpperCase() }, 400],
      [{ ttl_ms: 0 }, 400],
      [{ ttl_ms: 120_001 }, 400],
      [{ ttl_ms: 1.5 }, 400],
      [{ ttl_ms: '100' }, 400],
      [{ unexpected: true }, 400],
    ]
    for (const [extra, expected] of cases) {
      const response = await request(ROOT, 'POST', payload(extra))
      expect(response.status, JSON.stringify(extra)).toBe(expected)
    }
    expect(await status(ROOT, 'POST', '{')).toBe(400)
    expect(await status(ROOT, 'POST', '[]')).toBe(400)
    expect(await status(ROOT, 'POST', { pad: 'x'.repeat(20_000) })).toBe(413)
    for (const query of [
      `?bot_id=${BOT_ID}&guild_id=${GUILD_A}`,
      `?bot_id=${BOT_ID}&guild_id=${GUILD_A}&session_id=${client.sessionId}&session_id=${client.sessionId}`,
      `?bot_id=${BOT_ID}&guild_id=${GUILD_A}&session_id=${client.sessionId}&extra=1`,
      `?bot_id=${BOT_ID}&guild_id=${GUILD_A}&session_id=${client.sessionId}&wait_ms=30001`,
      `?bot_id=${BOT_ID}&guild_id=${GUILD_A}&session_id=${client.sessionId}&wait_ms=-1`,
    ]) {
      expect(await status(`${ROOT}/by-key/reidentify-1${query}`)).toBe(400)
    }
    expect(
      await status(
        `${ROOT}/by-key/reidentify-1?bot_id=${BOT_ID}&guild_id=${GUILD_A}&session_id=${client.sessionId}&wait_ms=1`,
        'DELETE'
      )
    ).toBe(400)
    // Nothing was invalidated by any rejected request.
    await fence(client)
    await fence(other)
    expect(client.frames.some((entry) => entry.op === 9)).toBe(false)
    expect(other.frames.some((entry) => entry.op === 9)).toBe(false)
  })

  it('refuses a retained session that is disconnected and awaiting RESUME', async () => {
    const lastSequence = server.sessionManager.get(client.sessionId)?.seq ?? 0
    client.ws.terminate()
    await client.closed
    const response = await request(ROOT, 'POST', payload())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ message: 'INVALID_STATE', code: 0 })
    // The refused key stays unused and the session can still be resumed.
    expect(await status(address())).toBe(404)
    const resumed = await open()
    resumed.ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq: lastSequence },
      })
    )
    await frame(resumed, (entry) => entry.t === 'RESUMED')
    // Once resumed on a new socket, the same session is live again.
    const result = await invalidate()
    expect(result.session_id).toBe(client.sessionId)
    expect(await invalidSession(resumed)).toBe(false)
    expect(await resumed.closed).toBe(4009)
  })

  it('composes with an explicit capture disconnect and cancels that session’s captures', async () => {
    const capture = await request('/_test/gateway-event-controls', 'POST', {
      bot_id: BOT_ID,
      guild_id: GUILD_A,
      session_id: client.sessionId,
      events: ['VOICE_STATE_UPDATE'],
    })
    expect(capture.status).toBe(201)
    const { id } = (await capture.json()) as { id: string }
    const disconnect = await request(
      `/_test/gateway-event-controls/${id}/disconnect`,
      'POST',
      {}
    )
    expect(disconnect.status).toBe(200)
    const checkpoint = (await disconnect.json()) as { sequence: number }
    await client.closed
    // While the controlled disconnect awaits RESUME the session is not live.
    expect(await status(ROOT, 'POST', payload())).toBe(409)

    const resumed = await open()
    resumed.ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: TOKEN,
          session_id: client.sessionId,
          seq: checkpoint.sequence,
        },
      })
    )
    await frame(resumed, (entry) => entry.t === 'RESUMED')
    await invalidate()
    expect(await resumed.closed).toBe(4009)
    expect(await status(`/_test/gateway-event-controls/${id}`)).toBe(404)
    expect(
      await status(`/_test/gateway-event-controls/${id}/disconnect`, 'POST', {})
    ).toBe(404)
  })

  it('records RESUME attempts for the stale session after a parallel reconnect', async () => {
    const result = await invalidate()
    await client.closed
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stale = await open()
      stale.ws.send(
        JSON.stringify({
          op: 6,
          d: {
            token: TOKEN,
            session_id: client.sessionId,
            seq: result.sequence,
          },
        })
      )
      expect(await invalidSession(stale)).toBe(false)
    }
    const body = await observe()
    expect(body.resumes_rejected).toBe(2)
    expect(body.status).toBe('awaiting_identify')
  })

  it('retires observations on reset and guild deletion', async () => {
    await invalidate()
    expect(await status('/_test/reset', 'POST', { token: OTHER_TOKEN })).toBe(
      204
    )
    expect(await status(address())).toBe(200)
    expect(await status('/_test/reset', 'POST', { token: TOKEN })).toBe(204)
    expect(await status(address())).toBe(404)
    expect(await status(ROOT, 'POST', payload())).toBe(409)

    const replacement = await connect()
    const second = await request(
      ROOT,
      'POST',
      payload({
        ownership_key: 'reidentify-2',
        session_id: replacement.sessionId,
      })
    )
    expect(second.status).toBe(201)
    const deleted = await fetch(`${base}/guilds/${GUILD_A}`, {
      method: 'DELETE',
      headers: { Authorization: TOKEN },
    })
    expect(deleted.status).toBe(204)
    expect(await status(address('reidentify-2', replacement.sessionId))).toBe(
      404
    )
  })

  it('bounds live observations per Gateway instance', async () => {
    const sessions = [client]
    for (let index = 1; index < 33; index += 1)
      sessions.push(await connect(TOKEN, GatewayIntentBits.GuildVoiceStates))
    for (const [index, target] of sessions.entries()) {
      const response = await request(ROOT, 'POST', {
        ownership_key: `bounded-${index}`,
        bot_id: BOT_ID,
        guild_id: GUILD_A,
        session_id: target.sessionId,
      })
      expect(response.status).toBe(index < 32 ? 201 : 429)
    }
    const last = sessions.at(-1)
    expect(last && server.sessionManager.get(last.sessionId)).toBeDefined()
    expect(await status(address('bounded-32', last?.sessionId))).toBe(404)
  })
})
