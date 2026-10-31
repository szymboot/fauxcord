import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { gatewayBus } from './gateway/bus'
import { createGuildBan, getGuildBan } from './services/guild-bans'
import type { RestFault } from './services/rest-faults'
import {
  createRealServer,
  seedBearerCredential,
  seedBot,
  seedGuild,
  type RealServerContext,
} from './test-helpers'

const token = 'Bot unban-owner'
const otherToken = 'Bot unban-other'
const user = '555555555555555555'
const otherGuild = '222222222222222223'
const failure = { status: 403, code: 50_013, message: 'Missing Permissions' }

describe('unban REST faults through the production HTTP app', () => {
  let server: RealServerContext
  let guild: string
  let path: string
  let bearer: string

  /** Sends a bounded request through authentication and all production middleware. */
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

  /** Arms the exact unban selector through the public control API. */
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

  /** Reads retained configuration and consumption evidence. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Returns a completed request's status. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Proves socket destruction without an HTTP response or automatic fetch retry. */
  function disconnected(route: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const attempt = httpRequest(server.baseUrl + route, {
        method: 'DELETE',
        headers: { Authorization: token },
      })
      attempt.on('response', (response) => {
        response.resume()
        reject(new Error(`Unexpected HTTP response: ${response.statusCode}`))
      })
      attempt.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') resolve()
        else reject(error)
      })
      attempt.setTimeout(2000, () => {
        attempt.destroy(new Error('Disconnect attempt timed out'))
      })
      attempt.end()
    })
  }

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token)
    seedBot(server.db, otherToken, '111111111111111112')
    guild = seedGuild(server.db, token)
    seedGuild(server.db, otherToken, otherGuild)
    bearer = `Bearer ${seedBearerCredential(server.db).bearerToken}`
    path = `/guilds/${guild}/bans/${user}`
    createGuildBan(server.db, guild, user, 'original reason')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await server.close()
  })

  it('preserves the ban and emits nothing across all prefixes, then unbans on retry', async () => {
    const fault = await arm({ times: 3 })
    expect(fault).toMatchObject({
      method: 'DELETE',
      path,
      guild_id: guild,
      channel_id: null,
      times: 3,
      remaining: 3,
      consumed: 0,
    })
    const before = getGuildBan(server.db, guild, user)
    const events = vi.spyOn(gatewayBus, 'emit')
    for (const prefix of ['/api/v10', '/api', '']) {
      const response = await request(prefix + path, 'DELETE')
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        code: failure.code,
        message: failure.message,
      })
      expect(getGuildBan(server.db, guild, user)).toEqual(before)
    }
    expect(events).not.toHaveBeenCalled()
    expect(await inspect(fault.id)).toMatchObject({ consumed: 3, remaining: 0 })
    expect(await status(path, 'DELETE')).toBe(204)
    expect(getGuildBan(server.db, guild, user)).toBeNull()
    expect(await inspect(fault.id)).toMatchObject({ consumed: 3, remaining: 0 })
    const missing = await request(path, 'DELETE')
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({
      code: 10_026,
      message: 'Unknown Ban',
    })
  })

  it('prearms an absent ban and can inject Unknown Ban without removing an existing ban', async () => {
    const absent = `/guilds/${guild}/bans/555555555555555599`
    const prearmed = await arm({ path: absent })
    expect(await status(absent, 'DELETE')).toBe(403)
    expect(await inspect(prearmed.id)).toMatchObject({
      consumed: 1,
      remaining: 0,
    })
    expect(await status(absent, 'DELETE')).toBe(404)

    await arm({ status: 404, code: 10_026, message: 'Unknown Ban' })
    const response = await request(path, 'DELETE')
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      code: 10_026,
      message: 'Unknown Ban',
    })
    expect(getGuildBan(server.db, guild, user)).not.toBeNull()
    expect(await status(path, 'DELETE')).toBe(204)
  })

  it('matches only the exact method and IDs after authentication', async () => {
    const fault = await arm()
    for (const auth of ['', 'Bot unknown', 'Bearer unknown'])
      expect(await status(path, 'DELETE', undefined, auth)).toBe(401)
    expect(await status(path)).toBe(200)
    expect(await status(path, 'PUT')).toBe(204)
    for (const route of [
      `/guilds/${guild}/bans/555555555555555599`,
      `/guilds/${otherGuild}/bans/${user}`,
      `/guilds/${guild}/bans/0${user}`,
    ])
      expect(await status(route, 'DELETE')).toBe(404)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 0, remaining: 1 })
    expect(await status(path, 'DELETE')).toBe(403)
  })

  it.each([otherToken, 'bearer'])(
    'retains mode-omitted PUT caller scope for %s',
    async (caller) => {
      const fault = await arm()
      expect(
        await status(
          path,
          'DELETE',
          undefined,
          caller === 'bearer' ? bearer : caller
        )
      ).toBe(403)
      expect(getGuildBan(server.db, guild, user)).not.toBeNull()
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 1,
        remaining: 0,
      })
    }
  )

  it('keeps PUT and DELETE controls independent and rejects active duplicates', async () => {
    const put = await arm({ method: 'PUT', status: 500 })
    const removal = await arm()
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'DELETE',
        path,
        mode: 'disconnect',
      })
    ).toBe(409)
    expect(await status(path, 'DELETE')).toBe(403)
    expect(await inspect(put.id)).toMatchObject({ consumed: 0, remaining: 1 })
    expect(await status(path, 'PUT')).toBe(500)
    expect(await inspect(removal.id)).toMatchObject({
      consumed: 1,
      remaining: 0,
    })
    expect(getGuildBan(server.db, guild, user)).not.toBeNull()
  })

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'binds %s to the owning Bot and preserves bans throughout consumption',
    async (mode) => {
      const response = await request('/_test/rest-faults', 'POST', {
        method: 'DELETE',
        path,
        mode,
        times: 3,
        ...(mode === 'rate_limit' && { retry_after: 0.02, global: true }),
        ...(mode === 'delay' && { delay_ms: 20 }),
      })
      expect(response.status).toBe(201)
      const fault = (await response.json()) as RestFault
      for (const caller of [otherToken, bearer]) {
        // Other authenticated callers take the native route without consuming.
        expect(await status(path, 'DELETE', undefined, caller)).toBe(204)
        expect(getGuildBan(server.db, guild, user)).toBeNull()
        createGuildBan(server.db, guild, user, 'original reason')
      }
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 0,
        remaining: 3,
      })
      const before = getGuildBan(server.db, guild, user)
      const events = vi.spyOn(gatewayBus, 'emit')
      for (const prefix of ['/api/v10', '/api', '']) {
        if (mode === 'disconnect') await disconnected(prefix + path)
        else {
          const failed = await request(prefix + path, 'DELETE')
          expect(failed.status).toBe(mode === 'rate_limit' ? 429 : 504)
          if (mode === 'rate_limit') {
            expect(failed.headers.get('Retry-After')).toBe('1')
            expect(failed.headers.get('X-RateLimit-Global')).toBe('true')
            await expect(failed.json()).resolves.toEqual({
              message: 'You are being rate limited.',
              retry_after: 0.02,
              global: true,
            })
          } else
            await expect(failed.json()).resolves.toEqual({
              code: 0,
              message: 'Transport failure',
            })
        }
        expect(getGuildBan(server.db, guild, user)).toEqual(before)
      }
      expect(events).not.toHaveBeenCalled()
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 3,
        remaining: 0,
        state: 'exhausted',
        outcomes: {
          pending: 0,
          cancelled: 0,
          responded: mode === 'disconnect' ? 0 : 3,
          disconnected: mode === 'disconnect' ? 3 : 0,
          delayed: mode === 'delay' ? 3 : 0,
        },
      })
      expect(await status(path, 'DELETE')).toBe(204)
      expect(getGuildBan(server.db, guild, user)).toBeNull()
    }
  )

  it.each(['cancel', 'reset', 'scoped reset'])(
    'clears active and exhausted evidence on %s',
    async (cleanup) => {
      const exhausted = await arm()
      expect(await status(path, 'DELETE')).toBe(403)
      const active = await arm()
      const foreign = await arm({ path: `/guilds/${otherGuild}/bans/${user}` })
      if (cleanup === 'cancel') {
        for (const fault of [active, exhausted])
          expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(
            204
          )
      } else
        expect(
          await status(
            '/_test/reset',
            'POST',
            cleanup === 'scoped reset' ? { token } : {}
          )
        ).toBe(204)
      for (const fault of [active, exhausted])
        expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${foreign.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
      expect(getGuildBan(server.db, guild, user)).not.toBeNull()
      expect(await status(path, 'DELETE')).toBe(204)
    }
  )

  it.each(['cancel', 'expire'])(
    'never resumes a delayed unban after %s',
    async (action) => {
      const fault = await arm({
        mode: 'delay',
        delay_ms: 60_000,
        timeout_ms: action === 'expire' ? 500 : 30_000,
        times: 2,
      })
      const events = vi.spyOn(gatewayBus, 'emit')
      const pending = request(path, 'DELETE')
      await expect
        .poll(() => inspect(fault.id))
        .toMatchObject({ consumed: 1, outcomes: { pending: 1 } })
      if (action === 'cancel')
        expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(
          204
        )
      const delayed = await pending
      expect(delayed.status).toBe(403)
      expect(getGuildBan(server.db, guild, user)).not.toBeNull()
      expect(events).not.toHaveBeenCalled()
      if (action === 'expire')
        expect(await inspect(fault.id)).toMatchObject({
          state: 'expired',
          remaining: 0,
          consumed: 1,
          outcomes: { pending: 0, cancelled: 1 },
        })
      expect(await status(path, 'DELETE')).toBe(204)
    }
  )

  it.each([
    '/guilds/1/bans',
    '/guilds/1/bans/',
    '/guilds/1/bans/2/',
    '/guilds/1/bans/2?x=1',
    '/guilds/1/bans/2#fragment',
    '/guilds/*/bans/2',
    '/guilds/1/bans/*',
    '/guilds/{guildId}/bans/{userId}',
    '/guilds/-1/bans/2',
    '/guilds/1/bans/@me',
    '/guilds/1/bans/1.5',
    '/guilds/1/bans/2/extra',
    '/api/guilds/1/bans/2',
    '/api/v10/guilds/1/bans/2',
    `/guilds/${'1'.repeat(21)}/bans/2`,
    `/guilds/1/bans/${'1'.repeat(21)}`,
  ])('rejects malformed DELETE selector %s', async (selector) => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'DELETE',
        path: selector,
        ...failure,
      })
    ).toBe(400)
  })

  it('requires an existing guild and derives scope from the path', async () => {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'DELETE',
      path: `/guilds/999999999999999999/bans/${user}`,
      ...failure,
    })
    expect(response.status).toBe(404)
    const fault = await arm({ guild_id: otherGuild })
    expect(fault.guild_id).toBe(guild)
  })
})
