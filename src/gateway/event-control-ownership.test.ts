import { request as httpRequest } from 'node:http'
import { GatewayEventControls } from './event-controls'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedVoiceChannel,
  seedMember,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'
import type { GuildVoiceState } from '../services/voice-states'

/** Real Gateway connection and frames received by the test client. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

const TOKEN = 'Bot voice-capture'
const BOT_ID = '111111111111111111'
const HUMAN_ID = '888888888888888888'
const ROOT = '/_test/gateway-event-controls'

describe('recoverable Gateway capture ownership', () => {
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
      allow_original_sequence: false,
      limit: 20,
      ttl_ms: 30_000,
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
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

  /** Builds a policy whose complete identity is known before the POST. */
  function payload(extra: Record<string, unknown> = {}) {
    return {
      ownership_key: 'capture-owner',
      bot_id: BOT_ID,
      guild_id: guild,
      session_id: client.sessionId,
      events: ['VOICE_STATE_UPDATE'],
      hold: true,
      allow_original_sequence: false,
      limit: 20,
      ttl_ms: 30_000,
      ...extra,
    }
  }

  /** Addresses only the caller's exact expected owner. */
  function address(
    key = 'capture-owner',
    bot = BOT_ID,
    guildId = guild,
    session = client.sessionId
  ) {
    return `${ROOT}/by-key/${key}?bot_id=${bot}&guild_id=${guildId}&session_id=${session}`
  }

  /** Reads the public response without assuming a creation UUID is available. */
  async function read(path = address(), method = 'GET', body?: unknown) {
    const response = await request(path, method, body)
    expect([200, 201]).toContain(response.status)
    return response.json() as Promise<Record<string, unknown>>
  }

  /** Builds a read-only discovery address without access to the bot's READY. */
  function preflight(bot = BOT_ID, guildId = guild, session?: string) {
    const search = new URLSearchParams({ bot_id: bot, guild_id: guildId })
    if (session !== undefined) search.set('session_id', session)
    return `${ROOT}/session?${search}`
  }

  it('discovers the unique owning session over unauthenticated HTTP without side effects', async () => {
    await transition({ channel_id: channel, self_stream: true, emit: false })
    await fence()
    const database = server.db.serialize()
    const owner = server.sessionManager.get(client.sessionId)
    const sequence = owner?.seq
    const replay = structuredClone(owner?.replayBuffer)
    const listeners = owner?.ws.listenerCount('close')
    const frames = structuredClone(client.frames)
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(base + preflight())
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toEqual({
        bot_id: BOT_ID,
        guild_id: guild,
        session_id: client.sessionId,
      })
    }
    expect(server.db.serialize()).toEqual(database)
    expect(owner?.seq).toBe(sequence)
    expect(owner?.replayBuffer).toEqual(replay)
    expect(owner?.ws.listenerCount('close')).toBe(listeners)
    expect(client.frames).toEqual(frames)
    expect(await status(address())).toBe(404)
    const future = await transition({ self_stream: false })
    await fence()
    expect(voices()).toHaveLength(1)
    expect(voices()[0].d).toMatchObject(future)
  })

  it('reads session scope without modifying an existing hold or its evidence', async () => {
    await read(ROOT, 'POST', payload())
    await transition({ channel_id: channel, self_stream: true })
    const evidence = await read()
    await read(preflight())
    await read(preflight(BOT_ID, guild, client.sessionId))
    expect(await read()).toEqual(evidence)
    await fence()
    expect(voices()).toHaveLength(0)
  })

  it('isolates discovery by bot, guild and exact setup token without disclosing candidates', async () => {
    const token = 'Bot preflight-other'
    seedBot(server.db, token, BOT_ID)
    const foreignGuild = seedGuild(server.db, token, '333333333333333333')
    const foreign = await connect(token)
    expect(await read(preflight())).toEqual({
      bot_id: BOT_ID,
      guild_id: guild,
      session_id: client.sessionId,
    })
    expect(await read(preflight(BOT_ID, foreignGuild))).toEqual({
      bot_id: BOT_ID,
      guild_id: foreignGuild,
      session_id: foreign.sessionId,
    })
    for (const path of [
      preflight('999'),
      preflight(BOT_ID, '999'),
      preflight(BOT_ID, guild, foreign.sessionId),
      preflight(BOT_ID, foreignGuild, client.sessionId),
    ]) {
      const response = await request(path)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        message: 'UNKNOWN_SCOPE',
        code: 0,
      })
    }
    const second = await connect()
    const ambiguous = await request(preflight())
    expect(ambiguous.status).toBe(409)
    expect(ambiguous.headers.get('Cache-Control')).toBe('no-store')
    expect(await ambiguous.json()).toEqual({
      message: 'AMBIGUOUS_SESSION',
      code: 0,
    })
    expect(await read(preflight(BOT_ID, guild, second.sessionId))).toEqual({
      bot_id: BOT_ID,
      guild_id: guild,
      session_id: second.sessionId,
    })
    expect(
      await status(
        ROOT,
        'POST',
        payload({ ownership_key: undefined, session_id: undefined })
      )
    ).toBe(409)
  })

  it('returns 404 for disconnected or absent owning sessions and wrong registered setup', async () => {
    const closed = once(client.ws, 'close')
    client.ws.close()
    await closed
    await expect.poll(() => status(preflight())).toBe(404)
    expect(await status(preflight(BOT_ID, guild, client.sessionId))).toBe(404)
    expect(await status(preflight(BOT_ID, guild, 'a'.repeat(32)))).toBe(404)
    client = await connect()
    seedBot(server.db, 'Bot replacement-setup', BOT_ID)
    server.db
      .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
      .run('Bot replacement-setup', guild)
    expect(await status(preflight())).toBe(404)
    expect(await status(preflight(BOT_ID, guild, client.sessionId))).toBe(404)
  })

  it('does not prune a capture when a read-only preflight discovers stale setup scope', async () => {
    await read(ROOT, 'POST', payload())
    const socket = server.sessionManager.get(client.sessionId)?.ws
    const listeners = socket?.listenerCount('close')
    seedBot(server.db, 'Bot replaced-preflight', BOT_ID)
    server.db
      .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
      .run('Bot replaced-preflight', guild)
    expect(await status(preflight())).toBe(404)
    expect(socket?.listenerCount('close')).toBe(listeners)
    // The ordinary capture action performs its existing invalidation later.
    expect(await status(address())).toBe(404)
    expect(socket?.listenerCount('close')).toBe((listeners ?? 0) - 1)
  })

  it('rejects malformed, duplicate and unexpected preflight query fields', async () => {
    const valid = new URLSearchParams({
      bot_id: BOT_ID,
      guild_id: guild,
    }).toString()
    for (const search of [
      '',
      `bot_id=${BOT_ID}`,
      `guild_id=${guild}`,
      `bot_id=0&guild_id=${guild}`,
      `bot_id=${BOT_ID}&guild_id=wrong`,
      `bot_id=${BOT_ID}%0A&guild_id=${guild}`,
      `bot_id=${BOT_ID}&guild_id=${guild}%0A`,
      `${valid}&session_id=${client.sessionId}%0A`,
      `${valid}&session_id=`,
      `${valid}&session_id=${'a'.repeat(31)}`,
      `${valid}&bot_id=${BOT_ID}`,
      `${valid}&guild_id=${guild}`,
      `${valid}&session_id=${client.sessionId}&session_id=${client.sessionId}`,
      `${valid}&ownership_key=unused`,
      `${valid}&extra=1`,
    ]) {
      expect(await status(`${ROOT}/session?${search}`)).toBe(400)
    }
    expect(await status(preflight())).toBe(200)
    expect(await status(ROOT, 'POST', payload())).toBe(201)
  })

  it('never retargets keyed creation after the discovered connection is replaced', async () => {
    const discovered = await read(preflight())
    const closed = once(client.ws, 'close')
    client.ws.close()
    await closed
    client = await connect()
    const stale = payload({ ...discovered })
    expect(await status(ROOT, 'POST', stale)).toBe(404)
    expect(
      await status(preflight(BOT_ID, guild, String(discovered.session_id)))
    ).toBe(404)
    const state = await transition({ channel_id: channel, self_stream: true })
    await fence()
    expect(voices()).toHaveLength(1)
    expect(voices()[0].d).toMatchObject(state)
    expect(await status(address())).toBe(404)
    // No POST succeeded, so no key was reserved. A deliberate new discovery
    // and new attempt can choose the replacement; the stale request never did.
    const replacement = await read(preflight())
    expect(replacement.session_id).not.toBe(discovered.session_id)
    expect(await status(ROOT, 'POST', payload({ ...replacement }))).toBe(201)
  })

  it('recovers a lost response and cleans only its hold while preserving voice state and future delivery', async () => {
    const discovered = await read(preflight())
    const other = await arm({ events: ['MESSAGE_CREATE'] })
    const response = await request(ROOT, 'POST', payload({ ...discovered }))
    expect(response.status).toBe(201)
    await response.body?.cancel()
    const state = await transition({ channel_id: channel, self_stream: true })
    await fence()
    expect(voices()).toHaveLength(0)
    const recovered = await read()
    expect(recovered).toMatchObject({
      ownership_key: 'capture-owner',
      events_captured: [{ envelope: { d: state }, state: 'held' }],
    })
    expect(
      await read(
        ROOT,
        'POST',
        payload({
          application_ack: false,
          limit: 20,
          ttl_ms: 30_000,
          allow_original_sequence: false,
        })
      )
    ).toEqual(recovered)
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await status(address(), 'DELETE')).toBe(204)
    expect(await status(address())).toBe(404)
    expect(await status(ROOT, 'POST', payload())).toBe(409)
    expect(await status(`${ROOT}/${String(recovered.id)}`)).toBe(404)
    expect(await status(`${ROOT}/${other}`)).toBe(200)
    expect(await current()).toEqual(state)
    const future = await transition({ self_stream: false })
    await fence()
    expect(voices()).toHaveLength(1)
    expect(voices()[0].d).toMatchObject(future)
    expect(JSON.stringify(recovered)).not.toContain(TOKEN)
    expect(recovered).not.toHaveProperty('token_hash')
  })

  it('supports exact UUID cleanup when a partial response retains the UUID', async () => {
    const created = await read(ROOT, 'POST', payload())
    expect(await status(`${ROOT}/${String(created.id)}`, 'DELETE')).toBe(204)
    expect(await status(address(), 'DELETE')).toBe(204)
    expect(await status(ROOT, 'POST', payload())).toBe(409)
  })

  it('deduplicates concurrent retries and normalizes event order without resetting evidence or quotas', async () => {
    const policy = payload({
      events: ['VOICE_STATE_UPDATE', 'MESSAGE_CREATE'],
      limit: 1,
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => read(ROOT, 'POST', policy))
    )
    expect(new Set(results.map((value) => value.id)).size).toBe(1)
    await transition({ channel_id: channel, self_stream: true })
    const exhausted = await read()
    expect(
      await read(ROOT, 'POST', {
        ...policy,
        events: ['MESSAGE_CREATE', 'VOICE_STATE_UPDATE'],
      })
    ).toEqual(exhausted)
    await transition({ self_stream: false })
    await fence()
    expect(voices()).toHaveLength(1)
    expect(await read()).toMatchObject({
      skipped: 1,
      events_captured: [{ state: 'held' }],
    })
    expect(await status(address(), 'DELETE')).toBe(204)
  })

  it('tombstones deletion before a delayed POST body completes, and before any creation', async () => {
    const other = await arm({ ownership_key: 'unrelated' })
    const encoded = JSON.stringify(payload())
    let pendingRequest: ReturnType<typeof httpRequest> | undefined
    const pending = new Promise<number>((resolve, reject) => {
      pendingRequest = httpRequest(
        base + ROOT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(encoded),
          },
        },
        (response) => {
          response.resume()
          response.on('end', () => {
            resolve(response.statusCode ?? 0)
          })
        }
      )
      pendingRequest.on('error', reject)
      pendingRequest.write(encoded.slice(0, 20))
    })
    expect(await status(address(), 'DELETE')).toBe(204)
    if (!pendingRequest) throw new Error('POST request was not initialized')
    pendingRequest.end(encoded.slice(20))
    expect(await pending).toBe(409)
    expect(await status(address('never-created'), 'DELETE')).toBe(204)
    expect(
      await status(ROOT, 'POST', payload({ ownership_key: 'never-created' }))
    ).toBe(409)
    expect(await status(`${ROOT}/${other}`)).toBe(200)
  })

  it('closes ownership regardless of concurrent creation and cancellation ordering', async () => {
    const [created, deleted] = await Promise.all([
      request(ROOT, 'POST', payload()),
      request(address(), 'DELETE'),
    ])
    expect([201, 409]).toContain(created.status)
    expect(deleted.status).toBe(204)
    expect(await status(address())).toBe(404)
    expect(await status(ROOT, 'POST', payload())).toBe(409)
  })

  it.each([
    { hold: false },
    { limit: 2 },
    { ttl_ms: 500 },
    { application_ack: true },
    { allow_original_sequence: true },
    { events: ['MESSAGE_CREATE'] },
  ])(
    'rejects conflicting normalized policy %j without modifying evidence',
    async (extra) => {
      const original = await read(ROOT, 'POST', payload())
      expect(await status(ROOT, 'POST', payload(extra))).toBe(409)
      expect(await read()).toEqual(original)
    }
  )

  it('isolates bot, guild, setup, session and key on recovery and cleanup', async () => {
    const original = await read(ROOT, 'POST', payload())
    const otherSession = await connect()
    const otherGuild = seedGuild(server.db, TOKEN, '333333333333333333')
    const otherToken = 'Bot other-owner'
    seedBot(server.db, otherToken, BOT_ID)
    const foreignGuild = seedGuild(server.db, otherToken, '444444444444444444')
    const foreign = await connect(otherToken)
    for (const [bot, guildId, session] of [
      [BOT_ID, otherGuild, client.sessionId],
      ['999', guild, client.sessionId],
      [BOT_ID, guild, otherSession.sessionId],
      [BOT_ID, foreignGuild, foreign.sessionId],
    ]) {
      expect(
        await status(address('capture-owner', bot, guildId, session))
      ).toBe(404)
      expect(
        await status(address('capture-owner', bot, guildId, session), 'DELETE')
      ).toBe(404)
      expect(
        await status(
          ROOT,
          'POST',
          payload({ bot_id: bot, guild_id: guildId, session_id: session })
        )
      ).toBe(409)
    }
    expect(await status(address('unknown'))).toBe(404)
    expect(await read()).toEqual(original)
  })

  it('never retargets a retired key to a replacement session or setup token', async () => {
    const originalSession = client.sessionId
    await read(ROOT, 'POST', payload())
    const closed = once(client.ws, 'close')
    client.ws.close()
    await closed
    expect(await status(address())).toBe(404)
    expect(await status(address(), 'DELETE')).toBe(204)
    client = await connect()
    expect(await status(ROOT, 'POST', payload())).toBe(409)
    expect(
      await status(ROOT, 'POST', payload({ session_id: originalSession }))
    ).toBe(409)
    const fresh = await read(ROOT, 'POST', payload({ ownership_key: 'fresh' }))
    const replacement = 'Bot replacement'
    seedBot(server.db, replacement, BOT_ID)
    server.db
      .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
      .run(replacement, guild)
    expect(await status(address('fresh'))).toBe(404)
    expect(
      await status(ROOT, 'POST', payload({ ownership_key: 'fresh' }))
    ).toBe(409)
    expect(await status(`${ROOT}/${String(fresh.id)}`)).toBe(404)
    expect(await status(address('fresh'), 'DELETE')).toBe(204)
  })

  it.each(['expiry', 'reset', 'global-reset', 'guild', 'setup'])(
    'keeps reservations closed across %s and scope recreation',
    async (action) => {
      const body = payload(action === 'expiry' ? { ttl_ms: 50 } : {})
      const oldAddress = address()
      await read(ROOT, 'POST', body)
      switch (action) {
        case 'expiry': {
          await expect.poll(() => status(oldAddress)).toBe(404)
          break
        }
        case 'reset': {
          expect(await status('/_test/reset', 'POST', { token: TOKEN })).toBe(
            204
          )
          break
        }
        case 'global-reset': {
          expect(await status('/_test/reset', 'POST', {})).toBe(204)
          break
        }
        case 'guild': {
          expect(await status(`/guilds/${guild}`, 'DELETE')).toBe(204)
          break
        }
        default: {
          expect(
            await status('/_test/setup/Bot%20voice-capture', 'DELETE')
          ).toBe(204)
        }
      }
      expect(await status(oldAddress)).toBe(404)
      expect(await status(oldAddress, 'DELETE')).toBe(204)
      seedBot(server.db, TOKEN)
      seedGuild(server.db, TOKEN, guild)
      expect(await status(ROOT, 'POST', body)).toBe(409)
      expect(
        await status(
          ROOT,
          'POST',
          payload({ ownership_key: 'fresh-after-cleanup' })
        )
      ).toBe(201)
    }
  )

  it('does not reserve failed creates and rejects invalid keys, missing sessions, malformed JSON and oversized bodies', async () => {
    for (const key of [
      '',
      null,
      42,
      'a'.repeat(129),
      'space key',
      'trailing\n',
    ])
      expect(await status(ROOT, 'POST', payload({ ownership_key: key }))).toBe(
        400
      )
    expect(await status(ROOT, 'POST', payload({ session_id: undefined }))).toBe(
      400
    )
    const bad = await fetch(base + ROOT, { method: 'POST', body: '{' })
    expect(bad.status).toBe(400)
    const oversized = await fetch(base + ROOT, {
      method: 'POST',
      body: JSON.stringify(payload({ ignored: 'x'.repeat(16_384) })),
    })
    expect(oversized.status).toBe(413)
    expect(await status(ROOT, 'POST', payload({ guild_id: '999' }))).toBe(404)
    const other = await arm()
    expect(await status(ROOT, 'POST', payload())).toBe(409)
    expect(await status(`${ROOT}/${other}`, 'DELETE')).toBe(204)
    expect(await status(ROOT, 'POST', payload())).toBe(201)
  })

  it('rejects malformed ownership addresses and unknown scope without touching controls', async () => {
    await read(ROOT, 'POST', payload())
    for (const suffix of [
      '',
      `?bot_id=${BOT_ID}&guild_id=${guild}`,
      address().split('?', 2)[1]
        ? `?${address().split('?', 2)[1]}&bot_id=${BOT_ID}`
        : '',
      `?${address().split('?', 2)[1]}&extra=1`,
    ]) {
      for (const method of ['GET', 'DELETE'])
        expect(
          await status(`${ROOT}/by-key/capture-owner${suffix}`, method)
        ).toBe(400)
    }
    expect(await status(address('new', BOT_ID, '999'), 'DELETE')).toBe(404)
    const response = await request(address())
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.status).toBe(200)
  })

  it('recovers controlled disconnected evidence without extending its lifetime or replacing the session', async () => {
    const created = await read(ROOT, 'POST', payload())
    await transition({ channel_id: channel, self_stream: true })
    const closed = once(client.ws, 'close')
    expect(
      await status(`${ROOT}/${String(created.id)}/disconnect`, 'POST', {
        pause_resume: true,
      })
    ).toBe(200)
    await closed
    const retained = await read()
    expect(retained).toMatchObject({
      awaiting_resume: true,
      events_captured: [{ state: 'held' }],
    })
    expect(await read(ROOT, 'POST', payload())).toEqual(retained)
    expect(retained.expires_at).toBe(created.expires_at)
    expect(await status(address(), 'DELETE')).toBe(204)
    expect(await status(ROOT, 'POST', payload())).toBe(409)
    expect(await status(address('cancel-before-create'), 'DELETE')).toBe(204)
    expect(
      await status(
        ROOT,
        'POST',
        payload({ ownership_key: 'cancel-before-create' })
      )
    ).toBe(409)
  })

  it('bounds reservations without evicting tombstones, including after reset', () => {
    const controls = new GatewayEventControls(server.db, server.sessionManager)
    for (let attempt = 0; attempt < 3; attempt++)
      expect(
        controls.inspectSession({ bot_id: BOT_ID, guild_id: guild })
      ).toEqual({
        bot_id: BOT_ID,
        guild_id: guild,
        session_id: client.sessionId,
      })
    for (let index = 0; index < 4096; index++)
      expect(
        controls.deleteByKey({
          ownership_key: `reservation-${index}`,
          bot_id: BOT_ID,
          guild_id: guild,
          session_id: client.sessionId,
        })
      ).toBe('DELETED')
    controls.reset()
    expect(
      controls.inspectSession({ bot_id: BOT_ID, guild_id: guild })
    ).toEqual({ bot_id: BOT_ID, guild_id: guild, session_id: client.sessionId })
    const extra = {
      ownership_key: 'overflow',
      bot_id: BOT_ID,
      guild_id: guild,
      session_id: client.sessionId,
    }
    expect(controls.deleteByKey(extra)).toBe('LIMIT')
    expect(
      controls.create(
        payload({
          ownership_key: 'overflow',
          allow_original_sequence: false,
          limit: 20,
          ttl_ms: 30_000,
        })
      )
    ).toBe('LIMIT')
    expect(
      controls.deleteByKey({ ...extra, ownership_key: 'reservation-0' })
    ).toBe('DELETED')
    expect(
      controls.create(
        payload({
          ownership_key: 'reservation-0',
          allow_original_sequence: false,
          limit: 20,
          ttl_ms: 30_000,
        })
      )
    ).toBe('CONFLICT')
  })
})
