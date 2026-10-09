import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { fork } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { Hono } from 'hono'
import { createAuthMiddleware, type AppEnv } from './middleware/auth'
import { createRestFaultMiddleware } from './middleware/rest-faults'
import { GatewayOp } from './gateway/opcodes'
import {
  createRealServer,
  seedBot,
  seedGuild,
  seedChannel,
  type RealServerContext,
} from './test-helpers'
import type { RestFault } from './services/rest-faults'

const TOKEN = 'Bot transport'
const OTHER = 'Bot other'
let server: RealServerContext
let guild: string
let channel: string
let path: string
let uploadPath: string

/** Sends bounded real HTTP requests, including while a selected route is delayed. */
function request(route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('Authorization')) headers.set('Authorization', TOKEN)
  return fetch(server.baseUrl + route, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(3000),
  })
}

/** Awaits a result before reading a field. */
async function select<T, R>(
  promise: Promise<T>,
  project: (value: T) => R
): Promise<R> {
  return project(await promise)
}

/** Sends a message through the ordinary assembled route. */
function send(init: RequestInit = {}): Promise<Response> {
  return request(path, {
    method: 'POST',
    body: JSON.stringify({ content: 'nickname log' }),
    ...init,
  })
}

/** Arms an existing scoped REST control with an explicit failure mode. */
async function arm(
  mode: 'rate_limit' | 'delay' | 'disconnect',
  overrides: Record<string, unknown> = {}
): Promise<RestFault> {
  const response = await request('/_test/rest-faults', {
    method: 'POST',
    body: JSON.stringify({
      method: 'POST',
      path,
      mode,
      ...(mode === 'rate_limit' && { retry_after: 0.02 }),
      ...(mode === 'delay' && { delay_ms: 500 }),
      ...overrides,
    }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<RestFault>
}

/** Reads observable counters rather than guessing whether a request arrived. */
async function status(id: string): Promise<RestFault> {
  const response = await request(`/_test/rest-faults/${id}`)
  expect(response.status).toBe(200)
  return response.json() as Promise<RestFault>
}

/** Waits for an explicit outcome with a bounded polling deadline. */
async function waitFor(
  id: string,
  expected: Partial<Omit<RestFault, 'outcomes'>> & {
    outcomes?: Partial<NonNullable<RestFault['outcomes']>>
  }
): Promise<void> {
  await expect.poll(() => status(id), { timeout: 2000 }).toMatchObject(expected)
}

/** Real isolated HTTP process serving the same persisted SQLite file. */
interface HttpWorker {
  baseUrl: string
  stop: (crash?: boolean) => Promise<void>
}

/** Starts a real Node HTTP app; IPC is only for startup and process cleanup. */
async function httpWorker(): Promise<HttpWorker> {
  const script = nodePath.join(uploadPath, 'http-worker.mjs')
  /** Resolves worktree-local modules for the isolated HTTP fixture. */
  const moduleUrl = (file: string) =>
    pathToFileURL(nodePath.resolve('src', file)).href
  await writeFile(
    script,
    `
    import { initializeDatabase } from ${JSON.stringify(moduleUrl('db.ts'))}
    import { buildApp } from ${JSON.stringify(moduleUrl('app.ts'))}
    import { serveWithGateway } from ${JSON.stringify(moduleUrl('http-server.ts'))}
    const db = initializeDatabase(process.argv[2])
    const built = buildApp(db, { baseUrl: 'http://127.0.0.1', disableAuth: false, uploadPath: process.argv[3] })
    const server = serveWithGateway({ fetch: built.app.fetch, port: 0, hostname: '127.0.0.1', wss: built.wss },
      (info) => process.send({ baseUrl: 'http://127.0.0.1:' + info.port }))
    process.on('message', () => {
      built.shutdownRestFaults()
      built.shutdownRestPageHolds()
      built.unsubscribeGateway()
      for (const socket of built.wss.clients) socket.terminate()
      server.close(() => { db.close(); process.disconnect() })
    })
  `
  )
  const child = fork(
    script,
    [
      nodePath.join(uploadPath, 'shared.db'),
      nodePath.join(uploadPath, 'worker-uploads'),
    ],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }
  )
  let errors = ''
  child.stderr?.on('data', (data: Buffer) => {
    errors += data.toString()
  })
  const exited = Promise.withResolvers<undefined>()
  const ready = Promise.withResolvers<string>()
  child.once('error', ready.reject)
  child.once('exit', () => {
    exited.resolve(undefined)
    ready.reject(new Error(`HTTP worker exited before startup: ${errors}`))
  })
  child.once('message', (message: unknown) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('baseUrl' in message) ||
      typeof message.baseUrl !== 'string'
    )
      ready.reject(new Error('Invalid HTTP worker startup'))
    else ready.resolve(message.baseUrl)
  })
  /** Stops this test-owned process and waits for its sockets/timers to disappear. */
  async function stop(crash = false): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (crash || !child.connected) child.kill('SIGKILL')
    else child.send('close')
    await exited.promise
  }
  try {
    return { baseUrl: await ready.promise, stop }
  } catch (error) {
    await stop(true)
    throw error
  }
}

/** Configures one test-owned persisted HTTP worker through the public API. */
async function prepareWorker(
  worker: HttpWorker,
  times = 2
): Promise<RestFault> {
  const setup = await fetch(worker.baseUrl + '/_test/setup', {
    method: 'POST',
    body: JSON.stringify({
      token: TOKEN,
      guilds: [
        {
          id: guild,
          name: 'Shared process',
          channels: [{ id: channel, name: 'Log' }],
        },
      ],
    }),
  })
  expect(setup.status).toBe(201)
  const armed = await fetch(worker.baseUrl + '/_test/rest-faults', {
    method: 'POST',
    body: JSON.stringify({
      method: 'POST',
      path,
      mode: 'delay',
      delay_ms: 60_000,
      timeout_ms: 60_000,
      times,
    }),
  })
  expect(armed.status).toBe(201)
  return armed.json() as Promise<RestFault>
}

/** Waits on real HTTP arrival evidence in a separate process. */
async function workerArrival(
  worker: HttpWorker,
  id: string,
  count = 1,
  timeoutMs = 2000
): Promise<void> {
  let observed: unknown
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    await expect
      .poll(
        async () => {
          const response = await fetch(
            worker.baseUrl + `/_test/rest-faults/${id}`,
            { signal }
          )
          observed = await response.json()
          return observed
        },
        { timeout: timeoutMs }
      )
      .toMatchObject({ consumed: count, outcomes: { pending: count } })
  } catch (error) {
    throw new Error(
      `Awaiting ${count} live attempts for ${id}; last observed: ${JSON.stringify(observed)}`,
      { cause: error }
    )
  }
}

/** Identifies a real Gateway session and exposes ordered heartbeat barriers. */
async function gateway(): Promise<{
  events: unknown[]
  barrier: () => Promise<void>
}> {
  const ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
  const ready = Promise.withResolvers<undefined>()
  const events: unknown[] = []
  let ack = Promise.withResolvers<undefined>()
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as { op: number; t?: string }
    if (frame.op === GatewayOp.Hello)
      ws.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: { token: TOKEN, intents: GatewayIntentBits.GuildMessages },
        })
      )
    else if (frame.t === 'READY') ready.resolve(undefined)
    if (frame.t === 'MESSAGE_CREATE') events.push(frame)
    if (frame.op === GatewayOp.HeartbeatAck) ack.resolve(undefined)
  })
  await ready.promise
  return {
    events,
    barrier: async () => {
      ack = Promise.withResolvers<undefined>()
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      await ack.promise
    },
  }
}

beforeEach(async () => {
  uploadPath = await mkdtemp(nodePath.join(tmpdir(), 'fauxcord-transport-'))
  server = await createRealServer({ uploadPath })
  seedBot(server.db, TOKEN)
  guild = seedGuild(server.db, TOKEN)
  channel = seedChannel(server.db, guild)
  path = `/channels/${channel}/messages`
})

afterEach(async () => {
  await server.close()
})

describe('bounded REST transport control contracts over real HTTP', () => {
  it('recovers all 256 slots on an already-open surviving process after a crash', async () => {
    const first = await httpWorker()
    let second: HttpWorker | undefined
    const attempts: Promise<number | string>[] = []
    try {
      const faults: RestFault[] = [await prepareWorker(first, 100)]
      const setupDeadline = Date.now() + 10_000
      // Outlives the whole 20-second test, not just each arrival barrier.
      const signal = AbortSignal.timeout(30_000)
      for (let group = 0; group < 3; group++) {
        const count = group === 2 ? 56 : 100
        if (group > 0) {
          const armed = await fetch(first.baseUrl + '/_test/rest-faults', {
            method: 'POST',
            body: JSON.stringify({
              method: 'POST',
              path,
              mode: 'delay',
              delay_ms: 60_000,
              timeout_ms: 60_000,
              times: count,
            }),
          })
          expect(armed.status).toBe(201)
          faults.push((await armed.json()) as RestFault)
        }
        for (let i = 0; i < count; i++) {
          attempts.push(
            fetch(first.baseUrl + path, {
              method: 'POST',
              headers: { Authorization: TOKEN },
              body: '{}',
              signal,
            }).then(
              (response) => response.status,
              () => 'disconnected'
            )
          )
          // Fill every slot without queueing 100 new sockets ahead of the
          // observation request on shared CI runners. All waits remain live.
          if ((i + 1) % 10 !== 0 && i !== count - 1) continue
          const budget = setupDeadline - Date.now()
          expect(
            budget,
            'Saturation setup exceeded its 10-second budget'
          ).toBeGreaterThan(0)
          await workerArrival(
            first,
            faults[group].id,
            i + 1,
            Math.min(2000, budget)
          )
        }
      }
      second = await httpWorker()
      for (const fault of faults) {
        const live = await fetch(
          second.baseUrl + `/_test/rest-faults/${fault.id}`
        )
        await expect(live.json()).resolves.toMatchObject({
          consumed: fault.times,
          outcomes: {
            pending: fault.times,
            cancelled: 0,
            disconnected: 0,
            responded: 0,
          },
        })
      }
      await first.stop(true)
      expect(await Promise.all(attempts)).toEqual(
        Array.from({ length: 256 }, () => 'disconnected')
      )
      // Inspect through the process that was already running before the crash.
      for (const fault of faults) {
        const recovered = await fetch(
          second.baseUrl + `/_test/rest-faults/${fault.id}`
        )
        await expect(recovered.json()).resolves.toMatchObject({
          state: 'exhausted',
          consumed: fault.times,
          outcomes: { pending: 0, cancelled: fault.times, responded: 0 },
        })
      }
      const replacement = await fetch(second.baseUrl + '/_test/rest-faults', {
        method: 'POST',
        body: JSON.stringify({
          method: 'POST',
          path,
          mode: 'delay',
          delay_ms: 30,
        }),
      })
      expect(replacement.status).toBe(201)
      const control = (await replacement.json()) as RestFault
      const response = await fetch(second.baseUrl + path, {
        method: 'POST',
        headers: { Authorization: TOKEN },
        body: '{}',
      })
      expect(response.status).toBe(504)
      const evidence = await fetch(
        second.baseUrl + `/_test/rest-faults/${control.id}`
      )
      await expect(evidence.json()).resolves.toMatchObject({
        outcomes: { pending: 0, delayed: 1, responded: 1, cancelled: 0 },
      })
      const messages = await fetch(
        second.baseUrl + `/_test/messages/${channel}`
      )
      await expect(messages.json()).resolves.toEqual({ messages: [] })
    } finally {
      await first.stop(true)
      await Promise.all(attempts)
      await second?.stop()
    }
  }, 20_000)

  it('reports the documented disconnect fallback for an in-process request', async () => {
    const fault = await arm('disconnect')
    const app = new Hono<AppEnv>()
    app.use('*', createAuthMiddleware(server.db, false))
    app.use('*', createRestFaultMiddleware(server.db))
    app.post(path, (c) => c.text('Unexpected native handler'))
    const response = await app.request(path, {
      method: 'POST',
      headers: { Authorization: TOKEN },
      body: '{}',
    })
    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toEqual({
      code: 0,
      message: 'Disconnect faults require a real Node HTTP server',
    })
    expect(await status(fault.id)).toMatchObject({
      consumed: 1,
      remaining: 0,
      outcomes: { cancelled: 1, disconnected: 0, pending: 0 },
    })
    expect(server.db.prepare('SELECT * FROM messages').all()).toEqual([])
  })

  it.each([
    'cancel',
    'reset',
    'scoped reset',
    'guild deletion',
    'channel deletion',
    'teardown',
  ])(
    'releases a real delay after %s through another process without a request to its owner',
    async (action) => {
      const first = await httpWorker()
      let second: HttpWorker | undefined
      try {
        const fault = await prepareWorker(first)
        const pending = fetch(first.baseUrl + path, {
          method: 'POST',
          headers: { Authorization: TOKEN },
          body: '{}',
          signal: AbortSignal.timeout(3000),
        })
        await workerArrival(first, fault.id)
        second = await httpWorker()
        const observation = await fetch(
          second.baseUrl + `/_test/rest-faults/${fault.id}`
        )
        await expect(observation.json()).resolves.toMatchObject({
          consumed: 1,
          outcomes: { pending: 1, cancelled: 0 },
        })
        const target =
          action === 'cancel'
            ? `/_test/rest-faults/${fault.id}`
            : action.includes('reset')
              ? '/_test/reset'
              : action === 'guild deletion'
                ? `/guilds/${guild}`
                : action === 'channel deletion'
                  ? `/channels/${channel}`
                  : `/_test/setup/${encodeURIComponent(TOKEN)}`
        const start = performance.now()
        const removed = await fetch(second.baseUrl + target, {
          method: action.includes('reset') ? 'POST' : 'DELETE',
          headers: { Authorization: TOKEN },
          body: action.includes('reset')
            ? JSON.stringify(action === 'scoped reset' ? { token: TOKEN } : {})
            : undefined,
        })
        expect(removed.status).toBeLessThan(300)
        // No request to first between invalidation and this awaited response.
        expect(await select(pending, (res) => res.status)).toBe(504)
        expect(performance.now() - start).toBeLessThan(2000)
        expect(
          await select(
            fetch(second.baseUrl + `/_test/rest-faults/${fault.id}`),
            (res) => res.status
          )
        ).toBe(404)
        if (['cancel', 'reset', 'scoped reset'].includes(action)) {
          const recovered = await fetch(first.baseUrl + path, {
            method: 'POST',
            headers: { Authorization: TOKEN },
            body: JSON.stringify({ content: 'recovered' }),
          })
          expect(recovered.status).toBe(200)
          const messages = await fetch(
            second.baseUrl + `/_test/messages/${channel}`
          )
          await expect(messages.json()).resolves.toMatchObject({
            messages: [expect.objectContaining({ content: 'recovered' })],
          })
        }
      } finally {
        await second?.stop()
        await first.stop()
      }
    },
    10_000
  )

  it('recovers abandoned ownership after an actual HTTP process crash', async () => {
    const first = await httpWorker()
    let second: HttpWorker | undefined
    try {
      const fault = await prepareWorker(first)
      const pending = fetch(first.baseUrl + path, {
        method: 'POST',
        headers: { Authorization: TOKEN },
        body: '{}',
        signal: AbortSignal.timeout(3000),
      })
      const disconnected = expect(pending).rejects.toThrow()
      await workerArrival(first, fault.id)
      await first.stop(true)
      await disconnected
      second = await httpWorker()
      const observation = await fetch(
        second.baseUrl + `/_test/rest-faults/${fault.id}`
      )
      await expect(observation.json()).resolves.toMatchObject({
        consumed: 1,
        remaining: 1,
        state: 'armed',
        outcomes: { pending: 0, delayed: 1, cancelled: 1, responded: 0 },
      })
      const messages = await fetch(
        second.baseUrl + `/_test/messages/${channel}`
      )
      await expect(messages.json()).resolves.toEqual({ messages: [] })
    } finally {
      await second?.stop()
      await first.stop()
    }
  }, 10_000)

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'invalidates %s controls immediately when public setup moves their channel',
    async (mode) => {
      const fault = await arm(mode, {
        times: 2,
        ...(mode === 'delay' && { delay_ms: 60_000 }),
      })
      const pending = mode === 'delay' ? send() : undefined
      if (pending) await waitFor(fault.id, { outcomes: { pending: 1 } })
      const setup = await request('/_test/setup', {
        method: 'POST',
        body: JSON.stringify({
          token: OTHER,
          user: { id: '111111111111111112' },
          guilds: [
            {
              id: '222222222222222223',
              name: 'New scope',
              channels: [{ id: channel, name: 'Moved log' }],
            },
          ],
        }),
      })
      expect(setup.status).toBe(201)
      // Await before inspecting: setup must release the old handler itself.
      if (pending) expect(await select(pending, (res) => res.status)).toBe(504)
      expect(
        await select(
          request(`/_test/rest-faults/${fault.id}`),
          (res) => res.status
        )
      ).toBe(404)
      expect(server.db.prepare('SELECT * FROM messages').all()).toEqual([])
      const replacement = await arm('rate_limit')
      expect(replacement.guild_id).toBe('222222222222222223')
      const oldOwner = await send()
      expect(oldOwner.status).toBe(403)
      expect(await oldOwner.json()).toMatchObject({ code: 50_001 })
      expect(await status(replacement.id)).toMatchObject({
        consumed: 0,
        remaining: 1,
      })
      expect(
        await select(
          send({ headers: { Authorization: OTHER } }),
          (res) => res.status
        )
      ).toBe(429)
    }
  )

  it('automatically retries real client deadline failures without duplicate messages', async () => {
    const fault = await arm('delay', { delay_ms: 5000, times: 2 })
    let attempts = 0
    let response: Response | undefined
    for (let i = 0; i < 3; i++) {
      attempts++
      try {
        response = await send({ signal: AbortSignal.timeout(100) })
        break
      } catch (error) {
        expect(error).toMatchObject({ name: 'TimeoutError' })
      }
    }
    expect(response?.status).toBe(200)
    expect(attempts).toBe(3)
    await waitFor(fault.id, {
      outcomes: { disconnected: 2, pending: 0, responded: 0 },
    })
    expect(server.db.prepare('SELECT * FROM messages').all()).toHaveLength(1)
  })

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'uses existing exact GET page selectors for %s',
    async (mode) => {
      const fault = await arm(mode, {
        method: 'GET',
        query: { limit: 2, after: '123' },
        ...(mode === 'delay' && { delay_ms: 1 }),
      })
      expect(
        await select(request(path + '?limit=3&after=123'), (res) => res.status)
      ).toBe(200)
      expect(
        await select(request(path + '?limit=2&after=124'), (res) => res.status)
      ).toBe(200)
      expect(await status(fault.id)).toMatchObject({
        consumed: 0,
        remaining: 1,
      })
      const matching = request('/api' + path + '?after=000123&limit=02')
      if (mode === 'disconnect') await expect(matching).rejects.toThrow()
      else
        expect(await select(matching, (res) => res.status)).toBe(
          mode === 'delay' ? 504 : 429
        )
      expect(await status(fault.id)).toMatchObject({
        query: { limit: 2, after: '123' },
        consumed: 1,
        remaining: 0,
      })
      expect(
        await select(request(path + '?limit=2&after=123'), (res) => res.status)
      ).toBe(200)
    }
  )

  it('preserves another owning bot’s live delay on scoped reset and cancels reassigned ownership', async () => {
    seedBot(server.db, OTHER, '111111111111111112')
    const otherGuild = seedGuild(server.db, OTHER, '222222222222222223')
    const otherChannel = seedChannel(
      server.db,
      otherGuild,
      '333333333333333334'
    )
    const otherPath = `/channels/${otherChannel}/messages`
    const own = await arm('delay', { delay_ms: 60_000 })
    const other = await arm('delay', { path: otherPath, delay_ms: 60_000 })
    const ownRequest = send()
    const otherRequest = request(otherPath, {
      method: 'POST',
      headers: { Authorization: OTHER },
      body: '{}',
    })
    await waitFor(own.id, { outcomes: { pending: 1 } })
    await waitFor(other.id, { outcomes: { pending: 1 } })
    await request('/_test/reset', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(await select(ownRequest, (res) => res.status)).toBe(504)
    expect(await status(other.id)).toMatchObject({
      state: 'delaying',
      outcomes: { pending: 1 },
    })
    server.db
      .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
      .run(TOKEN, otherGuild)
    expect(
      await select(
        request(`/_test/rest-faults/${other.id}`),
        (res) => res.status
      )
    ).toBe(404)
    expect(await select(otherRequest, (res) => res.status)).toBe(504)
    expect(server.db.prepare('SELECT * FROM messages').all()).toEqual([])
  })

  it.each([false, true])(
    'returns coherent 429 retry semantics with global=%s',
    async (global) => {
      const fault = await arm('rate_limit', {
        global,
        times: 2,
        retry_after: 0.025,
      })
      expect(fault).toMatchObject({
        mode: 'rate_limit',
        state: 'armed',
        remaining: 2,
        consumed: 0,
        timeout_ms: 30_000,
      })
      expect(JSON.stringify(fault)).not.toContain(TOKEN)
      for (const prefix of ['/api/v10', '/api']) {
        const response = await request(prefix + path, {
          method: 'POST',
          body: '{}',
        })
        expect(response.status).toBe(429)
        await expect(response.json()).resolves.toEqual({
          message: 'You are being rate limited.',
          retry_after: 0.025,
          global,
        })
        expect(response.headers.get('Retry-After')).toBe('1')
        expect(response.headers.get('X-RateLimit-Reset-After')).toBe('0.025')
        expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
        expect(response.headers.get('X-RateLimit-Limit')).toBe('1')
        expect(response.headers.get('X-RateLimit-Bucket')).toBe(
          `fault-${fault.id}`
        )
        expect(response.headers.get('X-RateLimit-Scope')).toBe(
          global ? 'global' : 'user'
        )
        expect(response.headers.get('X-RateLimit-Global')).toBe(
          global ? 'true' : null
        )
        expect(
          Number(response.headers.get('X-RateLimit-Reset'))
        ).toBeGreaterThan(Date.now() / 1000 - 1)
      }
      expect(await status(fault.id)).toMatchObject({
        state: 'exhausted',
        remaining: 0,
        consumed: 2,
        outcomes: { responded: 2, pending: 0 },
      })
      expect(await select(send(), (value) => value.status)).toBe(200)
    }
  )

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'fails %s before non-owner permissions or multipart mutation, then recovers',
    async (mode) => {
      expect(
        await select(
          request(`/_test/setup/${encodeURIComponent(TOKEN)}`, {
            method: 'DELETE',
          }),
          (value) => value.status
        )
      ).toBe(204)
      const human = await request('/_test/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'Human owner' }),
      })
      expect(human.status).toBe(201)
      const owner = (await human.json()) as { id: string }
      expect(
        await select(
          request('/_test/setup', {
            method: 'POST',
            body: JSON.stringify({
              token: TOKEN,
              guilds: [
                {
                  id: guild,
                  name: 'Non-owner transport',
                  owner_id: owner.id,
                  channels: [{ id: channel, name: 'Nickname log' }],
                },
              ],
            }),
          }),
          (value) => value.status
        )
      ).toBe(201)
      const view = 1n << 10n
      /** Changes permissions on the real route without owner/admin bypass. */
      async function permissions(value: bigint): Promise<void> {
        const response = await request(`/guilds/${guild}/roles/${guild}`, {
          method: 'PATCH',
          body: JSON.stringify({ permissions: String(value) }),
        })
        expect(response.status).toBe(200)
      }
      await permissions(view)
      const fault = await arm(mode, {
        ...(mode === 'delay' && { delay_ms: 30 }),
      })
      const observer = await gateway()
      const form = new FormData()
      form.set(
        'payload_json',
        JSON.stringify({
          content: 'failed log',
          embeds: [{ description: 'Nickname changed' }],
          poll: {
            question: { text: 'Test?' },
            answers: [
              { poll_media: { text: 'Yes' } },
              { poll_media: { text: 'No' } },
            ],
            duration: 24,
            layout_type: 1,
          },
        })
      )
      form.set('files[0]', new File(['log'], 'log.txt'))
      if (mode === 'disconnect')
        await expect(send({ body: form })).rejects.toThrow()
      else
        expect(
          await select(send({ body: form }), (value) => value.status)
        ).toBe(mode === 'delay' ? 504 : 429)
      // Exhaustion exposes the persisted permission denial on the next retry.
      const denied = await send({ body: form })
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({
        code: 50_013,
        message: 'Missing Permissions',
      })
      for (const table of ['messages', 'attachments', 'polls', 'poll_answers'])
        expect(server.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
      expect(
        server.db
          .prepare('SELECT last_message_id FROM channels WHERE id = ?')
          .get(channel)
      ).toEqual({ last_message_id: null })
      await expect(readdir(uploadPath)).resolves.toEqual([])
      await observer.barrier()
      expect(observer.events).toEqual([])
      expect(await status(fault.id)).toMatchObject({
        consumed: 1,
        remaining: 0,
        state: 'exhausted',
        outcomes: {
          pending: 0,
          ...(mode === 'disconnect' ? { disconnected: 1 } : { responded: 1 }),
        },
      })
      await permissions(view | (1n << 11n) | (1n << 14n))
      expect(await select(send({ body: form }), (value) => value.status)).toBe(
        200
      )
      await observer.barrier()
      expect(observer.events).toHaveLength(1)
      expect(server.db.prepare('SELECT * FROM messages').all()).toHaveLength(1)
      expect(server.db.prepare('SELECT * FROM attachments').all()).toHaveLength(
        1
      )
      expect(server.db.prepare('SELECT * FROM polls').all()).toHaveLength(1)
    }
  )

  it('terminates the native socket without any HTTP response bytes', async () => {
    const fault = await arm('disconnect')
    const responseSeen = { value: false }
    const error = await new Promise<NodeJS.ErrnoException>(
      (resolve, reject) => {
        const req = httpRequest(
          server.baseUrl + path,
          { method: 'POST', headers: { Authorization: TOKEN } },
          (response) => {
            responseSeen.value = true
            response.resume()
            reject(new Error('Unexpected HTTP response'))
          }
        )
        req.on('error', resolve)
        req.end('{}')
      }
    )
    expect(error.code).toBe('ECONNRESET')
    expect(responseSeen.value).toBe(false)
    expect(await status(fault.id)).toMatchObject({
      outcomes: { disconnected: 1, responded: 0 },
    })
    expect(
      await select(request('/_mock/health'), (value) => value.status)
    ).toBe(200)
    expect(await select(send(), (value) => value.status)).toBe(200)
  })

  it('lets a client deadline expire, frees the delay, and never mutates later', async () => {
    const fault = await arm('delay', { delay_ms: 1000 })
    const controller = new AbortController()
    const pending = send({ signal: controller.signal })
    const failed = expect(pending).rejects.toThrow()
    await waitFor(fault.id, {
      state: 'delaying',
      consumed: 1,
      outcomes: { pending: 1, delayed: 1 },
    })
    expect(
      await select(request('/_mock/health'), (value) => value.status)
    ).toBe(200)
    controller.abort(new Error('Client deadline expired'))
    await failed
    await waitFor(fault.id, {
      state: 'exhausted',
      outcomes: { pending: 0, disconnected: 1, responded: 0 },
    })
    await sleep(30)
    expect(server.db.prepare('SELECT * FROM messages').all()).toEqual([])
    expect(await select(send(), (value) => value.status)).toBe(200)
  })

  it('returns the configured error after the exact bounded delay', async () => {
    const fault = await arm('delay', {
      delay_ms: 60,
      status: 503,
      code: 7,
      message: 'Delayed upstream',
    })
    const start = performance.now()
    const response = await send()
    expect(performance.now() - start).toBeGreaterThanOrEqual(55)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      code: 7,
      message: 'Delayed upstream',
    })
    expect(await status(fault.id)).toMatchObject({
      outcomes: { responded: 1, delayed: 1, pending: 0 },
    })
  })

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'bounds concurrent %s consumption and permits rearming while older delays finish',
    async (mode) => {
      const fault = await arm(mode, {
        times: 3,
        ...(mode === 'delay' && { delay_ms: 80 }),
      })
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () => send())
      )
      const statuses = attempts.map((result) =>
        result.status === 'fulfilled' ? result.value.status : 'disconnected'
      )
      expect(statuses.filter((value) => value === 200)).toHaveLength(5)
      expect(
        statuses.filter(
          (value) =>
            value ===
            (mode === 'rate_limit'
              ? 429
              : mode === 'delay'
                ? 504
                : 'disconnected')
        )
      ).toHaveLength(3)
      expect(await status(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
        outcomes: { pending: 0 },
      })
      expect(server.db.prepare('SELECT * FROM messages').all()).toHaveLength(5)
      expect(await select(arm(mode), (value) => value.id)).not.toBe(fault.id)
    }
  )

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'automatically retries %s failures and persists exactly one successful send',
    async (mode) => {
      const fault = await arm(mode, {
        times: 2,
        ...(mode === 'delay' && { delay_ms: 25 }),
      })
      let attempts = 0
      /** Small real HTTP retry client: follows 429 retry_after and retries transport/5xx failures. */
      async function retrySend(): Promise<Response> {
        for (let i = 0; i < 4; i++) {
          attempts++
          try {
            const response = await send()
            if (response.status === 429) {
              const body = (await response.json()) as { retry_after: number }
              await sleep(body.retry_after * 1000)
            } else if (response.status >= 500) await response.arrayBuffer()
            else return response
          } catch {
            // Retry a real connection failure within the same bounded attempt budget.
          }
        }
        throw new Error('Retry budget exhausted')
      }
      expect(await select(retrySend(), (value) => value.status)).toBe(200)
      expect(attempts).toBe(3)
      expect(await status(fault.id)).toMatchObject({
        consumed: 2,
        remaining: 0,
        outcomes: { pending: 0 },
      })
      expect(server.db.prepare('SELECT * FROM messages').all()).toHaveLength(1)
    }
  )

  it.each([
    'cancel',
    'reset',
    'scoped reset',
    'teardown',
    'guild deletion',
    'channel deletion',
    'shutdown',
  ])(
    'cancels in-flight delays on %s without resuming the send',
    async (action) => {
      const fault = await arm('delay', {
        delay_ms: 60_000,
        timeout_ms: 60_000,
        times: 2,
      })
      const pending = send()
      await waitFor(fault.id, { outcomes: { pending: 1 } })
      let response: Response
      switch (action) {
        case 'cancel': {
          response = await request(`/_test/rest-faults/${fault.id}`, {
            method: 'DELETE',
          })
          break
        }
        case 'reset': {
          response = await request('/_test/reset', {
            method: 'POST',
            body: '{}',
          })
          break
        }
        case 'scoped reset': {
          response = await request('/_test/reset', {
            method: 'POST',
            body: JSON.stringify({ token: TOKEN }),
          })
          break
        }
        case 'teardown': {
          response = await request(
            `/_test/setup/${encodeURIComponent(TOKEN)}`,
            { method: 'DELETE' }
          )
          break
        }
        case 'guild deletion': {
          response = await request(`/guilds/${guild}`, { method: 'DELETE' })
          break
        }
        case 'channel deletion': {
          response = await request(`/channels/${channel}`, { method: 'DELETE' })
          break
        }
        case 'shutdown': {
          const closing = server.close()
          expect(await select(pending, (value) => value.status)).toBe(504)
          await closing
          return
        }
        default: {
          throw new Error('Unknown cleanup action')
        }
      }
      expect(response.status).toBeLessThan(300)
      expect(await select(pending, (value) => value.status)).toBe(504)
      expect(
        await select(
          request(`/_test/rest-faults/${fault.id}`),
          (value) => value.status
        )
      ).toBe(404)
      expect(server.db.prepare('SELECT * FROM messages').all()).toEqual([])
      if (['cancel', 'reset', 'scoped reset'].includes(action))
        expect(await select(send(), (value) => value.status)).toBe(200)
    }
  )

  it('expires unused attempts and cancels pending delays at the arming deadline', async () => {
    const fault = await arm('delay', {
      delay_ms: 60_000,
      timeout_ms: 80,
      times: 3,
    })
    const response = await send()
    expect(response.status).toBe(504)
    expect(await status(fault.id)).toMatchObject({
      state: 'expired',
      remaining: 0,
      consumed: 1,
      outcomes: { cancelled: 1, delayed: 1, pending: 0, responded: 0 },
    })
    expect(await select(send(), (value) => value.status)).toBe(200)
    const unused = await arm('disconnect', { timeout_ms: 1 })
    await sleep(10)
    expect(await status(unused.id)).toMatchObject({
      state: 'expired',
      remaining: 0,
      consumed: 0,
    })
    expect(await select(arm('disconnect'), (value) => value.id)).not.toBe(
      unused.id
    )
  })

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'isolates %s by owner, exact route/method and database',
    async (mode) => {
      seedBot(server.db, OTHER, '111111111111111112')
      const fault = await arm(mode)
      const nonMember = await send({ headers: { Authorization: OTHER } })
      expect(nonMember.status).toBe(403)
      expect(await nonMember.json()).toMatchObject({ code: 50_001 })
      expect(
        await select(
          send({ headers: { Authorization: 'Bot invalid' } }),
          (value) => value.status
        )
      ).toBe(401)
      expect(await select(request(path), (value) => value.status)).toBe(200)
      expect(
        await select(
          request(path + '/', { method: 'POST', body: '{}' }),
          (value) => value.status
        )
      ).toBe(404)
      const otherChannel = seedChannel(server.db, guild, '333333333333333334')
      expect(
        await select(
          request(`/channels/${otherChannel}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content: 'unrelated' }),
          }),
          (value) => value.status
        )
      ).toBe(200)
      const second = await createRealServer()
      try {
        expect(
          await select(
            fetch(second.baseUrl + `/_test/rest-faults/${fault.id}`),
            (value) => value.status
          )
        ).toBe(404)
      } finally {
        await second.close()
      }
      expect(await status(fault.id)).toMatchObject({
        remaining: 1,
        consumed: 0,
      })
      expect(
        await select(
          request('/_test/reset', {
            method: 'POST',
            body: JSON.stringify({ token: OTHER }),
          }),
          (value) => value.status
        )
      ).toBe(204)
      expect(await status(fault.id)).toMatchObject({ remaining: 1 })
    }
  )

  it('allows new controls after count exhaustion even with older delayed attempts pending', async () => {
    const fault = await arm('delay', { delay_ms: 60_000 })
    const pending = send()
    await waitFor(fault.id, { state: 'delaying', remaining: 0 })
    const next = await arm('rate_limit')
    expect(await select(send(), (value) => value.status)).toBe(429)
    expect(await status(next.id)).toMatchObject({ consumed: 1 })
    await request(`/_test/rest-faults/${fault.id}`, { method: 'DELETE' })
    expect(await select(pending, (value) => value.status)).toBe(504)
    expect(await select(send(), (value) => value.status)).toBe(200)
  })

  it.each([
    { mode: null },
    { mode: ['delay'] },
    { mode: 'unknown' },
    { timeout_ms: null },
    { timeout_ms: 0 },
    { timeout_ms: 60_001 },
    { timeout_ms: 1.5 },
    { delay_ms: 0 },
    { delay_ms: 60_001 },
    { delay_ms: null },
    { delay_ms: 1.5 },
    { mode: 'rate_limit', retry_after: 0 },
    { mode: 'rate_limit', retry_after: 61 },
    { mode: 'rate_limit', retry_after: '1' },
    { mode: 'rate_limit', retry_after: null },
    { mode: 'rate_limit', retry_after: 1, status: 503 },
    { mode: 'rate_limit', retry_after: 1, global: 'true' },
    { mode: 'disconnect', delay_ms: 1 },
    { retry_after: 1 },
    { global: true },
    { status: null },
    { code: null },
    { message: null },
    { times: 101 },
    { path: '/_mock/health' },
    { path: '/_test/reset' },
  ])('rejects invalid mode policy %j', async (override) => {
    const mode = override.mode ?? 'delay'
    const response = await request('/_test/rest-faults', {
      method: 'POST',
      body: JSON.stringify({
        method: 'POST',
        path,
        mode,
        ...(mode === 'delay' && { delay_ms: 1 }),
        ...override,
      }),
    })
    expect(response.status).toBe(400)
  })

  it('accepts maximum policies, rejects cross-mode conflicts and unknown scopes', async () => {
    const fault = await arm('delay', {
      times: 100,
      delay_ms: 60_000,
      timeout_ms: 60_000,
    })
    expect(fault).toMatchObject({
      times: 100,
      delay_ms: 60_000,
      timeout_ms: 60_000,
    })
    expect(
      await select(
        request('/_test/rest-faults', {
          method: 'POST',
          body: JSON.stringify({
            method: 'POST',
            path,
            mode: 'rate_limit',
            retry_after: 60,
          }),
        }),
        (value) => value.status
      )
    ).toBe(409)
    await request(`/_test/rest-faults/${fault.id}`, { method: 'DELETE' })
    expect(
      await arm('rate_limit', { retry_after: 60, times: 100 })
    ).toMatchObject({ retry_after: 60, times: 100 })
    expect(
      await select(
        request('/_test/rest-faults', {
          method: 'POST',
          body: JSON.stringify({
            method: 'POST',
            path: '/channels/123/messages',
            mode: 'disconnect',
          }),
        }),
        (value) => value.status
      )
    ).toBe(404)
  })
})
