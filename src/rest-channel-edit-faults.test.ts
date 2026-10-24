import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { buildApp } from './app'
import { initializeDatabase } from './db'
import { gatewayBus } from './gateway/bus'
import { GatewayOp } from './gateway/opcodes'
import {
  createRealServer,
  seedBot,
  seedChannel,
  seedGuild,
} from './test-helpers'
import type { RestFault } from './services/rest-faults'

const token = 'Bot channel-owner'
const otherToken = 'Bot channel-other'
const channel = '1513052391153471489'
const route = `/channels/${channel}`
const originalParent = '333333333333333338'
const foreignParent = '333333333333333337'
const failure = { status: 403, code: 50_013, message: 'Missing Permissions' }
const edit = {
  name: 'updated-shop',
  parent_id: '333333333333333339',
  topic: 'updated topic',
  nsfw: true,
  position: 7,
  rate_limit_per_user: 20,
}

describe('exact guild channel-edit REST faults', () => {
  let db: ReturnType<typeof initializeDatabase>
  let server: ReturnType<typeof buildApp>
  let guild: string
  let otherGuild: string
  const updates = vi.fn()

  /** Sends requests through production assembly, authentication and routes. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ): Promise<Response> {
    return server.app.request(path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Returns the response status after the selected route finishes. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Arms the existing control API for an exact channel edit. */
  async function arm(
    overrides: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'PATCH',
      path: route,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Reads independent control evidence without touching the native channel. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Snapshots every persisted channel field, including parent and settings. */
  function snapshot(): unknown {
    return db.prepare('SELECT * FROM channels WHERE id = ?').get(channel)
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    server = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, token, '100000000000000001')
    seedBot(db, otherToken, '100000000000000002')
    guild = seedGuild(db, token)
    otherGuild = seedGuild(db, otherToken, '222222222222222223')
    seedChannel(db, guild, channel)
    seedChannel(db, guild, edit.parent_id)
    seedChannel(db, guild, originalParent)
    seedChannel(db, otherGuild, foreignParent)
    for (const id of [edit.parent_id, originalParent, foreignParent])
      db.prepare('UPDATE channels SET type = 4 WHERE id = ?').run(id)
    db.prepare(
      'UPDATE channels SET topic = ?, parent_id = ?, position = 2, rate_limit_per_user = 3 WHERE id = ?'
    ).run('original topic', originalParent, channel)
    updates.mockClear()
    gatewayBus.on('channel.update', updates)
  })

  afterEach(() => {
    gatewayBus.off('channel.update', updates)
    server.shutdownRestFaults()
    server.unsubscribeGateway()
    server.wss.close()
    db.close()
  })

  it.each([
    failure,
    { status: 404, code: 10_003, message: 'Unknown Channel' },
    { status: 500, code: 0, message: 'Internal Server Error' },
  ])(
    'fails with $status across all prefixes before mutation or dispatch',
    async (error) => {
      const before = snapshot()
      const fault = await arm({ ...error, times: 3 })
      expect(fault).toMatchObject({
        path: route,
        guild_id: guild,
        channel_id: channel,
        remaining: 3,
        consumed: 0,
      })
      for (const prefix of ['/api/v10', '/api', '']) {
        const response = await request(prefix + route, 'PATCH', edit)
        expect(response.status).toBe(error.status)
        await expect(response.json()).resolves.toEqual({
          code: error.code,
          message: error.message,
        })
        expect(snapshot()).toEqual(before)
        expect(updates).not.toHaveBeenCalled()
      }
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
      expect(await status(route, 'PATCH', edit)).toBe(200)
      expect(snapshot()).toMatchObject({ ...edit, nsfw: 1 })
      expect(updates).toHaveBeenCalledExactlyOnceWith({
        channel: expect.objectContaining(edit),
      })
    }
  )

  it('isolates exact method, path, guild and registered owner token', async () => {
    const fault = await arm({ times: 2 })
    const sibling = seedChannel(db, guild, '1513052391153471490')
    const foreign = seedChannel(db, otherGuild, '1513052391153471491')
    expect(await status(route)).toBe(200)
    expect(await status(route, 'POST', edit)).toBe(404)
    for (const [target, parent] of [
      [sibling, edit.parent_id],
      [foreign, foreignParent],
    ]) {
      expect(
        await status(`/channels/${target}`, 'PATCH', {
          ...edit,
          parent_id: parent,
        })
      ).toBe(200)
      expect(
        db.prepare('SELECT parent_id FROM channels WHERE id = ?').get(target)
      ).toEqual({ parent_id: parent })
    }
    expect(await status(route, 'PATCH', edit, otherToken)).toBe(200)
    expect(snapshot()).toMatchObject({ parent_id: edit.parent_id })
    expect(await status(route, 'PATCH', edit, 'Bot unregistered')).toBe(401)
    expect(await status(route, 'PATCH', edit, '')).toBe(401)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 2, consumed: 0 })
    updates.mockClear()
    const before = snapshot()
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(route, 'PATCH', { name: 'retry' })
      )
    )
    expect(
      responses.map((response) => response.status).toSorted((a, b) => a - b)
    ).toEqual([200, 403, 403])
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 2 })
    expect(snapshot()).toMatchObject({
      ...(before as Record<string, unknown>),
      name: 'retry',
    })
    expect(updates).toHaveBeenCalledTimes(1)
  })

  it('keeps channel edits independent from channel deletion, message edits and guild channel creation', async () => {
    const selectors = [
      { method: 'PATCH', path: route },
      { method: 'DELETE', path: route },
      { method: 'PATCH', path: `${route}/messages/1513052391153471499` },
      { method: 'POST', path: `/guilds/${guild}/channels`, guild_id: guild },
    ]
    const faults: RestFault[] = []
    for (const selector of selectors)
      faults.push(await arm({ ...selector, times: 2 }))
    const before = snapshot()
    for (const [index, selector] of selectors.entries()) {
      expect(await status(selector.path, selector.method, edit)).toBe(403)
      for (const [faultIndex, fault] of faults.entries())
        expect(await inspect(fault.id)).toMatchObject({
          remaining: faultIndex <= index ? 1 : 2,
          consumed: faultIndex <= index ? 1 : 0,
        })
    }
    expect(snapshot()).toEqual(before)
    expect(updates).not.toHaveBeenCalled()
    // Earlier mode-omitted mutation selectors retain their nonowner behavior.
    for (const selector of selectors.slice(1, 3))
      expect(
        await status(selector.path, selector.method, edit, otherToken)
      ).toBe(403)
    expect(await status(route, 'PATCH', { name: 'nonowner' }, otherToken)).toBe(
      200
    )
    expect(
      await status(
        `/guilds/${guild}/channels`,
        'POST',
        { name: 'native' },
        otherToken
      )
    ).toBe(201)
    for (const [index, fault] of faults.entries())
      expect(await inspect(fault.id)).toMatchObject({
        remaining: index === 1 || index === 2 ? 0 : 1,
        consumed: index === 1 || index === 2 ? 2 : 1,
      })
    for (const index of [0, 3]) {
      const selector = selectors[index]
      expect(await status(selector.path, selector.method, edit)).toBe(403)
      expect(await inspect(faults[index].id)).toMatchObject({
        remaining: 0,
        consumed: 2,
      })
    }
  })

  it.each([0, 2, 4, 13])(
    'supports existing guild channel type %i',
    async (type) => {
      db.prepare(
        'UPDATE channels SET type = ?, parent_id = ? WHERE id = ?'
      ).run(type, type === 4 ? null : originalParent, channel)
      const before = snapshot()
      await arm()
      expect(await status(route, 'PATCH', edit)).toBe(403)
      expect(snapshot()).toEqual(before)
      expect(updates).not.toHaveBeenCalled()
      expect(await status(route, 'PATCH', { name: 'native-success' })).toBe(200)
      expect(updates).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps leading zeros and large numeric IDs exact instead of normalizing them', async () => {
    const padded = `0${channel}`
    seedChannel(db, guild, padded)
    const fault = await arm({ path: `/channels/${padded}` })
    expect(fault).toMatchObject({
      path: `/channels/${padded}`,
      channel_id: padded,
    })
    expect(await status(route, 'PATCH', edit)).toBe(200)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 0 })
    expect(await status(`/channels/${padded}`, 'PATCH', edit)).toBe(403)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1 })
  })

  it('conflicts while active, retains evidence and allows rearming or removal', async () => {
    const fault = await arm()
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'PATCH',
        path: route,
        mode: 'disconnect',
      })
    ).toBe(409)
    expect(await status(route, 'PATCH', {})).toBe(403)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 1 })
    const replacement = await arm()
    expect(await status(`/_test/rest-faults/${replacement.id}`, 'DELETE')).toBe(
      204
    )
    expect(await status(`/_test/rest-faults/${replacement.id}`)).toBe(404)
    expect(await status(route, 'PATCH', edit)).toBe(200)
    expect(await inspect(fault.id)).toMatchObject({ remaining: 0, consumed: 1 })
  })

  it.each([
    { path: '/channels/{channelID}' },
    { path: '/channels/*' },
    { path: '/channels/abc' },
    { path: `/channels/${'1'.repeat(21)}` },
    { path: `/api/v10${route}` },
    { path: `${route}/` },
    { path: `${route}?name=shop` },
    { method: 'patch' },
    { method: 'PUT' },
    { method: 'GET' },
    { query: {} },
    { recipient_id: '123' },
    { guild_id: '222222222222222222' },
    { guild_id: null },
    { times: 0 },
    { times: 101 },
    { status: 200 },
    { mode: 'rate_limit', retry_after: 0 },
    { mode: 'delay', delay_ms: 0 },
    { mode: 'disconnect', timeout_ms: 0 },
  ])(
    'rejects malformed or unsupported selector configuration: %j',
    async (overrides) => {
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'PATCH',
          path: route,
          ...failure,
          ...overrides,
        })
      ).toBe(400)
    }
  )

  it.each([1, 3, 10, 11, 12])(
    'rejects private/thread channel type %i without affecting native edits',
    async (type) => {
      const privateChannel = type === 1 || type === 3
      const origin = privateChannel
        ? null
        : seedChannel(db, guild, '1513052391153471492')
      if (type === 10)
        db.prepare('UPDATE channels SET type = 5 WHERE id = ?').run(origin)
      db.prepare(
        'UPDATE channels SET type = ?, guild_id = ?, parent_id = ? WHERE id = ?'
      ).run(type, privateChannel ? null : guild, origin, channel)
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'PATCH',
          path: route,
          ...failure,
        })
      ).toBe(404)
      expect(await status(route, 'PATCH', { name: 'native' })).toBe(200)
    }
  )

  it('rejects missing channels', async () => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'PATCH',
        path: '/channels/999',
        ...failure,
      })
    ).toBe(404)
  })

  it.each(['legacy', 'rate_limit', 'delay'])(
    'preserves nonowner and Bearer native behavior for %s controls',
    async (mode) => {
      const fault = await arm(
        mode === 'legacy'
          ? {}
          : {
              mode,
              status: mode === 'rate_limit' ? 429 : 503,
              ...(mode === 'rate_limit'
                ? { retry_after: 0.01 }
                : { delay_ms: 10 }),
            }
      )
      const native = buildApp(db, {
        baseUrl: 'http://localhost',
        disableAuth: true,
      })
      try {
        const response = await native.app.request(route, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer unrelated' },
          body: JSON.stringify({ name: 'bearer-edit' }),
        })
        expect(response.status).toBe(200)
      } finally {
        native.unsubscribeGateway()
        native.wss.close()
      }
      expect(await status(route, 'PATCH', edit, otherToken)).toBe(200)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 1,
        consumed: 0,
      })
    }
  )

  it.each(['legacy', 'delay'])(
    'invalidates %s ownership when a channel moves to another guild',
    async (mode) => {
      const fault = await arm(mode === 'legacy' ? {} : { mode, delay_ms: 10 })
      db.prepare('UPDATE channels SET guild_id = ? WHERE id = ?').run(
        otherGuild,
        channel
      )
      const movedEdit = { ...edit, parent_id: foreignParent }
      expect(await status(route, 'PATCH', movedEdit)).toBe(200)
      expect(snapshot()).toMatchObject({
        parent_id: foreignParent,
        guild_id: otherGuild,
      })
      expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      const replacement = await arm()
      expect(replacement.guild_id).toBe(otherGuild)
      expect(await status(route, 'PATCH', movedEdit, otherToken)).toBe(403)
      expect(snapshot()).toMatchObject({
        parent_id: foreignParent,
        guild_id: otherGuild,
      })
    }
  )

  it('invalidates controls when guild ownership is reassigned', async () => {
    const fault = await arm()
    db.prepare('UPDATE guilds SET bot_token = ? WHERE id = ?').run(
      otherToken,
      guild
    )
    expect(await status(route, 'PATCH', edit, otherToken)).toBe(200)
    expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
  })

  it.each([
    'cancel',
    'reset',
    'scoped reset',
    'setup deletion',
    'guild deletion',
    'channel deletion',
  ])(
    'removes active and exhausted controls through %s cleanup',
    async (cleanup) => {
      const exhausted = await arm()
      expect(await status(route, 'PATCH', edit)).toBe(403)
      const active = await arm({ mode: 'delay', delay_ms: 10 })
      const foreign = seedChannel(db, otherGuild, '1513052391153471491')
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
        case 'setup deletion': {
          expect(
            await status(`/_test/setup/${encodeURIComponent(token)}`, 'DELETE')
          ).toBe(204)
          break
        }
        case 'guild deletion': {
          expect(await status(`/guilds/${guild}`, 'DELETE')).toBe(204)
          break
        }
        case 'channel deletion': {
          expect(await status(route, 'DELETE')).toBe(200)
          break
        }
      }
      for (const fault of [active, exhausted])
        expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${other.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
      expect(updates).not.toHaveBeenCalled()
    }
  )

  it.each(['cancel', 'expiry', 'shutdown'])(
    'never resumes a delayed native mutation after %s',
    async (action) => {
      const before = snapshot()
      const fault = await arm({
        mode: 'delay',
        delay_ms: 60_000,
        timeout_ms: action === 'expiry' ? 1000 : 60_000,
        times: 2,
      })
      const pending = request(route, 'PATCH', edit)
      await expect
        .poll(() => inspect(fault.id))
        .toMatchObject({ outcomes: { pending: 1 } })
      if (action === 'cancel')
        expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(
          204
        )
      else if (action === 'shutdown') server.shutdownRestFaults()
      const response = await pending
      expect(response.status).toBe(403)
      expect(snapshot()).toEqual(before)
      expect(updates).not.toHaveBeenCalled()
      if (action !== 'cancel')
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 0,
          consumed: 1,
          outcomes: { pending: 0, delayed: 1, cancelled: 1, responded: 0 },
          ...(action === 'expiry' && { state: 'expired' }),
        })
      if (action !== 'shutdown')
        expect(await status(route, 'PATCH', edit)).toBe(200)
    }
  )

  it('expires unused attempts without consuming a request', async () => {
    const fault = await arm({ mode: 'disconnect', timeout_ms: 1 })
    await expect
      .poll(() => inspect(fault.id))
      .toMatchObject({ state: 'expired' })
    expect(await status(route, 'PATCH', edit)).toBe(200)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 0, remaining: 0 })
    await arm()
  })

  it('intercepts before native body validation and keeps two-field legacy 429 errors', async () => {
    const fault = await arm({ status: 429 })
    const response = await request(route, 'PATCH', { name: '' })
    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({
      code: failure.code,
      message: failure.message,
    })
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1 })
    expect(updates).not.toHaveBeenCalled()
    expect(await status(route, 'PATCH', { name: '' })).toBe(400)
  })

  it('preserves native success, validation and unknown-channel responses without an active fault', async () => {
    expect(await status(route, 'PATCH', edit)).toBe(200)
    expect(await status(route, 'PATCH', { name: '' })).toBe(400)
    expect(await status('/channels/999', 'PATCH', edit)).toBe(404)
    expect(updates).toHaveBeenCalledTimes(1)
  })
})

/** Queues Gateway frames to prove absent dispatches with a heartbeat barrier. */
function createReader(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const frames: Record<string, unknown>[] = []
  const waiters: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else frames.push(frame)
  })
  return () =>
    new Promise((resolve) => {
      const frame = frames.shift()
      if (frame) resolve(frame)
      else waiters.push(resolve)
    })
}

describe('real HTTP channel-edit transport faults', () => {
  it.each(
    ['rate_limit', 'delay', 'disconnect'].flatMap((mode) =>
      ['/api/v10', '/api', ''].map((prefix) => ({ mode, prefix }))
    )
  )(
    '$mode on $prefix preserves state and emits no CHANNEL_UPDATE until retry',
    async ({ mode, prefix }) => {
      const server = await createRealServer()
      let ws: WebSocket | undefined
      try {
        seedBot(server.db, token)
        const guild = seedGuild(server.db, token)
        seedChannel(server.db, guild, channel)
        for (const parent of [originalParent, edit.parent_id]) {
          seedChannel(server.db, guild, parent)
          server.db
            .prepare('UPDATE channels SET type = 4 WHERE id = ?')
            .run(parent)
        }
        server.db
          .prepare(
            'UPDATE channels SET type = 2, bitrate = 64000, user_limit = 2, rtc_region = ?, video_quality_mode = 1, parent_id = ? WHERE id = ?'
          )
          .run('us-east', originalParent, channel)
        ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
        const next = createReader(ws)
        expect(await next()).toMatchObject({ op: GatewayOp.Hello })
        ws.send(
          JSON.stringify({
            op: GatewayOp.Identify,
            d: { token, intents: GatewayIntentBits.Guilds },
          })
        )
        expect(await next()).toMatchObject({ t: 'READY' })
        expect(await next()).toMatchObject({ t: 'GUILD_CREATE' })
        /** Sends a bounded real HTTP request through buildApp. */
        const request = (path: string, method = 'GET', body?: unknown) =>
          fetch(server.baseUrl + path, {
            method,
            headers: {
              Authorization: token,
              'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(3000),
          })
        const armed = await request('/_test/rest-faults', 'POST', {
          method: 'PATCH',
          path: route,
          mode,
          times: 1,
          ...(mode === 'rate_limit' && { retry_after: 0.01, global: true }),
          ...(mode === 'delay' && { delay_ms: 10 }),
        })
        expect(armed.status).toBe(201)
        const fault = (await armed.json()) as RestFault
        const before = server.db
          .prepare('SELECT * FROM channels WHERE id = ?')
          .get(channel)
        const payload = {
          ...edit,
          bitrate: 80_000,
          user_limit: 5,
          rtc_region: null,
          video_quality_mode: 2,
        }
        const pending = request(prefix + route, 'PATCH', payload)
        if (mode === 'disconnect') await expect(pending).rejects.toThrow()
        else {
          const response = await pending
          expect(response.status).toBe(mode === 'rate_limit' ? 429 : 504)
          if (mode === 'rate_limit') {
            expect(response.headers.get('Retry-After')).toBe('1')
            expect(response.headers.get('X-RateLimit-Global')).toBe('true')
            await expect(response.json()).resolves.toEqual({
              message: 'You are being rate limited.',
              retry_after: 0.01,
              global: true,
            })
          }
        }
        expect(
          server.db.prepare('SELECT * FROM channels WHERE id = ?').get(channel)
        ).toEqual(before)
        ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
        expect(await next()).toMatchObject({ op: GatewayOp.HeartbeatAck })
        const evidence = await request(`/_test/rest-faults/${fault.id}`)
        await expect(evidence.json()).resolves.toMatchObject({
          remaining: 0,
          consumed: 1,
          state: 'exhausted',
          outcomes: {
            pending: 0,
            cancelled: 0,
            delayed: mode === 'delay' ? 1 : 0,
            disconnected: mode === 'disconnect' ? 1 : 0,
            responded: mode === 'disconnect' ? 0 : 1,
          },
        })
        const success = await request(prefix + route, 'PATCH', payload)
        expect(success.status).toBe(200)
        await expect(success.json()).resolves.toMatchObject(payload)
        expect(
          server.db.prepare('SELECT * FROM channels WHERE id = ?').get(channel)
        ).toMatchObject({ ...payload, nsfw: 1 })
        expect(await next()).toMatchObject({
          t: 'CHANNEL_UPDATE',
          d: payload,
        })
      } finally {
        ws?.terminate()
        await server.close()
      }
    }
  )
})
