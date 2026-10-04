import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('member boost date fixtures', () => {
  let context: ReturnType<typeof createFullTestApp>
  let token: string
  let guildId: string
  let userId: string
  const date = '2020-02-29T14:00:00.123456+02:00'
  const normalized = '2020-02-29T12:00:00.123000+00:00'

  beforeEach(() => {
    context = createFullTestApp()
    token = seedBot(context.db)
    guildId = seedGuild(context.db, token)
    userId = seedMember(context.db, guildId)
  })

  afterEach(() => {
    context.db.close()
    vi.restoreAllMocks()
  })

  /** Updates the fixture without bot authentication. */
  function patch(body: string, guild = guildId, user = userId) {
    return context.app.request(`/_test/guilds/${guild}/members/${user}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  }

  it('sets, changes, omits and clears a date consistently in GET and paginated lists', async () => {
    expect(
      getGuildMember(context.db, guildId, userId)?.premium_since
    ).toBeNull()
    for (const [body, expected] of [
      [JSON.stringify({ premium_since: date }), normalized],
      ['{}', normalized],
      [
        '{"premium_since":"2021-01-01T00:00:00Z"}',
        '2021-01-01T00:00:00.000000+00:00',
      ],
      ['{"premium_since":null}', null],
      ['{}', null],
    ] as const) {
      const response = await patch(body)
      expect(response.status).toBe(200)
      const member = await response.json()
      expect(member).toMatchObject({ premium_since: expected })
      for (const prefix of ['/api/v10', '/api', '']) {
        const get = await context.app.request(
          `${prefix}/guilds/${guildId}/members/${userId}`,
          {
            headers: { Authorization: token },
          }
        )
        expect(get.status).toBe(200)
        expect(await get.json()).toEqual(member)
        const list = await context.app.request(
          `${prefix}/guilds/${guildId}/members?limit=1&after=111111111111111111`,
          {
            headers: { Authorization: token },
          }
        )
        expect(list.status).toBe(200)
        expect(await list.json()).toEqual([member])
      }
    }
  })

  it('preserves other fields and isolates the date by guild and user without events', async () => {
    const otherGuild = seedGuild(context.db, token, '666666666666666666')
    seedMember(context.db, otherGuild, userId)
    const otherUser = seedMember(context.db, guildId, '777777777777777777')
    const role = seedRole(context.db, guildId)
    updateGuildMember(context.db, guildId, userId, {
      nick: 'Retained',
      roles: [role],
      mute: true,
    })
    const original = getGuildMember(context.db, guildId, userId)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const set = await patch(JSON.stringify({ premium_since: date }))
    expect(set.status).toBe(200)
    expect(getGuildMember(context.db, guildId, userId)).toEqual({
      ...original,
      premium_since: normalized,
    })
    expect(
      getGuildMember(context.db, otherGuild, userId)?.premium_since
    ).toBeNull()
    expect(
      getGuildMember(context.db, guildId, otherUser)?.premium_since
    ).toBeNull()
    const ordinaryUpdate = await context.app.request(
      `/guilds/${guildId}/members/${userId}`,
      {
        method: 'PATCH',
        headers: { Authorization: token },
        body: '{"nick":"Changed"}',
      }
    )
    expect(ordinaryUpdate.status).toBe(200)
    expect(await ordinaryUpdate.json()).toMatchObject({
      premium_since: normalized,
    })
    const cleared = await patch('{"premium_since":null}')
    expect(cleared.status).toBe(200)
    expect(emit).toHaveBeenCalledTimes(1) // Only the ordinary REST update emits.
  })

  it.each([
    '',
    '{invalid',
    'null',
    '[]',
    '42',
    ...[
      42,
      false,
      {},
      [],
      '',
      'invalid',
      '2020-01-01',
      '2020-01-01T00:00:00',
      '2021-02-29T00:00:00Z',
      '2020-02-30T00:00:00Z',
      '2020-13-01T00:00:00Z',
      '2020-01-01T24:00:00Z',
      '2020-01-01T00:00:60Z',
      '2020-01-01T00:00:00+24:00',
    ].map((premiumSince) => JSON.stringify({ premium_since: premiumSince })),
    '{"nick":"Unsupported"}',
    '{"__proto__":{},"premium_since":null}',
  ])('rejects invalid input %s without mutation or events', async (body) => {
    await patch(JSON.stringify({ premium_since: date }))
    const original = getGuildMember(context.db, guildId, userId)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await patch(body)
    expect(response.status).toBe(400)
    expect(getGuildMember(context.db, guildId, userId)).toEqual(original)
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', 'missing', 10_004],
    [undefined, 'missing', 10_007],
  ])('rejects missing guild/member (%s/%s)', async (guild, user, code) => {
    const response = await patch('{"premium_since":null}', guild, user)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code })
  })

  it('keeps ordinary member reads authenticated', async () => {
    const response = await context.app.request(
      `/guilds/${guildId}/members/${userId}`
    )
    expect(response.status).toBe(401)
  })

  it('returns stored dates and null through OAuth member reads', async () => {
    const credential = seedBearerCredential(context.db, userId)
    context.db
      .prepare(
        "UPDATE oauth2_access_tokens SET scope = 'guilds.members.read' WHERE token = ?"
      )
      .run(credential.bearerToken)
    for (const value of [date, null]) {
      const fixture = await patch(JSON.stringify({ premium_since: value }))
      expect(fixture.status).toBe(200)
      const response = await context.app.request(
        `/api/v10/users/@me/guilds/${guildId}/member`,
        {
          headers: { Authorization: `Bearer ${credential.bearerToken}` },
        }
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        premium_since: value === null ? null : normalized,
      })
    }
  })
})
