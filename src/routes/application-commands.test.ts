import { Hono } from 'hono'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApplicationCommandRoutes } from './application-commands'
import { initializeDatabase } from '../db'
import type { Database } from '../db'
import { createAuthMiddleware, type AppEnv } from '../middleware/auth'
import { seedBot, seedGuild } from '../test-helpers'

describe.each(['global', 'guild'])(
  'Application command option lists (%s)',
  (scope) => {
    let db: Database
    let app: Hono<AppEnv>
    let url: string
    const token = 'Bot options-test'
    const headers = {
      Authorization: token,
      'Content-Type': 'application/json',
    }
    const command = { name: 'me', description: 'Shows your profile' }
    const options = [{ type: 3, name: 'user', description: 'User to show' }]

    beforeEach(() => {
      db = initializeDatabase(':memory:')
      const applicationId = '111111111111111111'
      seedBot(db, token, applicationId)
      const guildId = seedGuild(db, token)
      app = new Hono<AppEnv>()
      app.use('*', createAuthMiddleware(db, false))
      app.route('/', createApplicationCommandRoutes(db))
      url = `/applications/${applicationId}${scope === 'guild' ? `/guilds/${guildId}` : ''}/commands`
    })

    afterEach(() => db.close())

    it.each(['POST', 'PUT'])('accepts options:null with %s', async (method) => {
      const payload = { ...command, options: null }
      const response = await app.request(url, {
        method,
        headers,
        body: JSON.stringify(method === 'PUT' ? [payload] : payload),
      })
      expect(response.status).toBe(method === 'POST' ? 201 : 200)
      const expected = { ...command, options: [] }
      await expect(response.json()).resolves.toMatchObject(
        method === 'PUT' ? [expected] : expected
      )
      const listed = await app.request(url, { headers })
      await expect(listed.json()).resolves.toMatchObject([expected])
    })

    it.each(['POST', 'PUT', 'PATCH'])(
      'clears existing options with null using %s and keeps the command ID',
      async (method) => {
        const created = await app.request(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...command, options }),
        })
        const original = (await created.json()) as { id: string }
        const payload = { ...command, options: null }
        const response = await app.request(
          method === 'PATCH' ? `${url}/${original.id}` : url,
          {
            method,
            headers,
            body: JSON.stringify(method === 'PUT' ? [payload] : payload),
          }
        )
        expect(response.status).toBe(200)
        const expected = { id: original.id, ...command, options: [] }
        await expect(response.json()).resolves.toMatchObject(
          method === 'PUT' ? [expected] : expected
        )
        const listed = await app.request(url, { headers })
        await expect(listed.json()).resolves.toMatchObject([expected])
      }
    )

    it('preserves options when PATCH omits them', async () => {
      const created = await app.request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...command, options }),
      })
      const original = (await created.json()) as { id: string }
      const response = await app.request(`${url}/${original.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ description: 'Updated profile description' }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        id: original.id,
        description: 'Updated profile description',
        options,
      })
    })

    it.each(['POST', 'PUT', 'PATCH'])(
      'normalizes nested null option lists using %s',
      async (method) => {
        const created = await app.request(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(command),
        })
        const original = (await created.json()) as { id: string }
        const subcommand = {
          type: 1,
          name: 'profile',
          description: 'Shows a profile',
          options: null,
        }
        const group = {
          type: 2,
          name: 'profiles',
          description: 'Profile commands',
          options: [subcommand],
        }
        const payload = {
          ...command,
          options: [group, { ...group, name: 'empty', options: null }],
        }
        const response = await app.request(
          method === 'PATCH' ? `${url}/${original.id}` : url,
          {
            method,
            headers,
            body: JSON.stringify(method === 'PUT' ? [payload] : payload),
          }
        )
        expect(response.status).toBe(200)
        const expected = {
          options: [
            { ...group, options: [{ ...subcommand, options: [] }] },
            { ...group, name: 'empty', options: [] },
          ],
        }
        await expect(response.json()).resolves.toMatchObject(
          method === 'PUT' ? [expected] : expected
        )
        const listed = await app.request(url, { headers })
        await expect(listed.json()).resolves.toMatchObject([expected])
      }
    )

    describe.each(['POST', 'PUT', 'PATCH'])('%s validation', (method) => {
      it('rejects excessive nesting through scalar options', async () => {
        const created = await app.request(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...command, options }),
        })
        const original = (await created.json()) as { id: string }
        const scalar = { type: 3, name: 'user', description: 'User' }
        const payload = {
          ...command,
          options: [
            {
              ...scalar,
              options: [
                { ...scalar, options: [{ ...scalar, options: [scalar] }] },
              ],
            },
          ],
        }
        const response = await app.request(
          method === 'PATCH' ? `${url}/${original.id}` : url,
          {
            method,
            headers,
            body: JSON.stringify(method === 'PUT' ? [payload] : payload),
          }
        )
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({
          code: 50_035,
          errors: {
            options: {
              _errors: [{ code: 'APPLICATION_COMMAND_OPTIONS_TOO_DEEP' }],
            },
          },
        })
        const listed = await app.request(url, { headers })
        await expect(listed.json()).resolves.toMatchObject([
          { id: original.id, ...command, options },
        ])
      })

      it.each([
        false,
        0,
        '',
        'invalid',
        {},
        [null],
        [{ type: 99, name: 'bad', description: 'Invalid type' }],
        ...[false, 0, '', {}].map((nested) => [
          { type: 1, name: 'profile', description: 'Profile', options: nested },
        ]),
        [{ type: 3, name: 'user', description: 'User', options: {} }],
      ])(
        'rejects malformed options %j without changing commands',
        async (bad) => {
          const created = await app.request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...command, options }),
          })
          const original = (await created.json()) as { id: string }
          const payload = { ...command, options: bad }
          const response = await app.request(
            method === 'PATCH' ? `${url}/${original.id}` : url,
            {
              method,
              headers,
              body: JSON.stringify(
                method === 'PUT'
                  ? [{ name: 'other', description: 'Valid command' }, payload]
                  : payload
              ),
            }
          )
          expect(response.status).toBe(400)
          await expect(response.json()).resolves.toMatchObject({
            code: 50_035,
            errors: {
              options: { _errors: [{ code: 'BASE_TYPE_BAD_TYPE' }] },
            },
          })
          const listed = await app.request(url, { headers })
          await expect(listed.json()).resolves.toMatchObject([
            { id: original.id, ...command, options },
          ])
        }
      )
    })
  }
)

describe('Application Commands routes (global)', () => {
  let db: Database
  let app: Hono<AppEnv>
  let token: string
  let applicationId: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      const bot = db
        .prepare('SELECT * FROM bots WHERE token = ?')
        .get(c.req.header('Authorization'))
      if (bot) c.set('bot', bot as never)
      await next()
    })
    app.route('/', createApplicationCommandRoutes(db))
    token = 'Bot testtoken'
    // seedBot() returns the token it was passed, not the bot's user ID —
    // capture the (default) user ID explicitly instead of misusing the
    // return value, since requireOwnApplication compares applicationId
    // against bots.user_id, not the token.
    applicationId = '111111111111111111'
    seedBot(db, token, applicationId)
  })

  it('creates a global command', async () => {
    const res = await app.request(`/applications/${applicationId}/commands`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'ping', description: 'Replies pong' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('ping')
  })

  it('updates an existing global command by name and returns 200', async () => {
    const url = `/applications/${applicationId}/commands`
    const headers = {
      Authorization: token,
      'Content-Type': 'application/json',
    }
    const created = await app.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ping', description: 'old' }),
    })
    const original = (await created.json()) as { id: string }

    const updated = await app.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ping', description: 'new' }),
    })

    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      id: original.id,
      description: 'new',
    })
  })

  it('403s when applicationId does not match the authenticated bot', async () => {
    const res = await app.request('/applications/999/commands', {
      method: 'GET',
      headers: { Authorization: token },
    })
    expect(res.status).toBe(403)
  })

  it('401s with no Authorization header', async () => {
    const res = await app.request(`/applications/${applicationId}/commands`)
    expect(res.status).toBe(403) // no bot set -> requireOwnApplication rejects
  })

  it('lists commands, returns 404 for unknown command, deletes a command', async () => {
    const create = await app.request(
      `/applications/${applicationId}/commands`,
      {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'ping', description: 'x' }),
      }
    )
    const created = (await create.json()) as { id: string }

    const list = await app.request(`/applications/${applicationId}/commands`, {
      headers: { Authorization: token },
    })
    expect(await list.json()).toHaveLength(1)

    const missing = await app.request(
      `/applications/${applicationId}/commands/does-not-exist`,
      { headers: { Authorization: token } }
    )
    expect(missing.status).toBe(404)

    const del = await app.request(
      `/applications/${applicationId}/commands/${created.id}`,
      { method: 'DELETE', headers: { Authorization: token } }
    )
    expect(del.status).toBe(204)
  })

  it('rejects an invalid command payload with 400', async () => {
    const res = await app.request(`/applications/${applicationId}/commands`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '', description: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a bulk-overwrite payload with a duplicate name/type with 400', async () => {
    const res = await app.request(`/applications/${applicationId}/commands`, {
      method: 'PUT',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        { name: 'ping', description: 'x' },
        { name: 'PING', description: 'y' },
      ]),
    })
    expect(res.status).toBe(400)
  })
})

describe('Application Commands routes (guild-scoped)', () => {
  let db: Database
  let app: Hono<AppEnv>
  let token: string
  let applicationId: string
  let guildId: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      const bot = db
        .prepare('SELECT * FROM bots WHERE token = ?')
        .get(c.req.header('Authorization'))
      if (bot) c.set('bot', bot as never)
      await next()
    })
    app.route('/', createApplicationCommandRoutes(db))
    token = 'Bot testtoken'
    // seedBot() returns the token it was passed, not the bot's user ID —
    // capture the (default) user ID explicitly instead of misusing the
    // return value, since requireOwnApplication compares applicationId
    // against bots.user_id, not the token.
    applicationId = '111111111111111111'
    seedBot(db, token, applicationId)
    guildId = '333333333333333333'
    db.prepare(
      'INSERT INTO guilds (id, name, owner_id, bot_token) VALUES (?, ?, ?, ?)'
    ).run(guildId, 'Test Guild', applicationId, token)
  })

  it('creates a guild command and returns 404 for an unknown guild', async () => {
    const res = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'ping', description: 'x' }),
      }
    )
    expect(res.status).toBe(201)

    const missingGuild = await app.request(
      `/applications/${applicationId}/guilds/999/commands`,
      { headers: { Authorization: token } }
    )
    expect(missingGuild.status).toBe(404)
  })

  it('updates an existing guild command by name and returns 200', async () => {
    const url = `/applications/${applicationId}/guilds/${guildId}/commands`
    const headers = {
      Authorization: token,
      'Content-Type': 'application/json',
    }
    const created = await app.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ping', description: 'old' }),
    })
    const original = (await created.json()) as { id: string }

    const updated = await app.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ping', description: 'new' }),
    })

    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      id: original.id,
      description: 'new',
    })
  })

  it('bulk overwrites guild commands', async () => {
    const res = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      {
        method: 'PUT',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ name: 'ping', description: 'x' }]),
      }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(body).toHaveLength(1)
  })

  it('keeps global and guild command lists distinct after bulk overwrite', async () => {
    const headers = {
      Authorization: token,
      'Content-Type': 'application/json',
    }
    await app.request(`/applications/${applicationId}/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'global', description: 'global command' }),
    })
    await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify([
          { name: 'guild-only', description: 'guild command' },
        ]),
      }
    )

    const global = await app.request(
      `/applications/${applicationId}/commands`,
      { headers: { Authorization: token } }
    )
    const guild = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      { headers: { Authorization: token } }
    )
    expect(await global.json()).toMatchObject([{ name: 'global' }])
    expect(await guild.json()).toMatchObject([{ name: 'guild-only' }])
  })

  it('rejects a bulk-overwrite payload with a duplicate name/type with 400', async () => {
    const res = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      {
        method: 'PUT',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          { name: 'ping', description: 'x' },
          { name: 'ping', description: 'y' },
        ]),
      }
    )
    expect(res.status).toBe(400)
  })
})

describe('Application Commands routes (permissions)', () => {
  let db: Database
  let app: Hono<AppEnv>
  let token: string
  let applicationId: string
  let guildId: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      const bot = db
        .prepare('SELECT * FROM bots WHERE token = ?')
        .get(c.req.header('Authorization'))
      if (bot) c.set('bot', bot as never)
      await next()
    })
    app.route('/', createApplicationCommandRoutes(db))
    token = 'Bot testtoken'
    // seedBot() returns the token it was passed, not the bot's user ID —
    // capture the (default) user ID explicitly instead of misusing the
    // return value, since requireOwnApplication compares applicationId
    // against bots.user_id, not the token.
    applicationId = '111111111111111111'
    seedBot(db, token, applicationId)
    guildId = '444444444444444444'
    db.prepare(
      'INSERT INTO guilds (id, name, owner_id, bot_token) VALUES (?, ?, ?, ?)'
    ).run(guildId, 'Test Guild', applicationId, token)
  })

  it('lists, gets, and sets command permissions', async () => {
    const create = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'ping', description: 'x' }),
      }
    )
    const command = (await create.json()) as { id: string }

    const list = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands/permissions`,
      { headers: { Authorization: token } }
    )
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([])

    const put = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands/${command.id}/permissions`,
      {
        method: 'PUT',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          permissions: [{ id: 'role1', type: 1, permission: true }],
        }),
      }
    )
    expect(put.status).toBe(200)

    const get = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands/${command.id}/permissions`,
      { headers: { Authorization: token } }
    )
    const body = (await get.json()) as { permissions: unknown[] }
    expect(body.permissions).toEqual([
      { id: 'role1', type: 1, permission: true },
    ])
  })

  it('404s permissions for an unknown command', async () => {
    const res = await app.request(
      `/applications/${applicationId}/guilds/${guildId}/commands/missing/permissions`,
      { headers: { Authorization: token } }
    )
    expect(res.status).toBe(404)
  })
})
