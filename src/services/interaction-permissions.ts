/**
 * Computed permissions carried by interactions: the invoking member's
 * `member.permissions` and the application's `app_permissions`.
 *
 * Both are snapshots of the state when the interaction is created, like the
 * payload Discord delivers; later role, overwrite or ownership changes do not
 * alter an interaction that already exists.
 */

import type { Database } from '../db'
import { getChannelOverwrites } from './channels'
import {
  ALL_PERMISSIONS,
  PermissionBit,
  resolveChannelPermissions,
} from './guild-permissions'

/**
 * Permissions a timed-out member keeps, per Discord's Permissions page
 * ("Permissions for Timed Out Members"); owners and administrators are exempt.
 */
const TIMED_OUT_PERMISSIONS =
  PermissionBit.VIEW_CHANNEL | PermissionBit.READ_MESSAGE_HISTORY

/**
 * `app_permissions` in (G)DMs with other users, per the interaction object's
 * documentation: ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE.
 */
export const DM_APP_PERMISSIONS =
  PermissionBit.ATTACH_FILES |
  PermissionBit.EMBED_LINKS |
  PermissionBit.MENTION_EVERYONE

/**
 * `app_permissions` in the DM with the app's own bot user: the (G)DM set plus
 * USE_EXTERNAL_EMOJIS, per the interaction object's documentation.
 */
export const BOT_DM_APP_PERMISSIONS =
  DM_APP_PERMISSIONS | PermissionBit.USE_EXTERNAL_EMOJIS

/**
 * Computes a user's total permissions in a guild channel the way Discord's
 * computed permissions do: the owner and guild-level ADMINISTRATOR get every
 * permission, everyone else gets base role permissions with the channel's
 * overwrites applied (see `resolveChannelPermissions`), reduced to
 * VIEW_CHANNEL | READ_MESSAGE_HISTORY while timed out. A thread (types 10,
 * 11, 12) inherits its parent channel's overwrites, as on Discord.
 * @param db - Database
 * @param guildId - Guild of the interaction
 * @param channelId - Channel of the interaction; guild-level when absent
 * @param userId - User whose permissions are computed
 * @returns The permission bits, or null when the user is not a guild member
 */
export function computeGuildChannelPermissions(
  db: Database,
  guildId: string,
  channelId: string | null,
  userId: string
): bigint | null {
  const channel = channelId
    ? (db
        .prepare('SELECT type, parent_id FROM channels WHERE id = ?')
        .get(channelId) as
        { type: number; parent_id: string | null } | undefined)
    : undefined
  // Threads carry no overwrites of their own and use their parent's.
  const source =
    channel && [10, 11, 12].includes(channel.type) && channel.parent_id
      ? channel.parent_id
      : channelId
  const overwrites = source ? getChannelOverwrites(db, source) : []
  const resolved = resolveChannelPermissions(db, guildId, overwrites, userId)
  if (!resolved) return null
  if (resolved.privileged) return ALL_PERMISSIONS
  const timeout = db
    .prepare(
      'SELECT communication_disabled_until FROM guild_members WHERE guild_id = ? AND user_id = ?'
    )
    .get(guildId, userId) as
    { communication_disabled_until: string | null } | undefined
  const until = timeout?.communication_disabled_until
  const timedOut = until !== null && until !== undefined
  return timedOut && Date.parse(until) > Date.now()
    ? resolved.permissions & TIMED_OUT_PERMISSIONS
    : resolved.permissions
}

/** Where an interaction happened, as stored on its row. */
export interface InteractionLocation {
  applicationId: string
  guildId: string | null
  channelId: string | null
  userId: string
}

/** Computed permission strings an interaction carries. */
export interface InteractionPermissions {
  /** Invoking member's permissions; absent outside guilds or for non-members. */
  memberPermissions?: string
  /** The application's permissions in the interaction's source location. */
  appPermissions: string
}

/**
 * Computes `member.permissions` and `app_permissions` for an interaction, as
 * decimal strings like Discord sends them. In a guild both are the channel's
 * computed permissions (guild-level when the interaction has no channel); an
 * app whose bot is not a member gets "0". Outside guilds there is no member,
 * and `app_permissions` is the documented DM set: the bot's own 1:1 DM (or an
 * interaction without a channel) also includes USE_EXTERNAL_EMOJIS.
 * @param db - Database
 * @param location - The interaction's application, guild, channel and user
 * @returns The permission strings to place in the payload
 */
export function computeInteractionPermissions(
  db: Database,
  location: InteractionLocation
): InteractionPermissions {
  const channel = location.channelId
    ? (db
        .prepare('SELECT guild_id, type FROM channels WHERE id = ?')
        .get(location.channelId) as
        { guild_id: string | null; type: number } | undefined)
    : undefined
  const guildId = location.guildId ?? channel?.guild_id ?? null
  if (guildId) {
    const member = location.guildId
      ? computeGuildChannelPermissions(
          db,
          guildId,
          location.channelId,
          location.userId
        )
      : null
    const app = computeGuildChannelPermissions(
      db,
      guildId,
      location.channelId,
      location.applicationId
    )
    return {
      ...(member !== null && { memberPermissions: member.toString() }),
      appPermissions: (app ?? 0n).toString(),
    }
  }

  const botDm =
    !channel ||
    (channel.type === 1 &&
      db
        .prepare(
          'SELECT 1 FROM channel_recipients WHERE channel_id = ? AND user_id = ?'
        )
        .get(location.channelId, location.applicationId) !== undefined)
  return {
    appPermissions: (botDm
      ? BOT_DM_APP_PERMISSIONS
      : DM_APP_PERMISSIONS
    ).toString(),
  }
}
