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
  const times = body.times === undefined ? 1 : body.times
  if (
    typeof times !== 'number' ||
    times < 1 ||
    times > 100 ||
    !Number.isSafeInteger(times) ||
    typeof body.path !== 'string' ||
    typeof body.status !== 'number' ||
    body.status < 400 ||
    body.status > 599 ||
    !Number.isSafeInteger(body.status) ||
    typeof body.code !== 'number' ||
    body.code < 0 ||
    !Number.isSafeInteger(body.code) ||
    typeof body.message !== 'string' ||
    body.message.length === 0 ||
    body.message.length > 1000
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
        status: body.status,
        code: body.code,
        message: body.message,
        times,
      }
    : undefined
}
