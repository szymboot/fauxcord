/**
 * Application-command permissions for guild invocations and permission edits.
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
import {
  getInteractionPermissionChannel,
  resolveInteractionMemberPermissions,
} from './interaction-permissions'

/** Command permission overwrite types. */
const OverwriteType = { ROLE: 1, USER: 2, CHANNEL: 3 } as const

/** Both permissions a non-privileged editor needs. */
const MANAGE_GUILD_AND_ROLES =
  PermissionBit.MANAGE_GUILD | PermissionBit.MANAGE_ROLES

/** Channel permissions required to find and use slash commands. */
const SLASH_COMMAND_PERMISSIONS =
  PermissionBit.VIEW_CHANNEL | PermissionBit.USE_APPLICATION_COMMANDS

/** Command fields needed to evaluate its guild permissions. */
type CommandPermissionTarget = Pick<
  ApplicationCommandObject,
  'id' | 'application_id' | 'default_member_permissions'
>

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
 * @returns The deciding entry, or undefined when no entry applies to the user
 */
function evaluateEntries(
  entries: CommandPermissionEntry[],
  guildId: string,
  userId: string,
  heldRoles: RankedRole[]
): CommandPermissionEntry | undefined {
  const personal = entries.find(
    (entry) => entry.type === OverwriteType.USER && entry.id === userId
  )
  if (personal) return personal

  const roleIds = new Set(heldRoles.map((role) => role.id))
  const roleEntries = entries.filter(
    (entry) => entry.type === OverwriteType.ROLE && roleIds.has(entry.id)
  )
  return (
    roleEntries.find((entry) => entry.permission) ??
    roleEntries.at(0) ??
    entries.find(
      (entry) => entry.type === OverwriteType.ROLE && entry.id === guildId
    )
  )
}

/** Gets the permission entries stored for this command in the guild. */
function getOwnEntries(
  db: Database,
  guildId: string,
  command: CommandPermissionTarget
): CommandPermissionEntry[] {
  return (
    getCommandPermissions(db, command.application_id, guildId, command.id)
      ?.permissions ?? []
  )
}

/** Gets the overwrite list used for the existing permission-edit check. */
function getEditPermissionEntries(
  db: Database,
  guildId: string,
  command: CommandPermissionTarget
): CommandPermissionEntry[] {
  const ownEntries = getOwnEntries(db, guildId, command)
  return ownEntries.length > 0
    ? ownEntries
    : getApplicationLevelPermissionEntries(db, command.application_id, guildId)
}

/** Checks whether the member's permissions meet the command's defaults. */
function meetsCommandDefaults(permissions: bigint, required: string | null) {
  if (required === null) return true
  const bits = BigInt(required)
  return bits !== 0n && (permissions & bits) === bits
}

/**
 * Resolves access to a slash command in a guild. The command can override
 * particular app-wide entries with its own entries for the same targets.
 * The channel and the member must both be allowed. A command-level allow
 * for the member bypasses command defaults; an app-wide allow still checks them.
 * @param db - Database
 * @param guildId - Guild where the command was invoked
 * @param channelId - Invoking channel ID, or null for a guild-only fixture
 * @param command - Resolved command
 * @param userId - Invoking member ID
 * @returns The cause of refusal, or null when the invocation is allowed
 */
export function checkGuildSlashCommandAccess(
  db: Database,
  guildId: string,
  channelId: string | null,
  command: CommandPermissionTarget,
  userId: string
): 'unknown_member' | 'missing_permissions' | null {
  const permissionChannel = getInteractionPermissionChannel(db, channelId)
  const member = resolveInteractionMemberPermissions(
    db,
    guildId,
    permissionChannel,
    userId
  )
  if (!member) return 'unknown_member'
  if (member.privileged) return null
  if (
    (member.permissions & SLASH_COMMAND_PERMISSIONS) !==
    SLASH_COMMAND_PERMISSIONS
  )
    return 'missing_permissions'

  // Keep command entries first so a command-level role allow takes priority
  // over an app-wide role allow when a member holds both roles.
  const ownEntries = getOwnEntries(db, guildId, command)
  const appEntries = getApplicationLevelPermissionEntries(
    db,
    command.application_id,
    guildId
  )
  const entries = [
    ...ownEntries,
    ...appEntries.filter((appEntry) =>
      ownEntries.every(
        (ownEntry) =>
          ownEntry.type !== appEntry.type || ownEntry.id !== appEntry.id
      )
    ),
  ]
  const allChannels = /^\d+$/.test(guildId)
    ? (BigInt(guildId) - 1n).toString()
    : undefined
  const channels = entries.filter(
    (entry) => entry.type === OverwriteType.CHANNEL
  )
  const channelAllowed =
    channels.find((entry) => entry.id === permissionChannel)?.permission ??
    channels.find((entry) => entry.id === allChannels)?.permission
  if (channelAllowed === false) return 'missing_permissions'

  const decision = evaluateEntries(
    entries,
    guildId,
    userId,
    getHeldRoles(db, guildId, userId)
  )
  if (decision?.permission === false) return 'missing_permissions'
  const commandAllowsMember = decision && ownEntries.includes(decision)
  return commandAllowsMember ||
    meetsCommandDefaults(member.permissions, command.default_member_permissions)
    ? null
    : 'missing_permissions'
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
    !(
      evaluateEntries(
        getEditPermissionEntries(db, guildId, command),
        guildId,
        userId,
        heldRoles
      )?.permission ??
      meetsCommandDefaults(
        resolved.permissions,
        command.default_member_permissions
      )
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
