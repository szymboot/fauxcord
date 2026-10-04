import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import { createFullTestApp } from '../test-helpers'
import {
  createTestUser,
  setupTestEnvironment,
  type SetupRequest,
} from '../services/test-control'
import { getGuild } from '../services/guilds'
import { getUser } from '../services/users'

const guildId = '222222222222222222'
const ownerId = '555555555555555555'
const iconHash = 'a_0123456789abcdef0123456789abcdef'
const token = 'Bot icon-fixture'

describe('Test guild icon fixtures', () => {
  let context: ReturnType<typeof createFullTestApp>

  beforeEach(() => {
    context = createFullTestApp()
    createTestUser(context.db, { id: ownerId, username: 'HumanOwner' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Submits icon fixtures alongside a guild using the default icon. */
  function setup(icon: unknown, fixtureToken = token) {
    return context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({
        token: fixtureToken,
        guilds: [
          { id: '333333333333333333', name: 'Default Guild' },
          { id: guildId, name: 'Icon Guild', owner_id: ownerId, icon },
        ],
      }),
    })
  }

  /** Captures all setup-owned state to check rollback on failure. */
  function snapshot() {
    return Object.fromEntries(
      ['users', 'bots', 'guilds', 'guild_members', 'roles', 'channels'].map(
        (table) => [table, context.db.prepare(`SELECT * FROM ${table}`).all()]
      )
    )
  }

  it.each([iconHash, null, undefined])(
    'persists icon=%s in REST and setup events while preserving human owners',
    async (icon) => {
      const owner = getUser(context.db, ownerId)
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await setup(icon)
      expect(response.status).toBe(201)
      const expectedIcon = icon ?? null
      expect(
        context.db.prepare('SELECT icon FROM guilds WHERE id = ?').get(guildId)
      ).toEqual({ icon: expectedIcon })
      expect(getUser(context.db, ownerId)).toEqual(owner)
      for (const prefix of ['/api/v10', '/api', '']) {
        const guild = await context.app.request(`${prefix}/guilds/${guildId}`, {
          headers: { Authorization: token },
        })
        expect(guild.status).toBe(200)
        await expect(guild.json()).resolves.toMatchObject({
          icon: expectedIcon,
          owner_id: ownerId,
        })
      }
      expect(getGuild(context.db, '333333333333333333')?.icon).toBeNull()
      expect(emit).toHaveBeenCalledWith(
        'guild.create',
        expect.objectContaining({
          guild: expect.objectContaining({
            id: guildId,
            icon: expectedIcon,
            owner_id: ownerId,
          }),
        })
      )
      const unauthenticated = await context.app.request(`/guilds/${guildId}`)
      expect(unauthenticated.status).toBe(401)
      const missing = await context.app.request('/guilds/999999999999999999', {
        headers: { Authorization: token },
      })
      expect(missing.status).toBe(404)
    }
  )

  it.each(['replacement-hash', null, undefined])(
    'handles icon=%s when reusing a guild ID without changing unrelated guilds',
    async (icon) => {
      const initialSetup = await setup(iconHash)
      expect(initialSetup.status).toBe(201)
      setupTestEnvironment(context.db, {
        token: 'Bot unrelated',
        guilds: [
          { id: '777777777777777777', name: 'Other', icon: 'other-hash' },
        ],
      })
      const unrelated = getGuild(context.db, '777777777777777777')
      const response = await setup(icon, 'Bot reused')
      expect(response.status).toBe(201)
      expect(getGuild(context.db, guildId)?.icon).toBe(
        icon === undefined ? iconHash : icon
      )
      expect(getGuild(context.db, '777777777777777777')).toEqual(unrelated)
      expect(getUser(context.db, ownerId)?.bot).toBe(false)
    }
  )

  it.each(
    ['', ' '.repeat(3), ' padded ', 123, true, {}, []].map((icon) => ({ icon }))
  )(
    'rejects invalid icon=$icon atomically through HTTP and direct setup',
    async ({ icon }) => {
      const initialSetup = await setup(iconHash)
      expect(initialSetup.status).toBe(201)
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await setup(icon, 'Bot invalid')
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        message: 'icon must be a non-empty hash string or null',
      })
      expect(() =>
        setupTestEnvironment(context.db, {
          token: 'Bot invalid-service',
          guilds: [{ name: 'Invalid', icon }],
        } as SetupRequest)
      ).toThrow('INVALID_GUILD_ICON')
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it('rolls back icon changes and events when later channel setup fails', async () => {
    const initialSetup = await setup(iconHash)
    expect(initialSetup.status).toBe(201)
    context.db
      .exec(`CREATE TRIGGER reject_fixture_channel AFTER INSERT ON channels
      BEGIN SELECT RAISE(ABORT, 'Fixture channel failed'); END`)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({
        token: 'Bot rollback',
        guilds: [
          { id: guildId, name: 'Changed', icon: null },
          {
            name: 'Failure',
            icon: 'new-hash',
            channels: [{ name: 'general' }],
          },
        ],
      }),
    })
    expect(response.status).toBe(500)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })
})
