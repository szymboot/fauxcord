/** Resolves a member's effective permissions in one guild channel. */
import type { Database } from '../db'
import type { ChannelObject } from './channels'

/** ADMINISTRATOR permission bit. */
const ADMINISTRATOR = 1n << 3n
/** MOVE_MEMBERS permission bit (also bypasses voice channel user limits). */
export const MOVE_MEMBERS = 1n << 24n
/** Permissions a timed-out member keeps: VIEW_CHANNEL and READ_MESSAGE_HISTORY. */
const TIMED_OUT_PERMISSIONS = (1n << 10n) | (1n << 16n)
/** Every permission bit, granted to owners and administrators. */
export const ALL_PERMISSIONS = (1n << 64n) - 1n

/** Effective channel permissions of one guild member. */
export interface ChannelPermissions {
  /** Effective bitfield after overwrites (every bit for owners/admins). */
  permissions: bigint
  /**
   * True for the guild owner or a member whose roles grant ADMINISTRATOR.
   * Channel overwrites never grant this bypass.
   */
  administrator: boolean
}

/**
 * Computes current persisted guild-channel permissions with BigInt, following
 * Discord's algorithm: base role permissions are combined, then the
 * `@everyone` overwrite, the member's role overwrites, and finally the
 * member's own overwrite are applied. Owners and administrators receive every
 * permission regardless of channel overwrites and timeouts; other members
 * with an active timeout keep only VIEW_CHANNEL and READ_MESSAGE_HISTORY
 * (https://docs.discord.com/developers/topics/permissions#permissions-for-timed-out-members).
 * @param db - Database
 * @param channel - Guild channel (`guild_id` must be set)
 * @param userId - User whose permissions are resolved
 * @returns The resolved permissions, or null if the user is neither the
 * guild owner nor a member
 */
export function computeChannelPermissions(
  db: Database,
  channel: ChannelObject & { guild_id: string },
  userId: string
): ChannelPermissions | null {
  const guildId = channel.guild_id
  const guild = db
    .prepare('SELECT owner_id FROM guilds WHERE id = ?')
    .get(guildId) as { owner_id: string } | undefined
  // seedGuild intentionally uses the fixture bot as owner. Owners inherently
  // have access even in the minimal helper fixture without a member row.
  if (guild?.owner_id === userId)
    return { permissions: ALL_PERMISSIONS, administrator: true }

  const member = db
    .prepare(
      'SELECT communication_disabled_until FROM guild_members WHERE guild_id = ? AND user_id = ?'
    )
    .get(guildId, userId) as
    { communication_disabled_until: string | null } | undefined
  if (!member) return null

  const roles = db
    .prepare(
      `SELECT id, permissions FROM roles
       WHERE guild_id = ? AND (id = ? OR id IN (
         SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?
       ))`
    )
    .all(guildId, guildId, guildId, userId) as {
    id: string
    permissions: string
  }[]
  let permissions = 0n
  const roleIds = new Set<string>()
  for (const role of roles) {
    permissions |= BigInt(role.permissions)
    if (role.id !== guildId) roleIds.add(role.id)
  }
  if (permissions & ADMINISTRATOR)
    return { permissions: ALL_PERMISSIONS, administrator: true }

  const everyone = channel.permission_overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === guildId
  )
  if (everyone)
    permissions =
      (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow)

  let allow = 0n
  let deny = 0n
  for (const overwrite of channel.permission_overwrites) {
    if (overwrite.type !== 0 || !roleIds.has(overwrite.id)) continue
    allow |= BigInt(overwrite.allow)
    deny |= BigInt(overwrite.deny)
  }
  permissions = (permissions & ~deny) | allow

  const personal = channel.permission_overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === userId
  )
  if (personal)
    permissions =
      (permissions & ~BigInt(personal.deny)) | BigInt(personal.allow)

  const timedOut =
    member.communication_disabled_until !== null &&
    Date.parse(member.communication_disabled_until) > Date.now()
  if (timedOut) permissions &= TIMED_OUT_PERMISSIONS

  return { permissions, administrator: false }
}
