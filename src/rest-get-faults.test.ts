import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { initializeDatabase } from './db'
import { seedBot, seedGuild, seedMember } from './test-helpers'

const token = 'Bot read-owner'
const otherToken = 'Bot other-reader'
const failure = { status: 403, code: 50_013, message: 'Missing Permissions' }

describe('scoped REST GET faults', () => {
  let db: ReturnType<typeof initializeDatabase>
  let server: ReturnType<typeof buildApp>
  let guild: string
  let otherGuild: string
  let user: string

  /** Sends requests through the assembled middleware and real routes. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ) {
    return server.app.request(path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Returns a response status for concise route assertions. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Arms a bounded read failure with optional explicit user-route ownership. */
  async function arm(path: string, scope?: string, times = 1, error = failure) {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'GET',
      path,
      ...(scope !== undefined && { guild_id: scope }),
      times,
      ...error,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as { id: string; guild_id: string }
  }

  /** Checks the retained observation without consuming a control. */
  async function counters(id: string, remaining: number, consumed: number) {
    await expect(
      request(`/_test/rest-faults/${id}`).then((response) => response.json())
    ).resolves.toMatchObject({ remaining, consumed })
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    server = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, token, '100000000000000001')
    seedBot(db, otherToken, '100000000000000002')
    guild = seedGuild(db, token)
    otherGuild = seedGuild(db, otherToken, '222222222222222223')
    user = seedMember(db, guild)
  })

  afterEach(() => {
    server.unsubscribeGateway()
    server.wss.close()
    db.close()
  })

  for (const route of ['audit-logs', 'member', 'user']) {
    it.each([
      failure,
      { status: 404, code: 10_013, message: 'Unknown User' },
      { status: 500, code: 0, message: 'Internal Server Error' },
    ])(
      `returns $status for ${route}, then succeeds after exhaustion`,
      async (error) => {
        const path =
          route === 'user'
            ? `/users/${user}`
            : route === 'member'
              ? `/guilds/${guild}/members/${user}`
              : `/guilds/${guild}/audit-logs`
        const fault = await arm(
          path,
          route === 'user' ? guild : undefined,
          2,
          error
        )
        expect(fault.guild_id).toBe(guild)
        for (const prefix of ['/api/v10', '/api']) {
          const response = await request(
            `${prefix}${path}?action_type=72&limit=1`
          )
          expect(response.status).toBe(error.status)
          expect(response.headers.get('X-RateLimit-Bucket')).toBe(
            `mock-get-${route === 'user' ? 'users' : 'guilds'}`
          )
          await expect(response.json()).resolves.toEqual({
            code: error.code,
            message: error.message,
          })
        }
        await counters(fault.id, 0, 2)
        const success = await request(path)
        expect(success.status).toBe(200)
        if (route === 'audit-logs')
          await expect(success.json()).resolves.toMatchObject({
            audit_log_entries: [],
          })
        const rearmed = await arm(path, route === 'user' ? guild : undefined)
        expect(rearmed.id).not.toBe(fault.id)
        expect(await status(`/_test/rest-faults/${rearmed.id}`, 'DELETE')).toBe(
          204
        )
        expect(await status(path)).toBe(200)
      }
    )
  }

  it('ignores audit query values and ordering, without expanding the path or method', async () => {
    const path = `/guilds/${guild}/audit-logs`
    const fault = await arm(path, undefined, 3)
    for (const mismatch of [
      `/guilds/${guild}/audit-logs/extra`,
      `/guilds/${guild}/audit-logs/`,
      `/guilds/${guild}/members/${user}`,
    ]) {
      expect(await status(mismatch)).not.toBe(403)
    }
    expect(
      await status(
        `/guilds/${otherGuild}/audit-logs`,
        'GET',
        undefined,
        otherToken
      )
    ).toBe(200)
    await request(path, 'POST')
    await request(path, 'HEAD')
    await counters(fault.id, 3, 0)
    for (const query of [
      '?action_type=72&limit=1',
      '?limit=100&action_type=73',
      '?user_id=123&before=456',
    ])
      expect(await status(path + query)).toBe(403)
    await counters(fault.id, 0, 3)
    expect(await status(path)).toBe(200)
  })

  it.each(['audit-logs', 'member', 'user'])(
    'does not consume %s faults for missing, invalid, bearer or nonowner auth',
    async (route) => {
      const path =
        route === 'user'
          ? `/users/${user}`
          : route === 'member'
            ? `/guilds/${guild}/members/${user}`
            : `/guilds/${guild}/audit-logs`
      const fault = await arm(path, route === 'user' ? guild : undefined)
      for (const auth of ['', 'Bot missing', 'Bearer missing'])
        expect(await status(path, 'GET', undefined, auth)).toBe(401)
      await request(path, 'GET', undefined, otherToken)
      await counters(fault.id, 1, 0)
      expect(await status(path)).toBe(403)
      await counters(fault.id, 0, 1)
    }
  )

  it('isolates global user reads by owning bot and rejects ambiguous same-bot scopes', async () => {
    const path = `/users/${user}`
    const own = await arm(path, guild)
    const other = await arm(path, otherGuild, 1, {
      status: 500,
      code: 0,
      message: 'Other failure',
    })
    const sameBotGuild = seedGuild(db, token, '222222222222222224')
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'GET',
        path,
        guild_id: sameBotGuild,
        ...failure,
      })
    ).toBe(409)
    expect(await status(path, 'GET', undefined, otherToken)).toBe(500)
    await counters(own.id, 1, 0)
    await counters(other.id, 0, 1)
    expect(await status(`/users/123`)).toBe(404)
    const otherUser = seedMember(db, guild, '555555555555555556')
    expect(await status(`/users/${otherUser}`)).toBe(200)
    await request(path, 'PATCH', {})
    await counters(own.id, 1, 0)
    expect(await status(path)).toBe(403)
    expect(await status(path)).toBe(200)
  })

  it('matches exact guild and member IDs and can prearm missing users', async () => {
    const path = `/guilds/${guild}/members/123`
    const fault = await arm(path, undefined, 1, {
      status: 500,
      code: 0,
      message: 'Read failed',
    })
    expect(await status(`/guilds/${guild}/members/${user}`)).toBe(200)
    await request(
      `/guilds/${otherGuild}/members/123`,
      'GET',
      undefined,
      otherToken
    )
    await request(path, 'PATCH', { mute: true })
    await counters(fault.id, 1, 0)
    expect(await status(path)).toBe(500)
    expect(await status(path)).toBe(404)
    await arm('/users/123', guild)
    expect(await status('/users/123')).toBe(403)
    expect(await status('/users/123')).toBe(404)
  })

  it.each(['reset', 'scoped reset', 'teardown', 'guild deletion'])(
    'cleans active and exhausted GET controls on %s',
    async (cleanup) => {
      const own = [
        await arm(`/guilds/${guild}/audit-logs`),
        await arm(`/guilds/${guild}/members/${user}`),
        await arm(`/users/${user}`, guild),
      ]
      await request(`/users/${user}`)
      own.push(await arm(`/users/${user}`, guild))
      const other = await arm(`/users/${user}`, otherGuild)
      switch (cleanup) {
        case 'reset': {
          await request('/_test/reset', 'POST', {})
          break
        }
        case 'scoped reset': {
          await request('/_test/reset', 'POST', { token })
          break
        }
        case 'teardown': {
          await request(`/_test/setup/${encodeURIComponent(token)}`, 'DELETE')
          break
        }
        case 'guild deletion': {
          await request(`/guilds/${guild}`, 'DELETE')
          break
        }
      }
      for (const fault of own)
        expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${other.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
      if (cleanup === 'scoped reset' || cleanup === 'reset')
        expect(await status(`/users/${user}`)).toBe(200)
    }
  )

  it('bounds concurrent reads', async () => {
    const path = `/guilds/${guild}/audit-logs`
    const fault = await arm(path, undefined, 3)
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(path))
    )
    expect(
      responses.filter((response) => response.status === 403)
    ).toHaveLength(3)
    expect(
      responses.filter((response) => response.status === 200)
    ).toHaveLength(5)
    await counters(fault.id, 0, 3)
  })

  it('keeps owner scoping when auth is disabled, including accepted Bearer tokens', async () => {
    const path = `/users/${user}`
    const fault = await arm(path, guild)
    const disabled = buildApp(db, {
      baseUrl: 'http://localhost',
      disableAuth: true,
    })
    try {
      for (const auth of ['Bot unregistered', otherToken, 'Bearer accepted']) {
        const response = await disabled.app.request(path, {
          headers: { Authorization: auth },
        })
        expect(response.status).toBe(200)
      }
      await counters(fault.id, 1, 0)
      const response = await disabled.app.request(path, {
        headers: { Authorization: token },
      })
      expect(response.status).toBe(403)
      await counters(fault.id, 0, 1)
    } finally {
      disabled.unsubscribeGateway()
      disabled.wss.close()
    }
  })

  it.each([
    { path: '/users/123' },
    { path: '/users/123', guild_id: null },
    { path: '/users/123', guild_id: 123 },
    { path: '/users/123', guild_id: '*' },
    { path: '/users/@me', guild_id: '123' },
    { path: '/users/*', guild_id: '123' },
    { path: '/guilds/123/audit-logs?limit=1' },
    { path: '/guilds/123/audit-logs/' },
    { path: '/guilds/123/members/search' },
    { path: '/guilds/123/audit-logs', guild_id: '456' },
    { path: '/guilds/123/members/456', guild_id: '789' },
  ])('rejects invalid GET selector %j', async (selector) => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'GET',
        ...failure,
        ...selector,
      })
    ).toBe(400)
  })

  it('rejects missing guild scopes', async () => {
    for (const selector of [
      { path: '/users/123', guild_id: '123' },
      { path: '/guilds/123/audit-logs' },
    ])
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'GET',
          ...failure,
          ...selector,
        })
      ).toBe(404)
  })
})
