/**
 * Authorization of command permission edits by a user-bound OAuth token.
 *
 * Fauxcord's approximation of Discord's rules for
 * `PUT /applications/{app}/guilds/{guild}/commands/{command}/permissions`.
 */
import type { Database } from '../db'
import { PermissionBit, resolveChannelPermissions } from './guild-permissions'
import { outranksRole } from './member-role-permissions'
import type {
  ApplicationCommandObject,
  CommandPermissionEntry,
} from './application-commands'
import { getCommandPermissions } from './application-commands'

/** Command permission overwrite types. */
const OverwriteType = { ROLE: 1, USER: 2 } as const

/** Both permissions a non-privileged editor needs. */
const MANAGE_GUILD_AND_ROLES =
  PermissionBit.MANAGE_GUILD | PermissionBit.MANAGE_ROLES

/** The position/ID pair Discord uses to order roles. */
interface RankedRole {
  id: string
  position: number
}

/**
 * Lists the roles a user holds besides `@everyone`.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - User ID
 * @returns Held roles with their positions
 */
function getHeldRoles(
  db: Database,
  guildId: string,
  userId: string
): RankedRole[] {
  return db
    .prepare(
      `SELECT r.id, r.position FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id AND r.guild_id = mr.guild_id
       WHERE mr.guild_id = ? AND mr.user_id = ? AND r.id <> ?`
    )
    .all(guildId, userId, guildId) as RankedRole[]
}

/**
 * Whether the user can run the command, from its stored permission overwrites
 * (user, then roles with any allow winning over denies, then `@everyone`) and
 * finally `default_member_permissions`. Channel overwrites are ignored.
 * @param db - Database
 * @param guildId - Guild ID
 * @param command - Command being edited
 * @param userId - User ID
 * @param permissions - The user's computed guild permissions
 * @param heldRoles - Roles the user holds besides `@everyone`
 * @returns True when the user can run the command
 */
function canRunCommand(
  db: Database,
  guildId: string,
  command: ApplicationCommandObject,
  userId: string,
  permissions: bigint,
  heldRoles: RankedRole[]
): boolean {
  const overwrites: CommandPermissionEntry[] =
    getCommandPermissions(db, command.application_id, guildId, command.id)
      ?.permissions ?? []

  const personal = overwrites.find(
    (entry) => entry.type === OverwriteType.USER && entry.id === userId
  )
  if (personal) return personal.permission

  const roleIds = new Set(heldRoles.map((role) => role.id))
  const roleEntries = overwrites.filter(
    (entry) => entry.type === OverwriteType.ROLE && roleIds.has(entry.id)
  )
  if (roleEntries.length > 0)
    return roleEntries.some((entry) => entry.permission)

  const everyone = overwrites.find(
    (entry) => entry.type === OverwriteType.ROLE && entry.id === guildId
  )
  if (everyone) return everyone.permission

  const required = command.default_member_permissions
  if (required === null) return true
  const bits = BigInt(required)
  return bits !== 0n && (permissions & bits) === bits
}

/**
 * Whether the user may edit the permissions of `command` in the guild.
 *
 * Mirrors Discord's documented requirements for the authorizing user, as
 * Fauxcord's approximation:
 * 1. The user is a guild member who is the owner or has ADMINISTRATOR, or has
 *    both MANAGE_GUILD and MANAGE_ROLES.
 * 2. The user can run the command. The owner and Administrators always can;
 *    otherwise the command's stored overwrites decide (user overwrite first,
 *    then the user's roles where any allow wins over denies, then the
 *    `@everyone` overwrite whose ID is the guild ID), falling back to
 *    `default_member_permissions` (null = everyone, "0" = nobody without
 *    Administrator, otherwise all bits required). Channel overwrites are
 *    ignored.
 * 3. Every ROLE entry other than `@everyone` exists in the guild and is
 *    strictly below the user's highest role (the owner is exempt). USER and
 *    CHANNEL entries are not checked: Discord does not document that rule.
 * @param db - Database
 * @param guildId - Guild ID
 * @param command - Command being edited
 * @param userId - User behind the Bearer token
 * @param entries - Permission entries in the request payload
 * @returns True when the edit is allowed
 */
export function canEditCommandPermissions(
  db: Database,
  guildId: string,
  command: ApplicationCommandObject,
  userId: string,
  entries: CommandPermissionEntry[]
): boolean {
  const resolved = resolveChannelPermissions(db, guildId, [], userId)
  if (!resolved) return false
  if (
    !resolved.privileged &&
    (resolved.permissions & MANAGE_GUILD_AND_ROLES) !== MANAGE_GUILD_AND_ROLES
  )
    return false

  const heldRoles = getHeldRoles(db, guildId, userId)
  if (
    !resolved.privileged &&
    !canRunCommand(
      db,
      guildId,
      command,
      userId,
      resolved.permissions,
      heldRoles
    )
  )
    return false

  if (resolved.owner) return true
  const everyoneRole = db
    .prepare('SELECT id, position FROM roles WHERE id = ? AND guild_id = ?')
    .get(guildId, guildId) as RankedRole | undefined
  // A member with no role besides @everyone ranks as @everyone.
  const [firstHeld, ...otherHeld] =
    heldRoles.length > 0
      ? heldRoles
      : [everyoneRole ?? { id: guildId, position: 0 }]
  const highest = otherHeld.reduce(
    (best, held) => (outranksRole(held, best) ? held : best),
    firstHeld
  )
  for (const entry of entries) {
    if (entry.type !== OverwriteType.ROLE || entry.id === guildId) continue
    const role = /^\d+$/.test(entry.id)
      ? (db
          .prepare(
            'SELECT id, position FROM roles WHERE id = ? AND guild_id = ?'
          )
          .get(entry.id, guildId) as RankedRole | undefined)
      : undefined
    if (!role || !outranksRole(highest, role)) return false
  }
  return true
}
