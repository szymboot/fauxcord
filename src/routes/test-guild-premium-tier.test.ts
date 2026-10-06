import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import { createFullTestApp } from '../test-helpers'
import {
  setupTestEnvironment,
  type SetupRequest,
} from '../services/test-control'
import { getGuild } from '../services/guilds'

const guildId = '222222222222222222'
const token = 'Bot premium-fixture'

describe('Test guild premium tier fixtures', () => {
  let context: ReturnType<typeof createFullTestApp>

  beforeEach(() => {
    context = createFullTestApp()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Submits a tier fixture alongside a guild with the field omitted. */
  function setup(premiumTier: unknown, fixtureToken = token) {
    return context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({
        token: fixtureToken,
        guilds: [
          { id: '333333333333333333', name: 'Default Guild' },
          { id: guildId, name: 'Premium Guild', premium_tier: premiumTier },
        ],
      }),
    })
  }

  /** Captures setup-owned state to check atomic failures. */
  function snapshot() {
    return Object.fromEntries(
      ['users', 'bots', 'guilds', 'guild_members', 'roles', 'channels'].map(
        (table) => [table, context.db.prepare(`SELECT * FROM ${table}`).all()]
      )
    )
  }

  it.each([0, 1, 2, 3, undefined])(
    'persists premium_tier=%s in REST and setup events',
    async (premiumTier) => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await setup(premiumTier)
      expect(response.status).toBe(201)
      for (const prefix of ['/api/v10', '/api', '']) {
        const guild = await context.app.request(`${prefix}/guilds/${guildId}`, {
          headers: { Authorization: token },
        })
        expect(guild.status).toBe(200)
        await expect(guild.json()).resolves.toMatchObject({
          id: guildId,
          premium_tier: premiumTier ?? 0,
        })
      }
      expect(getGuild(context.db, '333333333333333333')?.premium_tier).toBe(0)
      expect(emit).toHaveBeenCalledWith(
        'guild.create',
        expect.objectContaining({
          guild: expect.objectContaining({
            id: guildId,
            premium_tier: premiumTier ?? 0,
          }),
        })
      )
      const unauthenticated = await context.app.request(`/guilds/${guildId}`)
      expect(unauthenticated.status).toBe(401)
      const missing = await context.app.request('/guilds/999999999999999999', {
        headers: { Authorization: token },
      })
      expect(missing.status).toBe(404)
      const duplicate = await setup(premiumTier)
      expect(duplicate.status).toBe(409)
    }
  )

  it.each([0, 1, 2, 3, undefined])(
    'handles premium_tier=%s when reusing a guild ID',
    async (premiumTier) => {
      const initial = await setup(3)
      expect(initial.status).toBe(201)
      setupTestEnvironment(context.db, {
        token: 'Bot unrelated',
        guilds: [{ id: '777777777777777777', name: 'Other' }],
      })
      const unrelated = getGuild(context.db, '777777777777777777')
      const reused = await setup(premiumTier, 'Bot reused')
      expect(reused.status).toBe(201)
      expect(getGuild(context.db, guildId)?.premium_tier).toBe(premiumTier ?? 3)
      expect(getGuild(context.db, '777777777777777777')).toEqual(unrelated)
      const reset = await context.app.request('/_test/reset', {
        method: 'POST',
        body: JSON.stringify({ token: 'Bot reused' }),
      })
      expect(reset.status).toBe(204)
      expect(getGuild(context.db, guildId)?.premium_tier).toBe(premiumTier ?? 3)
    }
  )

  it.each(
    [-1, 4, 1.5, null, '2', true, false, {}, []].map((premiumTier) => ({
      premiumTier,
    }))
  )(
    'rejects invalid premium_tier=$premiumTier atomically through HTTP and seed setup',
    async ({ premiumTier }) => {
      const initial = await setup(3)
      expect(initial.status).toBe(201)
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await setup(premiumTier, 'Bot invalid')
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        message: 'premium_tier must be an integer between 0 and 3',
        code: 0,
      })
      expect(() =>
        setupTestEnvironment(context.db, {
          token: 'Bot invalid-seed',
          guilds: [{ name: 'Invalid', premium_tier: premiumTier }],
        } as SetupRequest)
      ).toThrow('INVALID_GUILD_PREMIUM_TIER')
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it.each([0, 1, 2, 3, undefined])(
    'supports premium_tier=%s in the shared SEED_FILE setup service',
    (premiumTier) => {
      const seedJson = JSON.stringify({
        bots: [
          {
            token,
            guilds: [{ id: guildId, name: 'Seed', premium_tier: premiumTier }],
          },
        ],
      })
      const seed = JSON.parse(seedJson) as { bots: SetupRequest[] }
      for (const bot of seed.bots) setupTestEnvironment(context.db, bot)
      expect(getGuild(context.db, guildId)?.premium_tier).toBe(premiumTier ?? 0)
    }
  )

  it.each([NaN, Infinity, -Infinity])(
    'rejects non-finite direct setup tier %s',
    (premiumTier) => {
      expect(() =>
        setupTestEnvironment(context.db, {
          token,
          guilds: [{ name: 'Invalid', premium_tier: premiumTier }],
        } as SetupRequest)
      ).toThrow('INVALID_GUILD_PREMIUM_TIER')
      expect(context.db.prepare('SELECT * FROM bots').all()).toEqual([])
    }
  )

  it('rolls back tiers and events when later channel setup fails', async () => {
    const initial = await setup(3)
    expect(initial.status).toBe(201)
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
          { id: guildId, name: 'Changed', premium_tier: 0 },
          { name: 'Failure', premium_tier: 2, channels: [{ name: 'general' }] },
        ],
      }),
    })
    expect(response.status).toBe(500)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('does not allow changing the tier through Discord Modify Guild', async () => {
    const initial = await setup(2)
    expect(initial.status).toBe(201)
    const response = await context.app.request(`/api/v10/guilds/${guildId}`, {
      method: 'PATCH',
      headers: { Authorization: token },
      body: JSON.stringify({ name: 'Renamed', premium_tier: 3 }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      name: 'Renamed',
      premium_tier: 2,
    })
    expect(getGuild(context.db, guildId)?.premium_tier).toBe(2)
  })
})
