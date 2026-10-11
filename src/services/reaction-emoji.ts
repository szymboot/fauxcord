/**
 * Reaction emoji identity helpers
 *
 * Reactions are persisted under a stable key: the Unicode sequence itself, or
 * `custom:<id>` for guild emoji, so a custom reaction keeps its identity when
 * the emoji is renamed or addressed with a different name in a REST path.
 */

import type { Database } from '../db'

/** Storage key prefix for custom (guild) emoji reactions. */
export const CUSTOM_KEY_PREFIX = 'custom:'

/** Discord's custom emoji reaction form: `name:id` or animated `a:name:id`. */
const CUSTOM_EMOJI_PATTERN = /^(?:(a):)?([^:]+):(\d+)$/

/** Emoji parsed from a REST path segment or test-control request. */
export interface ParsedReactionEmoji {
  /** Custom emoji snowflake, or null for a Unicode emoji */
  id: string | null
  /** Unicode sequence, or the custom emoji name supplied by the caller */
  name: string
  /** Whether the caller used the animated `a:name:id` form */
  animated: boolean
}

/** Partial emoji object carried by reaction payloads and message reactions. */
export interface ReactionEmoji {
  /** Custom emoji ID (null for Unicode emoji) */
  id: string | null
  /** Emoji name; null only for a custom emoji whose data is unavailable */
  name: string | null
  /** Whether the custom emoji is animated (omitted for Unicode emoji) */
  animated?: boolean
}

/** Current guild emoji data used to resolve a custom reaction. */
export interface GuildEmojiSnapshot {
  /** Guild that owns the emoji */
  guild_id: string
  /** Current emoji name */
  name: string
  /** Whether the emoji is animated */
  animated: boolean
}

/**
 * Parses a decoded reaction emoji. `name:id` and `a:name:id` are custom emoji;
 * every other string is treated as a Unicode emoji (unchanged legacy behavior).
 * @param raw - Decoded emoji string
 * @returns Parsed emoji
 */
export function parseReactionEmoji(raw: string): ParsedReactionEmoji {
  const custom = CUSTOM_EMOJI_PATTERN.exec(raw)
  return custom
    ? { id: custom[3], name: custom[2], animated: custom[1] === 'a' }
    : { id: null, name: raw, animated: false }
}

/**
 * Builds the persisted reaction key for a parsed emoji.
 * @param emoji - Parsed emoji
 * @returns `custom:<id>` for custom emoji, otherwise the Unicode sequence
 */
export function reactionEmojiKey(emoji: ParsedReactionEmoji): string {
  return emoji.id === null ? emoji.name : CUSTOM_KEY_PREFIX + emoji.id
}

/**
 * Builds the reaction payload emoji for a persisted key. Custom emoji prefer
 * the current guild data (so renames are reflected), then the caller-supplied
 * fallback, and finally Discord's `name: null` for unavailable emoji.
 * @param key - Persisted reaction key
 * @param current - Current guild emoji data, when the emoji still exists
 * @param fallback - Emoji parsed from the request, when available
 * @returns Partial emoji object
 */
export function reactionEmojiFromKey(
  key: string,
  current?: Pick<GuildEmojiSnapshot, 'name' | 'animated'>,
  fallback?: ParsedReactionEmoji
): ReactionEmoji {
  return key.startsWith(CUSTOM_KEY_PREFIX)
    ? {
        id: key.slice(CUSTOM_KEY_PREFIX.length),
        name: current?.name ?? fallback?.name ?? null,
        animated: current?.animated ?? fallback?.animated ?? false,
      }
    : { id: null, name: key }
}

/**
 * Looks up a guild emoji by ID.
 * @param db - Database
 * @param emojiId - Emoji ID
 * @returns Current emoji data, or undefined when it does not exist
 */
export function findGuildEmoji(
  db: Database,
  emojiId: string
): GuildEmojiSnapshot | undefined {
  const row = db
    .prepare('SELECT guild_id, name, animated FROM emojis WHERE id = ?')
    .get(emojiId) as
    { guild_id: string; name: string; animated: number } | undefined
  return row && { ...row, animated: row.animated === 1 }
}

/**
 * Resolves the payload emoji for a parsed request emoji.
 * @param db - Database
 * @param emoji - Parsed request emoji
 * @returns Partial emoji object with current custom emoji data
 */
export function resolveReactionEmoji(
  db: Database,
  emoji: ParsedReactionEmoji
): ReactionEmoji {
  return reactionEmojiFromKey(
    reactionEmojiKey(emoji),
    emoji.id === null ? undefined : findGuildEmoji(db, emoji.id),
    emoji
  )
}
