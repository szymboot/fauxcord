import { isAuditSnowflake, validateAuditLogQuery } from './audit-log'
import type { AuditLogQuery } from './audit-log'

/** JSON values deliberately unconstrained by Discord's audit entry schema. */
export type AuditResponseValue =
  | null
  | boolean
  | number
  | string
  | AuditResponseValue[]
  | { [key: string]: AuditResponseValue }

/** Explicit bot/guild/query policy, separate from deliberately unusual entries. */
export interface AuditLogResponseRequest {
  bot_id: string
  guild_id: string
  query: AuditLogQuery
  entries: Record<string, AuditResponseValue>[]
  times: number
  ttl_ms: number
}

/** Checks JSON structure with a bounded nesting depth, without audit validation. */
function isResponseValue(
  value: unknown,
  depth = 0
): value is AuditResponseValue {
  if (depth > 10) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'object'
    ? Object.values(value).every((child) => isResponseValue(child, depth + 1))
    : false
}

/** Canonicalizes exact supported query fields; absent fields stay absent. */
export function normalizeAuditResponseQuery(
  value: unknown
): AuditLogQuery | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const raw = value as Record<string, unknown>
  const strings: Record<string, string> = {}
  for (const [key, field] of Object.entries(raw)) {
    if (
      ![
        'user_id',
        'target_id',
        'action_type',
        'before',
        'after',
        'limit',
      ].includes(key)
    )
      return undefined
    if (
      typeof field !== 'string' &&
      !(typeof field === 'number' && ['action_type', 'limit'].includes(key))
    )
      return undefined
    strings[key] = String(field)
  }
  const query = validateAuditLogQuery(strings)
  return typeof query === 'string' ? undefined : query
}

/** Validates control scope and bounds while preserving malformed entry fields. */
export function validateAuditLogResponse(
  value: unknown
): AuditLogResponseRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  const query = normalizeAuditResponseQuery(body.query)
  const times = body.times === undefined ? 1 : body.times
  return !query ||
    typeof times !== 'number' ||
    body.bot_id === '0' ||
    !isAuditSnowflake(body.bot_id) ||
    body.guild_id === '0' ||
    !isAuditSnowflake(body.guild_id) ||
    !Number.isSafeInteger(times) ||
    times < 1 ||
    times > 100 ||
    typeof body.ttl_ms !== 'number' ||
    !Number.isSafeInteger(body.ttl_ms) ||
    body.ttl_ms < 1 ||
    body.ttl_ms > 60_000 ||
    !Array.isArray(body.entries) ||
    body.entries.length > 100 ||
    body.entries.some(
      (entry: unknown) =>
        !(
          typeof entry === 'object' &&
          entry !== null &&
          !Array.isArray(entry) &&
          Object.keys(entry).every((key) =>
            ['id', 'action_type', 'user_id', 'target_id', 'options'].includes(
              key
            )
          ) &&
          isResponseValue(entry)
        )
    ) ||
    Object.keys(body).some(
      (key) =>
        !['bot_id', 'guild_id', 'query', 'entries', 'times', 'ttl_ms'].includes(
          key
        )
    ) ||
    Buffer.byteLength(JSON.stringify(body)) > 65_536
    ? undefined
    : {
        bot_id: body.bot_id,
        guild_id: body.guild_id,
        query,
        entries: body.entries as Record<string, AuditResponseValue>[],
        times,
        ttl_ms: body.ttl_ms,
      }
}
