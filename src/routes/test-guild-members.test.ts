import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import type { GatewayBusEvents } from '../gateway/bus'
import { getGuildMember } from '../services/guild-members'
import type { GuildMemberObject } from '../services/guild-members'
import { createFullTestApp, seedBot, seedGuild } from '../test-helpers'

const guildId = '222222222222222222'
const userId = '555555555555555555'
const token = 'Bot join-token'
const joinPath = `/_test/guilds/${guildId}/members/${userId}`

describe('Test guild member join contract', () => {
  let context: ReturnType<typeof createFullTestApp>

  beforeEach(async () => {
    context = createFullTestApp()
    seedGuild(context.db, seedBot(context.db, token), guildId)
    const response = await context.app.request('/_test/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: userId,
        username: 'Human',
        discriminator: '1234',
      }),
    })
    expect(response.status).toBe(201)
    context.db
      .prepare('UPDATE users SET avatar = ? WHERE id = ?')
      .run('human-avatar', userId)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Returns all state that joining a member must preserve. */
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

  it('returns the stored member and emits once after commit without changing other resources', async () => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const onAdd = vi.fn((event: GatewayBusEvents['guild.member.add']) => {
      expect(context.db.inTransaction).toBe(false)
      expect(getGuildMember(context.db, guildId, userId)).toEqual(event.member)
    })
    gatewayBus.on('guild.member.add', onAdd)
    try {
      const response = await context.app.request(joinPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: 'Test nickname' }),
      })
      expect(response.status).toBe(201)
      const member = (await response.json()) as GuildMemberObject
      expect(member).toEqual({
        avatar: null,
        banner: null,
        communication_disabled_until: null,
        flags: 0,
        joined_at: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/
        ),
        nick: 'Test nickname',
        pending: false,
        premium_since: null,
        roles: [],
        user: {
          id: userId,
          username: 'Human',
          discriminator: '1234',
          avatar: 'human-avatar',
          bot: false,
          flags: 0,
          public_flags: 0,
          global_name: null,
          primary_guild: null,
        },
        mute: false,
        deaf: false,
      })
      expect(Math.abs(Date.now() - Date.parse(member.joined_at))).toBeLessThan(
        5000
      )
      expect(onAdd).toHaveBeenCalledExactlyOnceWith({ guildId, member })
      expect(emit).toHaveBeenCalledExactlyOnceWith('guild.member.add', {
        guildId,
        member,
      })
      const after = snapshot()
      expect({ ...after, guild_members: before.guild_members }).toEqual(before)
      const rest = await context.app.request(
        `/api/v10/guilds/${guildId}/members/${userId}`,
        {
          headers: { Authorization: token },
        }
      )
      expect(rest.status).toBe(200)
      await expect(rest.json()).resolves.toEqual(member)
    } finally {
      gatewayBus.off('guild.member.add', onAdd)
    }
  })

  it.each([undefined, '{}', '{"nick":null}'])(
    'defaults the nickname to null for body %s',
    async (body) => {
      const response = await context.app.request(joinPath, {
        method: 'POST',
        body,
      })
      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({
        nick: null,
        user: { id: userId, bot: false },
      })
    }
  )

  it.each([
    ...['null', '[]', '42', '{invalid'].map((body) => ({
      path: joinPath,
      body,
      status: 400,
      code: 0,
    })),
    {
      path: `/_test/guilds/missing/members/${userId}`,
      body: undefined,
      status: 404,
      code: 10_004,
    },
    {
      path: `/_test/guilds/${guildId}/members/missing`,
      body: undefined,
      status: 404,
      code: 10_013,
    },
    {
      path: `/_test/guilds/${guildId}/members/111111111111111111`,
      body: undefined,
      status: 400,
      code: 0,
    },
    { path: joinPath, body: '{"nick":42}', status: 400, code: 50_035 },
    {
      path: joinPath,
      body: JSON.stringify({ nick: 'x'.repeat(33) }),
      status: 400,
      code: 50_035,
    },
  ])(
    'rejects $path with $status without mutation or emission',
    async ({ path, body, status, code }) => {
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await context.app.request(path, { method: 'POST', body })
      expect(response.status).toBe(status)
      await expect(response.json()).resolves.toMatchObject({ code })
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it('rejects a duplicate even with a different nickname without mutation or emission', async () => {
    await context.app.request(joinPath, {
      method: 'POST',
      body: '{"nick":"Original"}',
    })
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(joinPath, {
      method: 'POST',
      body: '{"nick":"Replacement"}',
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      message: '409: Conflict',
      code: 0,
    })
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('rolls back a failed insert without emission', async () => {
    context.db.exec(`CREATE TRIGGER reject_join AFTER INSERT ON guild_members
      BEGIN SELECT RAISE(ABORT, 'Join failed'); END`)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(joinPath, { method: 'POST' })
    expect(response.status).toBe(500)
    expect(context.db.inTransaction).toBe(false)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('allows the same profile to return after the existing REST delete', async () => {
    await context.app.request(joinPath, {
      method: 'POST',
      body: '{"nick":"Before leaving"}',
    })
    const original = getGuildMember(context.db, guildId, userId)
    context.db
      .prepare(
        'UPDATE guild_members SET joined_at = ? WHERE guild_id = ? AND user_id = ?'
      )
      .run('2020-01-01 00:00:00', guildId, userId)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const removed = await context.app.request(
      `/guilds/${guildId}/members/${userId}`,
      {
        method: 'DELETE',
        headers: { Authorization: token },
      }
    )
    expect(removed.status).toBe(204)
    expect(getGuildMember(context.db, guildId, userId)).toBeNull()
    expect(emit).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith(
      'guild.member.remove',
      expect.objectContaining({ guildId, userId })
    )
    emit.mockClear()
    const response = await context.app.request(joinPath, { method: 'POST' })
    expect(response.status).toBe(201)
    const member = (await response.json()) as GuildMemberObject
    expect(member.user).toEqual(original?.user)
    expect(member.nick).toBeNull()
    expect(member.joined_at).not.toBe('2020-01-01T00:00:00.000000+00:00')
    expect(emit).toHaveBeenCalledExactlyOnceWith('guild.member.add', {
      guildId,
      member,
    })
  })
})
