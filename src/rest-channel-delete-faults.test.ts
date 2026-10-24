import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { buildApp } from './app'
import { closeDatabase, initializeDatabase } from './db'
import { gatewayBus } from './gateway/bus'
import {
  createRealServer,
  seedBearerCredential,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedMessage,
  seedVoiceChannel,
  seedVoiceState,
  type RealServerContext,
} from './test-helpers'
import type { RestFault } from './services/rest-faults'

const token = 'Bot channel-delete'
const otherToken = 'Bot channel-delete-other'
const channel = '1513052391153471489'
const otherChannel = '1513052391153471490'
const path = `/channels/${channel}`
const failure = { status: 403, code: 50_013, message: 'Missing Permissions' }

/** Seeds an occupied voice channel with a message and a separate bot scope. */
function seed(db: ReturnType<typeof initializeDatabase>): string {
  seedBot(db, token)
  seedBot(db, otherToken, '111111111111111112')
  const guild = seedGuild(db, token)
  seedGuild(db, otherToken, '222222222222222223')
  seedVoiceChannel(db, guild, channel)
  const member = seedMember(db, guild)
  seedVoiceState(db, guild, member, channel)
  seedMessage(db, channel, member, token)
  return guild
}

/** Snapshots native state around selected failures. */
function snapshot(db: ReturnType<typeof initializeDatabase>): unknown[] {
  return ['channels', 'messages', 'guild_voice_states'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  )
}

/** Checks native deletion cleanup, including the retained disconnected voice row. */
function expectDeleted(db: ReturnType<typeof initializeDatabase>): void {
  expect(db.prepare('SELECT * FROM channels').all()).toEqual([])
  expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
  expect(db.prepare('SELECT * FROM guild_voice_states').all()).toMatchObject([
    { channel_id: null },
  ])
}

describe('channel deletion REST faults through full buildApp', () => {
  let db: ReturnType<typeof initializeDatabase>
  let built: ReturnType<typeof buildApp>
  let guild: string

  /** Calls the assembled app with normal authentication and all middleware. */
  async function request(
    route: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ): Promise<Response> {
    return built.app.request(route, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Arms the exact channel deletion selector through the public control API. */
  async function arm(
    overrides: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'DELETE',
      path,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Returns the status of a completed request. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Reads retained consumption without entering any native route. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    return response.json() as Promise<RestFault>
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    built = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    guild = seed(db)
  })

  afterEach(() => {
    built.shutdownRestFaults()
    built.shutdownRestPageHolds()
    built.unsubscribeGateway()
    built.wss.close()
    closeDatabase(db)
    vi.restoreAllMocks()
  })

  it('preserves state and emits nothing across all prefixes, then deletes natively on retry', async () => {
    const fault = await arm({ times: 3 })
    expect(fault).toMatchObject({
      path,
      channel_id: channel,
      guild_id: guild,
      remaining: 3,
      consumed: 0,
    })
    const before = snapshot(db)
    const events = vi.spyOn(gatewayBus, 'emit')
    for (const prefix of ['/api/v10', '/api', '']) {
      const response = await request(prefix + path, 'DELETE')
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        code: failure.code,
        message: failure.message,
      })
      expect(snapshot(db)).toEqual(before)
    }
    expect(events).not.toHaveBeenCalled()
    expect(await inspect(fault.id)).toMatchObject({ consumed: 3, remaining: 0 })
    const response = await request(path, 'DELETE')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ id: channel })
    expectDeleted(db)
    expect(events.mock.calls.map(([name]) => name)).toEqual([
      'voice.state.update',
      'channel.delete',
    ])
    expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
    const missing = await request(path, 'DELETE')
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({
      message: 'Unknown Channel',
      code: 10_003,
    })
  })

  it('selects exact IDs and method, leaving other guilds and unauthenticated requests alone', async () => {
    seedChannel(db, guild, otherChannel)
    const foreign = seedChannel(db, '222222222222222223', '333333333333333334')
    const fault = await arm()
    for (const auth of ['', 'Bot missing', 'Bearer missing'])
      expect(await status(path, 'DELETE', undefined, auth)).toBe(401)
    expect(await status(path)).toBe(200)
    expect(await status(path, 'PATCH', { name: 'renamed' })).toBe(200)
    for (const id of [otherChannel, foreign])
      expect(await status(`/channels/${id}`, 'DELETE')).toBe(200)
    // Leading-zero aliases are distinct concrete selectors, not numeric coercions.
    expect(await status(`/channels/0${channel}`, 'DELETE')).toBe(404)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 0, remaining: 1 })
    expect(await status(path, 'DELETE')).toBe(403)
  })

  it('retains legacy cross-token mutation behavior and active selector conflicts', async () => {
    const fault = await arm()
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'DELETE',
        path,
        mode: 'disconnect',
      })
    ).toBe(409)
    expect(await status(path, 'DELETE', undefined, otherToken)).toBe(403)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1, remaining: 0 })
    const rearmed = await arm()
    expect(await status(`/_test/rest-faults/${rearmed.id}`, 'DELETE')).toBe(204)
    expect(await status(path, 'DELETE')).toBe(200)
  })

  it('keeps failure consumption outside native transaction rollback', async () => {
    const fault = await arm()
    const before = snapshot(db)
    db.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON channels
      BEGIN SELECT RAISE(ABORT, 'native deletion attempted'); END`)
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    expect(await status(path, 'DELETE')).toBe(403)
    expect(errors).not.toHaveBeenCalled()
    expect(await status(path, 'DELETE')).toBe(500)
    expect(errors).toHaveBeenCalledOnce()
    expect(snapshot(db)).toEqual(before)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1, remaining: 0 })
    db.exec('DROP TRIGGER reject_delete')
    expect(await status(path, 'DELETE')).toBe(200)
  })

  it.each([0, 4])(
    'supports text/category channel type %s without changing native success',
    async (type) => {
      seedChannel(db, guild, otherChannel)
      db.prepare('UPDATE channels SET type = ? WHERE id = ?').run(
        type,
        otherChannel
      )
      const target = `/channels/${otherChannel}`
      const fault = await arm({ path: target })
      const before = snapshot(db)
      expect(await status(target, 'DELETE')).toBe(403)
      expect(snapshot(db)).toEqual(before)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 1,
      })
      const deleted = await request(target, 'DELETE')
      expect(deleted.status).toBe(200)
      await expect(deleted.json()).resolves.toMatchObject({
        id: otherChannel,
        type,
      })
      // Deletion of another channel leaves the occupied voice channel untouched.
      expect(await status(path)).toBe(200)
      expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
    }
  )

  it.each([
    { method: 'GET' },
    { method: 'POST' },
    { method: 'delete' },
    { path: '/channels/{channelID}' },
    { path: '/channels/*' },
    { path: '/channels/abc' },
    { path: `/channels/${'1'.repeat(21)}` },
    { path: path + '/' },
    { path: path + '?x=1' },
    { path: '/api/v10' + path },
    { path: '/api' + path },
    { query: {} },
    { recipient_id: '123' },
    { times: 0 },
    { times: 101 },
    { mode: 'delay', delay_ms: 0 },
    { mode: 'rate_limit', status: 429, retry_after: 0 },
    { mode: 'disconnect', timeout_ms: null },
  ])('rejects invalid selectors or policies: %j', async (overrides) => {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'DELETE',
      path,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      message: '400: Bad Request',
      code: 0,
    })
  })

  it('requires an existing guild channel, excluding private channels', async () => {
    for (const id of ['999', '444444444444444444']) {
      if (id !== '999')
        db.prepare('INSERT INTO channels (id, type) VALUES (?, 1)').run(id)
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'DELETE',
          path: `/channels/${id}`,
          ...failure,
        })
      ).toBe(404)
    }
  })

  it.each([
    'cancel',
    'reset',
    'scoped reset',
    'guild deletion',
    'setup deletion',
  ])(
    'removes active and exhausted evidence on %s and preserves unrelated scopes',
    async (cleanup) => {
      const active = await arm()
      seedChannel(db, guild, otherChannel)
      const exhausted = await arm({ path: `/channels/${otherChannel}` })
      await request(`/channels/${otherChannel}`, 'DELETE')
      const foreign = seedChannel(
        db,
        '222222222222222223',
        '333333333333333334'
      )
      const other = await arm({ path: `/channels/${foreign}` })
      switch (cleanup) {
        case 'cancel': {
          for (const fault of [active, exhausted])
            expect(
              await status(`/_test/rest-faults/${fault.id}`, 'DELETE')
            ).toBe(204)
          break
        }
        case 'reset':
        case 'scoped reset': {
          expect(
            await status(
              '/_test/reset',
              'POST',
              cleanup === 'reset' ? {} : { token }
            )
          ).toBe(204)
          break
        }
        case 'guild deletion': {
          expect(await status(`/guilds/${guild}`, 'DELETE')).toBe(204)
          break
        }
        case 'setup deletion': {
          expect(
            await status(`/_test/setup/${encodeURIComponent(token)}`, 'DELETE')
          ).toBe(204)
          break
        }
      }
      for (const fault of [active, exhausted])
        expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${other.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
      if (cleanup === 'cancel' || cleanup.includes('reset'))
        expect(await status(path, 'DELETE')).toBe(200)
    }
  )

  it('expires unused attempts without mutation and permits rearming', async () => {
    const fault = await arm({ mode: 'disconnect', times: 2, timeout_ms: 1 })
    await expect
      .poll(() => inspect(fault.id))
      .toMatchObject({ state: 'expired', remaining: 0, consumed: 0 })
    const before = snapshot(db)
    const rearmed = await arm()
    expect(await status(path, 'DELETE')).toBe(403)
    expect(snapshot(db)).toEqual(before)
    await request(`/_test/rest-faults/${rearmed.id}`, 'DELETE')
    expect(await status(path, 'DELETE')).toBe(200)
  })
})

describe('channel deletion transport faults over real HTTP and Gateway', () => {
  let server: RealServerContext

  /** Sends actual HTTP requests so disconnect controls can destroy a Node socket. */
  function request(
    route: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ): Promise<Response> {
    return fetch(server.baseUrl + route, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  }

  /** Arms a bounded explicit mode for the exact deletion selector. */
  async function arm(
    mode: string,
    overrides: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'DELETE',
      path,
      mode,
      ...(mode === 'rate_limit' && { retry_after: 0.01 }),
      ...(mode === 'delay' && { delay_ms: 10 }),
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Returns the status of a completed real HTTP request. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Waits on public consumption evidence rather than assuming request arrival. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Records native deletion/disconnect dispatches and provides an ordered fence. */
  async function gateway(): Promise<{
    events: string[]
    barrier: () => Promise<void>
  }> {
    const ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
    const ready = Promise.withResolvers<undefined>()
    let ack = Promise.withResolvers<undefined>()
    const events: string[] = []
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { op: number; t?: string }
      if (frame.op === 10)
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents:
                GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates,
            },
          })
        )
      if (frame.t === 'READY') ready.resolve(undefined)
      else if (frame.t === 'CHANNEL_DELETE' || frame.t === 'VOICE_STATE_UPDATE')
        events.push(frame.t)
      if (frame.op === 11) ack.resolve(undefined)
    })
    await ready.promise
    return {
      events,
      barrier: async () => {
        ack = Promise.withResolvers<undefined>()
        ws.send(JSON.stringify({ op: 1, d: null }))
        await ack.promise
      },
    }
  }

  beforeEach(async () => {
    server = await createRealServer()
    seed(server.db)
  })

  afterEach(async () => {
    await server.close()
  })

  it.each(['rate_limit', 'delay', 'disconnect'])(
    'fails %s attempts without state changes or Gateway events and retries natively',
    async (mode) => {
      const client = await gateway()
      const before = snapshot(server.db)
      const fault = await arm(mode, { times: 3 })
      for (const prefix of ['/api/v10', '/api', '']) {
        const pending = request(prefix + path, 'DELETE')
        if (mode === 'disconnect') await expect(pending).rejects.toThrow()
        else {
          const response = await pending
          expect(response.status).toBe(mode === 'rate_limit' ? 429 : 504)
          if (mode === 'rate_limit') {
            expect(response.headers.get('Retry-After')).toBe('1')
            await expect(response.json()).resolves.toMatchObject({
              retry_after: 0.01,
              global: false,
            })
          }
        }
        expect(snapshot(server.db)).toEqual(before)
        await client.barrier()
        expect(client.events).toEqual([])
      }
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 3,
        remaining: 0,
        state: 'exhausted',
        outcomes: {
          pending: 0,
          responded: mode === 'disconnect' ? 0 : 3,
          disconnected: mode === 'disconnect' ? 3 : 0,
        },
      })
      expect(await status(path, 'DELETE')).toBe(200)
      await client.barrier()
      expect(client.events).toEqual(['VOICE_STATE_UPDATE', 'CHANNEL_DELETE'])
      expectDeleted(server.db)
      expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
    }
  )

  it.each(['other bot', 'Bearer'])(
    'does not consume an explicit control for %s callers',
    async (caller) => {
      const fault = await arm('disconnect')
      const auth =
        caller === 'other bot'
          ? otherToken
          : `Bearer ${seedBearerCredential(server.db).bearerToken}`
      expect(await status(path, 'GET', undefined, auth)).toBe(200)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 1,
        consumed: 0,
      })
      expect(await status(path, 'DELETE', undefined, auth)).toBe(200)
      expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
    }
  )

  it.each(['cancel', 'expire', 'native deletion'])(
    'never resumes a delayed deletion after %s, including self-pruning on native success',
    async (cleanup) => {
      const client = await gateway()
      const before = snapshot(server.db)
      const fault = await arm('delay', {
        delay_ms: 60_000,
        timeout_ms: cleanup === 'expire' ? 1000 : 60_000,
      })
      const pending = request(path, 'DELETE')
      if (cleanup !== 'expire')
        await expect
          .poll(() => inspect(fault.id))
          .toMatchObject({ consumed: 1, outcomes: { pending: 1 } })
      if (cleanup === 'cancel')
        expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(
          204
        )
      else if (cleanup === 'native deletion')
        expect(await status(path, 'DELETE')).toBe(200)
      const response = await pending
      expect(response.status).toBe(504)
      await client.barrier()
      if (cleanup === 'native deletion') {
        expect(client.events).toEqual(['VOICE_STATE_UPDATE', 'CHANNEL_DELETE'])
        expectDeleted(server.db)
      } else {
        expect(snapshot(server.db)).toEqual(before)
        expect(client.events).toEqual([])
        if (cleanup === 'expire')
          expect(await inspect(fault.id)).toMatchObject({
            state: 'expired',
            consumed: 1,
            outcomes: { pending: 0, delayed: 1, cancelled: 1, responded: 0 },
          })
        expect(await status(path, 'DELETE')).toBe(200)
      }
      expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
    }
  )
})
