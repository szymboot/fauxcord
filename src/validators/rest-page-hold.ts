/** Exact pagination selector; null requires an absent cursor parameter. */
export interface RestPageHoldRequest {
  path: string
  after: string | null
  before: string | null
  timeout_ms: number
}

/** Validates a bounded member/ban page hold without accepting broad selectors. */
export function validateRestPageHold(
  value: unknown
): RestPageHoldRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  return typeof body.path !== 'string' ||
    !/^\/guilds\/\d{1,20}\/(?:members|bans)$/.test(body.path) ||
    typeof body.timeout_ms !== 'number' ||
    !Number.isSafeInteger(body.timeout_ms) ||
    body.timeout_ms < 1 ||
    body.timeout_ms > 60_000 ||
    !('after' in body) ||
    (body.after !== null &&
      (typeof body.after !== 'string' || !/^\d{1,20}$/.test(body.after))) ||
    (body.before !== undefined &&
      body.before !== null &&
      (typeof body.before !== 'string' || !/^\d{1,20}$/.test(body.before))) ||
    (body.before != null &&
      (body.after !== null || body.path.endsWith('/members')))
    ? undefined
    : {
        path: body.path,
        after: body.after,
        before: body.before ?? null,
        timeout_ms: body.timeout_ms,
      }
}
