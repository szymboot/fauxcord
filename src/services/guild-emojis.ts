/**
 * Guild emoji operations service
 *
 * Provides CRUD operations for guild custom emojis.
 */

import type { Database } from '../db'
import { getUser, type UserObject } from './users'
import { gatewayBus } from '../gateway/bus'
// Used for compile-time type drift detection.
import type { APIEmoji } from 'discord-api-types/v10'

/**
 * Compile-time guard: ensures the safe-field subset of EmojiObject is
 * structurally compatible with APIEmoji.
 * Fails to compile when discord-api-types renames or retypes these fields.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _EmojiCompatGuard =
  Pick<
    APIEmoji,
    'id' | 'name' | 'managed' | 'animated' | 'available'
  > extends Pick<
    EmojiObject,
    'id' | 'name' | 'managed' | 'animated' | 'available'
  >
    ? true
    : never

/** Emoji record type retrieved from the DB */
interface EmojiRow {
  id: string
  guild_id: string
  name: string
  user_id: string | null
  roles: string
  animated: number
}

/** Emoji object for API responses (conforms to the spec EmojiResponse) */
export interface EmojiObject {
  id: string
  name: string
  user?: UserObject
  roles: string[]
  require_colons: boolean
  managed: boolean
  animated: boolean
  available: boolean
}

/**
 * Converts a DB emoji record into the API response format.
 * @param db - Database
 * @param row - DB record
 * @returns Object for API responses
 */
function toEmojiObject(db: Database, row: EmojiRow): EmojiObject {
  const roles = JSON.parse(row.roles) as string[]
  const emoji: EmojiObject = {
    id: row.id,
    name: row.name,
    roles,
    require_colons: true,
    managed: false,
    animated: row.animated === 1,
    available: true,
  }
  if (row.user_id) {
    const user = getUser(db, row.user_id)
    if (user) emoji.user = user
  }
  return emoji
}

/**
 * Retrieves the list of emojis for a guild, ordered by creation time.
 * @param db - Database
 * @param guildId - Guild ID
 * @returns Array of emoji objects
 */
export function getGuildEmojis(db: Database, guildId: string): EmojiObject[] {
  const rows = db
    .prepare('SELECT * FROM emojis WHERE guild_id = ? ORDER BY created_at, id')
    .all(guildId) as EmojiRow[]
  return rows.map((row) => toEmojiObject(db, row))
}

/**
 * Retrieves an emoji by ID within a guild.
 * @param db - Database
 * @param guildId - Guild ID
 * @param emojiId - Emoji ID
 * @returns Emoji object, or null
 */
export function getEmoji(
  db: Database,
  guildId: string,
  emojiId: string
): EmojiObject | null {
  const row = db
    .prepare('SELECT * FROM emojis WHERE id = ? AND guild_id = ?')
    .get(emojiId, guildId) as EmojiRow | undefined
  return row ? toEmojiObject(db, row) : null
}

/** Emoji creation parameters */
export interface EmojiCreateParams {
  emojiId: string
  guildId: string
  name: string
  userId: string | null
  roles?: string[] | null
  /** Whether the emoji image is animated (GIF); defaults to false */
  animated?: boolean
}

/**
 * Creates an emoji in a guild.
 * @param db - Database
 * @param params - Emoji creation parameters
 * @returns Created emoji object
 */
export function createEmoji(
  db: Database,
  params: EmojiCreateParams
): EmojiObject {
  db.prepare(
    'INSERT INTO emojis (id, guild_id, name, user_id, roles, animated) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    params.emojiId,
    params.guildId,
    params.name,
    params.userId,
    JSON.stringify(params.roles ?? []),
    params.animated ? 1 : 0
  )
  const row = db
    .prepare('SELECT * FROM emojis WHERE id = ?')
    .get(params.emojiId) as EmojiRow
  return toEmojiObject(db, row)
}

/** Emoji update parameters */
export interface EmojiUpdateParams {
  name?: string
  roles?: string[]
}

/**
 * Publishes the guild's full emoji list as `GUILD_EMOJIS_UPDATE` to the
 * sessions of the bot that owns the guild's setup.
 * @param db - Database the guild belongs to
 * @param guildId - Guild ID
 */
function emitGuildEmojisUpdate(db: Database, guildId: string): void {
  const owner = db
    .prepare(
      'SELECT bots.user_id, bots.token FROM guilds JOIN bots ON bots.token = guilds.bot_token WHERE guilds.id = ?'
    )
    .get(guildId) as { user_id: string; token: string } | undefined
  if (!owner) return
  gatewayBus.emit('guild.emojis.update', {
    guildId,
    emojis: getGuildEmojis(db, guildId),
    scope: { db, botId: owner.user_id, token: owner.token },
  })
}

/**
 * Updates an emoji's information and emits `GUILD_EMOJIS_UPDATE` when the name
 * or roles change. The emoji
 * ID is unchanged, so reactions keep their identity across renames.
 * @param db - Database
 * @param guildId - Guild ID
 * @param emojiId - Emoji ID
 * @param payload - Update payload
 * @returns Updated emoji object, or null
 */
export function updateEmoji(
  db: Database,
  guildId: string,
  emojiId: string,
  payload: EmojiUpdateParams
): EmojiObject | null {
  const current = db
    .prepare('SELECT * FROM emojis WHERE id = ? AND guild_id = ?')
    .get(emojiId, guildId) as EmojiRow | undefined
  if (!current) return null

  const updates: Record<string, unknown> = {
    ...(payload.name !== undefined && { name: payload.name }),
    ...(payload.roles !== undefined && {
      roles: JSON.stringify(payload.roles),
    }),
  }

  if (Object.keys(updates).length > 0) {
    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(', ')
    db.prepare(`UPDATE emojis SET ${setClauses} WHERE id = ?`).run(
      ...Object.values(updates),
      emojiId
    )
  }

  const row = db
    .prepare('SELECT * FROM emojis WHERE id = ?')
    .get(emojiId) as EmojiRow
  // Like GUILD_UPDATE, only a modification that changes the emoji dispatches.
  if (row.name !== current.name || row.roles !== current.roles) {
    emitGuildEmojisUpdate(db, guildId)
  }
  return toEmojiObject(db, row)
}

/**
 * Deletes an emoji.
 * @param db - Database
 * @param guildId - Guild ID
 * @param emojiId - Emoji ID
 * @returns true on successful deletion
 */
export function deleteEmoji(
  db: Database,
  guildId: string,
  emojiId: string
): boolean {
  const result = db
    .prepare('DELETE FROM emojis WHERE id = ? AND guild_id = ?')
    .run(emojiId, guildId)
  return result.changes > 0
}
