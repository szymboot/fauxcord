import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedMember,
  seedRole,
} from '../test-helpers'
import { getGuildMember, updateGuildMember } from '../services/guild-members'
import { gatewayBus } from '../gateway/bus'

describe('live member boost control', () => {
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

  /** Changes a live boost without bot authentication. */
  function boost(body: string, guild = guildId, user = userId) {
    return context.app.request(
      `/_test/guilds/${guild}/members/${user}/premium`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }
    )
  }

  it('stores the normalized value, then emits exactly one full member update', async () => {
    const role = seedRole(context.db, guildId)
    updateGuildMember(context.db, guildId, userId, {
      nick: 'Booster',
      roles: [role],
    })
    const calls: unknown[] = []
    const original = gatewayBus.emit.bind(gatewayBus)
    const emit = vi.spyOn(gatewayBus, 'emit')
    emit.mockImplementation(((
      event: string,
      payload: { guildId: string; member: { premium_since: string | null } }
    ) => {
      // The commit must already be visible when the event is emitted.
      calls.push([
        event,
        getGuildMember(context.db, payload.guildId, userId)?.premium_since,
        context.db.inTransaction,
      ])
      return original(event as never, payload as never)
    }) as never)

    const response = await boost(JSON.stringify({ premium_since: date }))
    expect(response.status).toBe(200)
    const member = await response.json()
    expect(member).toEqual(getGuildMember(context.db, guildId, userId))
    expect(member).toMatchObject({
      nick: 'Booster',
      roles: [role],
      premium_since: normalized,
    })
    // Emission happens after commit, not inside the writing transaction.
    expect(calls).toEqual([['guild.member.update', normalized, false]])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      'guild.member.update',
      expect.objectContaining({
        guildId,
        member,
        scope: expect.objectContaining({ db: context.db, token }),
      })
    )
  })

  it('changes, ends and re-reads the boost through REST', async () => {
    for (const [value, expected] of [
      [date, normalized],
      ['2021-01-01T00:00:00Z', '2021-01-01T00:00:00.000000+00:00'],
      [null, null],
    ] as const) {
      const response = await boost(JSON.stringify({ premium_since: value }))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ premium_since: expected })
      for (const prefix of ['/api/v10', '/api', '']) {
        const get = await context.app.request(
          `${prefix}/guilds/${guildId}/members/${userId}`,
          { headers: { Authorization: token } }
        )
        expect(await get.json()).toMatchObject({ premium_since: expected })
        const list = await context.app.request(
          `${prefix}/guilds/${guildId}/members?limit=1&after=111111111111111111`,
          { headers: { Authorization: token } }
        )
        expect(await list.json()).toMatchObject([{ premium_since: expected }])
      }
    }
  })

  it('returns 200 without an event when the stored value is unchanged', async () => {
    const initial = await boost('{"premium_since":null}')
    expect(initial.status).toBe(200)
    const emit = vi.spyOn(gatewayBus, 'emit')
    await boost(JSON.stringify({ premium_since: date }))
    expect(emit).toHaveBeenCalledTimes(1)
    emit.mockClear()
    // The same instant in another notation normalizes to the stored value.
    const same = await boost('{"premium_since":"2020-02-29T12:00:00.123Z"}')
    expect(same.status).toBe(200)
    expect(await same.json()).toMatchObject({ premium_since: normalized })
    expect(emit).not.toHaveBeenCalled()
    await boost('{"premium_since":null}')
    emit.mockClear()
    const again = await boost('{"premium_since":null}')
    expect(again.status).toBe(200)
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([
    '2020-02-29T12:00:00.123Z',
    '2020-02-29T14:00:00.123+02:00',
    '2020-02-29 12:00:00.123',
  ])('treats legacy stored %s of the same instant as a no-op', async (raw) => {
    context.db
      .prepare(
        'UPDATE guild_members SET premium_since = ? WHERE guild_id = ? AND user_id = ?'
      )
      .run(raw, guildId, userId)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await boost(
      JSON.stringify({ premium_since: '2020-02-29T12:00:00.123Z' })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ premium_since: normalized })
    expect(emit).not.toHaveBeenCalled()
    // The stored value is canonicalized silently.
    expect(getGuildMember(context.db, guildId, userId)?.premium_since).toBe(
      normalized
    )
  })

  it('isolates the change by guild and user', async () => {
    const otherGuild = seedGuild(context.db, token, '666666666666666666')
    seedMember(context.db, otherGuild, userId)
    const otherUser = seedMember(context.db, guildId, '777777777777777777')
    const response = await boost(JSON.stringify({ premium_since: date }))
    expect(response.status).toBe(200)
    expect(
      getGuildMember(context.db, otherGuild, userId)?.premium_since
    ).toBeNull()
    expect(
      getGuildMember(context.db, guildId, otherUser)?.premium_since
    ).toBeNull()
  })

  it.each([
    '',
    '{invalid',
    'null',
    '[]',
    '42',
    '{}',
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
      '2020-01-01T24:00:00Z',
      '2020-01-01T00:00:00+24:00',
    ].map((premiumSince) => JSON.stringify({ premium_since: premiumSince })),
    '{"premium_since":null,"joined_at":"2019-01-02T03:04:05Z"}',
    '{"premium_since":null,"nick":"Unsupported"}',
    '{"__proto__":{},"premium_since":null}',
  ])('rejects invalid input %s without mutation or events', async (body) => {
    await boost(JSON.stringify({ premium_since: date }))
    const original = getGuildMember(context.db, guildId, userId)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await boost(body)
    expect(response.status).toBe(400)
    expect(getGuildMember(context.db, guildId, userId)).toEqual(original)
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports field errors in the Discord validation shape', async () => {
    const missing = await boost('{}')
    expect(await missing.json()).toMatchObject({
      code: 50_035,
      errors: { premium_since: { _errors: [{ code: 'BASE_TYPE_REQUIRED' }] } },
    })
    const bad = await boost('{"premium_since":"2020-01-01T00:00:00"}')
    expect(await bad.json()).toMatchObject({
      code: 50_035,
      errors: {
        premium_since: { _errors: [{ code: 'BASE_TYPE_BAD_FORMAT' }] },
      },
    })
  })

  it.each([
    ['missing', 'missing', 10_004],
    [undefined, 'missing', 10_007],
  ])('rejects missing guild/member (%s/%s)', async (guild, user, code) => {
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await boost('{"premium_since":null}', guild, user)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code })
    expect(emit).not.toHaveBeenCalled()
  })

  it('rejects a user that is only a member of another guild', async () => {
    const otherGuild = seedGuild(context.db, token, '666666666666666666')
    const outsider = seedMember(context.db, otherGuild, '777777777777777777')
    const response = await boost(
      JSON.stringify({ premium_since: date }),
      guildId,
      outsider
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 10_007 })
    expect(
      getGuildMember(context.db, otherGuild, outsider)?.premium_since
    ).toBeNull()
  })

  it('rejects bot members without mutation or events', async () => {
    const botId = context.db
      .prepare('SELECT user_id FROM bots WHERE token = ?')
      .get(token) as { user_id: string }
    context.db
      .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
      .run(guildId, botId.user_id)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await boost(
      JSON.stringify({ premium_since: date }),
      guildId,
      botId.user_id
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      message: 'Bot members cannot boost',
      code: 0,
    })
    expect(
      getGuildMember(context.db, guildId, botId.user_id)?.premium_since
    ).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('leaves the silent PATCH fixture contract event-free', async () => {
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(
      `/_test/guilds/${guildId}/members/${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ premium_since: date }),
      }
    )
    expect(response.status).toBe(200)
    expect(emit).not.toHaveBeenCalled()
  })
})
