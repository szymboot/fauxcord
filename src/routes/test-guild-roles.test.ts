import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import { createFullTestApp } from '../test-helpers'
import type { RoleObject } from '../services/guild-roles'
import { setupTestEnvironment } from '../services/test-control'

const token = 'Bot managed-role-fixture'
const guildId = '222222222222222222'
const botId = '111111111111111111'

describe('Test guild role fixtures', () => {
  let context: ReturnType<typeof createFullTestApp>

  beforeEach(() => {
    context = createFullTestApp()
    setupTestEnvironment(context.db, {
      token,
      user: { id: botId },
      guilds: [{ id: guildId, name: 'Fixture Guild' }],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Creates a role fixture without native Bot authentication. */
  function createFixture(payload: unknown, targetGuild = guildId) {
    return context.app.request(`/_test/guilds/${targetGuild}/roles`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  it.each([true, false, undefined])(
    'persists managed=%s in role and guild reads and emits the stored role',
    async (managed) => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await createFixture({ name: 'Shop role', managed })
      expect(response.status).toBe(201)
      const role = (await response.json()) as RoleObject
      expect(role).toMatchObject({
        id: expect.stringMatching(/^\d+$/),
        name: 'Shop role',
        managed: managed ?? false,
        position: 1,
        permissions: '0',
      })
      expect(emit).toHaveBeenCalledExactlyOnceWith('guild.role.create', {
        guildId,
        role,
      })
      for (const prefix of ['/api/v10', '/api', '']) {
        const roles = await context.app.request(
          `${prefix}/guilds/${guildId}/roles`,
          { headers: { Authorization: token } }
        )
        expect(roles.status).toBe(200)
        await expect(roles.json()).resolves.toContainEqual(role)
        const guild = await context.app.request(`${prefix}/guilds/${guildId}`, {
          headers: { Authorization: token },
        })
        expect(guild.status).toBe(200)
        await expect(guild.json()).resolves.toMatchObject({
          roles: expect.arrayContaining([role]),
        })
        const member = await context.app.request(
          `${prefix}/guilds/${guildId}/members/${botId}`,
          { headers: { Authorization: token } }
        )
        expect(member.status).toBe(200)
        await expect(member.json()).resolves.toMatchObject({
          user: { id: botId },
          roles: [],
        })
      }
    }
  )

  it.each([
    null,
    [],
    true,
    'role',
    {},
    { name: null },
    { name: 42 },
    { name: '' },
    { name: 'x'.repeat(101) },
    { name: 'role', managed: 'true' },
    { name: 'role', managed: 1 },
    { name: 'role', managed: null },
    { name: 'role', id: '333333333333333333' },
    { name: 'role', permissions: '8' },
  ])(
    'rejects invalid payload %j without state changes or events',
    async (payload) => {
      const before = context.db.prepare('SELECT * FROM roles').all()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await createFixture(payload)
      expect(response.status).toBe(400)
      if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        await expect(response.json()).resolves.toEqual({
          message: '400: Bad Request',
          code: 0,
        })
      } else {
        await expect(response.json()).resolves.toMatchObject({
          message: 'Invalid Form Body',
          code: 50_035,
        })
      }
      expect(context.db.prepare('SELECT * FROM roles').all()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it('rejects malformed or empty JSON', async () => {
    const emit = vi.spyOn(gatewayBus, 'emit')
    for (const body of ['', '{']) {
      const response = await context.app.request(
        `/_test/guilds/${guildId}/roles`,
        { method: 'POST', body }
      )
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        message: '400: Bad Request',
        code: 0,
      })
    }
    expect(emit).not.toHaveBeenCalled()
  })

  it('returns Unknown Guild without creating a role or emitting an event', async () => {
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await createFixture(
      { name: 'Managed', managed: true },
      '999999999999999999'
    )
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      code: 10_004,
      message: 'Unknown Guild',
    })
    expect(emit).not.toHaveBeenCalled()
    expect(
      context.db.prepare('SELECT COUNT(*) AS count FROM roles').get()
    ).toEqual({
      count: 1,
    })
  })

  it('returns field errors for invalid managed input', async () => {
    const response = await createFixture({ name: 'Managed', managed: 'true' })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 50_035,
      message: 'Invalid Form Body',
      errors: { managed: { _errors: [{ code: 'BASE_TYPE_BAD_TYPE' }] } },
    })
  })

  it.each(['id', 'permissions'])(
    'returns an UNKNOWN_FIELD error for unsupported %s',
    async (field) => {
      const response = await createFixture({ name: 'Managed', [field]: '8' })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 50_035,
        message: 'Invalid Form Body',
        errors: { [field]: { _errors: [{ code: 'UNKNOWN_FIELD' }] } },
      })
    }
  )

  it('rejects creation at the guild role limit without emitting', async () => {
    context.db.transaction(() => {
      const insert = context.db.prepare(
        'INSERT INTO roles (id, guild_id, name) VALUES (?, ?, ?)'
      )
      for (let index = 1; index < 250; index++) {
        insert.run(String(index), guildId, 'Existing role')
      }
    })()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await createFixture({ name: 'Managed', managed: true })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 30_005 })
    expect(emit).not.toHaveBeenCalled()
    expect(
      context.db.prepare('SELECT COUNT(*) AS count FROM roles').get()
    ).toEqual({ count: 250 })
  })

  it('keeps native creation unmanaged and authenticated', async () => {
    for (const prefix of ['/api/v10', '/api', '']) {
      const response = await context.app.request(
        `${prefix}/guilds/${guildId}/roles`,
        {
          method: 'POST',
          headers: { Authorization: token },
          body: JSON.stringify({ name: 'Native', managed: true }),
        }
      )
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ managed: false })
    }
    const unauthenticated = await context.app.request(
      `/guilds/${guildId}/roles`,
      {
        method: 'POST',
        body: JSON.stringify({ name: 'Native', managed: true }),
      }
    )
    expect(unauthenticated.status).toBe(401)
  })

  it.each([undefined, token])(
    'retains roles through reset for token=%s',
    async (resetToken) => {
      const response = await createFixture({ name: 'Managed', managed: true })
      const role = (await response.json()) as RoleObject
      const reset = await context.app.request('/_test/reset', {
        method: 'POST',
        body: JSON.stringify({ token: resetToken }),
      })
      expect(reset.status).toBe(204)
      const roles = await context.app.request(`/guilds/${guildId}/roles`, {
        headers: { Authorization: token },
      })
      await expect(roles.json()).resolves.toContainEqual(role)
    }
  )

  it.each(['guild', 'setup'])(
    'removes fixture roles on %s deletion and preserves other guilds',
    async (scope) => {
      const response = await createFixture({ name: 'Managed', managed: true })
      const role = (await response.json()) as RoleObject
      const otherGuild = '333333333333333333'
      setupTestEnvironment(context.db, {
        token: 'Bot other',
        user: { id: '444444444444444444' },
        guilds: [{ id: otherGuild, name: 'Other Guild' }],
      })
      const otherResponse = await createFixture(
        { name: 'Other', managed: true },
        otherGuild
      )
      const otherRole = (await otherResponse.json()) as RoleObject
      const deleted = await context.app.request(
        scope === 'guild'
          ? `/guilds/${guildId}`
          : `/_test/setup/${encodeURIComponent(token)}`,
        { method: 'DELETE', headers: { Authorization: token } }
      )
      expect(deleted.status).toBe(204)
      expect(
        context.db.prepare('SELECT id FROM roles WHERE id = ?').get(role.id)
      ).toBeUndefined()
      expect(
        context.db
          .prepare('SELECT id FROM roles WHERE id = ?')
          .get(otherRole.id)
      ).toEqual({ id: otherRole.id })
    }
  )
})
