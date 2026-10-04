/** Action types from the committed Discord AuditLogActionTypes schema. */
const AUDIT_ACTION_TYPES = new Set([
  1, 10, 11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 31, 32, 40,
  41, 42, 50, 51, 52, 60, 61, 62, 72, 73, 74, 75, 80, 81, 82, 83, 84, 85, 90,
  91, 92, 100, 101, 102, 110, 111, 112, 121, 130, 131, 132, 140, 141, 142, 143,
  144, 145, 146, 150, 151, 163, 164, 165, 166, 167, 171, 172, 180, 190, 191,
  192, 193, 200, 201, 202, 211,
])

/** Narrow fixture payload for a controlled MESSAGE_DELETE audit entry. */
export interface AuditLogFixture {
  id?: string
  /** ISO UTC timestamp encoded into the ID; mutually exclusive with id. */
  timestamp?: string
  action_type: 72
  user_id: string
  target_id: string
  options: { channel_id: string; count: string }
}

/** Supported Discord audit-log query filters. */
export interface AuditLogQuery {
  user_id?: string
  target_id?: string
  action_type?: number
  before?: string
  after?: string
  limit?: number
}

/** Checks a canonical unsigned 64-bit Discord snowflake without rounding. */
export function isAuditSnowflake(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  )
}

/** Validates an exact UTC timestamp representable in a Discord snowflake. */
function isAuditTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false
  const date = new Date(value)
  const time = date.getTime()
  return (
    Number.isFinite(time) &&
    date.toISOString() === value &&
    time > 1_420_070_400_000 &&
    time <= 5_818_116_911_103
  )
}

/** Validates the entire fixture before any datastore mutation. */
export function validateAuditLogFixture(
  value: unknown
): AuditLogFixture | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).some(
      (key) =>
        ![
          'id',
          'timestamp',
          'action_type',
          'user_id',
          'target_id',
          'options',
        ].includes(key)
    )
  )
    return undefined
  if (
    body.action_type !== 72 ||
    !isAuditSnowflake(body.user_id) ||
    body.user_id === '0' ||
    !isAuditSnowflake(body.target_id) ||
    body.target_id === '0' ||
    (body.id !== undefined &&
      (!isAuditSnowflake(body.id) || body.id === '0')) ||
    (body.timestamp !== undefined && !isAuditTimestamp(body.timestamp)) ||
    (body.id !== undefined && body.timestamp !== undefined) ||
    typeof body.options !== 'object' ||
    body.options === null ||
    Array.isArray(body.options)
  )
    return undefined
  const options = body.options as Record<string, unknown>
  return Object.keys(options).some(
    (key) => !['channel_id', 'count'].includes(key)
  ) ||
    !isAuditSnowflake(options.channel_id) ||
    options.channel_id === '0' ||
    typeof options.count !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(options.count) ||
    !Number.isSafeInteger(Number(options.count))
    ? undefined
    : {
        id: body.id,
        timestamp: body.timestamp,
        action_type: 72,
        user_id: body.user_id,
        target_id: body.target_id,
        options: { channel_id: options.channel_id, count: options.count },
      }
}

/** Parses bounded REST query values, returning the invalid field on failure. */
export function validateAuditLogQuery(
  query: Record<string, string | undefined>
): AuditLogQuery | string {
  const result: AuditLogQuery = {}
  for (const field of ['user_id', 'target_id', 'before', 'after'] as const) {
    const value = query[field]
    if (value === undefined) continue
    if (!isAuditSnowflake(value)) return field
    result[field] = value
  }
  for (const field of ['action_type', 'limit'] as const) {
    const value = query[field]
    if (value === undefined) continue
    if (
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      return field
    const number = Number(value)
    if (field === 'limit' && (number < 1 || number > 100)) return field
    if (field === 'action_type' && !AUDIT_ACTION_TYPES.has(number)) return field
    result[field] = number
  }
  return result
}
