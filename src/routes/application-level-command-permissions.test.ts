import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFullTestApp, seedBot, seedGuild } from '../test-helpers'
import type { FullTestContext } from '../test-helpers'
import type { TokenResponse } from '../services/oauth2'

const APP_ID = '111111111111111111'
const GUILD = '222222222222222222'
const BOT_TOKEN = 'Bot app-level-permissions-test'
const SCOPE = 'applications.commands.permissions.update'
const MANAGE_GUILD = 1n << 5n
const MANAGE_ROLES = 1n << 28n
const MANAGE_BOTH = MANAGE_GUILD | MANAGE_ROLES
const OVERRIDES = [{ id: '888888888888888888', type: 2, permission: true }]

/** Resolves a (possibly synchronous) response to its HTTP status. */
async function statusOf(
  response: Promise<Response> | Response
): Promise<number> {
  const resolved = await response
  return resolved.status
}

/** A command permission entry. */
interface Entry {
  id: string
  type: number
  permission: boolean
}

describe('application-level command permissions', () => {
  let context: FullTestContext
  let nextId = 0

  /** Permissions route of a command (or the application) in the guild. */
  function url(id: string): string {
    return `/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands/${id}/permissions`
  }

  /** Inserts a role; positions are explicit and IDs ascend per call. */
  function role(position: number, permissions = 0n): string {
    const id = `70000000000000${String(nextId++).padStart(4, '0')}`
    context.db
      .prepare(
        `INSERT INTO roles (id, guild_id, name, position, permissions)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, GUILD, `role-${id}`, position, String(permissions))
    return id
  }

  /** Registers a human who joined the guild with the given roles. */
  function member(roles: string[] = []): string {
    const id = `80000000000000${String(nextId++).padStart(4, '0')}`
    context.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'Dash', '0', 0)"
      )
      .run(id)
    context.db
      .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
      .run(GUILD, id)
    for (const roleId of roles)
      context.db
        .prepare(
          'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
        )
        .run(GUILD, id, roleId)
    return id
  }

  /** Registers a human who is not in the guild. */
  function outsider(): string {
    const id = `90000000000000${String(nextId++).padStart(4, '0')}`
    context.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'Out', '0', 0)"
      )
      .run(id)
    return id
  }

  /** Issues a user-bound Bearer credential through the test control. */
  async function bearer(userId: string): Promise<string> {
    const response = await context.app.request('/_test/oauth2/tokens', {
      method: 'POST',
      body: JSON.stringify({
        client_id: APP_ID,
        user_id: userId,
        scope: SCOPE,
      }),
    })
    expect(response.status).toBe(201)
    return `Bearer ${((await response.json()) as TokenResponse).access_token}`
  }

  /** Creates a guild command, optionally with default_member_permissions. */
  async function createCommand(
    name: string,
    defaultMemberPermissions?: string
  ): Promise<string> {
    const response = await context.app.request(
      `/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands`,
      {
        method: 'POST',
        headers: { Authorization: BOT_TOKEN },
        body: JSON.stringify({
          name,
          description: 'd',
          ...(defaultMemberPermissions !== undefined && {
            default_member_permissions: defaultMemberPermissions,
          }),
        }),
      }
    )
    return ((await response.json()) as { id: string }).id
  }

  /** PUTs permissions with the given credentials. */
  function put(
    authorization: string,
    target: string,
    permissions: unknown = OVERRIDES
  ): Promise<Response> | Response {
    return context.app.request(url(target), {
      method: 'PUT',
      headers: { Authorization: authorization },
      body: JSON.stringify({ permissions }),
    })
  }

  /** Stores permissions as the owning bot. */
  async function store(target: string, permissions: Entry[]): Promise<void> {
    const response = await put(BOT_TOKEN, target, permissions)
    expect(response.status).toBe(200)
  }

  /** Reads stored permissions as the owning bot. */
  async function stored(target: string): Promise<unknown> {
    const response = await context.app.request(url(target), {
      headers: { Authorization: BOT_TOKEN },
    })
    return ((await response.json()) as { permissions: unknown }).permissions
  }

  /** Asserts a 403 / 50013 response that left the stored list alone. */
  async function expectDenied(
    response: Response,
    target: string,
    before: unknown = []
  ): Promise<void> {
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      message: 'Missing Permissions',
      code: 50_013,
    })
    expect(await stored(target)).toEqual(before)
  }

  beforeEach(() => {
    context = createFullTestApp()
    seedBot(context.db, BOT_TOKEN, APP_ID)
    seedGuild(context.db, BOT_TOKEN, GUILD)
  })

  afterEach(() => {
    context.cleanup()
  })

  describe('storing and reading', () => {
    it('reads an empty list before any is set', async () => {
      const response = await context.app.request(url(APP_ID), {
        headers: { Authorization: BOT_TOKEN },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        id: APP_ID,
        application_id: APP_ID,
        guild_id: GUILD,
        permissions: [],
      })
    })

    it('stores the list with PUT and returns it from GET', async () => {
      const put1 = await put(BOT_TOKEN, APP_ID)
      expect(put1.status).toBe(200)
      await expect(put1.json()).resolves.toEqual({
        id: APP_ID,
        application_id: APP_ID,
        guild_id: GUILD,
        permissions: OVERRIDES,
      })
      expect(await stored(APP_ID)).toEqual(OVERRIDES)

      await store(APP_ID, [{ id: GUILD, type: 1, permission: false }])
      expect(await stored(APP_ID)).toEqual([
        { id: GUILD, type: 1, permission: false },
      ])
    })

    it('works under every route prefix', async () => {
      await store(APP_ID, OVERRIDES)
      for (const prefix of ['/api', '']) {
        const response = await context.app.request(
          `${prefix}/applications/${APP_ID}/guilds/${GUILD}/commands/${APP_ID}/permissions`,
          { headers: { Authorization: BOT_TOKEN } }
        )
        expect(response.status).toBe(200)
      }
    })

    it('keeps the list separate from command overwrites', async () => {
      const commandId = await createCommand('ban')
      await store(APP_ID, OVERRIDES)
      expect(await stored(commandId)).toEqual([])
      await store(commandId, [{ id: GUILD, type: 1, permission: false }])
      expect(await stored(APP_ID)).toEqual(OVERRIDES)
    })

    it('lists the application entry in the guild listing only when non-empty', async () => {
      const commandId = await createCommand('ban')
      const list = async (): Promise<{ id: string }[]> => {
        const response = await context.app.request(
          `/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands/permissions`,
          { headers: { Authorization: BOT_TOKEN } }
        )
        return (await response.json()) as { id: string }[]
      }
      expect(await list()).toEqual([])

      await store(APP_ID, OVERRIDES)
      await store(commandId, [{ id: GUILD, type: 1, permission: true }])
      const entries = await list()
      expect(new Set(entries.map((entry) => entry.id))).toEqual(
        new Set([APP_ID, commandId])
      )
      expect(entries.find((entry) => entry.id === APP_ID)).toEqual({
        id: APP_ID,
        application_id: APP_ID,
        guild_id: GUILD,
        permissions: OVERRIDES,
      })

      await store(APP_ID, [])
      const remaining = await list()
      expect(remaining.map((entry) => entry.id)).toEqual([commandId])
    })

    it('validates the payload and still 404s unknown commands', async () => {
      const invalid = await put(BOT_TOKEN, APP_ID, 'nope')
      expect(invalid.status).toBe(400)
      const unknown = await put(BOT_TOKEN, '999999999999999999')
      expect(unknown.status).toBe(404)
    })

    it('denies another application and an unknown guild', async () => {
      const other = await context.app.request(
        `/api/v10/applications/333333333333333333/guilds/${GUILD}/commands/333333333333333333/permissions`,
        { headers: { Authorization: BOT_TOKEN } }
      )
      expect(other.status).toBe(403)
      const unknownGuild = await context.app.request(
        `/api/v10/applications/${APP_ID}/guilds/999999999999999999/commands/${APP_ID}/permissions`,
        { headers: { Authorization: BOT_TOKEN } }
      )
      expect(unknownGuild.status).toBe(404)
    })

    it('is removed with the guild', async () => {
      await store(APP_ID, OVERRIDES)
      context.db.prepare('DELETE FROM guilds WHERE id = ?').run(GUILD)
      expect(
        context.db
          .prepare('SELECT COUNT(*) FROM application_level_command_permissions')
          .pluck()
          .get()
      ).toBe(0)
    })
  })

  describe('canRunCommand through a command edit', () => {
    let commandId: string

    beforeEach(async () => {
      commandId = await createCommand('lock', '0')
    })

    it('lets a manager allowed only by an application-level role entry edit a command without own overwrites', async () => {
      const allowRole = role(1, MANAGE_BOTH)
      const editor = member([allowRole])
      await store(APP_ID, [{ id: allowRole, type: 1, permission: true }])
      const response = await put(await bearer(editor), commandId)
      expect(response.status).toBe(200)
      expect(await stored(commandId)).toEqual(OVERRIDES)
    })

    it('rejects the same manager when the command has its own unrelated overwrites', async () => {
      const allowRole = role(1, MANAGE_BOTH)
      const editor = member([allowRole])
      await store(APP_ID, [{ id: allowRole, type: 1, permission: true }])
      const own = [{ id: '333333333333333333', type: 3, permission: false }]
      await store(commandId, own)
      await expectDenied(
        await put(await bearer(editor), commandId),
        commandId,
        own
      )
    })

    it('treats an emptied command list as having no overwrites', async () => {
      const allowRole = role(1, MANAGE_BOTH)
      const editor = member([allowRole])
      await store(APP_ID, [{ id: allowRole, type: 1, permission: true }])
      await store(commandId, [{ id: role(2), type: 1, permission: false }])
      await store(commandId, [])
      expect(await statusOf(put(await bearer(editor), commandId, []))).toBe(200)
    })

    it('lets the user entry beat role entries', async () => {
      const allowRole = role(1, MANAGE_BOTH)
      const editor = member([allowRole])
      const before = [
        { id: editor, type: 2, permission: false },
        { id: allowRole, type: 1, permission: true },
      ]
      await store(APP_ID, before)
      await expectDenied(
        await put(await bearer(editor), commandId, []),
        commandId
      )

      await store(APP_ID, [
        { id: editor, type: 2, permission: true },
        { id: allowRole, type: 1, permission: false },
      ])
      expect(await statusOf(put(await bearer(editor), commandId, []))).toBe(200)
    })

    it('denies when only role denies match, and lets any allow win', async () => {
      const denyRole = role(1, MANAGE_BOTH)
      const allowRole = role(2)
      const editor = member([denyRole])
      await store(APP_ID, [
        { id: denyRole, type: 1, permission: false },
        { id: allowRole, type: 1, permission: true },
      ])
      await expectDenied(
        await put(await bearer(editor), commandId, []),
        commandId
      )

      const both = member([denyRole, allowRole])
      expect(await statusOf(put(await bearer(both), commandId, []))).toBe(200)
    })

    it('applies the @everyone entry when no user or role entry matches', async () => {
      const editor = member([role(1, MANAGE_BOTH)])
      await store(APP_ID, [{ id: GUILD, type: 1, permission: true }])
      expect(await statusOf(put(await bearer(editor), commandId, []))).toBe(200)

      await store(APP_ID, [{ id: GUILD, type: 1, permission: false }])
      await expectDenied(
        await put(await bearer(editor), commandId, []),
        commandId
      )
    })

    it('lets an @everyone deny stand over a permissive default', async () => {
      const open = await createCommand('open')
      const editor = member([role(1, MANAGE_BOTH)])
      await store(APP_ID, [{ id: GUILD, type: 1, permission: false }])
      await expectDenied(await put(await bearer(editor), open, []), open)
    })

    it('falls back to default_member_permissions when no entry applies', async () => {
      const editor = member([role(1, MANAGE_BOTH)])
      await store(APP_ID, [
        { id: role(2), type: 1, permission: true },
        { id: '333333333333333333', type: 3, permission: true },
      ])
      await expectDenied(
        await put(await bearer(editor), commandId, []),
        commandId
      )

      const open = await createCommand('open')
      expect(await statusOf(put(await bearer(editor), open, []))).toBe(200)

      const needsBits = await createCommand('bits', String(MANAGE_BOTH))
      expect(await statusOf(put(await bearer(editor), needsBits, []))).toBe(200)
    })

    it('lets the owner and Administrators pass despite a deny', async () => {
      await store(APP_ID, [{ id: GUILD, type: 1, permission: false }])
      const owner = outsider()
      context.db.prepare('UPDATE guilds SET owner_id = ?').run(owner)
      expect(await statusOf(put(await bearer(owner), commandId, []))).toBe(200)

      const admin = member([role(1, 1n << 3n)])
      expect(await statusOf(put(await bearer(admin), commandId, []))).toBe(200)
    })
  })

  describe('editing the application-level list with a user-bound token', () => {
    it('skips the can-run check', async () => {
      // Nothing allows or denies this user, and no command exists to run.
      const editor = member([role(1, MANAGE_BOTH)])
      await store(APP_ID, [{ id: GUILD, type: 1, permission: false }])
      const response = await put(await bearer(editor), APP_ID)
      expect(response.status).toBe(200)
      expect(await stored(APP_ID)).toEqual(OVERRIDES)
    })

    it('still requires Manage Guild and Manage Roles, or the owner or an Administrator', async () => {
      const weak = member([role(1, MANAGE_GUILD)])
      await expectDenied(await put(await bearer(weak), APP_ID), APP_ID)

      const stranger = outsider()
      await expectDenied(await put(await bearer(stranger), APP_ID), APP_ID)

      const admin = member([role(2, 1n << 3n)])
      expect(await statusOf(put(await bearer(admin), APP_ID))).toBe(200)
    })

    it('enforces the role hierarchy of payload entries', async () => {
      const mine = role(5, MANAGE_BOTH)
      const editor = member([mine])
      const token = await bearer(editor)
      const allowed = await put(token, APP_ID, [
        { id: role(1), type: 1, permission: true },
        { id: GUILD, type: 1, permission: false },
      ])
      expect(allowed.status).toBe(200)
      const before = await stored(APP_ID)

      for (const id of [mine, role(9), '700000000000000777'])
        await expectDenied(
          await put(token, APP_ID, [{ id, type: 1, permission: true }]),
          APP_ID,
          before
        )
    })

    it('exempts the owner from the hierarchy but not from existence', async () => {
      const owner = outsider()
      context.db.prepare('UPDATE guilds SET owner_id = ?').run(owner)
      const token = await bearer(owner)
      const allowed = await put(token, APP_ID, [
        { id: role(99), type: 1, permission: true },
      ])
      expect(allowed.status).toBe(200)
      const before = await stored(APP_ID)
      await expectDenied(
        await put(token, APP_ID, [
          { id: '700000000000000777', type: 1, permission: true },
        ]),
        APP_ID,
        before
      )
    })

    it('keeps bot and client-credentials access unchanged', async () => {
      expect(await statusOf(put(BOT_TOKEN, APP_ID))).toBe(200)

      const response = await context.app.request('/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP_ID,
          scope: SCOPE,
        }),
      })
      const { access_token: accessToken } =
        (await response.json()) as TokenResponse
      const result = await put(`Bearer ${accessToken}`, APP_ID, [])
      expect(result.status).toBe(200)
      expect(await stored(APP_ID)).toEqual([])
    })
  })
})
