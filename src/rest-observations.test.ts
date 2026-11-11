import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app'
import { initializeDatabase } from './db'
import { deleteGuild } from './services/guilds'
import { resetTestData } from './services/test-control'
import {
  seedApplicationCommand,
  seedBot,
  seedChannel,
  seedGuild,
  seedRole,
} from './test-helpers'

const OWNER = 'Bot observe-owner'
const OTHER = 'Bot observe-other'
const APP = '100000000000000001'
const OTHER_APP = '100000000000000002'
const GUILD = '222222222222222221'
const OTHER_GUILD = '222222222222222222'
const SCOPE = 'applications.commands.permissions.update'
const BEARER = 'Bearer app-owner'

/** Subset of an observation snapshot the tests assert on. */
interface Snapshot {
  id: string
  method: string
  path: string
  guild_id: string
  count: number
  requests: {
    method: string
    path: string
    status: number
    at: string
    credential: string
  }[]
  expires_at: string
  state?: string
}

/** Base path of a guild's application commands. */
const commandsPath = (application = APP, guild = GUILD): string =>
  `/applications/${application}/guilds/${guild}/commands`

describe('REST observations', () => {
  let db: ReturnType<typeof initializeDatabase>
  let server: ReturnType<typeof buildApp>
  let commandId: string
  let otherCommandId: string
  const permissionBody = {
    permissions: [{ id: GUILD, type: 1, permission: false }],
  }

  /** Sends a request through the assembled middleware and real routes. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    auth = OWNER
  ): Promise<Response> {
    return server.app.request(path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Creates an observation and returns its creation response. */
  async function observe(
    method: string,
    path: string,
    extra: Record<string, unknown> = {}
  ): Promise<Snapshot> {
    const response = await request('/_test/rest-observations', 'POST', {
      method,
      path,
      ...extra,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as Snapshot
  }

  /** Reads an observation snapshot. */
  async function read(id: string): Promise<Snapshot> {
    const response = await request(`/_test/rest-observations/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Snapshot
  }

  /** Reads one field of an observation snapshot. */
  async function field<K extends keyof Snapshot>(
    id: string,
    key: K
  ): Promise<Snapshot[K]> {
    const snapshot = await read(id)
    return snapshot[key]
  }

  /** Resolves a response to its status code. */
  async function code(response: Promise<Response>): Promise<number> {
    const { status } = await response
    return status
  }

  /** Reads the HTTP status of reading an observation. */
  async function readStatus(id: string): Promise<number> {
    return await code(request(`/_test/rest-observations/${id}`))
  }

  /** Registers a client and an unexpired access token for it. */
  function seedAccessToken(
    token: string,
    clientId: string,
    userId: string | null
  ): void {
    db.prepare(
      'INSERT OR IGNORE INTO oauth2_clients (client_id, client_secret) VALUES (?, ?)'
    ).run(clientId, `secret-${clientId}`)
    db.prepare(
      `INSERT INTO oauth2_access_tokens (token, client_id, user_id, scope, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+1 day'))`
    ).run(token, clientId, userId, SCOPE)
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    server = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, OWNER, APP)
    seedBot(db, OTHER, OTHER_APP)
    seedGuild(db, OWNER, GUILD)
    seedGuild(db, OTHER, OTHER_GUILD)
    seedRole(db, GUILD)
    commandId = seedApplicationCommand(db, APP, GUILD, 'existing')
    otherCommandId = seedApplicationCommand(db, APP, GUILD, 'second')
    seedAccessToken('app-owner', APP, null)
    seedAccessToken('app-other', OTHER_APP, null)
  })

  afterEach(() => {
    vi.useRealTimers()
    server.unsubscribeGateway()
    server.wss.close()
    db.close()
  })

  describe('creation', () => {
    it('returns an empty observation with the resolved guild', async () => {
      const created = await observe('GET', commandsPath())
      expect(created).toEqual({
        id: expect.stringMatching(/^\d+$/),
        method: 'GET',
        path: commandsPath(),
        guild_id: GUILD,
        count: 0,
        requests: [],
        expires_at: expect.any(String),
      })
      const remaining = Date.parse(created.expires_at) - Date.now()
      expect(remaining).toBeGreaterThan(55_000)
      expect(remaining).toBeLessThanOrEqual(60_000)
      expect(await read(created.id)).toEqual({ ...created, state: 'active' })
    })

    it('honors timeout_ms up to ten minutes', async () => {
      const created = await observe('GET', commandsPath(), {
        timeout_ms: 600_000,
      })
      expect(Date.parse(created.expires_at) - Date.now()).toBeGreaterThan(
        599_000
      )
    })
  })

  describe.each([
    {
      name: 'GET guild commands',
      method: 'GET',
      path: () => commandsPath(),
    },
    {
      name: 'GET guild command permissions',
      method: 'GET',
      path: () => `${commandsPath()}/${commandId}/permissions`,
    },
    {
      name: 'PUT command permissions',
      method: 'PUT',
      path: () => `${commandsPath()}/${commandId}/permissions`,
      body: permissionBody,
    },
  ])('$name', (route) => {
    /** Sends the observed request as the given caller. */
    const send = (auth: string, prefix = ''): Promise<Response> =>
      request(`${prefix}${route.path()}`, route.method, route.body, auth)

    it('counts succeeding requests by the bot on every prefix', async () => {
      const observation = await observe(route.method, route.path())
      for (const prefix of ['/api/v10', '/api', '']) {
        expect(await code(send(OWNER, prefix))).toBe(200)
      }
      const snapshot = await read(observation.id)
      expect(snapshot.count).toBe(3)
      expect(snapshot.state).toBe('active')
      expect(snapshot.requests).toHaveLength(3)
      for (const entry of snapshot.requests) {
        expect(entry).toEqual({
          method: route.method,
          path: route.path(),
          status: 200,
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
          credential: 'bot',
        })
      }
    })

    it('counts requests by a Bearer token of the owning application', async () => {
      const observation = await observe(route.method, route.path())
      const response = await send(BEARER)
      const snapshot = await read(observation.id)
      expect(snapshot.count).toBe(1)
      expect(snapshot.requests[0]).toMatchObject({
        status: response.status,
        credential: 'bearer',
      })
      if (route.path().endsWith('/permissions'))
        expect(response.status).toBe(200)
    })

    it('does not count another bot or a Bearer token of another application', async () => {
      const observation = await observe(route.method, route.path())
      await send(OTHER)
      await send('Bearer app-other')
      expect(await field(observation.id, 'count')).toBe(0)
      await send(OWNER)
      expect(await field(observation.id, 'count')).toBe(1)
    })
  })

  it('does not count other methods, commands or guilds', async () => {
    const observation = await observe(
      'GET',
      `${commandsPath()}/${commandId}/permissions`
    )
    await request(`${commandsPath()}/${otherCommandId}/permissions`)
    await request(
      `${commandsPath()}/${commandId}/permissions`,
      'PUT',
      permissionBody
    )
    await request(commandsPath())
    await request(commandsPath(OTHER_APP, OTHER_GUILD), 'GET', undefined, OTHER)
    expect(await field(observation.id, 'count')).toBe(0)
  })

  describe('command wildcard', () => {
    it.each(['GET', 'PUT'])(
      'matches every command of the guild for %s',
      async (method) => {
        const body = method === 'PUT' ? permissionBody : undefined
        const observation = await observe(
          method,
          `${commandsPath()}/*/permissions`
        )
        expect(observation.path).toBe(`${commandsPath()}/*/permissions`)
        expect(observation.guild_id).toBe(GUILD)
        for (const id of [commandId, otherCommandId]) {
          const path = `${commandsPath()}/${id}/permissions`
          expect(await code(request(path, method, body))).toBe(200)
          expect(await code(request(path, method, body, BEARER))).toBe(200)
        }
        const snapshot = await read(observation.id)
        expect(snapshot.count).toBe(4)
        expect(snapshot.requests.map((entry) => entry.path)).toEqual([
          `${commandsPath()}/${commandId}/permissions`,
          `${commandsPath()}/${commandId}/permissions`,
          `${commandsPath()}/${otherCommandId}/permissions`,
          `${commandsPath()}/${otherCommandId}/permissions`,
        ])
        expect(snapshot.requests.map((entry) => entry.credential)).toEqual([
          'bot',
          'bearer',
          'bot',
          'bearer',
        ])
      }
    )

    it('matches the application ID used as command ID', async () => {
      const observation = await observe(
        'PUT',
        `${commandsPath()}/*/permissions`
      )
      await request(
        `${commandsPath()}/${APP}/permissions`,
        'PUT',
        permissionBody
      )
      expect(await field(observation.id, 'count')).toBe(1)
    })

    it('does not match other methods, guilds or the permissions listing', async () => {
      const observation = await observe(
        'GET',
        `${commandsPath()}/*/permissions`
      )
      await request(`${commandsPath()}/permissions`)
      await request(`${commandsPath()}/${commandId}`)
      await request(
        `${commandsPath()}/${commandId}/permissions`,
        'PUT',
        permissionBody
      )
      await request(
        `${commandsPath(OTHER_APP, OTHER_GUILD)}/${commandId}/permissions`,
        'GET',
        undefined,
        OTHER
      )
      expect(await field(observation.id, 'count')).toBe(0)
    })

    it('does not count another bot', async () => {
      const observation = await observe(
        'GET',
        `${commandsPath()}/*/permissions`
      )
      await request(
        `${commandsPath()}/${commandId}/permissions`,
        'GET',
        undefined,
        OTHER
      )
      expect(await field(observation.id, 'count')).toBe(0)
    })
  })

  it('counts guild role listings by the bot and a Bearer token', async () => {
    const observation = await observe('GET', `/guilds/${GUILD}/roles`)
    expect(await code(request(`/guilds/${GUILD}/roles`))).toBe(200)
    await request(`/guilds/${GUILD}/roles`, 'GET', undefined, BEARER)
    await request(`/guilds/${GUILD}/roles`, 'GET', undefined, OTHER)
    const snapshot = await read(observation.id)
    expect(snapshot.count).toBe(2)
    expect(snapshot.requests.map((entry) => entry.credential)).toEqual([
      'bot',
      'bearer',
    ])
  })

  it('does not count a Bearer token on a selector outside the application scope', async () => {
    const observation = await observe('GET', `/guilds/${GUILD}/channels`)
    await request(`/guilds/${GUILD}/channels`, 'GET', undefined, BEARER)
    expect(await field(observation.id, 'count')).toBe(0)
    await request(`/guilds/${GUILD}/channels`)
    expect(await field(observation.id, 'count')).toBe(1)
  })

  it('counts unrestricted write selectors for any authenticated caller', async () => {
    const channel = seedChannel(db, GUILD)
    const observation = await observe('POST', `/channels/${channel}/messages`)
    const response = await request(
      `/channels/${channel}/messages`,
      'POST',
      { content: 'hello' },
      OWNER
    )
    expect(response.status).toBe(200)
    const [entry] = await field(observation.id, 'requests')
    expect(entry).toMatchObject({
      status: 200,
      credential: 'bot',
    })
  })

  describe('effects on requests', () => {
    it('lets a counted permission edit take effect', async () => {
      const observation = await observe(
        'PUT',
        `${commandsPath()}/*/permissions`
      )
      const response = await request(
        `${commandsPath()}/${commandId}/permissions`,
        'PUT',
        permissionBody
      )
      expect(response.status).toBe(200)
      expect(await field(observation.id, 'count')).toBe(1)
      const stored = await request(`${commandsPath()}/${commandId}/permissions`)
      expect(stored.status).toBe(200)
      await expect(stored.json()).resolves.toMatchObject({
        application_id: APP,
        guild_id: GUILD,
        id: commandId,
        permissions: permissionBody.permissions,
      })
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM application_command_permissions')
          .get()
      ).toEqual({ n: 1 })
    })

    it('records error responses of the route with their status', async () => {
      const observation = await observe(
        'PUT',
        `${commandsPath()}/*/permissions`
      )
      const response = await request(
        `${commandsPath()}/${commandId}/permissions`,
        'PUT',
        { permissions: 'invalid' }
      )
      expect(response.status).toBe(400)
      const snapshot = await read(observation.id)
      expect(snapshot.count).toBe(1)
      expect(snapshot.requests[0].status).toBe(400)
    })

    it('counts a request that a REST fault fails, with its status', async () => {
      const path = `${commandsPath()}/${commandId}/permissions`
      const fault = await request('/_test/rest-faults', 'POST', {
        method: 'PUT',
        path,
        status: 503,
        code: 0,
        message: 'Service Unavailable',
      })
      expect(fault.status).toBe(201)
      const observation = await observe('PUT', path)
      expect(await code(request(path, 'PUT', permissionBody))).toBe(503)
      expect(await code(request(path, 'PUT', permissionBody))).toBe(200)
      const snapshot = await read(observation.id)
      expect(snapshot.count).toBe(2)
      expect(snapshot.requests.map((entry) => entry.status)).toEqual([503, 200])
    })

    it('counts a request answered by a rate limit fault', async () => {
      const path = `${commandsPath()}/${commandId}/permissions`
      await request('/_test/rest-faults', 'POST', {
        method: 'PUT',
        path,
        mode: 'rate_limit',
        retry_after: 1,
      })
      const observation = await observe('PUT', path)
      expect(await code(request(path, 'PUT', permissionBody))).toBe(429)
      const [entry] = await field(observation.id, 'requests')
      expect(entry.status).toBe(429)
    })

    it('does not consume or change a fault itself', async () => {
      const path = commandsPath()
      const faultResponse = await request('/_test/rest-faults', 'POST', {
        method: 'GET',
        path,
        status: 500,
        code: 0,
        message: 'Internal Server Error',
      })
      const fault = (await faultResponse.json()) as { id: string }
      await observe('GET', path)
      const before = await request(`/_test/rest-faults/${fault.id}`)
      await expect(before.json()).resolves.toMatchObject({ consumed: 0 })
      expect(await code(request(path))).toBe(500)
      const after = await request(`/_test/rest-faults/${fault.id}`)
      await expect(after.json()).resolves.toMatchObject({
        consumed: 1,
        remaining: 0,
      })
    })
  })

  it('counts overlapping observations independently', async () => {
    const path = `${commandsPath()}/${commandId}/permissions`
    const first = await observe('PUT', path)
    await request(path, 'PUT', permissionBody)
    const wildcard = await observe('PUT', `${commandsPath()}/*/permissions`)
    const second = await observe('PUT', path, { timeout_ms: 1000 })
    await request(path, 'PUT', permissionBody)
    await request(
      `${commandsPath()}/${otherCommandId}/permissions`,
      'PUT',
      permissionBody
    )
    expect(await field(first.id, 'count')).toBe(2)
    expect(await field(wildcard.id, 'count')).toBe(2)
    expect(await field(second.id, 'count')).toBe(1)
    expect(
      await code(request(`/_test/rest-observations/${first.id}`, 'DELETE'))
    ).toBe(204)
    await request(path, 'PUT', permissionBody)
    expect(await readStatus(first.id)).toBe(404)
    expect(await field(wildcard.id, 'count')).toBe(3)
    expect(await field(second.id, 'count')).toBe(2)
  })

  it('keeps the latest 1000 requests while the count continues', async () => {
    const observation = await observe('GET', `/guilds/${GUILD}/roles`)
    for (let index = 0; index < 1002; index++) {
      await request(`/guilds/${GUILD}/roles`)
    }
    const snapshot = await read(observation.id)
    expect(snapshot.count).toBe(1002)
    expect(snapshot.requests).toHaveLength(1000)
    expect(snapshot.requests.every((entry) => entry.status === 200)).toBe(true)
  })

  describe('expiry', () => {
    it('stops counting after timeout_ms but stays readable', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
      const observation = await observe('GET', commandsPath(), {
        timeout_ms: 5000,
      })
      expect(observation.expires_at).toBe('2030-01-01T00:00:05.000Z')
      await request(commandsPath())
      vi.setSystemTime(new Date('2030-01-01T00:00:04.999Z'))
      await request(commandsPath())
      expect(await field(observation.id, 'state')).toBe('active')
      vi.setSystemTime(new Date('2030-01-01T00:00:05.000Z'))
      await request(commandsPath())
      const snapshot = await read(observation.id)
      expect(snapshot.state).toBe('expired')
      expect(snapshot.count).toBe(2)
      expect(snapshot.requests).toHaveLength(2)
      expect(snapshot.expires_at).toBe('2030-01-01T00:00:05.000Z')
      expect(
        await code(
          request(`/_test/rest-observations/${observation.id}`, 'DELETE')
        )
      ).toBe(204)
      expect(await readStatus(observation.id)).toBe(404)
    })
  })

  describe('removal', () => {
    it('deletes an observation and 404s for unknown ids', async () => {
      const observation = await observe('GET', commandsPath())
      await request(commandsPath())
      expect(
        await code(
          request(`/_test/rest-observations/${observation.id}`, 'DELETE')
        )
      ).toBe(204)
      expect(await readStatus(observation.id)).toBe(404)
      const again = await request(
        `/_test/rest-observations/${observation.id}`,
        'DELETE'
      )
      expect(again.status).toBe(404)
      await expect(again.json()).resolves.toEqual({
        message: '404: Not Found',
        code: 0,
      })
      expect(await readStatus('999')).toBe(404)
    })

    it('is cleared by a global reset', async () => {
      const first = await observe('GET', commandsPath())
      const second = await observe('GET', commandsPath(OTHER_APP, OTHER_GUILD))
      const response = await request('/_test/reset', 'POST')
      expect(response.status).toBe(204)
      expect(await readStatus(first.id)).toBe(404)
      expect(await readStatus(second.id)).toBe(404)
    })

    it('is cleared by a token reset without touching other bots', async () => {
      const first = await observe('GET', commandsPath())
      const second = await observe('GET', commandsPath(OTHER_APP, OTHER_GUILD))
      resetTestData(db, OWNER)
      expect(await readStatus(first.id)).toBe(404)
      expect(await field(second.id, 'guild_id')).toBe(OTHER_GUILD)
    })

    it('is cleared when the setup is deleted', async () => {
      const first = await observe('GET', commandsPath())
      const second = await observe('GET', commandsPath(OTHER_APP, OTHER_GUILD))
      const response = await request(
        `/_test/setup/${encodeURIComponent(OWNER)}`,
        'DELETE'
      )
      expect(response.status).toBe(204)
      expect(await readStatus(first.id)).toBe(404)
      expect(await field(second.id, 'count')).toBe(0)
    })

    it('is cleared when the guild is deleted', async () => {
      const first = await observe('GET', commandsPath())
      const second = await observe('GET', commandsPath(OTHER_APP, OTHER_GUILD))
      expect(deleteGuild(db, GUILD)).toBe(true)
      expect(await readStatus(first.id)).toBe(404)
      expect(await field(second.id, 'count')).toBe(0)
    })

    it('is cleared when the guild changes its owning bot', async () => {
      const first = await observe('GET', commandsPath())
      db.prepare('UPDATE guilds SET bot_token = ? WHERE id = ?').run(
        OTHER,
        GUILD
      )
      expect(await readStatus(first.id)).toBe(404)
    })

    it('survives an unrelated setup', async () => {
      const first = await observe('GET', commandsPath())
      const response = await request('/_test/setup', 'POST', {
        token: 'Bot fresh-bot',
        user: { username: 'Fresh' },
        guilds: [{ name: 'Fresh guild', channels: [] }],
      })
      expect(response.status).toBe(201)
      expect(await field(first.id, 'guild_id')).toBe(GUILD)
    })
  })

  describe('validation', () => {
    const invalid: [string, unknown][] = [
      ['an unsupported path', { method: 'GET', path: '/gateway' }],
      ['an unsupported method', { method: 'OPTIONS', path: commandsPath() }],
      ['a missing method', { path: commandsPath() }],
      ['a missing path', { method: 'GET' }],
      ['a non-string path', { method: 'GET', path: 7 }],
      [
        'a versioned path',
        { method: 'GET', path: `/api/v10${commandsPath()}` },
      ],
      ['a non-numeric ID', { method: 'GET', path: '/guilds/abc/roles' }],
      ['a wildcard guild', { method: 'GET', path: '/guilds/*/roles' }],
      [
        'a wildcard on an unsupported method',
        { method: 'POST', path: `${commandsPath()}/*/permissions` },
      ],
      [
        'a wildcard on a non-permission route',
        { method: 'GET', path: `${commandsPath()}/*` },
      ],
      [
        'a wildcard application',
        { method: 'GET', path: `/applications/*/guilds/${GUILD}/commands` },
      ],
      [
        'a mismatching guild_id',
        { method: 'GET', path: commandsPath(), guild_id: OTHER_GUILD },
      ],
      [
        'a non-numeric guild_id',
        { method: 'GET', path: commandsPath(), guild_id: 'abc' },
      ],
      [
        'a numeric guild_id',
        { method: 'GET', path: commandsPath(), guild_id: 5 },
      ],
      ['timeout_ms 0', { method: 'GET', path: commandsPath(), timeout_ms: 0 }],
      [
        'timeout_ms above ten minutes',
        { method: 'GET', path: commandsPath(), timeout_ms: 600_001 },
      ],
      [
        'a fractional timeout_ms',
        { method: 'GET', path: commandsPath(), timeout_ms: 1.5 },
      ],
      [
        'a string timeout_ms',
        { method: 'GET', path: commandsPath(), timeout_ms: '5' },
      ],
      [
        'an unknown field',
        { method: 'GET', path: commandsPath(), status: 500 },
      ],
      ['an array body', []],
      ['a null body', null],
    ]

    it.each(invalid)('rejects %s with 400', async (_, body) => {
      const response = await request('/_test/rest-observations', 'POST', body)
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        message: '400: Bad Request',
        code: 0,
      })
    })

    it('rejects malformed JSON with 400', async () => {
      const response = await server.app.request('/_test/rest-observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
      expect(response.status).toBe(400)
    })

    it('requires guild_id for global user selectors like faults', async () => {
      const response = await request('/_test/rest-observations', 'POST', {
        method: 'GET',
        path: '/users/123456789012345678',
      })
      expect(response.status).toBe(400)
      const ok = await request('/_test/rest-observations', 'POST', {
        method: 'GET',
        path: '/users/123456789012345678',
        guild_id: GUILD,
      })
      expect(ok.status).toBe(201)
    })

    it.each([
      ['an unknown guild', 'GET', '/guilds/999999999999999999/roles'],
      [
        'an application that does not own the guild',
        'GET',
        commandsPath(OTHER_APP, GUILD),
      ],
      [
        'an unknown guild in an application command path',
        'PUT',
        `${commandsPath(APP, '999999999999999999')}/*/permissions`,
      ],
    ])('returns 404 for %s', async (_, method, path) => {
      const response = await request('/_test/rest-observations', 'POST', {
        method,
        path,
      })
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toEqual({
        message: '404: Not Found',
        code: 0,
      })
    })
  })
})
