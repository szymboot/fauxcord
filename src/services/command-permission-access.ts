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
import {
  getApplicationLevelPermissionEntries,
  getCommandPermissions,
} from './application-commands'

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
 * Resolves a permission entry list for a user: the user's own entry, then the
 * user's roles (any allow wins over denies), then the `@everyone` entry whose
 * ID is the guild ID. Channel entries are ignored.
 * @param entries - Stored permission entries
 * @param guildId - Guild ID
 * @param userId - User ID
 * @param heldRoles - Roles the user holds besides `@everyone`
 * @returns The decision, or undefined when no entry applies to the user
 */
function evaluateEntries(
  entries: CommandPermissionEntry[],
  guildId: string,
  userId: string,
  heldRoles: RankedRole[]
): boolean | undefined {
  const personal = entries.find(
    (entry) => entry.type === OverwriteType.USER && entry.id === userId
  )
  if (personal) return personal.permission

  const roleIds = new Set(heldRoles.map((role) => role.id))
  const roleEntries = entries.filter(
    (entry) => entry.type === OverwriteType.ROLE && roleIds.has(entry.id)
  )
  return roleEntries.length > 0
    ? roleEntries.some((entry) => entry.permission)
    : entries.find(
        (entry) => entry.type === OverwriteType.ROLE && entry.id === guildId
      )?.permission
}

/**
 * Whether the user can run the command. The command's own stored overwrites
 * decide when it has any; a command with none falls back to the
 * application-level list (Discord applies it to every command without
 * explicit overwrites). Each list is evaluated as the user's own entry, then
 * the user's roles (any allow winning over denies), then the `@everyone` entry.
 * When no entry applies, `default_member_permissions` decides. Channel
 * overwrites are ignored.
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
  const ownEntries: CommandPermissionEntry[] =
    getCommandPermissions(db, command.application_id, guildId, command.id)
      ?.permissions ?? []
  const entries =
    ownEntries.length > 0
      ? ownEntries
      : getApplicationLevelPermissionEntries(
          db,
          command.application_id,
          guildId
        )

  const decided = evaluateEntries(entries, guildId, userId, heldRoles)
  if (decided !== undefined) return decided

  const required = command.default_member_permissions
  if (required === null) return true
  const bits = BigInt(required)
  return bits !== 0n && (permissions & bits) === bits
}

/**
 * Shared authorization of permission edits. `command` is the command being
 * edited, or null for the application-level list, which belongs to no single
 * command and therefore skips the "can run the command" check.
 * @param db - Database
 * @param guildId - Guild ID
 * @param command - Command being edited, or null for the application-level list
 * @param userId - User behind the Bearer token
 * @param entries - Permission entries in the request payload
 * @returns True when the edit is allowed
 */
function canEditPermissions(
  db: Database,
  guildId: string,
  command: ApplicationCommandObject | null,
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
    command &&
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

  // A member with no role besides @everyone ranks as @everyone.
  const everyoneRole = db
    .prepare('SELECT id, position FROM roles WHERE id = ? AND guild_id = ?')
    .get(guildId, guildId) as RankedRole | undefined
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
    // Existence applies to everyone, the owner included.
    const role = /^\d+$/.test(entry.id)
      ? (db
          .prepare(
            'SELECT id, position FROM roles WHERE id = ? AND guild_id = ?'
          )
          .get(entry.id, guildId) as RankedRole | undefined)
      : undefined
    if (!role || (!resolved.owner && !outranksRole(highest, role))) return false
  }
  return true
}

/**
 * Whether the user may edit the permissions of `command` in the guild.
 *
 * Mirrors Discord's documented requirements for the authorizing user, as
 * Fauxcord's approximation:
 * 1. The user is a guild member who is the owner or has ADMINISTRATOR, or has
 *    both MANAGE_GUILD and MANAGE_ROLES.
 * 2. The user can run the command. The owner and Administrators always can.
 *    Otherwise the command's stored overwrites decide when it has any; a
 *    command with none uses the application-level list (the permissions stored
 *    under the application ID). Each list is evaluated as the user's own
 *    entry, then the user's roles where any allow wins over denies, then the
 *    `@everyone` entry whose ID is the guild ID. When no entry applies,
 *    `default_member_permissions` decides (null = everyone, "0" = nobody
 *    without Administrator, otherwise all bits required). Channel overwrites
 *    are ignored.
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
  return canEditPermissions(db, guildId, command, userId, entries)
}

/**
 * Whether the user may edit the application-level permission list of the
 * guild (the list stored under the application ID). The same rules as
 * {@link canEditCommandPermissions} apply (rules 1 and 3: guild member who is
 * the owner, has ADMINISTRATOR, or has MANAGE_GUILD and MANAGE_ROLES, and
 * every ROLE entry other than `@everyone` exists and ranks strictly below the
 * user's highest role, the owner being exempt), except that the "can run the
 * command" check is skipped because the list belongs to no single command.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - User behind the Bearer token
 * @param entries - Permission entries in the request payload
 * @returns True when the edit is allowed
 */
export function canEditApplicationPermissions(
  db: Database,
  guildId: string,
  userId: string,
  entries: CommandPermissionEntry[]
): boolean {
  return canEditPermissions(db, guildId, null, userId, entries)
}
