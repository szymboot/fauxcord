/**
 * Permission and role-hierarchy checks for Add/Remove Guild Member Role
 * (`PUT`/`DELETE /guilds/:guildId/members/:userId/roles/:roleId`).
 */
import type { Database } from '../db'
import { PermissionBit, resolveChannelPermissions } from './guild-permissions'
import type { RoleObject } from './guild-roles'

/** The only denial a member role assignment/removal check produces (403). */
export type MemberRoleChangeError = 'MISSING_PERMISSIONS'

/** The position/ID pair Discord uses to order roles. */
interface RankedRole {
  id: string
  position: number
}

/**
 * Whether `role` ranks strictly above `other`. Discord orders roles by
 * position and sorts roles with the same position by ID, where the lower
 * (older) ID ranks higher.
 * @param role - Candidate higher role
 * @param other - Candidate lower role
 * @returns True when `role` is strictly higher than `other`
 */
export function outranksRole(role: RankedRole, other: RankedRole): boolean {
  return role.position === other.position
    ? BigInt(role.id) < BigInt(other.id)
    : role.position > other.position
}

/**
 * Checks whether the actor may add or remove `role` on a member, without
 * writing anything.
 *
 * - Managed roles (bot, integration and booster roles) can never be assigned
 *   or removed this way, not even by the owner: 50013.
 * - The guild owner bypasses every other check.
 * - Anyone else needs `MANAGE_ROLES` (guild-level `ADMINISTRATOR` implies it)
 *   and a highest role that ranks strictly above the target role.
 *   `ADMINISTRATOR` does not skip the hierarchy, as on Discord.
 * - A caller that is not a guild member is not evaluated, apart from the
 *   managed-role rule above, to keep the existence-only behavior of
 *   detached-guild routes.
 * - Fixture bootstrap: an actor holding no role besides `@everyone` is not
 *   restricted. This is a compatibility choice for the discord-bot harness,
 *   which assigns roles through this route with a bot that has none yet:
 *   Fauxcord creates no bot role when a bot is set up, and
 *   `POST /_test/guilds/:id/bot` only accepts roles for a bot that is not yet
 *   in the guild. (`PATCH` member `roles` is the other, unchecked path.)
 * @param db - Database
 * @param guildId - Guild ID
 * @param actorId - User ID of the caller
 * @param role - Target role (must belong to the guild and not be `@everyone`)
 * @returns The first denial, or null when allowed
 */
export function checkMemberRoleChange(
  db: Database,
  guildId: string,
  actorId: string,
  role: RoleObject
): MemberRoleChangeError | null {
  if (role.managed) return 'MISSING_PERMISSIONS'

  const resolved = resolveChannelPermissions(db, guildId, [], actorId)
  // A caller without a membership (a bot that left, was removed, or was never
  // added to a prepared `bot_present: false` guild) keeps the existence-only
  // behavior that Fauxcord's detached-guild routes had before this check.
  if (!resolved) return null
  if (resolved.owner) return null

  const heldRoles = db
    .prepare(
      `SELECT r.id, r.position FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id AND r.guild_id = mr.guild_id
       WHERE mr.guild_id = ? AND mr.user_id = ? AND r.id <> ?`
    )
    .all(guildId, actorId, guildId) as RankedRole[]
  if (heldRoles.length === 0) return null

  if (
    !resolved.privileged &&
    !(resolved.permissions & PermissionBit.MANAGE_ROLES)
  )
    return 'MISSING_PERMISSIONS'

  const highest = heldRoles.reduce((best, held) =>
    outranksRole(held, best) ? held : best
  )
  return outranksRole(highest, role) ? null : 'MISSING_PERMISSIONS'
}
