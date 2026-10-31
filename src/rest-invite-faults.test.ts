import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRealServer,
  seedBot,
  seedGuild,
  seedChannel,
  seedInvite,
  type RealServerContext,
} from './test-helpers'
import type { RestFault } from './services/rest-faults'

const token = 'Bot invite-owner'
const otherToken = 'Bot other-invite-owner'
const failure = { status: 503, code: 0, message: 'Invite request failed' }

describe('invite REST faults', () => {
  let server: RealServerContext
  let guild: string
  let channel: string
  let otherGuild: string
  let otherChannel: string

  /** Sends a bounded request through the assembled app and real HTTP socket. */
  function request(
    path: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ): Promise<Response> {
    return fetch(server.baseUrl + path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  }

  /** Returns a response status for concise route assertions. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Arms either invite selector with the shared failure defaults. */
  async function arm(
    method: string,
    path: string,
    options: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method,
      path,
      ...failure,
      ...options,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Reads retained consumption and mode evidence through the control API. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Captures persisted invites so failed attempts cannot silently mutate them. */
  function invites(): unknown[] {
    return server.db.prepare('SELECT * FROM invites ORDER BY code').all()
  }

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token, '100000000000000001')
    seedBot(server.db, otherToken, '100000000000000002')
    guild = seedGuild(server.db, token)
    channel = seedChannel(server.db, guild)
    otherGuild = seedGuild(server.db, otherToken, '222222222222222223')
    otherChannel = seedChannel(server.db, otherGuild, '333333333333333334')
    seedInvite(server.db, channel, guild, '100000000000000001')
  })

  afterEach(async () => {
    await server.close()
  })

  for (const method of ['GET', 'POST']) {
    /** Resolves the concrete exact selector for the current fixture. */
    function path(): string {
      return method === 'GET'
        ? `/guilds/${guild}/invites`
        : `/channels/${channel}/invites`
    }

    it(`${method} consumes exact attempts across prefixes without changing invites`, async () => {
      const before = invites()
      const fault = await arm(method, path(), {
        times: 3,
        ...(method === 'GET' && { guild_id: guild }),
      })
      expect(fault).toMatchObject({
        method,
        path: path(),
        guild_id: guild,
        channel_id: method === 'GET' ? null : channel,
        times: 3,
        remaining: 3,
        consumed: 0,
      })
      expect(fault.query).toBeUndefined()
      for (const prefix of ['/api/v10', '/api', '']) {
        const response = await request(
          prefix + path() + '?limit=1',
          method,
          method === 'POST' ? {} : undefined
        )
        expect(response.status).toBe(503)
        await expect(response.json()).resolves.toEqual({
          code: failure.code,
          message: failure.message,
        })
        expect(invites()).toEqual(before)
      }
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
      const success = await request(
        path(),
        method,
        method === 'POST' ? {} : undefined
      )
      expect(success.status).toBe(200)
      if (method === 'GET') {
        await expect(success.json()).resolves.toHaveLength(1)
        expect(invites()).toEqual(before)
      } else expect(invites()).toHaveLength(2)
      const next = await arm(method, path())
      expect(next.id).not.toBe(fault.id)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
      expect(await status(`/_test/rest-faults/${next.id}`, 'DELETE')).toBe(204)
      expect(await status(`/_test/rest-faults/${next.id}`)).toBe(404)
      expect(
        await status(path(), method, method === 'POST' ? {} : undefined)
      ).toBe(200)
    })

    it(`${method} isolates exact paths, methods and authentication`, async () => {
      const fault = await arm(method, path())
      for (const auth of ['', 'Bot missing', 'Bearer missing'])
        expect(
          await status(path(), method, method === 'POST' ? {} : undefined, auth)
        ).toBe(401)
      const unrelated =
        method === 'GET'
          ? `/guilds/${otherGuild}/invites`
          : `/channels/${otherChannel}/invites`
      expect(
        await status(
          unrelated,
          method,
          method === 'POST' ? {} : undefined,
          otherToken
        )
      ).toBe(200)
      for (const suffix of ['/', '/extra'])
        expect(await status(path() + suffix, method)).toBe(404)
      await request(path(), method === 'GET' ? 'POST' : 'GET')
      await request(path(), 'HEAD')
      if (method === 'GET') {
        expect(await status(path(), method, undefined, otherToken)).toBe(200)
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 1,
          consumed: 0,
        })
        expect(await status(path())).toBe(503)
      } else {
        // Mode-omitted creation follows message-send faults: any authenticated caller.
        expect(await status(path(), method, {}, otherToken)).toBe(503)
      }
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 1,
      })
    })

    it.each(['rate_limit', 'delay', 'disconnect'] as const)(
      `${method} supports %s without mutation and then recovers`,
      async (mode) => {
        const before = invites()
        const fault = await arm(method, path(), {
          mode,
          status: mode === 'rate_limit' ? 429 : 503,
          ...(mode === 'rate_limit' && { retry_after: 0.025 }),
          ...(mode === 'delay' && { delay_ms: 30 }),
        })
        expect(
          await status('/_test/rest-faults', 'POST', {
            method,
            path: path(),
            ...failure,
          })
        ).toBe(409)
        await request(
          path(),
          method,
          method === 'POST' ? {} : undefined,
          otherToken
        )
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 1,
          consumed: 0,
        })
        const snapshot = invites()
        const attempt = request(
          path(),
          method,
          method === 'POST' ? [] : undefined
        )
        if (mode === 'disconnect') await expect(attempt).rejects.toThrow()
        else {
          const response = await attempt
          expect(response.status).toBe(mode === 'rate_limit' ? 429 : 503)
          if (mode === 'rate_limit') {
            expect(response.headers.get('X-RateLimit-Bucket')).toBe(
              `fault-${fault.id}`
            )
            await expect(response.json()).resolves.toEqual({
              message: failure.message,
              retry_after: 0.025,
              global: false,
            })
          }
        }
        expect(invites()).toEqual(snapshot)
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 0,
          consumed: 1,
          state: 'exhausted',
          outcomes: {
            pending: 0,
            ...(mode === 'disconnect' ? { disconnected: 1 } : { responded: 1 }),
            ...(mode === 'delay' && { delayed: 1 }),
          },
        })
        expect(
          await status(path(), method, method === 'POST' ? [] : undefined)
        ).toBe(method === 'POST' ? 400 : 200)
        expect(
          await status(path(), method, method === 'POST' ? {} : undefined)
        ).toBe(200)
        expect(invites()).toHaveLength(
          method === 'POST' ? before.length + 2 : before.length
        )
      }
    )

    it.each(['cancel', 'reset', 'scoped reset'])(
      `${method} removes active and exhausted controls on %s`,
      async (cleanup) => {
        const exhausted = await arm(method, path())
        await request(path(), method)
        const active = await arm(method, path())
        if (cleanup === 'cancel') {
          for (const fault of [exhausted, active])
            expect(
              await status(`/_test/rest-faults/${fault.id}`, 'DELETE')
            ).toBe(204)
        } else {
          expect(
            await status(
              '/_test/reset',
              'POST',
              cleanup === 'reset' ? {} : { token }
            )
          ).toBe(204)
        }
        for (const fault of [exhausted, active])
          expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
        expect(
          await status(path(), method, method === 'POST' ? {} : undefined)
        ).toBe(200)
      }
    )

    it.each(['cancel', 'reset', 'scoped reset', 'expiry'])(
      `${method} releases an in-flight delay on %s without resuming the route`,
      async (cleanup) => {
        const before = invites()
        const fault = await arm(method, path(), {
          mode: 'delay',
          delay_ms: 60_000,
          timeout_ms: cleanup === 'expiry' ? 500 : 60_000,
          times: 2,
        })
        const pending = request(
          path(),
          method,
          method === 'POST' ? {} : undefined
        )
        await expect
          .poll(() => inspect(fault.id))
          .toMatchObject({
            consumed: 1,
            outcomes: { pending: 1 },
          })
        if (cleanup === 'cancel') {
          expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(
            204
          )
        } else if (cleanup !== 'expiry') {
          expect(
            await status(
              '/_test/reset',
              'POST',
              cleanup === 'reset' ? {} : { token }
            )
          ).toBe(204)
        }
        const response = await pending
        expect(response.status).toBe(503)
        expect(invites()).toEqual(cleanup.includes('reset') ? [] : before)
        if (cleanup === 'expiry') {
          expect(await inspect(fault.id)).toMatchObject({
            state: 'expired',
            remaining: 0,
            consumed: 1,
            outcomes: { pending: 0, cancelled: 1, responded: 0 },
          })
        } else expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
        expect(
          await status(path(), method, method === 'POST' ? {} : undefined)
        ).toBe(200)
      }
    )

    it(`${method} rejects malformed selectors and unsupported fields`, async () => {
      const invalid = [
        { path: path() + '/' },
        { path: path() + '?limit=1' },
        { path: path() + '/extra' },
        { method: method === 'GET' ? 'POST' : 'GET' },
        { method: 'DELETE' },
        { path: '/api/v10' + path() },
        { path: path().replace(/\d+/, '*') },
        { path: path().replace(/\d+/, '{id}') },
        { path: path().replace(/\d+/, 'abc') },
        { path: path().replace(/\d+/, '123456789012345678901') },
        { query: {} },
        { query: { limit: 1 } },
        { recipient_id: '123' },
        { guild_id: otherGuild },
        { guild_id: null },
        { guild_id: 123 },
        ...(method === 'POST' ? [{ guild_id: guild }] : []),
      ]
      for (const override of invalid) {
        const response = await request('/_test/rest-faults', 'POST', {
          method,
          path: path(),
          ...failure,
          ...override,
        })
        expect(response.status, JSON.stringify(override)).toBe(400)
      }
    })
  }

  it('requires an existing guild or guild channel, rejecting DM and group DM scopes', async () => {
    for (const type of [1, 3]) {
      server.db
        .prepare('INSERT INTO channels (id, type) VALUES (?, ?)')
        .run(String(type), type)
    }
    for (const selector of [
      { method: 'GET', path: '/guilds/123/invites' },
      { method: 'POST', path: '/channels/123/invites' },
      { method: 'POST', path: '/channels/1/invites' },
      { method: 'POST', path: '/channels/3/invites' },
    ]) {
      expect(
        await status('/_test/rest-faults', 'POST', {
          ...selector,
          ...failure,
        })
      ).toBe(404)
    }
  })
})
