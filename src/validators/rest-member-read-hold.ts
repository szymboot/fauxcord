/** Exact guild/user selector for one held `GET /guilds/{id}/members/{id}`. */
export interface RestMemberReadHoldRequest {
  guild_id: string
  user_id: string
  timeout_ms: number
}

/** Matches a decimal Snowflake string without accepting broad selectors. */
const SNOWFLAKE = /^\d{1,20}$/

/**
 * Validates a bounded member-read snapshot hold.
 * @param value - Parsed JSON request body
 * @returns The normalized selector, or undefined when invalid
 */
export function validateRestMemberReadHold(
  value: unknown
): RestMemberReadHoldRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  return typeof body.guild_id !== 'string' ||
    !SNOWFLAKE.test(body.guild_id) ||
    typeof body.user_id !== 'string' ||
    !SNOWFLAKE.test(body.user_id) ||
    typeof body.timeout_ms !== 'number' ||
    !Number.isSafeInteger(body.timeout_ms) ||
    body.timeout_ms < 1 ||
    body.timeout_ms > 60_000
    ? undefined
    : {
        guild_id: body.guild_id,
        user_id: body.user_id,
        timeout_ms: body.timeout_ms,
      }
}
