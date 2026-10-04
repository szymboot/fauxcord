import { toDiscordTimestamp } from '../timestamp'

/** ISO 8601 timestamp with a timezone and a valid time of day. */
const JOIN_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/**
 * Validates and normalizes a fixture join date without Date's calendar rollover.
 * @param value - Untrusted timestamp, with an explicit timezone
 * @returns Discord timestamp at millisecond precision, or null if malformed
 */
export function normalizeMemberJoinDate(value: unknown): string | null {
  if (typeof value !== 'string' || !JOIN_TIMESTAMP.test(value)) return null
  const timestamp = Date.parse(value)
  const calendarDate = value.slice(0, 10)
  const calendarTimestamp = Date.parse(`${calendarDate}T00:00:00Z`)
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(calendarTimestamp) ||
    new Date(calendarTimestamp).toISOString().slice(0, 10) !== calendarDate
  ) {
    return null
  }
  const normalized = toDiscordTimestamp(new Date(timestamp))
  return /^\d{4}-/.test(normalized) ? normalized : null
}
