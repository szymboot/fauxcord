import { isSnowflakeString } from './bulk-delete'

/** Exact pagination selector; null requires an absent cursor parameter. */
export interface RestPageHoldRequest {
  path: string
  after: string | null
  before: string | null
  /** Message history only; always null for guild member and ban pages. */
  around: string | null
  timeout_ms: number
}

/** Guild member and ban list paths, selected by their guild. */
const GUILD_PAGE_PATH = /^\/guilds\/\d{1,20}\/(?:members|bans)$/

/** Message history list paths, selected by their channel. */
const MESSAGE_PAGE_PATH = /^\/channels\/\d{1,20}\/messages$/

/** Whether a bare (unprefixed) path is a message history list. */
export function isRestMessagePagePath(path: string): boolean {
  return MESSAGE_PAGE_PATH.test(path)
}

/** Whether a bare (unprefixed) path is a page that can be held. */
export function isRestPageHoldPath(path: string): boolean {
  return GUILD_PAGE_PATH.test(path) || isRestMessagePagePath(path)
}

/** Whether a value is a guild page's decimal cursor. */
function isGuildCursor(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value)
}

/**
 * Validates a bounded member, ban or message history page hold without
 * accepting broad selectors. Guild pages require an explicit `after`; every
 * message history cursor defaults to null.
 */
export function validateRestPageHold(
  value: unknown
): RestPageHoldRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  const { path, timeout_ms: timeout } = body
  if (
    typeof path !== 'string' ||
    typeof timeout !== 'number' ||
    !isRestPageHoldPath(path) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 60_000
  )
    return undefined
  const messages = isRestMessagePagePath(path)
  if (!messages && !('after' in body)) return undefined
  const after = body.after ?? null
  const before = body.before ?? null
  const around = body.around ?? null
  // Message cursors are Snowflakes; guild pages accept any short decimal.
  const isDecimal = messages ? isSnowflakeString : isGuildCursor
  /** Whether a value is an exact cursor or an explicit absence. */
  const isCursor = (cursor: unknown): cursor is string | null =>
    cursor === null || isDecimal(cursor)
  if (!isCursor(after) || !isCursor(before) || !isCursor(around))
    return undefined
  // Discord's history list and the guild pages accept one cursor at a time.
  if ([after, before, around].filter((cursor) => cursor !== null).length > 1)
    return undefined
  if (!messages && around !== null) return undefined
  return before !== null && path.endsWith('/members')
    ? undefined
    : { path, after, before, around, timeout_ms: timeout }
}
