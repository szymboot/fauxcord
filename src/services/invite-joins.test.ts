import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, initializeDatabase } from '../db'
import type { Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import {
  seedBot,
  seedChannel,
  seedGuild,
  seedInvite,
  seedMember,
} from '../test-helpers'
import {
  consumeInviteUse,
  createInvite,
  deleteInvite,
  getInvite,
} from './invites'
import {
  createTestInvite,
  createTestUser,
  joinTestGuildMember,
} from './test-control'

const guildId = '222222222222222222'
const channelId = '333333333333333333'
const inviterId = '555555555555555555'
const joinerId = '555555555555555556'

describe('invite joins (service)', () => {
  let db: Database

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    seedGuild(db, seedBot(db, 'Bot svc-token'), guildId)
    seedChannel(db, guildId, channelId)
    createTestUser(db, { id: inviterId, username: 'inviter' })
    createTestUser(db, { id: joinerId, username: 'joiner' })
    expect(typeof joinTestGuildMember(db, guildId, inviterId)).toBe('object')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    closeDatabase(db)
  })

  /** Reads an invite's stored use counter. */
  function usesOf(code: string): number | undefined {
    return (
      db.prepare('SELECT uses FROM invites WHERE code = ?').get(code) as
        { uses: number } | undefined
    )?.uses
  }

  describe('joinTestGuildMember with an invite', () => {
    it('rolls back the use when the membership insert fails, with no event', () => {
      const invite = createInvite(db, {
        channelId,
        guildId,
        inviterId,
        maxUses: 1,
      })
      db.exec(
        `CREATE TRIGGER fail_member_insert BEFORE INSERT ON guild_members
         BEGIN SELECT RAISE(ABORT, 'boom'); END`
      )
      const emit = vi.spyOn(gatewayBus, 'emit')

      expect(() =>
        joinTestGuildMember(db, guildId, joinerId, null, invite.code)
      ).toThrow('boom')

      // The increment preceded the failing insert, yet nothing persisted:
      // the invite is still present (not exhausted-and-deleted) with 0 uses.
      expect(db.inTransaction).toBe(false)
      expect(usesOf(invite.code)).toBe(0)
      expect(emit).not.toHaveBeenCalled()
    })

    it('consumes the use and creates the membership together', () => {
      const invite = createInvite(db, { channelId, guildId, inviterId })
      const result = joinTestGuildMember(
        db,
        guildId,
        joinerId,
        'nick',
        invite.code
      )
      expect(result).toMatchObject({ nick: 'nick' })
      expect(usesOf(invite.code)).toBe(1)
    })

    it('returns UNKNOWN_INVITE for a code that does not exist', () => {
      expect(joinTestGuildMember(db, guildId, joinerId, null, 'nope')).toBe(
        'UNKNOWN_INVITE'
      )
      expect(
        db
          .prepare('SELECT 1 FROM guild_members WHERE user_id = ?')
          .get(joinerId)
      ).toBeUndefined()
    })

    it('deletes the target-users data together with an exhausted invite', () => {
      const invite = createInvite(db, {
        channelId,
        guildId,
        inviterId,
        maxUses: 1,
      })
      db.prepare(
        `INSERT INTO invite_target_users (code, raw_csv, total_users, processed_users, status)
         VALUES (?, 'user_id\n', 0, 0, 2)`
      ).run(invite.code)
      joinTestGuildMember(db, guildId, joinerId, null, invite.code)
      expect(getInvite(db, invite.code)).toBeNull()
      expect(db.prepare('SELECT * FROM invite_target_users').all()).toEqual([])
    })
  })

  describe('INVITE_DELETE publication inside an outer transaction', () => {
    it('refuses deleteInvite and keeps the invite and the bus silent', () => {
      const invite = createInvite(db, { channelId, guildId, inviterId })
      const emit = vi.spyOn(gatewayBus, 'emit')
      expect(() =>
        db.transaction(() => deleteInvite(db, invite.code))()
      ).toThrow('open transaction')
      expect(getInvite(db, invite.code)).not.toBeNull()
      expect(emit).not.toHaveBeenCalled()
    })

    it('refuses an invite join and leaves uses, membership and the bus untouched', () => {
      const invite = createInvite(db, {
        channelId,
        guildId,
        inviterId,
        maxUses: 1,
      })
      const emit = vi.spyOn(gatewayBus, 'emit')
      expect(() =>
        db.transaction(() =>
          joinTestGuildMember(db, guildId, joinerId, null, invite.code)
        )()
      ).toThrow('open transaction')
      expect(usesOf(invite.code)).toBe(0)
      expect(emit).not.toHaveBeenCalled()
    })
  })

  describe('consumeInviteUse', () => {
    it('refuses to run outside a transaction', () => {
      const invite = createInvite(db, { channelId, guildId, inviterId })
      expect(() => consumeInviteUse(db, guildId, invite.code)).toThrow(
        'transaction'
      )
      expect(usesOf(invite.code)).toBe(0)
    })

    it('judges expiry against created_at on the JS clock', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2031-05-05T10:00:00.000Z'))
      const invite = createInvite(db, {
        channelId,
        guildId,
        inviterId,
        maxAge: 10,
      })
      const row = db
        .prepare('SELECT created_at FROM invites WHERE code = ?')
        .get(invite.code) as { created_at: string }
      expect(row.created_at).toBe('2031-05-05 10:00:00')

      const consume = db.transaction(() =>
        consumeInviteUse(db, guildId, invite.code)
      )
      vi.setSystemTime(new Date('2031-05-05T10:00:09.999Z'))
      expect(consume()).toBe(true)
      vi.setSystemTime(new Date('2031-05-05T10:00:10.000Z'))
      expect(consume()).toBe(false)
      expect(usesOf(invite.code)).toBe(1)
    })

    it('treats a seeded invite as unlimited and unexpired by default clock use', () => {
      const code = seedInvite(db, channelId, guildId, inviterId, 'seeded01')
      db.prepare('UPDATE invites SET max_age = 0 WHERE code = ?').run(code)
      expect(db.transaction(() => consumeInviteUse(db, guildId, code))()).toBe(
        true
      )
      expect(usesOf(code)).toBe(1)
    })
  })

  describe('createTestInvite', () => {
    it('reports each rejection reason without creating an invite', () => {
      const bot = db.prepare('SELECT user_id FROM bots').get() as {
        user_id: string
      }
      const outsider = '555555555555555560'
      createTestUser(db, { id: outsider, username: 'outsider' })
      db.prepare(
        'INSERT INTO channels (id, guild_id, type, name) VALUES (?, NULL, 1, NULL)'
      ).run('777777777777777777')
      const attempts: [string, string, string][] = [
        ['UNKNOWN_CHANNEL', '1', inviterId],
        ['NOT_GUILD_CHANNEL', '777777777777777777', inviterId],
        ['UNKNOWN_USER', channelId, '1'],
        ['BOT_USER', channelId, bot.user_id],
        ['NOT_MEMBER', channelId, outsider],
      ]
      for (const [reason, cid, uid] of attempts) {
        expect(createTestInvite(db, cid, { inviter_id: uid })).toBe(reason)
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM invites').get()).toEqual({
        n: 0,
      })
    })

    it('creates an invite owned by a seeded human member', () => {
      const member = seedMember(db, guildId, '555555555555555561')
      const result = createTestInvite(db, channelId, { inviter_id: member })
      expect(result).toMatchObject({ inviter: { id: member }, uses: 0 })
    })
  })
})
