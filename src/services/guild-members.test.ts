import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initializeDatabase, closeDatabase } from '../db'
import type { Database } from '../db'
import {
  addMemberRole,
  removeMemberRole,
  removeGuildMember,
} from './guild-members'
import { gatewayBus } from '../gateway/bus'
import { seedBot, seedGuild, seedMember, seedRole } from '../test-helpers'

describe('Guilds Service', () => {
  let db: Database

  beforeEach(() => {
    db = initializeDatabase(':memory:')
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('removeGuildMember', () => {
    it.each([false, true])(
      'emits a normalized user with bot=%s and only removes membership in the target guild',
      (bot) => {
        const token = seedBot(db)
        const guildId = seedGuild(db, token)
        const otherGuildId = seedGuild(db, token, '666666666666666666')
        const userId = seedMember(db, guildId)
        seedMember(db, otherGuildId, userId)
        db.prepare(
          'UPDATE users SET username = ?, discriminator = ?, avatar = ?, bot = ? WHERE id = ?'
        ).run('DepartingMember', '1234', 'avatar-hash', bot ? 1 : 0, userId)
        const profile = db
          .prepare('SELECT * FROM users WHERE id = ?')
          .get(userId)
        const roleId = seedRole(db, guildId)
        const otherRoleId = seedRole(db, otherGuildId)
        addMemberRole(db, guildId, userId, roleId)
        addMemberRole(db, otherGuildId, userId, otherRoleId)

        const listener = vi.fn()
        gatewayBus.on('guild.member.remove', listener)
        try {
          expect(removeGuildMember(db, guildId, userId)).toBe(true)
          expect(listener).toHaveBeenCalledExactlyOnceWith({
            guildId,
            userId,
            user: {
              id: userId,
              username: 'DepartingMember',
              discriminator: '1234',
              avatar: 'avatar-hash',
              bot,
              flags: 0,
              public_flags: 0,
              global_name: null,
              primary_guild: null,
            },
          })
          expect(
            db
              .prepare('SELECT * FROM guild_members WHERE user_id = ?')
              .all(userId)
          ).toEqual([
            expect.objectContaining({
              guild_id: otherGuildId,
              user_id: userId,
            }),
          ])
          expect(
            db
              .prepare('SELECT * FROM member_roles WHERE user_id = ?')
              .all(userId)
          ).toEqual([
            { guild_id: otherGuildId, user_id: userId, role_id: otherRoleId },
          ])
          expect(
            db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
          ).toEqual(profile)

          expect(removeGuildMember(db, guildId, userId)).toBe(false)
          expect(listener).toHaveBeenCalledTimes(1)
        } finally {
          gatewayBus.off('guild.member.remove', listener)
        }
      }
    )

    it('returns false without emitting for a user who is not a member', () => {
      const token = seedBot(db)
      const guildId = seedGuild(db, token)
      const listener = vi.fn()
      gatewayBus.on('guild.member.remove', listener)
      try {
        expect(removeGuildMember(db, guildId, '111111111111111111')).toBe(false)
        expect(removeGuildMember(db, guildId, '999999999999999999')).toBe(false)
        expect(listener).not.toHaveBeenCalled()
      } finally {
        gatewayBus.off('guild.member.remove', listener)
      }
    })
  })

  describe('addMemberRole', () => {
    const guildId = '222222222222222222'
    const userId = '555555555555555555'
    const roleId = '444444444444444444'

    beforeEach(() => {
      db.prepare(
        "INSERT INTO users (id, username, bot) VALUES (?, 'TestBot', 1)"
      ).run('111111111111111111')
      db.prepare(
        "INSERT INTO bots (token, user_id, username) VALUES (?, ?, 'TestBot')"
      ).run('Bot testtoken', '111111111111111111')
      db.prepare(
        'INSERT INTO guilds (id, name, owner_id, bot_token) VALUES (?, ?, ?, ?)'
      ).run(guildId, 'Test Guild', '111111111111111111', 'Bot testtoken')
      db.prepare(
        "INSERT INTO users (id, username) VALUES (?, 'TestMember')"
      ).run(userId)
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, userId)
      db.prepare(
        'INSERT INTO roles (id, guild_id, name, position) VALUES (?, ?, ?, 1)'
      ).run(roleId, guildId, 'Test Role')
    })

    it('adds a role to an existing member and returns true', () => {
      const result = addMemberRole(db, guildId, userId, roleId)
      expect(result).toBe(true)

      const row = db
        .prepare(
          'SELECT 1 FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?'
        )
        .get(guildId, userId, roleId)
      expect(row).toBeDefined()
    })

    it('is idempotent when the role is already assigned', () => {
      addMemberRole(db, guildId, userId, roleId)
      const result = addMemberRole(db, guildId, userId, roleId)
      expect(result).toBe(true)

      const rows = db
        .prepare(
          'SELECT * FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?'
        )
        .all(guildId, userId, roleId)
      expect(rows.length).toBe(1)
    })

    it('returns false when the member does not exist', () => {
      const result = addMemberRole(db, guildId, '999999999999999999', roleId)
      expect(result).toBe(false)
    })

    it('returns false when the role does not exist', () => {
      const result = addMemberRole(db, guildId, userId, '999999999999999999')
      expect(result).toBe(false)

      const row = db
        .prepare(
          'SELECT 1 FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?'
        )
        .get(guildId, userId, '999999999999999999')
      expect(row).toBeUndefined()
    })

    it('emits guild.member.update with the updated member on success', () => {
      const listener = vi.fn()
      gatewayBus.on('guild.member.update', listener)
      try {
        addMemberRole(db, guildId, userId, roleId)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ guildId })
        )
      } finally {
        gatewayBus.off('guild.member.update', listener)
      }
    })

    it('does not emit guild.member.update when getGuildMember returns null (inconsistent DB state)', () => {
      // Simulate a member row whose user record has gone missing, which makes
      // getGuildMember() return null even though the initial membership check
      // (which only looks at guild_members) passes.
      db.pragma('foreign_keys = OFF')
      db.prepare('DELETE FROM users WHERE id = ?').run(userId)

      const listener = vi.fn()
      gatewayBus.on('guild.member.update', listener)
      try {
        const result = addMemberRole(db, guildId, userId, roleId)
        expect(result).toBe(true)
        expect(listener).not.toHaveBeenCalled()
      } finally {
        gatewayBus.off('guild.member.update', listener)
      }
    })
  })

  describe('removeMemberRole', () => {
    const guildId = '222222222222222222'
    const userId = '555555555555555555'
    const roleId = '444444444444444444'

    beforeEach(() => {
      db.prepare(
        "INSERT INTO users (id, username, bot) VALUES (?, 'TestBot', 1)"
      ).run('111111111111111111')
      db.prepare(
        "INSERT INTO bots (token, user_id, username) VALUES (?, ?, 'TestBot')"
      ).run('Bot testtoken', '111111111111111111')
      db.prepare(
        'INSERT INTO guilds (id, name, owner_id, bot_token) VALUES (?, ?, ?, ?)'
      ).run(guildId, 'Test Guild', '111111111111111111', 'Bot testtoken')
      db.prepare(
        "INSERT INTO users (id, username) VALUES (?, 'TestMember')"
      ).run(userId)
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, userId)
      db.prepare(
        'INSERT INTO roles (id, guild_id, name, position) VALUES (?, ?, ?, 1)'
      ).run(roleId, guildId, 'Test Role')
      db.prepare(
        'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
      ).run(guildId, userId, roleId)
    })

    it('removes an assigned role and returns true', () => {
      const result = removeMemberRole(db, guildId, userId, roleId)
      expect(result).toBe(true)

      const row = db
        .prepare(
          'SELECT 1 FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?'
        )
        .get(guildId, userId, roleId)
      expect(row).toBeUndefined()
    })

    it('is idempotent when the role is not assigned', () => {
      removeMemberRole(db, guildId, userId, roleId)
      const result = removeMemberRole(db, guildId, userId, roleId)
      expect(result).toBe(true)
    })

    it('returns false when the member does not exist', () => {
      const result = removeMemberRole(db, guildId, '999999999999999999', roleId)
      expect(result).toBe(false)
    })

    it('emits guild.member.update with the updated member on success', () => {
      const listener = vi.fn()
      gatewayBus.on('guild.member.update', listener)
      try {
        removeMemberRole(db, guildId, userId, roleId)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ guildId })
        )
      } finally {
        gatewayBus.off('guild.member.update', listener)
      }
    })

    it('does not emit guild.member.update when getGuildMember returns null (inconsistent DB state)', () => {
      // Simulate a member row whose user record has gone missing, which makes
      // getGuildMember() return null even though the initial membership check
      // (which only looks at guild_members) passes.
      db.pragma('foreign_keys = OFF')
      db.prepare('DELETE FROM users WHERE id = ?').run(userId)

      const listener = vi.fn()
      gatewayBus.on('guild.member.update', listener)
      try {
        const result = removeMemberRole(db, guildId, userId, roleId)
        expect(result).toBe(true)
        expect(listener).not.toHaveBeenCalled()
      } finally {
        gatewayBus.off('guild.member.update', listener)
      }
    })
  })
})
