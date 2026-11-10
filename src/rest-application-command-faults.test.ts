import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { initializeDatabase } from './db'
import {
  createRealServer,
  seedApplicationCommand,
  seedBot,
  seedGuild,
  seedRole,
  type RealServerContext,
} from './test-helpers'

const OWNER = 'Bot command-fault-owner'
const OTHER = 'Bot command-fault-other'
const APP = '100000000000000001'
const OTHER_APP = '100000000000000002'
const GUILD = '222222222222222221'
const OTHER_GUILD = '222222222222222222'
const SCOPE = 'applications.commands.permissions.update'
const failure = { status: 500, code: 0, message: 'Internal Server Error' }

/** One selector under test, with the request that triggers it. */
interface Selector {
  name: string
  method: 'GET' | 'PUT'
  path: (commandId: string, application?: string, guild?: string) => string
  body?: unknown
}

/** Builds a guild application commands base path. */
const commandsPath = (application = APP, guild = GUILD): string =>
  `/applications/${application}/guilds/${guild}/commands`

const COMMANDS = commandsPath()
const selectors: Selector[] = [
  {
    name: 'guild command list',
    method: 'GET',
    path: (_, application, guild) => commandsPath(application, guild),
  },
  {
    name: 'guild command bulk overwrite',
    method: 'PUT',
    path: (_, application, guild) => commandsPath(application, guild),
    body: [{ name: 'overwritten', description: 'Overwritten' }],
  },
  {
    name: 'guild command permissions list',
    method: 'GET',
    path: (_, application, guild) =>
      `${commandsPath(application, guild)}/permissions`,
  },
  {
    name: 'command permissions read',
    method: 'GET',
    path: (id, application, guild) =>
      `${commandsPath(application, guild)}/${id}/permissions`,
  },
  {
    name: 'command permissions update',
    method: 'PUT',
    path: (id, application, guild) =>
      `${commandsPath(application, guild)}/${id}/permissions`,
    body: { permissions: [{ id: GUILD, type: 1, permission: false }] },
  },
  {
    name: 'guild role list',
    method: 'GET',
    path: (_, __, guild = GUILD) => `/guilds/${guild}/roles`,
  },
]

/** Resolves a response to its status code. */
async function code(response: Promise<Response>): Promise<number> {
  const { status } = await response
  return status
}

/** Credentials that identify the same application in different ways. */
type Credential = 'bot' | 'user bearer' | 'client-credentials bearer'
const credentials: Credential[] = [
  'bot',
  'user bearer',
  'client-credentials bearer',
]

describe('application command REST faults', () => {
  let db: ReturnType<typeof initializeDatabase>
  let server: ReturnType<typeof buildApp>
  let commandId: string

  /** Registers a client and an unexpired access token for it. */
  function seedAccessToken(
    token: string,
    clientId: string,
    userId: string | null
  ): string {
    db.prepare(
      'INSERT OR IGNORE INTO oauth2_clients (client_id, client_secret) VALUES (?, ?)'
    ).run(clientId, `secret-${clientId}`)
    db.prepare(
      `INSERT INTO oauth2_access_tokens (token, client_id, user_id, scope, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+1 day'))`
    ).run(token, clientId, userId, SCOPE)
    return `Bearer ${token}`
  }

  /** Returns the Authorization header for a credential kind. */
  function authorization(credential: Credential): string {
    return credential === 'bot'
      ? OWNER
      : credential === 'user bearer'
        ? 'Bearer user-owner'
        : 'Bearer app-owner'
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

  /** Arms a fault and returns its control. */
  async function arm(
    method: string,
    path: string,
    extra: Record<string, unknown> = {}
  ): Promise<{ id: string; guild_id: string; remaining: number }> {
    const response = await request('/_test/rest-faults', 'POST', {
      method,
      path,
      ...failure,
      ...extra,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as {
      id: string
      guild_id: string
      remaining: number
    }
  }

  /** Reads the retained control without consuming it. */
  async function control(id: string): Promise<Record<string, unknown>> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }

  /** Snapshots every stored command and permission row. */
  function commandState(): unknown {
    return {
      commands: db
        .prepare('SELECT * FROM application_commands ORDER BY id')
        .all(),
      permissions: db
        .prepare('SELECT * FROM application_command_permissions ORDER BY 1, 2')
        .all(),
    }
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
    seedAccessToken('user-owner', APP, '555555555555555551')
    seedAccessToken('app-owner', APP, null)
    seedAccessToken('user-other', OTHER_APP, '555555555555555552')
  })

  afterEach(() => {
    server.unsubscribeGateway()
    server.wss.close()
    db.close()
  })

  describe.each(selectors)('$name', (selector) => {
    /** Resolves the selected request path for the seeded command. */
    const path = (): string => selector.path(commandId)

    /** Sends the selected request as the given caller. */
    const send = (auth: string, prefix = ''): Promise<Response> =>
      request(`${prefix}${path()}`, selector.method, selector.body, auth)

    it.each(credentials)(
      'is consumed by a %s of the owning application on every prefix, then follows the route',
      async (credential) => {
        const fault = await arm(selector.method, path(), { times: 3 })
        expect(fault.guild_id).toBe(GUILD)
        for (const prefix of ['/api/v10', '/api', '']) {
          const response = await send(authorization(credential), prefix)
          expect(response.status).toBe(500)
          await expect(response.json()).resolves.toEqual({
            code: 0,
            message: 'Internal Server Error',
          })
        }
        expect(await control(fault.id)).toMatchObject({
          remaining: 0,
          consumed: 3,
        })
        // The fourth attempt reaches the native route, never the fault.
        expect(await code(send(authorization(credential)))).not.toBe(500)
        expect(await control(fault.id)).toMatchObject({ consumed: 3 })
      }
    )

    it('carries a rich HTTP error through unchanged', async () => {
      await arm(selector.method, path(), {
        status: 403,
        code: 50_013,
        message: 'Missing Permissions',
      })
      const response = await send('Bearer user-owner')
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        code: 50_013,
        message: 'Missing Permissions',
      })
    })

    it('is not consumed by a Bearer token of another client', async () => {
      const fault = await arm(selector.method, path())
      const response = await send('Bearer user-other')
      expect(response.status).not.toBe(500)
      expect(await control(fault.id)).toMatchObject({
        remaining: 1,
        consumed: 0,
      })
      expect(await code(send(OWNER))).toBe(500)
      expect(await control(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 1,
      })
    })

    it('is not consumed by another bot or an expired Bearer token', async () => {
      const fault = await arm(selector.method, path())
      db.prepare(
        `UPDATE oauth2_access_tokens SET expires_at = datetime('now', '-1 day')
         WHERE token = 'app-owner'`
      ).run()
      expect(await send(OTHER)).not.toMatchObject({ status: 500 })
      expect(await code(send('Bearer app-owner'))).toBe(401)
      expect(await control(fault.id)).toMatchObject({
        remaining: 1,
        consumed: 0,
      })
    })

    it('rejects arming for another application, guild or unknown scope', async () => {
      const guildOnly = selector.path(commandId).startsWith('/guilds/')
      const unknown = '999999999999999999'
      // A guild that does not exist is unknown for every selector; the
      // application must also be the one owning the guild.
      const foreign = [
        selector.path(commandId, APP, unknown),
        ...(guildOnly
          ? []
          : [
              selector.path(commandId, APP, OTHER_GUILD),
              selector.path(commandId, OTHER_APP, GUILD),
              selector.path(commandId, unknown, GUILD),
            ]),
      ]
      for (const missing of foreign) {
        const response = await request('/_test/rest-faults', 'POST', {
          method: selector.method,
          path: missing,
          ...failure,
        })
        expect(response.status).toBe(404)
      }
    })

    it('rejects a guild_id that differs from the path guild', async () => {
      const response = await request('/_test/rest-faults', 'POST', {
        method: selector.method,
        path: path(),
        guild_id: OTHER_GUILD,
        ...failure,
      })
      expect(response.status).toBe(400)
      const matching = await request('/_test/rest-faults', 'POST', {
        method: selector.method,
        path: path(),
        guild_id: GUILD,
        ...failure,
      })
      expect(matching.status).toBe(201)
    })

    it('conflicts with an active control for the same selector only', async () => {
      await arm(selector.method, path())
      const duplicate = await request('/_test/rest-faults', 'POST', {
        method: selector.method,
        path: path(),
        ...failure,
      })
      expect(duplicate.status).toBe(409)
    })

    it('is removed with its guild by a scoped reset, a global reset and setup deletion', async () => {
      for (const action of ['scoped', 'global', 'setup'] as const) {
        const fault = await arm(selector.method, path())
        if (action === 'setup') {
          const response = await server.app.request(
            `/_test/setup/${encodeURIComponent(OWNER)}`,
            { method: 'DELETE' }
          )
          expect(response.status).toBeLessThan(300)
        } else {
          const response = await request('/_test/reset', 'POST', {
            ...(action === 'scoped' && { token: OWNER }),
          })
          expect(response.status).toBe(204)
        }
        expect(await code(request(`/_test/rest-faults/${fault.id}`))).toBe(404)
        if (action === 'setup') break
        expect(await code(send(OWNER))).not.toBe(500)
      }
    })

    it('keeps another bot’s controls on a scoped reset', async () => {
      const fault = await arm(selector.method, path())
      const response = await request('/_test/reset', 'POST', { token: OTHER })
      expect(response.status).toBe(204)
      expect(await control(fault.id)).toMatchObject({ remaining: 1 })
    })
  })

  describe('failed writes', () => {
    it('leaves stored permissions unchanged when PUT permissions is faulted', async () => {
      // A user-bound token must be authorized as its user: make it the owner.
      db.prepare(
        "INSERT OR IGNORE INTO users (id, username, discriminator, bot) VALUES ('555555555555555551', 'Owner', '0', 0)"
      ).run()
      db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(
        '555555555555555551',
        GUILD
      )
      /** Replaces the command permissions as the given caller. */
      const put = (permission: boolean, auth: string): Promise<Response> =>
        request(
          `${COMMANDS}/${commandId}/permissions`,
          'PUT',
          { permissions: [{ id: GUILD, type: 1, permission }] },
          auth
        )
      expect(await code(put(true, 'Bearer user-owner'))).toBe(200)
      const before = commandState()
      const fault = await arm('PUT', `${COMMANDS}/${commandId}/permissions`)
      const failed = await put(false, 'Bearer user-owner')
      expect(failed.status).toBe(500)
      expect(commandState()).toEqual(before)
      expect(await control(fault.id)).toMatchObject({ consumed: 1 })

      expect(await code(put(false, 'Bearer user-owner'))).toBe(200)
      expect(commandState()).not.toEqual(before)
    })

    it('leaves stored commands unchanged when the bulk overwrite is faulted', async () => {
      const before = commandState()
      await arm('PUT', COMMANDS)
      /** Bulk-overwrites the guild commands as the given caller. */
      const overwrite = (auth: string): Promise<Response> =>
        request(
          COMMANDS,
          'PUT',
          [{ name: 'replacement', description: 'Replacement' }],
          auth
        )
      expect(await code(overwrite(OWNER))).toBe(500)
      expect(commandState()).toEqual(before)

      const success = await overwrite(OWNER)
      expect(success.status).toBe(200)
      expect(commandState()).not.toEqual(before)
    })
  })

  describe('explicit modes', () => {
    it('answers rate_limit with Retry-After for a Bearer caller', async () => {
      const path = `${COMMANDS}/${commandId}/permissions`
      const fault = await arm('GET', path, {
        mode: 'rate_limit',
        retry_after: 2,
        status: undefined,
      })
      const response = await request(path, 'GET', undefined, 'Bearer app-owner')
      expect(response.status).toBe(429)
      expect(response.headers.get('Retry-After')).toBe('2')
      await expect(response.json()).resolves.toMatchObject({ retry_after: 2 })
      expect(await control(fault.id)).toMatchObject({
        consumed: 1,
        outcomes: { responded: 1 },
      })
      expect(
        await code(request(path, 'GET', undefined, 'Bearer app-owner'))
      ).toBe(200)
    })

    it('delays a faulted bulk overwrite and never runs the route afterwards', async () => {
      const before = commandState()
      const fault = await arm('PUT', COMMANDS, {
        mode: 'delay',
        delay_ms: 20,
        status: 503,
      })
      const started = Date.now()
      const response = await request(
        COMMANDS,
        'PUT',
        [{ name: 'delayed', description: 'Delayed' }],
        'Bearer user-owner'
      )
      expect(Date.now() - started).toBeGreaterThanOrEqual(15)
      expect(response.status).toBe(503)
      expect(commandState()).toEqual(before)
      expect(await control(fault.id)).toMatchObject({
        consumed: 1,
        outcomes: { delayed: 1, responded: 1, pending: 0 },
      })
    })

    it('does not let another bot or client consume an explicit mode', async () => {
      const fault = await arm('GET', `/guilds/${GUILD}/roles`, {
        mode: 'delay',
        delay_ms: 5,
      })
      expect(
        await code(request(`/guilds/${GUILD}/roles`, 'GET', undefined, OTHER))
      ).not.toBe(500)
      expect(
        await code(
          request(
            `/guilds/${GUILD}/roles`,
            'GET',
            undefined,
            'Bearer user-other'
          )
        )
      ).not.toBe(500)
      expect(await control(fault.id)).toMatchObject({ consumed: 0 })
    })
  })

  describe('existing selectors', () => {
    it('are still not consumable with a Bearer token', async () => {
      const fault = await arm('GET', `/guilds/${GUILD}/channels`)
      await request(
        `/guilds/${GUILD}/channels`,
        'GET',
        undefined,
        'Bearer app-owner'
      )
      expect(await control(fault.id)).toMatchObject({
        consumed: 0,
        remaining: 1,
      })
      expect(await code(request(`/guilds/${GUILD}/channels`))).toBe(500)
    })
  })
})

describe('application command REST faults over real HTTP', () => {
  let real: RealServerContext

  beforeEach(async () => {
    real = await createRealServer()
    seedBot(real.db, OWNER, APP)
    seedGuild(real.db, OWNER, GUILD)
    real.db
      .prepare(
        'INSERT INTO oauth2_clients (client_id, client_secret) VALUES (?, ?)'
      )
      .run(APP, 'secret')
    real.db
      .prepare(
        `INSERT INTO oauth2_access_tokens (token, client_id, user_id, scope, expires_at)
         VALUES ('real-bearer', ?, NULL, ?, datetime('now', '+1 day'))`
      )
      .run(APP, SCOPE)
  })

  afterEach(async () => {
    await real.close()
  })

  it('destroys the socket of a Bearer request when the control is a disconnect', async () => {
    const path = `${COMMANDS}/${seedApplicationCommand(real.db, APP, GUILD)}/permissions`
    const armed = await fetch(`${real.baseUrl}/_test/rest-faults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'PUT', path, mode: 'disconnect' }),
    })
    expect(armed.status).toBe(201)
    const { id } = (await armed.json()) as { id: string }
    /** Sends the selected Bearer request over the real socket. */
    const attempt = (): Promise<Response> =>
      fetch(`${real.baseUrl}${path}`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer real-bearer',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ permissions: [] }),
        signal: AbortSignal.timeout(3000),
      })
    await expect(attempt()).rejects.toThrow()
    const inspected = await fetch(`${real.baseUrl}/_test/rest-faults/${id}`)
    const state = (await inspected.json()) as Record<string, unknown>
    expect(state).toMatchObject({
      consumed: 1,
      remaining: 0,
      outcomes: { disconnected: 1 },
    })
    expect(await code(attempt())).toBe(200)
  })
})
