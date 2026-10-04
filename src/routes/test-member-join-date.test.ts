import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import { getGuildMember } from '../services/guild-members'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedMember,
  seedBearerCredential,
} from '../test-helpers'

const guildId = '222222222222222222'
const userId = '555555555555555555'
const token = 'Bot fixture-token'
const fixturePath = `/_test/guilds/${guildId}/members/${userId}`
const joinedAt = '2020-02-29T12:34:56.123000+00:00'

describe('Test member join date preparation', () => {
  let context: ReturnType<typeof createFullTestApp>

  beforeEach(() => {
    context = createFullTestApp()
    seedGuild(context.db, seedBot(context.db, token), guildId)
    seedMember(context.db, guildId, userId)
    seedMember(context.db, guildId, '666666666666666666')
    const otherGuild = seedGuild(context.db, token, '777777777777777777')
    seedMember(context.db, otherGuild, userId)
    context.db
      .prepare(
        'UPDATE guild_members SET nick = ?, mute = 1, deaf = 1, flags = 4 WHERE guild_id = ? AND user_id = ?'
      )
      .run('Retained', guildId, userId)
    context.db
      .prepare('INSERT INTO roles (id, guild_id, name) VALUES (?, ?, ?)')
      .run('888888888888888888', guildId, 'Retained role')
    context.db
      .prepare(
        'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
      )
      .run(guildId, userId, '888888888888888888')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Captures membership and the identities and resources it must preserve. */
  function snapshot() {
    return Object.fromEntries(
      [
        'guilds',
        'users',
        'bots',
        'guild_members',
        'member_roles',
        'roles',
        'channels',
      ].map((table) => [
        table,
        context.db.prepare(`SELECT * FROM ${table}`).all(),
      ])
    )
  }

  it('silently changes only the selected membership and returns the native member in GET and list', async () => {
    const before = snapshot()
    const original = getGuildMember(context.db, guildId, userId)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: JSON.stringify({
        joined_at: '2020-02-29T14:34:56.123+02:00',
      }),
    })
    expect(response.status).toBe(200)
    const expected = { ...original, joined_at: joinedAt }
    await expect(response.json()).resolves.toEqual(expected)
    const after = snapshot()
    expect({ ...after, guild_members: before.guild_members }).toEqual(before)
    expect(after.guild_members).toEqual(
      (before.guild_members as Record<string, unknown>[]).map((member) =>
        member.guild_id === guildId && member.user_id === userId
          ? { ...member, joined_at: joinedAt }
          : member
      )
    )
    expect(emit).not.toHaveBeenCalled()
    for (const prefix of ['', '/api', '/api/v10']) {
      const rest = await context.app.request(
        `${prefix}/guilds/${guildId}/members/${userId}`,
        {
          headers: { Authorization: token },
        }
      )
      expect(rest.status).toBe(200)
      await expect(rest.json()).resolves.toEqual(expected)
      const list = await context.app.request(
        `${prefix}/guilds/${guildId}/members?limit=100`,
        {
          headers: { Authorization: token },
        }
      )
      expect(list.status).toBe(200)
      await expect(list.json()).resolves.toContainEqual(expected)
    }
    const unauthenticated = await context.app.request(
      `/api/v10/guilds/${guildId}/members/${userId}`
    )
    expect(unauthenticated.status).toBe(401)
  })

  it.each(['{}', '{"premium_since":null}'])(
    'preserves the generated join date when joined_at is omitted in %s',
    async (body) => {
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await context.app.request(fixturePath, {
        method: 'PATCH',
        body,
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(
        getGuildMember(context.db, guildId, userId)
      )
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it('returns prepared and legacy join dates through the scoped OAuth member read', async () => {
    const credential = seedBearerCredential(context.db, userId)
    context.db
      .prepare(
        "UPDATE oauth2_access_tokens SET scope = 'guilds.members.read' WHERE token = ?"
      )
      .run(credential.bearerToken)
    const original = getGuildMember(context.db, guildId, userId)
    for (const expected of [original?.joined_at, joinedAt]) {
      if (expected === joinedAt) {
        const fixture = await context.app.request(fixturePath, {
          method: 'PATCH',
          body: JSON.stringify({
            joined_at: joinedAt,
            premium_since: '2021-01-01T00:00:00Z',
          }),
        })
        expect(fixture.status).toBe(200)
      }
      for (const prefix of ['', '/api', '/api/v10']) {
        const response = await context.app.request(
          `${prefix}/users/@me/guilds/${guildId}/member`,
          {
            headers: { Authorization: `Bearer ${credential.bearerToken}` },
          }
        )
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({
          joined_at: expected,
          premium_since:
            expected === joinedAt
              ? '2021-01-01T00:00:00.000000+00:00'
              : original?.premium_since,
          user: { id: userId },
        })
      }
    }
  })

  it.each([
    {
      input: '2020-02-29T12:34:56Z',
      output: '2020-02-29T12:34:56.000000+00:00',
    },
    { input: '2020-02-29T12:34:56.123456+00:00', output: joinedAt },
    {
      input: '2020-03-01T00:30:00+01:00',
      output: '2020-02-29T23:30:00.000000+00:00',
    },
  ])('normalizes $input consistently', async ({ input, output }) => {
    const response = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: JSON.stringify({ joined_at: input }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ joined_at: output })
    expect(getGuildMember(context.db, guildId, userId)?.joined_at).toBe(output)
  })

  it('keeps live REST updates and subsequent joins on their existing paths', async () => {
    const prepared = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: JSON.stringify({ joined_at: joinedAt }),
    })
    expect(prepared.status).toBe(200)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const updated = await context.app.request(
      `/api/v10/guilds/${guildId}/members/${userId}`,
      {
        method: 'PATCH',
        headers: { Authorization: token },
        body: JSON.stringify({
          nick: 'Live nickname',
          joined_at: '2010-01-01T00:00:00Z',
        }),
      }
    )
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      nick: 'Live nickname',
      joined_at: joinedAt,
    })
    expect(emit).toHaveBeenCalledWith('guild.member.update', expect.any(Object))
    const removed = await context.app.request(
      `/api/v10/guilds/${guildId}/members/${userId}`,
      {
        method: 'DELETE',
        headers: { Authorization: token },
      }
    )
    expect(removed.status).toBe(204)
    emit.mockClear()
    const rejoined = await context.app.request(fixturePath, { method: 'POST' })
    expect(rejoined.status).toBe(201)
    const member = (await rejoined.json()) as {
      joined_at: string
      nick: string | null
    }
    expect(Math.abs(Date.now() - Date.parse(member.joined_at))).toBeLessThan(
      5000
    )
    expect(member.nick).toBeNull()
    expect(emit).toHaveBeenCalledExactlyOnceWith('guild.member.add', {
      guildId,
      member,
    })
  })

  it.each(
    [
      null,
      42,
      true,
      {},
      [],
      '',
      'invalid',
      '2020-01-01',
      '2020-01-01T00:00:00',
      '2021-02-29T00:00:00Z',
      '2020-04-31T00:00:00Z',
      '2020-13-01T00:00:00Z',
      '2020-01-01T24:00:00Z',
      '2020-01-01T00:00:60Z',
      '2020-01-01T00:00:00+24:00',
      '9999-12-31T23:59:59-01:00',
    ].map((value) => ({ value }))
  )('rejects invalid joined_at $value atomically', async ({ value }) => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: JSON.stringify({ joined_at: value }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 50_035,
      errors: { joined_at: { _errors: expect.any(Array) } },
    })
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'null', '[]', '42', '{invalid'])(
    'rejects malformed body %s without effects',
    async (body) => {
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await context.app.request(fixturePath, {
        method: 'PATCH',
        body,
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ code: 0 })
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it('sets both dates atomically and preserves each omitted field without activity', async () => {
    const original = getGuildMember(context.db, guildId, userId)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const premiumSince = '2021-01-01T00:00:00.000000+00:00'
    const expected = {
      ...original,
      joined_at: joinedAt,
      premium_since: premiumSince,
    }
    const set = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: JSON.stringify({
        joined_at: joinedAt,
        premium_since: premiumSince,
      }),
    })
    expect(set.status).toBe(200)
    await expect(set.json()).resolves.toEqual(expected)
    const after = snapshot()
    expect({ ...after, guild_members: before.guild_members }).toEqual(before)
    expect(after.guild_members).toEqual(
      (before.guild_members as Record<string, unknown>[]).map((member) =>
        member.guild_id === guildId && member.user_id === userId
          ? { ...member, joined_at: joinedAt, premium_since: premiumSince }
          : member
      )
    )
    for (const body of [
      { joined_at: joinedAt },
      { premium_since: premiumSince },
      {},
    ]) {
      const omitted = await context.app.request(fixturePath, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      expect(omitted.status).toBe(200)
      await expect(omitted.json()).resolves.toEqual(expected)
      expect(snapshot()).toEqual(after)
    }
    const cleared = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: JSON.stringify({ joined_at: joinedAt, premium_since: null }),
    })
    expect(cleared.status).toBe(200)
    await expect(cleared.json()).resolves.toEqual({
      ...expected,
      premium_since: null,
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([
    { joined_at: null, premium_since: '2021-01-01T00:00:00Z' },
    { joined_at: 'invalid', premium_since: null },
    { joined_at: joinedAt, premium_since: 'invalid' },
    { joined_at: joinedAt, premium_since: '2021-02-29T00:00:00Z' },
    { joined_at: joinedAt, premium_since: null, nick: 'Unsupported' },
  ])('validates the whole fixture before any write: %j', async (body) => {
    const set = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: '{"premium_since":"2022-01-01T00:00:00Z"}',
    })
    expect(set.status).toBe(200)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 50_035 })
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([
    { path: `/_test/guilds/missing/members/${userId}`, code: 10_004 },
    { path: `/_test/guilds/${guildId}/members/missing`, code: 10_007 },
    {
      path: `/_test/guilds/${guildId}/members/111111111111111111`,
      code: 10_007,
    },
  ])('does not create missing membership at $path', async ({ path, code }) => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(path, {
      method: 'PATCH',
      body: JSON.stringify({ joined_at: joinedAt }),
    })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code })
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('rolls back a database failure without emitting activity', async () => {
    context.db.exec(`CREATE TRIGGER reject_date AFTER UPDATE ON guild_members
      BEGIN SELECT RAISE(ABORT, 'Fixture failed'); END`)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(fixturePath, {
      method: 'PATCH',
      body: JSON.stringify({
        joined_at: joinedAt,
        premium_since: '2021-01-01T00:00:00Z',
      }),
    })
    expect(response.status).toBe(500)
    expect(context.db.inTransaction).toBe(false)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })
})
