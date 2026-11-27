/**
 * Discord-compatible ISO 8601 timestamp formatting.
 *
 * The real Discord API emits timestamps as ISO 8601 datetimes with
 * microsecond precision and an explicit `+00:00` UTC offset (e.g.
 * `2021-01-01T01:01:01.010000+00:00`), never the `Z`-suffixed format that
 * `Date.prototype.toISOString()` produces (e.g. `2021-01-01T01:01:01.010Z`).
 * Most client libraries parse both forms leniently, but some (e.g.
 * twilight-rs's `Timestamp::parse`) strictly reject the `Z` suffix, so every
 * Discord-facing timestamp field must go through this helper instead of
 * calling `toISOString()` directly.
 */

import { parseSnowflakeTimestamp } from './snowflake'

/**
 * Formats a `Date` as a Discord-style ISO 8601 timestamp string.
 * @param date - Date to format
 * @returns ISO 8601 string with microsecond precision and a `+00:00` offset
 * (e.g. `2021-01-01T01:01:01.010000+00:00`)
 */
export function toDiscordTimestamp(date: Date): string {
  const [base, fraction] = date.toISOString().split('.', 2)
  // toISOString() always yields exactly 3 fractional digits (milliseconds)
  // followed by "Z"; pad to 6 digits (microseconds) since JS Date has no
  // finer resolution to offer.
  const milliseconds = fraction.slice(0, 3)
  return `${base}.${milliseconds}000+00:00`
}

/**
 * Parses a stored timestamp, treating SQLite's zone-less datetimes as UTC.
 * Explicit ISO 8601 offsets are preserved when parsing fixture timestamps.
 * @param value - SQLite datetime or an explicitly zoned ISO 8601 timestamp
 * @returns Parsed date
 */
export function parseStoredTimestamp(value: string): Date {
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
    value
  )
    ? `${value.replace(' ', 'T')}Z`
    : value
  return new Date(timestamp)
}

/**
 * Formats a stored timestamp, treating SQLite's zone-less datetimes as UTC.
 * Explicit ISO 8601 offsets are preserved when parsing fixture timestamps.
 * @param value - SQLite datetime or an explicitly zoned ISO 8601 timestamp
 * @returns Discord timestamp with six fractional digits and a UTC offset
 */
export function formatStoredTimestamp(value: string): string {
  return toDiscordTimestamp(parseStoredTimestamp(value))
}

/**
 * Formats a `Date` as a zone-less UTC SQLite datetime with milliseconds, which
 * stays comparable with the output of SQLite's `datetime()`.
 * @param date - Date to format
 * @returns Stored datetime (e.g. `2021-01-01 01:01:01.010`)
 */
export function toStoredTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

/**
 * Derives the stored creation time of a message from its Snowflake ID.
 * @param messageId - Message ID
 * @returns Stored datetime, or null when the ID is not a valid Snowflake
 */
export function storedTimestampFromSnowflake(messageId: string): string | null {
  const date = parseSnowflakeTimestamp(messageId)
  return date ? toStoredTimestamp(date) : null
}
