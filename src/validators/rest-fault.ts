/** Exact request selector and Discord-shaped failure configured by tests. */
export interface RestFaultRequest {
  method: 'DELETE' | 'PUT' | 'PATCH' | 'POST' | 'GET'
  path: string
  /** Cleanup scope and owning bot selector; required only for global user GETs. */
  guild_id?: string
  status: number
  code: number
  message: string
  times: number
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
    /^\/guilds\/\d{1,20}\/(?:audit-logs|members\/\d{1,20})$/.test(body.path)
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
        status: body.status,
        code: body.code,
        message: body.message,
        times,
      }
    : undefined
}
