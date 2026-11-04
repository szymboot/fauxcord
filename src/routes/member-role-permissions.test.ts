import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app'
import { closeDatabase, initializeDatabase, type Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import { outranksRole } from '../services/member-role-permissions'
import {
  seedBearerCredential,
  seedBot,
  seedGuild,
  seedMember,
} from '../test-helpers'

const BOT_TOKEN = 'Bot role-perms-bot'
const BOT_ID = '111111111111111111'
const OWNER_ID = '444444444444444444'
const TARGET_ID = '555555555555555555'
const GUILD = '222222222222222222'
const MANAGE_ROLES = 1n << 28n
const ADMINISTRATOR = 1n << 3n
const SEND_MESSAGES = 1n << 11n

describe('outranksRole', () => {
  it('orders by position, then by lower ID', () => {
    expect(
      outranksRole({ id: '9', position: 2 }, { id: '1', position: 1 })
    ).toBe(true)
    expect(
      outranksRole({ id: '1', position: 1 }, { id: '9', position: 2 })
    ).toBe(false)
    expect(
      outranksRole({ id: '1', position: 3 }, { id: '2', position: 3 })
    ).toBe(true)
    expect(
      outranksRole({ id: '2', position: 3 }, { id: '1', position: 3 })
    ).toBe(false)
    expect(
      outranksRole({ id: '2', position: 3 }, { id: '2', position: 3 })
    ).toBe(false)
  })
})

describe('member role routes enforce permissions and hierarchy', () => {
  let db: Database
  let built: ReturnType<typeof buildApp>
  let nextRole: number

  /** Calls the assembled app with the given credentials. */
  function request(
    path: string,
    method: string,
    auth = BOT_TOKEN,
    body?: unknown
  ): Promise<Response> {
    return Promise.resolve(
      built.app.request(path, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    )
  }

  /** Inserts a role with explicit hierarchy fields; IDs ascend per call. */
  function role(
    name: string,
    position: number,
    permissions = 0n,
    managed = false
  ): string {
    const id = `70000000000000${String(nextRole++).padStart(4, '0')}`
    db.prepare(
      `INSERT INTO roles (id, guild_id, name, position, permissions, managed)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, GUILD, name, position, String(permissions), managed ? 1 : 0)
    return id
  }

  /** Gives the registered bot a role in the guild. */
  function giveBot(roleId: string) {
    db.prepare(
      'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
    ).run(GUILD, BOT_ID, roleId)
  }

  /** Lists the target member's role IDs. */
  function targetRoles(): string[] {
    return (
      db
        .prepare(
          'SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?'
        )
        .all(GUILD, TARGET_ID) as { role_id: string }[]
    ).map((row) => row.role_id)
  }

  /** Path of the member role route for the target member. */
  function route(roleId: string, prefix = '/api/v10'): string {
    return `${prefix}/guilds/${GUILD}/members/${TARGET_ID}/roles/${roleId}`
  }

  /** Resolves a request to its HTTP status. */
  async function status(response: Promise<Response>): Promise<number> {
    const resolved = await response
    return resolved.status
  }

  /** Asserts the Discord Missing Permissions body. */
  async function expectDenied(response: Response) {
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      message: 'Missing Permissions',
      code: 50_013,
    })
  }

  /** Makes the bot a non-owner member whose only role has the permissions. */
  function humanOwnedWithBotRole(position: number, permissions: bigint) {
    seedMember(db, GUILD, OWNER_ID)
    db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(
      OWNER_ID,
      GUILD
    )
    const botRole = role('bot role', position, permissions)
    giveBot(botRole)
    return botRole
  }

  beforeEach(() => {
    nextRole = 1
    db = initializeDatabase(':memory:')
    built = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, BOT_TOKEN, BOT_ID)
    seedGuild(db, BOT_TOKEN, GUILD)
    seedMember(db, GUILD, BOT_ID)
    seedMember(db, GUILD, TARGET_ID)
    // The default @everyone role, like setup and guild creation.
    db.prepare(
      `INSERT OR IGNORE INTO roles (id, guild_id, name, position, permissions)
       VALUES (?, ?, '@everyone', 0, '0')`
    ).run(GUILD, GUILD)
  })

  afterEach(() => {
    built.shutdownRestFaults()
    built.shutdownRestPageHolds()
    built.unsubscribeGateway()
    built.wss.close()
    closeDatabase(db)
    vi.restoreAllMocks()
  })

  describe.each(['PUT', 'DELETE'])('%s', (method) => {
    /** Prepares a target holding the role so DELETE has something to remove. */
    function prepare(roleId: string) {
      if (method === 'DELETE')
        db.prepare(
          'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
        ).run(GUILD, TARGET_ID, roleId)
    }

    /** The target's roles after a successful call. */
    function expectedAfter(roleId: string): string[] {
      return method === 'PUT' ? [roleId] : []
    }

    /** The target's roles after a rejected call. */
    function expectedUnchanged(roleId: string): string[] {
      return method === 'PUT' ? [] : [roleId]
    }

    it('lets the guild owner bypass permissions and hierarchy', async () => {
      const above = role('above', 50)
      prepare(above)
      // The fixture guild is owned by the bot, which holds no role.
      giveBot(role('weak', 1, SEND_MESSAGES))
      const response = await request(route(above), method)
      expect(response.status).toBe(204)
      expect(targetRoles()).toEqual(expectedAfter(above))
    })

    it('allows a MANAGE_ROLES role strictly below the highest role, on every prefix', async () => {
      humanOwnedWithBotRole(10, MANAGE_ROLES)
      const below = role('below', 9)
      for (const prefix of ['/api/v10', '/api', '']) {
        db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(TARGET_ID)
        prepare(below)
        const events = vi.spyOn(gatewayBus, 'emit')
        const response = await request(route(below, prefix), method)
        expect(response.status).toBe(204)
        expect(targetRoles()).toEqual(expectedAfter(below))
        expect(events.mock.calls.map(([name]) => name)).toEqual([
          'guild.member.update',
        ])
        events.mockRestore()
      }
    })

    it('denies a role above the highest role without state change or event', async () => {
      humanOwnedWithBotRole(10, MANAGE_ROLES)
      const target = role('target', 11)
      prepare(target)
      const events = vi.spyOn(gatewayBus, 'emit')
      await expectDenied(await request(route(target), method))
      expect(targetRoles()).toEqual(expectedUnchanged(target))
      expect(events).not.toHaveBeenCalled()
    })

    it('breaks equal positions by ID, where the lower ID ranks higher', async () => {
      seedMember(db, GUILD, OWNER_ID)
      db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(
        OWNER_ID,
        GUILD
      )
      const older = role('older', 10, MANAGE_ROLES)
      const newer = role('newer', 10)
      giveBot(older)
      prepare(newer)
      expect(await status(request(route(newer), method))).toBe(204)
      expect(targetRoles()).toEqual(expectedAfter(newer))

      db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(BOT_ID)
      db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(TARGET_ID)
      giveBot(newer)
      db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(
        String(MANAGE_ROLES),
        newer
      )
      prepare(older)
      await expectDenied(await request(route(older), method))
      expect(targetRoles()).toEqual(expectedUnchanged(older))
    })

    it('denies a role below the highest role without MANAGE_ROLES', async () => {
      humanOwnedWithBotRole(10, SEND_MESSAGES)
      const below = role('below', 2)
      prepare(below)
      await expectDenied(await request(route(below), method))
      expect(targetRoles()).toEqual(expectedUnchanged(below))
    })

    it('treats MANAGE_ROLES from @everyone as a permission, not as hierarchy', async () => {
      humanOwnedWithBotRole(10, 0n)
      db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(
        String(MANAGE_ROLES),
        GUILD
      )
      const below = role('below', 2)
      prepare(below)
      expect(await status(request(route(below), method))).toBe(204)
    })

    it('lets Administrator imply MANAGE_ROLES but not skip the hierarchy', async () => {
      humanOwnedWithBotRole(10, ADMINISTRATOR)
      const below = role('below', 2)
      const above = role('above', 20)
      prepare(below)
      expect(await status(request(route(below), method))).toBe(204)
      db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(TARGET_ID)
      prepare(above)
      await expectDenied(await request(route(above), method))
      expect(targetRoles()).toEqual(expectedUnchanged(above))
    })

    it('denies managed roles, even for the owner and an Administrator', async () => {
      const managed = role('managed', 1, 0n, true)
      prepare(managed)
      await expectDenied(await request(route(managed), method))
      expect(targetRoles()).toEqual(expectedUnchanged(managed))

      humanOwnedWithBotRole(40, ADMINISTRATOR)
      await expectDenied(await request(route(managed), method))
      expect(targetRoles()).toEqual(expectedUnchanged(managed))
    })

    it('keeps the @everyone rejection and the 404s ahead of permissions', async () => {
      humanOwnedWithBotRole(10, SEND_MESSAGES)
      const everyone = await request(route(GUILD), method)
      expect(everyone.status).toBe(400)
      await expect(everyone.json()).resolves.toEqual({
        message: 'Invalid role',
        code: 50_028,
      })

      const missingRole = await request(route('777777777777777999'), method)
      expect(missingRole.status).toBe(404)
      await expect(missingRole.json()).resolves.toMatchObject({ code: 10_011 })

      const missingGuild = await request(
        `/api/v10/guilds/999999999999999999/members/${TARGET_ID}/roles/${GUILD}`,
        method
      )
      expect(missingGuild.status).toBe(404)
      await expect(missingGuild.json()).resolves.toMatchObject({ code: 10_004 })
    })

    it('returns Unknown Member for an unknown target once permitted, and 403 when not', async () => {
      const botRole = humanOwnedWithBotRole(10, MANAGE_ROLES)
      const below = role('below', 2)
      const unknown = `/api/v10/guilds/${GUILD}/members/666666666666666666/roles/${below}`
      const missing = await request(unknown, method)
      expect(missing.status).toBe(404)
      await expect(missing.json()).resolves.toMatchObject({ code: 10_007 })

      db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(
        '0',
        botRole
      )
      await expectDenied(await request(unknown, method))
    })

    it('does not restrict a bot that holds no role (fixture bootstrap)', async () => {
      seedMember(db, GUILD, OWNER_ID)
      db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(
        OWNER_ID,
        GUILD
      )
      const target = role('target', 5)
      prepare(target)
      expect(await status(request(route(target), method))).toBe(204)
      expect(targetRoles()).toEqual(expectedAfter(target))

      const managed = role('managed', 5, 0n, true)
      prepare(managed)
      await expectDenied(await request(route(managed), method))
      expect(targetRoles().includes(managed)).toBe(method === 'DELETE')
    })

    it('keeps the existence-only behavior for a bot that is not a guild member', async () => {
      seedMember(db, GUILD, OWNER_ID)
      db.prepare(
        'UPDATE guilds SET owner_id = ?, bot_present = 0 WHERE id = ?'
      ).run(OWNER_ID, GUILD)
      db.prepare(
        'DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?'
      ).run(GUILD, BOT_ID)
      const target = role('target', 5)
      prepare(target)
      expect(await status(request(route(target), method))).toBe(204)
      expect(targetRoles()).toEqual(expectedAfter(target))

      const managed = role('managed', 5, 0n, true)
      prepare(managed)
      await expectDenied(await request(route(managed), method))
      expect(targetRoles().includes(managed)).toBe(method === 'DELETE')
    })

    it('denies an OAuth2 Bearer user and ignores a dummy DISABLE_AUTH bot', async () => {
      const target = role('target', 5)
      prepare(target)
      const { bearerToken } = seedBearerCredential(db)
      await expectDenied(
        await request(route(target), method, `Bearer ${bearerToken}`)
      )
      expect(targetRoles()).toEqual(expectedUnchanged(target))

      const open = buildApp(db, {
        baseUrl: 'http://localhost',
        disableAuth: true,
      })
      try {
        const response = await open.app.request(route(target), {
          method,
          headers: { Authorization: 'Bot unregistered' },
        })
        expect(response.status).toBe(204)
        expect(targetRoles()).toEqual(expectedAfter(target))
      } finally {
        open.shutdownRestFaults()
        open.shutdownRestPageHolds()
        open.unsubscribeGateway()
        open.wss.close()
      }
    })

    it('runs REST fault selectors before the native permission check', async () => {
      humanOwnedWithBotRole(10, 0n)
      const target = role('target', 5)
      prepare(target)
      const path = `/guilds/${GUILD}/members/${TARGET_ID}/roles/${target}`
      const armed = await request('/_test/rest-faults', 'POST', BOT_TOKEN, {
        method,
        path,
        status: 500,
        code: 0,
        message: 'injected',
      })
      expect(armed.status).toBe(201)

      const injected = await request(path, method)
      expect(injected.status).toBe(500)
      await expect(injected.json()).resolves.toEqual({
        code: 0,
        message: 'injected',
      })
      expect(targetRoles()).toEqual(expectedUnchanged(target))

      await expectDenied(await request(path, method))
    })
  })
})
