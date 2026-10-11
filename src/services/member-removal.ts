/**
 * Member removal service
 *
 * Removes members from guilds (kick, ban, bulk ban) and publishes the Gateway
 * events real Discord sends for each departure. Test cleanup (reset, setup
 * deletion, guild deletion) deliberately bypasses this module and stays silent.
 */

import type { Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import { getGuildMember, type GuildMemberObject } from './guild-members'
import { getUser, type UserObject } from './users'
import { publishRemovedMemberVoiceDisconnect } from './voice-state-events'
import { getGuildDispatchScope } from './voice-state-publisher'
import { getGuildVoiceState, type GuildVoiceState } from './voice-states'

/** Member and voice state read before deletion, for post-commit dispatch. */
export interface DepartingMember {
  guildId: string
  userId: string
  member: GuildMemberObject
  voice: GuildVoiceState | null
}

/**
 * Reads a member and its voice state before removal. Must be called before
 * the member row is deleted, because the voice-state row is removed with it.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - User ID
 * @returns Snapshot, or null when the user is not a member of the guild
 */
export function snapshotDepartingMember(
  db: Database,
  guildId: string,
  userId: string
): DepartingMember | null {
  const member = getGuildMember(db, guildId, userId)
  return member
    ? {
        guildId,
        userId,
        member,
        voice: getGuildVoiceState(db, guildId, userId),
      }
    : null
}

/**
 * Deletes a guild membership and its role assignments. The voice-state row
 * is deleted by the `trg_member_delete_voice_state` trigger. Emits nothing.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - User ID
 * @returns true when a membership was deleted
 */
export function deleteGuildMembership(
  db: Database,
  guildId: string,
  userId: string
): boolean {
  // member_roles has no FK to guild_members, so delete it explicitly to avoid
  // orphaned rows.
  db.prepare('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?').run(
    guildId,
    userId
  )
  const result = db
    .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId)
  return result.changes > 0
}

/**
 * Publishes a committed member departure: first the voice disconnect (only
 * when the member was connected), then GUILD_MEMBER_REMOVE.
 * @param db - Database
 * @param departing - Snapshot taken before the member was deleted
 */
export function publishMemberDeparture(
  db: Database,
  departing: DepartingMember
): void {
  const { guildId, userId, member, voice } = departing
  if (voice) publishRemovedMemberVoiceDisconnect(db, voice, member)
  // The users row survives membership deletion. Use the API user helper to
  // normalize SQLite's numeric bot flag.
  const user = getUser(db, userId) ?? { ...member.user, primary_guild: null }
  const scope = getGuildDispatchScope(db, guildId)
  gatewayBus.emit('guild.member.remove', {
    guildId,
    userId,
    user: user as unknown as Record<string, unknown>,
    ...(scope && { scope }),
  })
}

/**
 * Publishes GUILD_BAN_ADD for a newly created ban.
 * @param db - Database
 * @param guildId - Guild ID
 * @param user - Banned user payload
 * @param deleteMessageSeconds - Message deletion window of the ban, in seconds
 */
export function publishGuildBanAdd(
  db: Database,
  guildId: string,
  user: UserObject,
  deleteMessageSeconds: number
): void {
  const scope = getGuildDispatchScope(db, guildId)
  if (!scope) return
  gatewayBus.emit('guild.ban.add', {
    guildId,
    user: user as unknown as Record<string, unknown>,
    deleteMessageSeconds,
    scope,
  })
}

/**
 * Removes a member from a guild (kick) and publishes the departure.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - User ID
 * @returns true on successful removal
 */
export function removeGuildMember(
  db: Database,
  guildId: string,
  userId: string
): boolean {
  const departing = snapshotDepartingMember(db, guildId, userId)
  if (!departing || !deleteGuildMembership(db, guildId, userId)) return false
  publishMemberDeparture(db, departing)
  return true
}
