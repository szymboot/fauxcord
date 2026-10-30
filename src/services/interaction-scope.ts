/**
 * Guild and channel gating shared by simulated interactions.
 *
 * An interaction is only created for guilds the application's bot is still
 * in and for channels that exist outside guilds the bot left or lost.
 */

import type { Database } from '../db'

/** Where an interaction may happen, or why no interaction is possible. */
export type InteractionScope =
  | { ok: true; guildId: string | undefined }
  | { ok: false; reason: 'unknown_guild' | 'unknown_channel' }

/**
 * Resolves the guild an interaction carries. A `guildId` must name an
 * existing guild the application's bot is still in and a `channelId` an
 * existing channel (of that guild, when given) outside guilds the bot left
 * or lost. A channel-only request happens in the channel's guild, which the
 * interaction must carry so removed setups never receive it.
 * @param db - Database
 * @param applicationId - Application (bot user) ID
 * @param guildId - Requested guild ID
 * @param channelId - Requested channel ID
 * @returns The guild the interaction belongs to, or why it cannot exist
 */
export function resolveInteractionScope(
  db: Database,
  applicationId: string,
  guildId: string | undefined,
  channelId: string | undefined
): InteractionScope {
  /** Whether the application's bot is still in a guild of its setup. */
  const botInGuild = (id: string): boolean =>
    db
      .prepare(
        'SELECT 1 FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ? AND g.bot_present = 1 AND b.user_id = ?'
      )
      .get(id, applicationId) !== undefined
  if (guildId !== undefined && !botInGuild(guildId))
    return { ok: false, reason: 'unknown_guild' }
  let interactionGuildId = guildId
  if (channelId !== undefined) {
    const channel = db
      .prepare(
        `SELECT c.guild_id FROM channels c
         LEFT JOIN guilds g ON g.id = c.guild_id
         WHERE c.id = ? AND COALESCE(g.bot_present, 1) = 1`
      )
      .get(channelId) as { guild_id: string | null } | undefined
    if (!channel || (guildId !== undefined && channel.guild_id !== guildId))
      return { ok: false, reason: 'unknown_channel' }
    if (channel.guild_id !== null) {
      if (!botInGuild(channel.guild_id))
        return { ok: false, reason: 'unknown_channel' }
      interactionGuildId = channel.guild_id
    }
  }
  return { ok: true, guildId: interactionGuildId }
}
