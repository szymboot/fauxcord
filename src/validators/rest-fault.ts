/** Exact request selector and Discord-shaped failure configured by tests. */
export interface RestFaultRequest {
  method: 'DELETE' | 'PUT' | 'PATCH' | 'POST' | 'GET'
  path: string
  /** Cleanup scope and owning bot selector; required only for global user GETs. */
  guild_id?: string
  /** Exact normalized page selector, supported only on the three list GETs. */
  query?: RestFaultQuery
  status: number
  code: number
  message: string
  times: number
  /** Explicit bounded failure mode; omitted for legacy HTTP errors. */
  mode?: 'rate_limit' | 'delay' | 'disconnect'
  retry_after?: number
  global?: boolean
  delay_ms?: number
  timeout_ms?: number
}

/** Canonical page size and optional single numeric cursor. */
export interface RestFaultQuery {
  limit: number
  after?: string
  before?: string
  around?: string
}

/** Identifies list routes whose faults select a page rather than ignoring queries. */
export function isRestFaultPagePath(path: string): boolean {
  return (
    /^\/guilds\/\d{1,20}\/(?:members|bans)$/.test(path) ||
    /^\/channels\/\d{1,20}\/messages$/.test(path)
  )
}

/** Validates and canonicalizes a page query without losing snowflake precision. */
export function normalizeRestFaultQuery(
  path: string,
  value: unknown
): RestFaultQuery | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const query = value as Record<string, unknown>
  const members = path.endsWith('/members')
  const messages = path.startsWith('/channels/')
  const cursors = members
    ? ['after']
    : messages
      ? ['after', 'before', 'around']
      : ['after', 'before']
  if (
    Object.keys(query).some((key) => key !== 'limit' && !cursors.includes(key))
  )
    return undefined
  const rawLimit =
    query.limit === undefined
      ? members
        ? 1
        : messages
          ? 50
          : 1000
      : query.limit
  if (
    typeof rawLimit !== 'number' &&
    (typeof rawLimit !== 'string' || !/^\d{1,4}$/.test(rawLimit))
  )
    return undefined
  const limit = Number(rawLimit)
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (messages ? 100 : 1000)
  )
    return undefined
  const result: RestFaultQuery = { limit }
  let cursorCount = 0
  for (const key of cursors) {
    if (query[key] === undefined) continue
    const raw = query[key]
    if (typeof raw !== 'string' || !/^\d{1,20}$/.test(raw)) return undefined
    result[key as 'after' | 'before' | 'around'] = BigInt(raw).toString()
    cursorCount++
  }
  if (cursorCount > 1) return undefined
  if (members && result.after === undefined) result.after = '0'
  return result
}

/** Returns a validated, bounded fault request, or undefined for invalid input. */
export function validateRestFault(
  value: unknown
): RestFaultRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const body = value as Record<string, unknown>
  if (typeof body.path !== 'string') return undefined
  const mode = body.mode
  if (
    mode !== undefined &&
    (typeof mode !== 'string' ||
      !['rate_limit', 'delay', 'disconnect'].includes(mode))
  )
    return undefined
  const timeout = body.timeout_ms === undefined ? 30_000 : body.timeout_ms
  if (
    mode !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 60_000)
  )
    return undefined
  if (mode === undefined && body.timeout_ms !== undefined) return undefined
  if (mode === 'rate_limit') {
    if (
      typeof body.retry_after !== 'number' ||
      !Number.isFinite(body.retry_after) ||
      body.retry_after <= 0 ||
      body.retry_after > 60 ||
      (body.global !== undefined && typeof body.global !== 'boolean') ||
      (body.status !== undefined && body.status !== 429)
    )
      return undefined
  } else if (body.retry_after !== undefined || body.global !== undefined)
    return undefined
  if (mode === 'delay') {
    if (
      typeof body.delay_ms !== 'number' ||
      !Number.isSafeInteger(body.delay_ms) ||
      body.delay_ms < 1 ||
      body.delay_ms > 60_000
    )
      return undefined
  } else if (body.delay_ms !== undefined) return undefined
  const status =
    body.status === undefined
      ? mode === 'rate_limit'
        ? 429
        : mode
          ? 504
          : undefined
      : body.status
  const code = body.code === undefined ? (mode ? 0 : undefined) : body.code
  const message =
    body.message === undefined
      ? mode === 'rate_limit'
        ? 'You are being rate limited.'
        : mode
          ? 'Transport failure'
          : undefined
      : body.message
  const times = body.times === undefined ? 1 : body.times
  if (
    typeof times !== 'number' ||
    times < 1 ||
    times > 100 ||
    !Number.isSafeInteger(times)
  )
    return undefined
  if (
    typeof status !== 'number' ||
    status < 400 ||
    status > 599 ||
    !Number.isSafeInteger(status)
  )
    return undefined
  if (typeof code !== 'number' || code < 0 || !Number.isSafeInteger(code))
    return undefined
  if (
    typeof message !== 'string' ||
    message.length === 0 ||
    message.length > 1000
  )
    return undefined

  const userRead =
    body.method === 'GET' && /^\/users\/\d{1,20}$/.test(body.path)
  const guildRead =
    body.method === 'GET' &&
    /^\/guilds\/\d{1,20}\/(?:audit-logs|members|bans|members\/\d{1,20})$/.test(
      body.path
    )
  const pageRead = body.method === 'GET' && isRestFaultPagePath(body.path)
  const query = pageRead
    ? normalizeRestFaultQuery(
        body.path,
        body.query === undefined ? {} : body.query
      )
    : undefined
  if (
    (pageRead && !query) ||
    (!pageRead && body.query !== undefined) ||
    (pageRead && !guildRead && body.guild_id !== undefined)
  )
    return undefined
  if (
    (userRead && body.guild_id === undefined) ||
    (body.method === 'GET' &&
      body.guild_id !== undefined &&
      (typeof body.guild_id !== 'string' ||
        !/^\d{1,20}$/.test(body.guild_id) ||
        (guildRead && body.guild_id !== body.path.split('/', 3)[2])))
  )
    return undefined

  const supported =
    userRead ||
    guildRead ||
    pageRead ||
    (body.method === 'POST' &&
      /^\/channels\/\d{1,20}\/messages$/.test(body.path)) ||
    (body.method === 'DELETE' &&
      /^\/channels\/\d{1,20}\/messages\/\d{1,20}$/.test(body.path)) ||
    (body.method === 'PUT' &&
      /^\/guilds\/\d{1,20}\/(?:bans\/\d{1,20}|members\/\d{1,20}\/roles\/\d{1,20})$/.test(
        body.path
      )) ||
    (body.method === 'PATCH' &&
      /^\/guilds\/\d{1,20}\/members\/\d{1,20}$/.test(body.path))
  return supported
    ? {
        method: body.method as RestFaultRequest['method'],
        path: body.path,
        ...(userRead && { guild_id: body.guild_id as string }),
        ...(query && { query }),
        status,
        code,
        message,
        times,
        ...(mode !== undefined && {
          mode: mode as RestFaultRequest['mode'],
          timeout_ms: typeof timeout === 'number' ? timeout : 30_000,
          ...(mode === 'rate_limit' && {
            retry_after:
              typeof body.retry_after === 'number'
                ? body.retry_after
                : undefined,
            global: typeof body.global === 'boolean' ? body.global : false,
          }),
          ...(mode === 'delay' && {
            delay_ms:
              typeof body.delay_ms === 'number' ? body.delay_ms : undefined,
          }),
        }),
      }
    : undefined
}
