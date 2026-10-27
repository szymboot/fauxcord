import type { Database } from '../db'
import type { DmChannelRequest } from '../validators/dm-channel'
import {
  findDmChannel,
  getOrCreateDmChannel,
  type ChannelObject,
} from './channels'

/** Rejections shared by the DM channel lookup and open controls. */
export type DmChannelTargetError =
  'UNKNOWN_GUILD' | 'UNKNOWN_USER' | 'BOT_RECIPIENT'

/** DM channel plus whether this call created it. */
export interface OpenedDmChannel {
  channel: ChannelObject
  created: boolean
}

/**
 * Resolves the bot user that owns the guild's setup token, and checks that the
 * other party is an existing human. The guild selects the exact owning setup.
 * @param db - Database
 * @param request - Guild ID selecting the bot and the human user ID
 * @returns The owning bot's user ID, or the reason the target is invalid
 */
function resolveDmTarget(
  db: Database,
  request: DmChannelRequest
): DmChannelTargetError | { botUserId: string } {
  const guild = db
    .prepare(
      `SELECT b.user_id FROM guilds g
       JOIN bots b ON b.token = g.bot_token WHERE g.id = ?`
    )
    .get(request.guild_id) as { user_id: string } | undefined
  if (!guild) return 'UNKNOWN_GUILD'
  const user = db
    .prepare('SELECT bot FROM users WHERE id = ?')
    .get(request.user_id) as { bot: number } | undefined
  if (!user) return 'UNKNOWN_USER'
  return user.bot ? 'BOT_RECIPIENT' : { botUserId: guild.user_id }
}

/**
 * Looks up the 1:1 DM channel between a guild's owning bot and a human without
 * creating it. No Gateway event is emitted.
 * @param db - Database
 * @param request - Guild ID selecting the bot and the human user ID
 * @returns The channel object, null when the bot has not opened one, or a
 * target error
 */
export function lookupDmChannel(
  db: Database,
  request: DmChannelRequest
): ChannelObject | null | DmChannelTargetError {
  const target = resolveDmTarget(db, request)
  return typeof target === 'string'
    ? target
    : findDmChannel(db, target.botUserId, request.user_id)
}

/**
 * Opens the 1:1 DM channel between a guild's owning bot and a human, as the
 * human would, reusing the storage of `POST /users/@me/channels`. Idempotent.
 * @param db - Database
 * @param request - Guild ID selecting the bot and the human user ID
 * @returns The channel and whether it was just created, or a target error
 */
export function openDmChannel(
  db: Database,
  request: DmChannelRequest
): OpenedDmChannel | DmChannelTargetError {
  const target = resolveDmTarget(db, request)
  if (typeof target === 'string') return target
  const existing = findDmChannel(db, target.botUserId, request.user_id)
  return existing
    ? { channel: existing, created: false }
    : {
        channel: getOrCreateDmChannel(db, target.botUserId, request.user_id),
        created: true,
      }
}
