import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, initializeDatabase, type Database } from '../db'
import { seedBot, seedChannel, seedGuild } from '../test-helpers'
import { createTestUser, deleteTestSetup, resetTestData } from './test-control'
import { createAuditLogEntry, listAuditLogs } from './audit-logs'
import { snowflakeToTimestamp } from '../snowflake'

describe('controlled audit logs', () => {
  let db: Database
  let guildId: string
  let channelId: string
  let actorId: string
  let targetId: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    const token = seedBot(db, 'Bot audit', '111111111111111111')
    actorId = '111111111111111111'
    guildId = seedGuild(db, token)
    channelId = seedChannel(db, guildId)
    targetId = createTestUser(db, { username: 'Author' }).id
  })

  afterEach(() => {
    closeDatabase(db)
  })

  /** Creates a deletion entry without touching messages or memberships. */
  function seed(id: string, target = targetId) {
    return createAuditLogEntry(db, guildId, {
      id,
      action_type: 72,
      user_id: actorId,
      target_id: target,
      options: { channel_id: channelId, count: '2' },
    })
  }

  it('keeps empty history valid and returns only referenced user profiles', () => {
    expect(listAuditLogs(db, guildId).audit_log_entries).toEqual([])
    expect(seed('999')).toEqual({
      id: '999',
      action_type: 72,
      user_id: actorId,
      target_id: targetId,
      options: { channel_id: channelId, count: '2' },
    })
    const logs = listAuditLogs(db, guildId)
    expect(logs.users.map((user) => user.id)).toEqual([actorId, targetId])
    expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
    expect(db.prepare('SELECT * FROM guild_members').all()).toEqual([])
  })

  it('sorts and paginates unsigned snowflakes numerically beyond SQLite integers', () => {
    for (const id of [
      '9',
      '100',
      '99',
      '9223372036854775808',
      '18446744073709551615',
    ])
      seed(id)
    const ids = (query = {}) =>
      listAuditLogs(db, guildId, query).audit_log_entries.map(
        (entry) => entry.id
      )
    expect(ids({ before: '18446744073709551615' })).toEqual([
      '9223372036854775808',
      '100',
      '99',
      '9',
    ])
    expect(ids({ before: '100', limit: 1 })).toEqual(['99'])
    expect(ids({ after: '9', limit: 2 })).toEqual(['99', '100'])
    expect(ids({ before: '100', after: '9' })).toEqual(['99'])
    expect(ids({ action_type: 73 })).toEqual([])
    expect(ids({ user_id: targetId })).toEqual([])
    expect(ids({ target_id: actorId })).toEqual([])
  })

  it('uses a default page of 50, allows 100 and excludes future entries without a cursor', () => {
    for (let index = 1; index <= 105; index++) seed(String(index))
    seed('18446744073709551615')
    const defaultPage = listAuditLogs(db, guildId)
    expect(defaultPage.audit_log_entries).toHaveLength(50)
    expect(defaultPage.audit_log_entries[0]?.id).toBe('105')
    expect(defaultPage.audit_log_entries.at(-1)?.id).toBe('56')
    expect(
      listAuditLogs(db, guildId, { limit: 100 }).audit_log_entries
    ).toHaveLength(100)
    expect(
      listAuditLogs(db, guildId, { after: '105' }).audit_log_entries.map(
        (entry) => entry.id
      )
    ).toEqual(['18446744073709551615'])
  })

  it('retains the historical channel reference after its channel is deleted', () => {
    seed('100')
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId)
    expect(listAuditLogs(db, guildId).audit_log_entries).toMatchObject([
      { id: '100', options: { channel_id: channelId } },
    ])
  })

  it('supports deterministic old timestamps and mismatched authors', () => {
    const result = createAuditLogEntry(db, guildId, {
      timestamp: '2026-01-01T00:00:00.000Z',
      action_type: 72,
      user_id: actorId,
      target_id: targetId,
      options: { channel_id: channelId, count: '1' },
    })
    expect(typeof result).toBe('object')
    if (typeof result === 'string') throw new Error(result)
    expect(snowflakeToTimestamp(result.id).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    )
    seed('100', actorId)
    expect(
      listAuditLogs(db, guildId, { target_id: actorId }).users.map(
        (user) => user.id
      )
    ).toEqual([actorId])
  })

  it('rejects invalid fixtures, unknown users, wrong-guild channels and duplicate IDs without mutation', () => {
    const otherGuild = seedGuild(
      db,
      seedBot(db, 'Bot other', '444444444444444444'),
      '555555555555555555'
    )
    const otherChannel = seedChannel(db, otherGuild, '666666666666666666')
    const request = {
      id: '100',
      action_type: 72 as const,
      user_id: actorId,
      target_id: targetId,
      options: { channel_id: channelId, count: '1' },
    }
    expect(createAuditLogEntry(db, guildId, { ...request, id: '01' })).toBe(
      'INVALID_INPUT'
    )
    expect(
      createAuditLogEntry(db, guildId, { ...request, target_id: '987' })
    ).toBe('UNKNOWN_USER')
    expect(
      createAuditLogEntry(db, guildId, {
        ...request,
        options: { channel_id: otherChannel, count: '1' },
      })
    ).toBe('UNKNOWN_CHANNEL')
    expect(createAuditLogEntry(db, '987', request)).toBe('UNKNOWN_GUILD')
    expect(listAuditLogs(db, guildId).audit_log_entries).toEqual([])
    seed('100')
    expect(
      createAuditLogEntry(db, otherGuild, {
        ...request,
        options: { channel_id: otherChannel, count: '1' },
      })
    ).toBe('CONFLICT')
    expect(listAuditLogs(db, otherGuild).audit_log_entries).toEqual([])
    expect(listAuditLogs(db, guildId).audit_log_entries).toHaveLength(1)
  })

  it('cleans up guild, bot and scoped/global test resets without clearing another guild', () => {
    const otherGuild = seedGuild(
      db,
      seedBot(db, 'Bot other', '444444444444444444'),
      '555555555555555555'
    )
    const otherChannel = seedChannel(db, otherGuild, '666666666666666666')
    const seedOther = () =>
      createAuditLogEntry(db, otherGuild, {
        id: '200',
        action_type: 72,
        user_id: actorId,
        target_id: targetId,
        options: { channel_id: otherChannel, count: '1' },
      })
    seed('100')
    seedOther()
    resetTestData(db, 'Bot audit')
    expect(listAuditLogs(db, guildId).audit_log_entries).toEqual([])
    expect(listAuditLogs(db, otherGuild).audit_log_entries).toHaveLength(1)
    seed('100')
    deleteTestSetup(db, 'Bot audit')
    expect(listAuditLogs(db, guildId).audit_log_entries).toEqual([])
    db.prepare('DELETE FROM guilds WHERE id = ?').run(otherGuild)
    expect(listAuditLogs(db, otherGuild).audit_log_entries).toEqual([])
    const newGuild = seedGuild(db, 'Bot other')
    const newChannel = seedChannel(db, newGuild)
    createAuditLogEntry(db, newGuild, {
      id: '300',
      action_type: 72,
      user_id: actorId,
      target_id: targetId,
      options: { channel_id: newChannel, count: '1' },
    })
    resetTestData(db)
    expect(listAuditLogs(db, newGuild).audit_log_entries).toEqual([])
  })
})
