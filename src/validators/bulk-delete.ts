/**
 * Whether a value is a canonical Snowflake string: unsigned 64-bit decimal
 * without leading zeros, as bulk deletion accepts message IDs.
 * @param value - Candidate value
 * @returns True for a canonical Snowflake string
 */
export function isSnowflakeString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,19})$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  )
}

/**
 * Reads the `messages` array of a bulk-delete body without rounding unquoted
 * Snowflakes. Node 24's JSON reviver source preserves integer tokens while
 * JSON.parse validates the complete JSON syntax, structure, escaping and
 * duplicate-key semantics.
 * @param rawBody - Original request body
 * @returns Unvalidated entries, numbers as their source text, or null without a
 * JSON object holding a `messages` array
 */
export function readBulkDeleteEntries(rawBody: string): unknown[] | null {
  let payload: unknown
  try {
    payload = JSON.parse(
      rawBody,
      (_key: string, value: unknown, context?: { source: string }) =>
        typeof value === 'number' ? context?.source : value
    ) as unknown
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const messages = (payload as Record<string, unknown>).messages
  return Array.isArray(messages) ? messages : null
}

/**
 * Parses a bulk-delete body, rejecting it unless every entry is a Snowflake.
 * @param rawBody - Original request body
 * @returns Canonical Snowflake strings, or null for invalid body/ID types
 */
export function parseBulkDeleteMessages(rawBody: string): string[] | null {
  const entries = readBulkDeleteEntries(rawBody)
  return entries?.every((id) => isSnowflakeString(id)) ? entries : null
}
