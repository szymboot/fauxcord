import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import type { GatewayBusEvents } from '../gateway/bus'
import { getGuildMember } from '../services/guild-members'
import type { InviteObject } from '../services/invites'
import {
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'

const guildId = '222222222222222222'
const otherGuildId = '222222222222222223'
const channelId = '333333333333333333'
const otherChannelId = '333333333333333334'
const inviterId = '555555555555555555'
const joinerId = '555555555555555556'
const outsiderId = '555555555555555557'
const token = 'Bot invite-token'
const auth = { Authorization: token }

describe('Human-created invites and invite-based joins', () => {
  let context: ReturnType<typeof createFullTestApp>

  /** Registers a non-bot user through the test control. */
  async function registerUser(id: string): Promise<void> {
    const response = await context.app.request('/_test/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        username: `user-${id}`,
        discriminator: '1234',
      }),
    })
    expect(response.status).toBe(201)
  }

  /** Posts JSON to a path. */
  function post(path: string, body?: unknown, headers = {}) {
    return context.app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Joins a registered user, optionally through an invite. */
  function join(userId: string, inviteCode?: string, gid = guildId) {
    return post(
      `/_test/guilds/${gid}/members/${userId}`,
      inviteCode === undefined ? {} : { invite_code: inviteCode }
    )
  }

  /** Joins and resolves with only the HTTP status. */
  async function joinStatus(
    userId: string,
    inviteCode?: string,
    gid = guildId
  ): Promise<number> {
    const response = await join(userId, inviteCode, gid)
    return response.status
  }

  /** Resets all test data and resolves with the HTTP status. */
  async function resetStatus(): Promise<number> {
    const response = await post('/_test/reset')
    return response.status
  }

  /** Creates a human invite through the fixture and returns it. */
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

  /** Lists a guild's invites through the bot-authenticated REST route. */
  async function guildInvites(gid = guildId): Promise<InviteObject[]> {
    const response = await context.app.request(
      `/api/v10/guilds/${gid}/invites`,
      { headers: auth }
    )
    expect(response.status).toBe(200)
    return (await response.json()) as InviteObject[]
  }

  /** Resolves with the first invite of the guild list. */
  async function firstInvite(): Promise<InviteObject> {
    const invites = await guildInvites()
    return invites[0]
  }

  /** Returns raw invite rows for no-mutation assertions. */
  function inviteRows() {
    return context.db.prepare('SELECT * FROM invites ORDER BY code').all()
  }

  /** Returns raw member rows for no-mutation assertions. */
  function memberRows() {
    return context.db
      .prepare('SELECT * FROM guild_members ORDER BY guild_id, user_id')
      .all()
  }

  beforeEach(async () => {
    context = createFullTestApp()
    const botToken = seedBot(context.db, token)
    seedGuild(context.db, botToken, guildId)
    seedChannel(context.db, guildId, channelId)
    seedGuild(context.db, botToken, otherGuildId)
    seedChannel(context.db, otherGuildId, otherChannelId)
    for (const id of [inviterId, joinerId, outsiderId]) await registerUser(id)
    expect(await joinStatus(inviterId)).toBe(201)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  describe('POST /_test/channels/:channelId/invites', () => {
    it('stores an ordinary invite with defaults, without auth or events', async () => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await post(`/_test/channels/${channelId}/invites`, {
        inviter_id: inviterId,
      })
      expect(response.status).toBe(201)
      const invite = (await response.json()) as InviteObject
      expect(invite).toMatchObject({
        type: 0,
        max_age: 86_400,
        max_uses: 0,
        temporary: false,
        uses: 0,
        guild_id: guildId,
        channel: { id: channelId },
        inviter: { id: inviterId, bot: false },
      })
      expect(invite.code).toMatch(/^[A-Za-z0-9]{8}$/)
      expect(emit).not.toHaveBeenCalled()

      const listed = await guildInvites()
      expect(listed).toEqual([invite])
      const byCode = await context.app.request(
        `/api/v10/invites/${invite.code}`,
        {
          headers: auth,
        }
      )
      await expect(byCode.json()).resolves.toEqual(invite)
      const byChannel = await context.app.request(
        `/api/v10/channels/${channelId}/invites`,
        { headers: auth }
      )
      await expect(byChannel.json()).resolves.toEqual([invite])
    })

    it('has the same shape as a natively created invite', async () => {
      const human = await createInvite({ max_age: 60, max_uses: 3 })
      const nativeResponse = await post(
        `/api/v10/channels/${channelId}/invites`,
        { max_age: 60, max_uses: 3 },
        auth
      )
      const native = (await nativeResponse.json()) as InviteObject
      expect(Object.keys(human).toSorted((a, b) => a.localeCompare(b))).toEqual(
        Object.keys(native).toSorted((a, b) => a.localeCompare(b))
      )
      expect(native.inviter?.bot).toBe(true)
      expect(human.inviter?.bot).toBe(false)
    })

    it('honours max_age, max_uses and temporary, accepting null as default', async () => {
      const invite = await createInvite({
        max_age: 0,
        max_uses: 5,
        temporary: true,
      })
      expect(invite).toMatchObject({
        max_age: 0,
        expires_at: null,
        max_uses: 5,
        temporary: true,
      })
      const defaults = await createInvite({
        max_age: null,
        max_uses: null,
        temporary: null,
      })
      expect(defaults).toMatchObject({
        max_age: 86_400,
        max_uses: 0,
        temporary: false,
      })
    })

    it('rejects every invalid request without mutation or events', async () => {
      await createInvite()
      const before = inviteRows()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const dmId = '999999999999999999'
      context.db
        .prepare(
          'INSERT INTO channels (id, guild_id, type, name) VALUES (?, NULL, 1, NULL)'
        )
        .run(dmId)
      const botUserId = (
        context.db
          .prepare('SELECT user_id FROM bots WHERE token = ?')
          .get(token) as {
          user_id: string
        }
      ).user_id

      const cases: [string, unknown, number, number?][] = [
        [
          `/_test/channels/404404404404404404/invites`,
          { inviter_id: inviterId },
          404,
          10_003,
        ],
        [
          `/_test/channels/${dmId}/invites`,
          { inviter_id: inviterId },
          400,
          50_024,
        ],
        [
          `/_test/channels/${channelId}/invites`,
          { inviter_id: '404404404404404404' },
          404,
          10_013,
        ],
        [
          `/_test/channels/${channelId}/invites`,
          { inviter_id: botUserId },
          400,
          0,
        ],
        [
          `/_test/channels/${channelId}/invites`,
          { inviter_id: outsiderId },
          404,
          10_007,
        ],
        [`/_test/channels/${channelId}/invites`, {}, 400, 50_035],
        [
          `/_test/channels/${channelId}/invites`,
          { inviter_id: 555 },
          400,
          50_035,
        ],
        [
          `/_test/channels/${channelId}/invites`,
          { inviter_id: inviterId, max_age: 5_184_001 },
          400,
          50_035,
        ],
        [
          `/_test/channels/${channelId}/invites`,
          { inviter_id: inviterId, max_uses: 101 },
          400,
          50_035,
        ],
        [
          `/_test/channels/${channelId}/invites`,
          { inviter_id: inviterId, max_uses: -1 },
          400,
          50_035,
        ],
        [
          `/_test/channels/${channelId}/invites`,
          { inviter_id: inviterId, temporary: 'yes' },
          400,
          50_035,
        ],
        [`/_test/channels/${channelId}/invites`, [], 400, 0],
      ]
      for (const [path, body, status, code] of cases) {
        const response = await post(path, body)
        expect(response.status, JSON.stringify(body)).toBe(status)
        expect(((await response.json()) as { code: number }).code).toBe(code)
      }
      const malformed = await context.app.request(
        `/_test/channels/${channelId}/invites`,
        { method: 'POST', body: '{nope' }
      )
      expect(malformed.status).toBe(400)

      expect(inviteRows()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    })

    it('rejects an inviter who is a member of a different guild only', async () => {
      expect(await joinStatus(outsiderId, undefined, otherGuildId)).toBe(201)
      const response = await post(`/_test/channels/${channelId}/invites`, {
        inviter_id: outsiderId,
      })
      expect(response.status).toBe(404)
      expect(((await response.json()) as { code: number }).code).toBe(10_007)
    })
  })

  describe('POST /_test/guilds/:guildId/members/:userId with invite_code', () => {
    it('increments uses and commits before the single GUILD_MEMBER_ADD emission', async () => {
      const invite = await createInvite()
      const seen: { inTransaction: boolean; uses: number | undefined }[] = []
      const onAdd = vi.fn((event: GatewayBusEvents['guild.member.add']) => {
        const row = context.db
          .prepare('SELECT uses FROM invites WHERE code = ?')
          .get(invite.code) as { uses: number } | undefined
        seen.push({ inTransaction: context.db.inTransaction, uses: row?.uses })
        expect(getGuildMember(context.db, guildId, joinerId)).toEqual(
          event.member
        )
      })
      gatewayBus.on('guild.member.add', onAdd)
      const emit = vi.spyOn(gatewayBus, 'emit')
      try {
        const response = await join(joinerId, invite.code)
        expect(response.status).toBe(201)
        const member = (await response.json()) as { user: { id: string } }
        expect(member.user.id).toBe(joinerId)
        expect(emit).toHaveBeenCalledExactlyOnceWith('guild.member.add', {
          guildId,
          member,
        })
      } finally {
        gatewayBus.off('guild.member.add', onAdd)
      }
      expect(seen).toEqual([{ inTransaction: false, uses: 1 }])
    })

    it('shows uses in the guild list, channel list and invite lookup', async () => {
      const invite = await createInvite()
      await join(joinerId, invite.code)
      const first = await firstInvite()
      expect(first.uses).toBe(1)
      const channelList = await context.app.request(
        `/api/v10/channels/${channelId}/invites`,
        { headers: auth }
      )
      expect(((await channelList.json()) as InviteObject[])[0].uses).toBe(1)
      const lookup = await context.app.request(
        `/api/v10/invites/${invite.code}?with_counts=true`,
        { headers: auth }
      )
      expect(((await lookup.json()) as InviteObject).uses).toBe(1)
    })

    it('lets a bot listing invites inside the handler see the new uses', async () => {
      const invite = await createInvite()
      const before = await guildInvites()
      let during: InviteObject[] = []
      const handler = vi.fn(() => {
        during = context.db
          .prepare('SELECT code, uses FROM invites')
          .all() as unknown as InviteObject[]
      })
      gatewayBus.on('guild.member.add', handler)
      try {
        await join(joinerId, invite.code)
      } finally {
        gatewayBus.off('guild.member.add', handler)
      }
      expect(before[0].uses).toBe(0)
      expect(during).toEqual([{ code: invite.code, uses: 1 }])
    })

    it('removes an invite when it reaches max_uses, keeping it until then', async () => {
      const invite = await createInvite({ max_uses: 2 })
      await registerUser('555555555555555558')
      expect(await joinStatus(joinerId, invite.code)).toBe(201)
      expect(await firstInvite()).toMatchObject({
        code: invite.code,
        uses: 1,
      })

      const emit = vi.spyOn(gatewayBus, 'emit')
      expect(await joinStatus('555555555555555558', invite.code)).toBe(201)
      // The exhausting join publishes INVITE_DELETE, then its single member add.
      expect(emit.mock.calls.map(([event]) => event)).toEqual([
        'invite.delete',
        'guild.member.add',
      ])

      expect(await guildInvites()).toEqual([])
      const channelList = await context.app.request(
        `/api/v10/channels/${channelId}/invites`,
        { headers: auth }
      )
      await expect(channelList.json()).resolves.toEqual([])
      const lookup = await context.app.request(
        `/api/v10/invites/${invite.code}`,
        {
          headers: auth,
        }
      )
      expect(lookup.status).toBe(404)
      expect(((await lookup.json()) as { code: number }).code).toBe(10_006)
    })

    it('removes max_uses=1 invites on the first use and rejects a second join', async () => {
      const invite = await createInvite({ max_uses: 1 })
      expect(await joinStatus(joinerId, invite.code)).toBe(201)
      expect(await guildInvites()).toEqual([])
      const emit = vi.spyOn(gatewayBus, 'emit')
      const before = memberRows()
      const response = await join(outsiderId, invite.code)
      expect(response.status).toBe(404)
      expect(((await response.json()) as { code: number }).code).toBe(10_006)
      expect(memberRows()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    })

    it('keeps unlimited invites listed and counts every use', async () => {
      const invite = await createInvite({ max_uses: 0, max_age: 0 })
      await join(joinerId, invite.code)
      await join(outsiderId, invite.code)
      expect(await firstInvite()).toMatchObject({ uses: 2 })
    })

    it('accepts an invite exactly until its expiry on the Fauxcord clock', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
      const invite = await createInvite({ max_age: 60 })
      expect(invite.created_at).toBe('2030-01-01T00:00:00.000000+00:00')

      vi.setSystemTime(new Date('2030-01-01T00:00:59.999Z'))
      expect(await joinStatus(joinerId, invite.code)).toBe(201)

      vi.setSystemTime(new Date('2030-01-01T00:01:00.000Z'))
      const emit = vi.spyOn(gatewayBus, 'emit')
      const before = { invites: inviteRows(), members: memberRows() }
      const response = await join(outsiderId, invite.code)
      expect(response.status).toBe(404)
      expect(((await response.json()) as { code: number }).code).toBe(10_006)
      expect({ invites: inviteRows(), members: memberRows() }).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    })

    it('never expires an invite with max_age 0', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
      const invite = await createInvite({ max_age: 0 })
      vi.setSystemTime(new Date('2090-01-01T00:00:00.000Z'))
      expect(await joinStatus(joinerId, invite.code)).toBe(201)
    })

    it.each([
      ['unknown', () => 'doesnotexist'],
      ['foreign-guild', () => 'FOREIGN01'],
      ['exhausted', () => 'EXHAUST01'],
    ])(
      'rejects a %s invite with Unknown Invite and no side effects',
      async (_name, code) => {
        context.db
          .prepare(
            'INSERT INTO invites (code, channel_id, guild_id, inviter_id, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run('FOREIGN01', otherChannelId, otherGuildId, inviterId, 0, 0)
        context.db
          .prepare(
            'INSERT INTO invites (code, channel_id, guild_id, inviter_id, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run('EXHAUST01', channelId, guildId, inviterId, 2, 2)
        const before = { invites: inviteRows(), members: memberRows() }
        const emit = vi.spyOn(gatewayBus, 'emit')

        const response = await join(joinerId, code())
        expect(response.status).toBe(404)
        const body = (await response.json()) as {
          code: number
          message: string
        }
        expect(body).toMatchObject({ code: 10_006, message: 'Unknown Invite' })
        expect({ invites: inviteRows(), members: memberRows() }).toEqual(before)
        expect(emit).not.toHaveBeenCalled()
      }
    )

    it('does not consume a use when the user is already a member (409)', async () => {
      const invite = await createInvite({ max_uses: 2 })
      expect(await joinStatus(joinerId, invite.code)).toBe(201)
      const before = { invites: inviteRows(), members: memberRows() }
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await join(joinerId, invite.code)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        message: '409: Conflict',
        code: 0,
      })
      expect({ invites: inviteRows(), members: memberRows() }).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    })

    it('keeps the existing error precedence for guild, user and bot', async () => {
      const invite = await createInvite()
      const botUserId = (
        context.db
          .prepare('SELECT user_id FROM bots WHERE token = ?')
          .get(token) as {
          user_id: string
        }
      ).user_id
      const before = inviteRows()
      expect(
        await joinStatus(joinerId, invite.code, '404404404404404404')
      ).toBe(404)
      expect(await joinStatus('404404404404404404', invite.code)).toBe(404)
      expect(await joinStatus(botUserId, invite.code)).toBe(400)
      expect(inviteRows()).toEqual(before)
    })

    it.each([null, 123, '', true, ['abc']])(
      'rejects invite_code %j as a validation error without mutation',
      async (value) => {
        const invite = await createInvite()
        const before = { invites: inviteRows(), members: memberRows() }
        const response = await post(
          `/_test/guilds/${guildId}/members/${joinerId}`,
          { invite_code: value }
        )
        expect(response.status).toBe(400)
        expect(((await response.json()) as { code: number }).code).toBe(50_035)
        expect({ invites: inviteRows(), members: memberRows() }).toEqual(before)
        expect(invite.uses).toBe(0)
      }
    )

    it('joins without invite_code exactly as before and leaves uses untouched', async () => {
      const invite = await createInvite()
      expect(await joinStatus(joinerId)).toBe(201)
      expect(await firstInvite()).toMatchObject({
        code: invite.code,
        uses: 0,
      })
    })

    it('drops invites on reset', async () => {
      const invite = await createInvite()
      await join(joinerId, invite.code)
      expect(await resetStatus()).toBe(204)
      expect(inviteRows()).toEqual([])
    })
  })
})
