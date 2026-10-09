import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedMember,
  seedRole,
  seedBearerCredential,
} from '../test-helpers'
import { getGuildMember, updateGuildMember } from '../services/guild-members'
import { gatewayBus } from '../gateway/bus'
import { toDiscordTimestamp } from '../timestamp'

describe('guild member timeouts', () => {
  let context: ReturnType<typeof createFullTestApp>
  let token: string
  let guildId: string
  let userId: string
  const now = new Date('2026-10-03T12:00:00Z')
  const deadline = '2026-10-04T14:00:00+02:00'
  const normalized = '2026-10-04T12:00:00.000000+00:00'

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime())
    context = createFullTestApp()
    token = seedBot(context.db)
    guildId = seedGuild(context.db, token)
    userId = seedMember(context.db, guildId)
  })

  afterEach(() => {
    context.db.close()
    vi.restoreAllMocks()
  })

  /** Sends a timeout update through the assembled application. */
  function patch(payload: Record<string, unknown>, prefix = '/api/v10') {
    return context.app.request(
      `${prefix}/guilds/${guildId}/members/${userId}`,
      {
        method: 'PATCH',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    )
  }

  it.each(['/api/v10', '/api', ''])(
    'sets, changes and clears timeouts under %s',
    async (prefix) => {
      for (const value of [deadline, '2026-10-05T12:00:00.123Z', null]) {
        const expected =
          value === null ? null : toDiscordTimestamp(new Date(value))
        const response = await patch(
          { communication_disabled_until: value },
          prefix
        )
        expect(response.status).toBe(200)
        const member = await response.json()
        expect(member).toMatchObject({ communication_disabled_until: expected })
        const get = await context.app.request(
          `${prefix}/guilds/${guildId}/members/${userId}`,
          {
            headers: { Authorization: token },
          }
        )
        expect(get.status).toBe(200)
        expect(await get.json()).toEqual(member)
        const list = await context.app.request(
          `${prefix}/guilds/${guildId}/members?limit=100`,
          {
            headers: { Authorization: token },
          }
        )
        expect(await list.json()).toContainEqual(member)
      }
    }
  )

  it('preserves unrelated member state, omitted timeouts and other guilds', async () => {
    const roleId = seedRole(context.db, guildId)
    updateGuildMember(context.db, guildId, userId, {
      nick: 'Original',
      roles: [roleId],
      mute: true,
    })
    context.db
      .prepare(
        'UPDATE guild_members SET deaf = 1, flags = 2 WHERE guild_id = ? AND user_id = ?'
      )
      .run(guildId, userId)
    const otherGuild = seedGuild(context.db, token, '666666666666666666')
    seedMember(context.db, otherGuild, userId)
    const before = getGuildMember(context.db, guildId, userId)
    const listener = vi.fn()
    gatewayBus.on('guild.member.update', listener)
    try {
      await patch({ communication_disabled_until: deadline })
      expect(getGuildMember(context.db, guildId, userId)).toEqual({
        ...before,
        communication_disabled_until: normalized,
      })
      expect(listener).toHaveBeenCalledWith({
        guildId,
        member: getGuildMember(context.db, guildId, userId),
        scope: { db: context.db, botId: '111111111111111111', token },
      })
      await patch({ nick: 'Changed' })
      await patch({ roles: [], mute: false })
      await patch({})
      expect(getGuildMember(context.db, guildId, userId)).toMatchObject({
        nick: 'Changed',
        roles: [],
        mute: false,
        deaf: true,
        flags: 2,
        communication_disabled_until: normalized,
      })
      expect(
        getGuildMember(context.db, otherGuild, userId)
          ?.communication_disabled_until
      ).toBeNull()
      await patch({ communication_disabled_until: null })
      expect(getGuildMember(context.db, guildId, userId)).toMatchObject({
        nick: 'Changed',
        roles: [],
        mute: false,
        deaf: true,
        flags: 2,
        communication_disabled_until: null,
      })
    } finally {
      gatewayBus.off('guild.member.update', listener)
    }
  })

  it('returns the updated member when timeout, roles and mute are patched together', async () => {
    const response = await patch({
      communication_disabled_until: deadline,
      roles: [],
      mute: false,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      communication_disabled_until: normalized,
    })
  })

  it.each(
    [
      42,
      true,
      [],
      {},
      '',
      'not-a-date',
      '2026-10-04',
      '2026-10-04T12:00:00',
      '2026-02-30T12:00:00Z',
      '2026-10-04T24:00:00Z',
      '2026-10-31T12:00:00.001Z',
    ].map((value) => [value])
  )(
    'rejects invalid timeout %j without mutating or dispatching',
    async (value) => {
      await patch({ communication_disabled_until: deadline })
      const before = getGuildMember(context.db, guildId, userId)
      const listener = vi.fn()
      gatewayBus.on('guild.member.update', listener)
      try {
        const response = await patch({
          nick: 'Must not change',
          communication_disabled_until: value,
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          code: 50_035,
          errors: {
            communication_disabled_until: { _errors: expect.any(Array) },
          },
        })
        expect(getGuildMember(context.db, guildId, userId)).toEqual(before)
        expect(listener).not.toHaveBeenCalled()
      } finally {
        gatewayBus.off('guild.member.update', listener)
      }
    }
  )

  it.each(['2026-10-31T12:00:00Z', '2026-10-02T12:00:00Z'])(
    'accepts the 28-day boundary and past timestamps: %s',
    async (value) => {
      const response = await patch({ communication_disabled_until: value })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        communication_disabled_until: toDiscordTimestamp(new Date(value)),
      })
    }
  )

  it('returns 401 for an unauthenticated timeout update', async () => {
    const response = await context.app.request(
      `/api/v10/guilds/${guildId}/members/${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ communication_disabled_until: deadline }),
      }
    )
    expect(response.status).toBe(401)
  })

  it('exposes the timeout through member search and the OAuth member view', async () => {
    const credential = seedBearerCredential(context.db, userId)
    context.db
      .prepare(
        "UPDATE oauth2_access_tokens SET scope = 'guilds.members.read' WHERE token = ?"
      )
      .run(credential.bearerToken)
    for (const value of [deadline, null]) {
      await patch({ communication_disabled_until: value })
      const expected = {
        communication_disabled_until: value === null ? null : normalized,
      }
      const search = await context.app.request(
        `/api/v10/guilds/${guildId}/members/search?query=Test`,
        { headers: { Authorization: token } }
      )
      expect(search.status).toBe(200)
      expect(await search.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            user: expect.objectContaining({ id: userId }),
            ...expected,
          }),
        ])
      )
      const oauth = await context.app.request(
        `/api/v10/users/@me/guilds/${guildId}/member`,
        { headers: { Authorization: `Bearer ${credential.bearerToken}` } }
      )
      expect(oauth.status).toBe(200)
      expect(await oauth.json()).toMatchObject(expected)
    }
  })

  it('does not set a timeout through the nickname-only current member endpoint', async () => {
    seedMember(context.db, guildId, '111111111111111111')
    const response = await context.app.request(
      `/api/v10/guilds/${guildId}/members/@me`,
      {
        method: 'PATCH',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nick: 'New nickname',
          communication_disabled_until: deadline,
        }),
      }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      nick: 'New nickname',
      communication_disabled_until: null,
    })
  })

  it.each(['guild', 'member'])(
    'returns 404 for an unknown %s',
    async (entity) => {
      if (entity === 'guild') guildId = '999999999999999999'
      else userId = '999999999999999999'
      const response = await patch({ communication_disabled_until: deadline })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        code: entity === 'guild' ? 10_004 : 10_007,
      })
    }
  )
})
