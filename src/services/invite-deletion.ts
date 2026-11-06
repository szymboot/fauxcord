/**
 * Invite deletion with its audit trail.
 *
 * Shared by `DELETE /invites/:code` (actor = the calling bot or OAuth2 user)
 * and the `POST /_test/invites/:code/delete` control (actor = a human member).
 */
import type { Database } from '../db'
import { recordInviteDeleteAuditEntry } from './audit-logs'
import { getChannel } from './channels'
import { getGuildMember } from './guild-members'
import { PermissionBit, resolveChannelPermissions } from './guild-permissions'
import { deleteInvite, peekInvite, type InviteObject } from './invites'

/** Why a member-driven invite deletion was refused (nothing changed). */
export type MemberInviteDeleteError =
  'UNKNOWN_INVITE' | 'UNKNOWN_USER' | 'BOT_USER' | 'MISSING_PERMISSIONS'

/**
 * Deletes an invite, then records its `INVITE_DELETE` audit entry.
 * `deleteInvite` publishes `INVITE_DELETE` after its commit; the audit entry
 * (and `GUILD_AUDIT_LOG_ENTRY_CREATE`) follows, so the events keep that order.
 * Nothing is recorded when no invite was deleted, when the invite has no
 * guild, or when no actor can be resolved.
 * @param db - Database (no transaction may be open)
 * @param code - Invite code
 * @param actor - Actor's user ID, or a resolver run on the deleted invite
 * (lets the production route fall back to the guild's bot user)
 * @param reason - Optional audit log reason (empty means none)
 * @param now - Clock snapshot for the expiry purge (defaults to the current time)
 * @returns The deleted invite, or null when it did not exist
 */
export function deleteInviteWithAudit(
  db: Database,
  code: string,
  actor: string | undefined | ((invite: InviteObject) => string | undefined),
  reason?: string | null,
  now = Date.now()
): InviteObject | null {
  const invite = deleteInvite(db, code, now)
  if (!invite) return null
  const actorId = typeof actor === 'function' ? actor(invite) : actor
  if (actorId && invite.guild_id !== null) {
    recordInviteDeleteAuditEntry(db, {
      guildId: invite.guild_id,
      actorId,
      invite,
      reason,
    })
  }
  return invite
}

/**
 * Deletes an invite on behalf of a human guild member, as Discord does for
 * `DELETE /invites/:code`: the invite must exist (unexpired) in a guild, and
 * the actor must be a registered non-bot member holding `MANAGE_CHANNELS` on
 * the invite's channel (overwrites included) or `MANAGE_GUILD`; the owner and
 * `ADMINISTRATOR` pass both. Every check runs before the first mutation, so a
 * refusal changes nothing and publishes nothing.
 * @param db - Database (no transaction may be open)
 * @param code - Invite code
 * @param actorId - User ID of the moderator
 * @param reason - Optional audit log reason
 * @returns The deleted invite, or the refusal reason
 */
export function deleteInviteAsMember(
  db: Database,
  code: string,
  actorId: string,
  reason?: string | null
): InviteObject | MemberInviteDeleteError {
  // One clock snapshot for the check and the deletion: an invite cannot
  // expire in between, so a refusal never purges unrelated expired rows.
  const now = Date.now()
  // Side-effect free: a refusal must not even purge unrelated expired rows.
  const invite = peekInvite(db, code, now)
  if (!invite?.guild_id) return 'UNKNOWN_INVITE'
  const user = db.prepare('SELECT bot FROM users WHERE id = ?').get(actorId) as
    { bot: number } | undefined
  if (!user) return 'UNKNOWN_USER'
  if (user.bot === 1) return 'BOT_USER'
  if (!getGuildMember(db, invite.guild_id, actorId))
    return 'MISSING_PERMISSIONS'

  const channel = getChannel(db, invite.channel.id)
  const onChannel = resolveChannelPermissions(
    db,
    invite.guild_id,
    channel?.permission_overwrites ?? [],
    actorId
  )
  const onGuild = resolveChannelPermissions(db, invite.guild_id, [], actorId)
  const allowed =
    onChannel?.privileged === true ||
    onGuild?.privileged === true ||
    ((onChannel?.permissions ?? 0n) & PermissionBit.MANAGE_CHANNELS) !== 0n ||
    ((onGuild?.permissions ?? 0n) & PermissionBit.MANAGE_GUILD) !== 0n
  return allowed
    ? (deleteInviteWithAudit(db, code, actorId, reason, now) ??
        'UNKNOWN_INVITE')
    : 'MISSING_PERMISSIONS'
}
