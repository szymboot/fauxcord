import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import { createFullTestApp } from '../test-helpers'
import { getUser } from '../services/users'
import { setupTestEnvironment } from '../services/test-control'

const ownerId = '555555555555555555'
const botId = '111111111111111111'
const guildId = '222222222222222222'
const token = 'Bot owner-fixture'

describe('Test guild owner fixtures', () => {
  let context: ReturnType<typeof createFullTestApp>

  beforeEach(async () => {
    context = createFullTestApp()
    const response = await context.app.request('/_test/users', {
      method: 'POST',
      body: JSON.stringify({
        id: ownerId,
        username: 'HumanOwner',
        global_name: 'Human Display Name',
        discriminator: '1234',
      }),
    })
    expect(response.status).toBe(201)
    context.db
      .prepare('UPDATE users SET avatar = ? WHERE id = ?')
      .run('owner-avatar', ownerId)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Submits a fixture with an explicit owner and a separate default guild. */
  function setup(owner: unknown = ownerId, userId = botId) {
    return context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({
        token,
        user: { id: userId, username: 'FixtureBot' },
        guilds: [
          { id: '333333333333333333', name: 'Default Guild' },
          {
            id: guildId,
            name: 'Human Owned Guild',
            owner_id: owner,
            channels: [{ id: '444444444444444444', name: 'general' }],
          },
        ],
      }),
    })
  }

  /** Captures fixture state to verify that failures are atomic. */
  function snapshot() {
    return Object.fromEntries(
      ['users', 'bots', 'guilds', 'guild_members', 'roles', 'channels'].map(
        (table) => [table, context.db.prepare(`SELECT * FROM ${table}`).all()]
      )
    )
  }

  it('preserves human identity in guild and member REST while retaining the default bot owner', async () => {
    const profile = getUser(context.db, ownerId)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const setupResponse = await setup()
    expect(setupResponse.status).toBe(201)
    expect(getUser(context.db, ownerId)).toEqual(profile)

    for (const prefix of ['/api/v10', '/api', '']) {
      const guild = await context.app.request(`${prefix}/guilds/${guildId}`, {
        headers: { Authorization: token },
      })
      expect(guild.status).toBe(200)
      await expect(guild.json()).resolves.toMatchObject({ owner_id: ownerId })
      const member = await context.app.request(
        `${prefix}/guilds/${guildId}/members/${ownerId}`,
        { headers: { Authorization: token } }
      )
      expect(member.status).toBe(200)
      await expect(member.json()).resolves.toMatchObject({ user: profile })
    }
    const members = await context.app.request(
      `/guilds/${guildId}/members?limit=100`,
      {
        headers: { Authorization: token },
      }
    )
    await expect(members.json()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user: profile }),
        expect.objectContaining({
          user: expect.objectContaining({ id: botId, bot: true }),
        }),
      ])
    )
    expect(
      context.db.prepare('SELECT COUNT(*) AS count FROM guild_members').get()
    ).toEqual({ count: 3 })
    const defaultGuild = await context.app.request(
      '/guilds/333333333333333333',
      { headers: { Authorization: token } }
    )
    await expect(defaultGuild.json()).resolves.toMatchObject({
      owner_id: botId,
    })
    expect(emit).toHaveBeenCalledWith(
      'guild.create',
      expect.objectContaining({
        guild: expect.objectContaining({
          id: guildId,
          owner_id: ownerId,
          member_count: 2,
          members: expect.arrayContaining([
            expect.objectContaining({ user: profile }),
          ]),
        }),
      })
    )
    const unauthenticated = await context.app.request(`/guilds/${guildId}`)
    expect(unauthenticated.status).toBe(401)
  })

  it.each(
    [null, '', ' '.repeat(3), ' padded ', 555_555, true, {}, []].map(
      (owner) => ({
        owner,
      })
    )
  )(
    'rejects malformed owner_id=$owner without state changes or Gateway events',
    async ({ owner }) => {
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await setup(owner)
      expect(response.status).toBe(400)
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it('rejects an unknown owner and rolls back every guild in the request', async () => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await setup('999999999999999999')
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 10_013 })
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('rejects an owner reused as the setup bot without promoting the human', async () => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await setup(ownerId, ownerId)
    expect(response.status).toBe(400)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('rejects a registered bot as an explicit owner', async () => {
    setupTestEnvironment(context.db, {
      token: 'Bot other',
      user: { id: '666666666666666666' },
    })
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await setup('666666666666666666')
    expect(response.status).toBe(400)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('keeps an existing human owner human when a later setup reuses its ID for a bot', async () => {
    const setupResponse = await setup()
    expect(setupResponse.status).toBe(201)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({ token: 'Bot colliding', user: { id: ownerId } }),
    })
    expect(response.status).toBe(400)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('validates owner references in direct service setup as well as HTTP setup', () => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    expect(() =>
      setupTestEnvironment(context.db, {
        token,
        guilds: [{ name: 'Invalid', owner_id: '999999999999999999' }],
      })
    ).toThrow('UNKNOWN_USER')
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('rolls back bot, owner membership and guild state if channel setup fails', async () => {
    context.db
      .exec(`CREATE TRIGGER reject_fixture_channel AFTER INSERT ON channels
      BEGIN SELECT RAISE(ABORT, 'Fixture channel failed'); END`)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await setup()
    expect(response.status).toBe(500)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('scopes teardown to the setup token and keeps a shared human profile', async () => {
    const setupResponse = await setup()
    expect(setupResponse.status).toBe(201)
    const secondToken = 'Bot isolated'
    setupTestEnvironment(context.db, {
      token: secondToken,
      guilds: [{ id: '777777777777777777', name: 'Other', owner_id: ownerId }],
    })
    const profile = getUser(context.db, ownerId)
    const response = await context.app.request(
      '/_test/setup/Bot%20owner-fixture',
      { method: 'DELETE' }
    )
    expect(response.status).toBe(204)
    expect(context.db.prepare('SELECT id FROM guilds').all()).toEqual([
      { id: '777777777777777777' },
    ])
    expect(context.db.prepare('SELECT id FROM channels').all()).toEqual([])
    expect(getUser(context.db, ownerId)).toEqual(profile)
    const member = await context.app.request(
      `/guilds/777777777777777777/members/${ownerId}`,
      { headers: { Authorization: secondToken } }
    )
    expect(member.status).toBe(200)
    await expect(member.json()).resolves.toMatchObject({ user: profile })
    const recreated = await setup()
    expect(recreated.status).toBe(201)
  })
})
