/**
 * Guild ban operations service
 *
 * Provides listing, retrieval, creation, and removal of guild bans.
 */

import { runInTransaction, type Database } from '../db'
import {
  deleteGuildMembership,
  publishGuildBanAdd,
  publishMemberDeparture,
  snapshotDepartingMember,
  type DepartingMember,
} from './member-removal'
import { getUser, type UserObject } from './users'

/** Guild ban object for API responses (GuildBanResponse) */
export interface GuildBanObject {
  user: UserObject
  reason: string | null
}

/** Guild ban record type retrieved from the DB */
interface BanRow {
  guild_id: string
  user_id: string
  reason: string | null
}

/**
 * Resolves the user object for a ban. Falls back to a minimal schema-valid
 * user when the user is not present in the `users` table (Discord allows
 * banning users who are not, or never were, guild members).
 * @param db - Database
 * @param userId - Banned user ID
 * @returns User object for the ban response
 */
function resolveBanUser(db: Database, userId: string): UserObject {
  const user = getUser(db, userId)
  return (
    user ?? {
      id: userId,
      username: 'Unknown User',
      discriminator: '0',
      avatar: null,
      bot: false,
      flags: 0,
      public_flags: 0,
      global_name: null,
      primary_guild: null,
    }
  )
}

/**
 * Retrieves a single guild ban.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - Banned user ID
 * @returns Guild ban object, or null when no ban exists
 */
export function getGuildBan(
  db: Database,
  guildId: string,
  userId: string
): GuildBanObject | null {
  const row = db
    .prepare('SELECT * FROM guild_bans WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId) as BanRow | undefined
  return row ? { user: resolveBanUser(db, userId), reason: row.reason } : null
}

/**
 * Retrieves the list of bans for a guild.
 * @param db - Database
 * @param guildId - Guild ID
 * @param limit - Number of items to retrieve (clamped to 1000, default 1000)
 * @param before - Pagination cursor; only bans with user_id lower than this
 * @param after - Pagination cursor; only bans with user_id greater than this
 * @returns Array of guild ban objects ordered by user_id ascending
 */
export function getGuildBans(
  db: Database,
  guildId: string,
  limit = 1000,
  before?: string,
  after?: string
): GuildBanObject[] {
  const clampedLimit = Math.min(limit, 1000)
  const conditions = ['guild_id = ?']
  const params: (string | number)[] = [guildId]
  if (after !== undefined) {
    conditions.push('user_id > ?')
    params.push(after)
  }
  if (before !== undefined) {
    conditions.push('user_id < ?')
    params.push(before)
  }
  params.push(clampedLimit)

  const rows = db
    .prepare(
      `SELECT * FROM guild_bans WHERE ${conditions.join(' AND ')}
       ORDER BY user_id ASC LIMIT ?`
    )
    .all(...params) as BanRow[]

  return rows.map((row) => ({
    user: resolveBanUser(db, row.user_id),
    reason: row.reason,
  }))
}

/**
 * Publishes the committed Gateway events for one ban in the order observed on
 * real Discord: GUILD_BAN_ADD (new bans only), then the voice disconnect when
 * the member was connected, then GUILD_MEMBER_REMOVE. Discord documents the
 * event set but not this order.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - Banned user ID
 * @param created - Whether the ban did not exist before
 * @param departing - Member snapshot when the user was a member, else null
 */
export function publishBanEvents(
  db: Database,
  guildId: string,
  userId: string,
  created: boolean,
  departing: DepartingMember | null
): void {
  if (created) publishGuildBanAdd(db, guildId, resolveBanUser(db, userId))
  if (departing) publishMemberDeparture(db, departing)
}

/**
 * Creates a guild ban and removes the user's guild membership.
 * Banning a user implies kicking them, so their `guild_members` and
 * `member_roles` rows are deleted in the same transaction. When
 * `deleteMessageSeconds` is greater than 0, the banned user's messages in the
 * guild's channels newer than that window are also deleted (matching Discord's
 * `delete_message_seconds` behavior).
 *
 * After commit, GUILD_BAN_ADD is published when the ban is new, followed by a
 * removed member's departure (voice disconnect when connected, then
 * GUILD_MEMBER_REMOVE). Like real Discord, banning an already banned user
 * keeps the original reason and publishes no ban event.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - User ID to ban
 * @param reason - Ban reason from the audit header or legacy query, or null
 * @param deleteMessageSeconds - Age window (seconds) of the user's messages to delete
 */
export function createGuildBan(
  db: Database,
  guildId: string,
  userId: string,
  reason: string | null,
  deleteMessageSeconds = 0
): void {
  const banUser = db.transaction(() => {
    const created = !db
      .prepare('SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId)
    db.prepare(
      `INSERT INTO guild_bans (guild_id, user_id, reason) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO NOTHING`
    ).run(guildId, userId, reason)
    const departing = snapshotDepartingMember(db, guildId, userId)
    deleteGuildMembership(db, guildId, userId)
    if (deleteMessageSeconds > 0) {
      db.prepare(
        `DELETE FROM messages
         WHERE author_id = ?
           AND channel_id IN (SELECT id FROM channels WHERE guild_id = ?)
           AND created_at >= datetime('now', ?)`
      ).run(userId, guildId, `-${deleteMessageSeconds} seconds`)
    }
    return { created, departing }
  })
  const { created, departing } = banUser()
  publishBanEvents(db, guildId, userId, created, departing)
}

/** Result of a bulk ban, matching the Bulk Guild Ban response body. */
export interface BulkBanResult {
  banned_users: string[]
  failed_users: string[]
}

/**
 * Bans users in bulk. Unknown users and users that are already banned are
 * reported in `failed_users` without any change or event, as documented for
 * Bulk Guild Ban. Each newly banned user's events are published after commit,
 * grouped per user in request order. The caller returns error 500000 when
 * `banned_users` is empty.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userIds - Requested user IDs (non-strings are ignored)
 * @param deferredUserId - The guild's own bot: reported as banned once, in its
 * request position, without any write here; the caller removes the guild
 * from that bot afterwards
 * @returns Banned and failed user IDs
 */
export function bulkBanGuildMembers(
  db: Database,
  guildId: string,
  userIds: unknown[],
  deferredUserId?: string
): BulkBanResult {
  const banned: string[] = []
  const failed: string[] = []
  const departures: (DepartingMember | null)[] = []
  runInTransaction(db, () => {
    for (const value of userIds) {
      if (typeof value !== 'string') continue
      if (value === deferredUserId) {
        if (!banned.includes(value)) banned.push(value)
        continue
      }
      if (
        !db.prepare('SELECT 1 FROM users WHERE id = ?').get(value) ||
        db
          .prepare(
            'SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?'
          )
          .get(guildId, value)
      ) {
        failed.push(value)
        continue
      }
      db.prepare(
        'INSERT INTO guild_bans (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, value)
      departures.push(snapshotDepartingMember(db, guildId, value))
      deleteGuildMembership(db, guildId, value)
      banned.push(value)
    }
  })
  const created = banned.filter((id) => id !== deferredUserId)
  for (const [index, userId] of created.entries()) {
    publishBanEvents(db, guildId, userId, true, departures[index])
  }
  return { banned_users: banned, failed_users: failed }
}

/**
 * Removes a guild ban (unban).
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - Banned user ID
 * @returns true on successful removal; false when no ban existed
 */
export function removeGuildBan(
  db: Database,
  guildId: string,
  userId: string
): boolean {
  const result = db
    .prepare('DELETE FROM guild_bans WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId)
  return result.changes > 0
}
