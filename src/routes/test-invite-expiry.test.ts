import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { closeDatabase, initializeDatabase } from '../db'
import { createAuthMiddleware, type AppEnv } from '../middleware/auth'
import { createRemovedSetupMiddleware } from '../middleware/removed-setup'
import { gatewayBus } from '../gateway/bus'
import {
  createInvite,
  setInviteTargetUsers,
  type InviteObject,
} from '../services/invites'
import { createInviteRoutes } from './invites'
import {
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'

const guildId = '222222222222222222'
const channelId = '333333333333333333'
const otherChannelId = '333333333333333334'
const inviterId = '555555555555555555'
const joinerId = '555555555555555556'
const token = 'Bot expiry-token'
const auth = { Authorization: token }

/** Builds an ISO 8601 timestamp the given number of seconds before now. */
function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString()
}

describe('Invite expiry', () => {
  let context: ReturnType<typeof createFullTestApp>

  /** Posts JSON to a path. */
  function post(path: string, body?: unknown) {
    return context.app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Sends an authenticated request. */
  function bot(path: string, method = 'GET') {
    return context.app.request(`/api/v10${path}`, { method, headers: auth })
  }

  /** Resolves with only the HTTP status of a POST. */
  async function postStatus(path: string, body?: unknown): Promise<number> {
    const response = await post(path, body)
    return response.status
  }

  /** Resolves with only the HTTP status of an authenticated GET. */
  async function botStatus(path: string): Promise<number> {
    const response = await bot(path)
    return response.status
  }

  /** Creates a human invite through the fixture. */
  async function createInvite(
    body: Record<string, unknown> = {},
    cid = channelId
  ): Promise<InviteObject> {
    const response = await post(`/_test/channels/${cid}/invites`, {
      inviter_id: inviterId,
      ...body,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as InviteObject
  }

  /** Lists invite codes from a listing route. */
  async function codes(path: string): Promise<string[]> {
    const response = await bot(path)
    expect(response.status).toBe(200)
    return ((await response.json()) as InviteObject[]).map(
      (invite) => invite.code
    )
  }

  /** Asserts a response is Unknown Invite. */
  async function expectUnknownInvite(response: Response): Promise<void> {
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      code: 10_006,
      message: 'Unknown Invite',
    })
  }

  /** Counts stored invite rows. */
  function inviteRowCount(): number {
    return (
      context.db.prepare('SELECT COUNT(*) AS n FROM invites').get() as {
        n: number
      }
    ).n
  }

  beforeEach(async () => {
    context = createFullTestApp()
    const botToken = seedBot(context.db, token)
    seedGuild(context.db, botToken, guildId)
    seedChannel(context.db, guildId, channelId)
    seedChannel(context.db, guildId, otherChannelId)
    for (const id of [inviterId, joinerId]) {
      const response = await post('/_test/users', {
        id,
        username: `user-${id}`,
        discriminator: '1234',
      })
      expect(response.status).toBe(201)
    }
    expect(
      await postStatus(`/_test/guilds/${guildId}/members/${inviterId}`)
    ).toBe(201)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  it('drops an expired invite from listings and lookup, keeping live ones', async () => {
    const live = await createInvite({ max_age: 3600 })
    const never = await createInvite({
      max_age: 0,
      created_at: secondsAgo(10 * 86_400),
    })
    const expired = await createInvite({
      max_age: 60,
      created_at: secondsAgo(120),
    })
    expect(expired.expires_at).not.toBeNull()
    expect(Date.parse(expired.expires_at ?? '')).toBeLessThan(Date.now())

    const guildCodes = await codes(`/guilds/${guildId}/invites`)
    expect(guildCodes).toContain(live.code)
    expect(guildCodes).toContain(never.code)
    expect(guildCodes).not.toContain(expired.code)
    expect(await codes(`/channels/${channelId}/invites`)).toEqual(guildCodes)
    await expectUnknownInvite(await bot(`/invites/${expired.code}`))
    expect(await botStatus(`/invites/${live.code}`)).toBe(200)
    expect(await botStatus(`/invites/${never.code}`)).toBe(200)
  })

  it('expires from the exact instant now >= created_at + max_age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const invite = await createInvite({ max_age: 60 })

    vi.setSystemTime(new Date('2030-01-01T00:00:59.999Z'))
    expect(await codes(`/guilds/${guildId}/invites`)).toEqual([invite.code])
    expect(await botStatus(`/invites/${invite.code}`)).toBe(200)

    vi.setSystemTime(new Date('2030-01-01T00:01:00.000Z'))
    expect(await codes(`/guilds/${guildId}/invites`)).toEqual([])
    await expectUnknownInvite(await bot(`/invites/${invite.code}`))
  })

  it('lists a fixture invite that expires soon until it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const invite = await createInvite({
      max_age: 60,
      created_at: '2029-12-31T23:59:30Z',
    })
    expect(invite.created_at).toBe('2029-12-31T23:59:30.000000+00:00')
    expect(invite.expires_at).toBe('2030-01-01T00:00:30.000000+00:00')
    expect(await codes(`/channels/${channelId}/invites`)).toEqual([invite.code])

    vi.setSystemTime(new Date('2030-01-01T00:00:30.000Z'))
    expect(await codes(`/channels/${channelId}/invites`)).toEqual([])
  })

  it('keeps the milliseconds of an explicit created_at for the expiry boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:01:00.000Z'))
    const invite = await createInvite({
      max_age: 60,
      created_at: '2030-01-01T00:00:00.900Z',
    })
    expect(invite.created_at).toBe('2030-01-01T00:00:00.900000+00:00')
    expect(invite.expires_at).toBe('2030-01-01T00:01:00.900000+00:00')

    vi.setSystemTime(new Date('2030-01-01T00:01:00.500Z'))
    expect(await codes(`/guilds/${guildId}/invites`)).toEqual([invite.code])
    expect(await botStatus(`/invites/${invite.code}`)).toBe(200)

    vi.setSystemTime(new Date('2030-01-01T00:01:00.900Z'))
    expect(await codes(`/guilds/${guildId}/invites`)).toEqual([])
    await expectUnknownInvite(await bot(`/invites/${invite.code}`))
  })

  it('never expires max_age 0, however old the invite is', async () => {
    const invite = await createInvite({
      max_age: 0,
      created_at: '2001-01-01T00:00:00Z',
    })
    expect(invite.expires_at).toBeNull()
    expect(await codes(`/guilds/${guildId}/invites`)).toEqual([invite.code])
    expect(await botStatus(`/invites/${invite.code}`)).toBe(200)
    expect(
      await postStatus(`/_test/guilds/${guildId}/members/${joinerId}`, {
        invite_code: invite.code,
      })
    ).toBe(201)
  })

  it('answers DELETE of an expired invite as Unknown Invite without INVITE_DELETE', async () => {
    const expired = await createInvite({
      max_age: 60,
      created_at: secondsAgo(120),
    })
    const emit = vi.spyOn(gatewayBus, 'emit')
    await expectUnknownInvite(await bot(`/invites/${expired.code}`, 'DELETE'))
    expect(emit).not.toHaveBeenCalled()
    expect(inviteRowCount()).toBe(0)
  })

  it('emits no event when expiry removes an invite from a listing', async () => {
    await createInvite({ max_age: 60, created_at: secondsAgo(120) })
    const emit = vi.spyOn(gatewayBus, 'emit')
    expect(await codes(`/guilds/${guildId}/invites`)).toEqual([])
    expect(await codes(`/channels/${channelId}/invites`)).toEqual([])
    expect(emit).not.toHaveBeenCalled()
    expect(inviteRowCount()).toBe(0)
  })

  it('keeps answering Unknown Invite to joins through an expired invite', async () => {
    const expired = await createInvite({
      max_age: 60,
      created_at: secondsAgo(120),
    })
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await post(
      `/_test/guilds/${guildId}/members/${joinerId}`,
      {
        invite_code: expired.code,
      }
    )
    await expectUnknownInvite(response)
    expect(emit).not.toHaveBeenCalled()
    expect(
      context.db
        .prepare('SELECT 1 FROM guild_members WHERE user_id = ?')
        .get(joinerId)
    ).toBeUndefined()
  })

  it('removes target-users data with the expired invite', async () => {
    const expired = await createInvite({
      max_age: 60,
      created_at: secondsAgo(120),
    })
    context.db
      .prepare(
        `INSERT INTO invite_target_users
           (code, raw_csv, total_users, processed_users, status)
         VALUES (?, 'user_id\n1\n', 1, 1, 2)`
      )
      .run(expired.code)

    await expectUnknownInvite(
      await bot(`/invites/${expired.code}/target-users`)
    )
    expect(
      context.db.prepare('SELECT COUNT(*) AS n FROM invite_target_users').get()
    ).toEqual({ n: 0 })
    await expectUnknownInvite(
      await bot(`/invites/${expired.code}/target-users/job-status`)
    )
  })

  it('keeps exhaustion at max_uses publishing INVITE_DELETE', async () => {
    const invite = await createInvite({ max_age: 3600, max_uses: 1 })
    const emit = vi.spyOn(gatewayBus, 'emit')
    expect(
      await postStatus(`/_test/guilds/${guildId}/members/${joinerId}`, {
        invite_code: invite.code,
      })
    ).toBe(201)
    expect(emit.mock.calls.map(([event]) => event)).toContain('invite.delete')
    expect(await codes(`/guilds/${guildId}/invites`)).toEqual([])
  })

  describe('created_at validation', () => {
    it('defaults to now for absent and null', async () => {
      const before = Date.now()
      const absent = await createInvite()
      const nulled = await createInvite({ created_at: null })
      for (const invite of [absent, nulled]) {
        const createdMs = Date.parse(invite.created_at)
        expect(createdMs).toBeGreaterThanOrEqual(before - 1000)
        expect(createdMs).toBeLessThanOrEqual(Date.now())
      }
    })

    it('normalizes an offset timestamp', async () => {
      const invite = await createInvite({
        max_age: 3600,
        created_at: '2020-06-01T12:00:00+02:00',
      })
      expect(invite.created_at).toBe('2020-06-01T10:00:00.000000+00:00')
      expect(invite.expires_at).toBe('2020-06-01T11:00:00.000000+00:00')
    })

    it.each([
      ['in the future', new Date(Date.now() + 3_600_000).toISOString()],
      ['without a timezone', '2020-01-01T00:00:00'],
      ['not a calendar date', '2020-02-30T00:00:00Z'],
      ['a number', 1_600_000_000],
      ['a boolean', true],
      ['an empty string', ''],
    ])('rejects created_at %s', async (_name, value) => {
      const response = await post(`/_test/channels/${channelId}/invites`, {
        inviter_id: inviterId,
        created_at: value,
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as {
        code: number
        errors: { created_at: { _errors: unknown[] } }
      }
      expect(body.code).toBe(50_035)
      expect(body.errors.created_at._errors).toHaveLength(1)
      expect(inviteRowCount()).toBe(0)
    })
  })
})

describe('Invite expiry consistency across layers', () => {
  const botToken = 'Bot first-setup'
  let db: ReturnType<typeof initializeDatabase>

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    seedBot(db, botToken)
    seedGuild(db, botToken, guildId)
    seedChannel(db, guildId, channelId)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('answers Unknown Invite, not Missing Access, to a removed setup for an expired invite', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', createAuthMiddleware(db, false))
    app.use('*', createRemovedSetupMiddleware(db))
    app.route('/', createInviteRoutes(db))

    // Another setup takes over the guild; the first setup was removed from it.
    seedBot(db, 'Bot second-setup', '111111111111111112')
    db.prepare('UPDATE guilds SET bot_token = ? WHERE id = ?').run(
      'Bot second-setup',
      guildId
    )
    db.prepare(
      'INSERT INTO guild_bot_removals (guild_id, bot_token) VALUES (?, ?)'
    ).run(guildId, botToken)
    const created = (): string => {
      const code = createInvite(db, {
        channelId,
        guildId,
        inviterId: null,
        maxAge: 60,
        createdAt: new Date(Date.now() - 120_000),
      }).code
      return code
    }

    for (const method of ['GET', 'DELETE']) {
      const code = created()
      const response = await app.request(`/invites/${code}`, {
        method,
        headers: { Authorization: botToken },
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 10_006 })
    }
  })

  it('does not store target users for an invite that expired meanwhile', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const invite = createInvite(db, {
      channelId,
      guildId,
      inviterId: null,
      maxAge: 60,
    })
    vi.setSystemTime(new Date('2030-01-01T00:01:00.000Z'))
    expect(setInviteTargetUsers(db, invite.code, ['1'])).toBe(false)
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM invite_target_users').get()
    ).toEqual({ n: 0 })
    vi.useRealTimers()
  })
})
