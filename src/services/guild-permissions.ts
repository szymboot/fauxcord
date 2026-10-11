/** Shared guild/channel permission resolution for enforced REST checks. */
import type { Database } from '../db'
import type { ChannelOverwriteObject } from './channels'

/** Discord permission bits used by Fauxcord's enforced checks. */
export const PermissionBit = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  CONNECT: 1n << 20n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
} as const

/** A member's resolved channel permissions. */
export interface ResolvedChannelPermissions {
  /** True for the guild owner or a member with guild-level ADMINISTRATOR. */
  privileged: boolean
  /** Channel permissions after overwrites; meaningless when privileged. */
  permissions: bigint
}

/**
 * Resolves a user's persisted permissions in one guild channel with BigInt.
 * `@everyone` and assigned role permissions are combined first, then the
 * everyone, combined role and member overwrites apply (denies before allows).
 * The owner bypasses all checks even without a member row; guild-level
 * ADMINISTRATOR bypasses as well, while an overwrite ADMINISTRATOR bit does not.
 * @param db - Database
 * @param guildId - Guild that owns the channel
 * @param overwrites - The channel's permission overwrites
 * @param userId - User whose permissions are resolved
 * @returns Resolved permissions, or null when the user is not a guild member
 */
export function resolveChannelPermissions(
  db: Database,
  guildId: string,
  overwrites: ChannelOverwriteObject[],
  userId: string
): ResolvedChannelPermissions | null {
  const guild = db
    .prepare('SELECT owner_id FROM guilds WHERE id = ?')
    .get(guildId) as { owner_id: string } | undefined
  // seedGuild intentionally uses the fixture bot as owner. Owners inherently
  // have access even in the minimal helper fixture without a member row.
  if (guild?.owner_id === userId) return { privileged: true, permissions: 0n }

  const member = db
    .prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId)
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
  if (permissions & PermissionBit.ADMINISTRATOR)
    return { privileged: true, permissions }

  const everyone = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === guildId
  )
  if (everyone)
    permissions =
      (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow)

  let allow = 0n
  let deny = 0n
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !roleIds.has(overwrite.id)) continue
    allow |= BigInt(overwrite.allow)
    deny |= BigInt(overwrite.deny)
  }
  permissions = (permissions & ~deny) | allow

  const personal = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === userId
  )
  if (personal)
    permissions =
      (permissions & ~BigInt(personal.deny)) | BigInt(personal.allow)

  return { privileged: false, permissions }
}
