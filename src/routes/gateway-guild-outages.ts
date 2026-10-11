import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isAuditOwnershipKey } from '../validators/audit-log-response'
import type {
  GatewayGuildOutages,
  GuildOutageOwnership,
  GuildOutageRequest,
} from '../gateway/guild-outages'

const ROOT = '/_test/gateway-guild-outages'
/** Positive snowflake of 1-20 digits, without padding. */
const SNOWFLAKE = /^[1-9]\d{0,19}$/
/** Default and maximum outage duration in milliseconds. */
const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 600_000
/** Maximum long-poll duration in milliseconds. */
const MAX_WAIT_MS = 30_000

/** Validates an outage request; unknown fields are rejected. */
function validateRequest(value: unknown): GuildOutageRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const data = value as Record<string, unknown>
  const allowed = new Set([
    'ownership_key',
    'bot_id',
    'guild_id',
    'ttl_ms',
    'identify_dispatch',
  ])
  if (Object.keys(data).some((key) => !allowed.has(key))) return undefined
  const ttlMs = data.ttl_ms === undefined ? DEFAULT_TTL_MS : data.ttl_ms
  const identifyDispatch =
    data.identify_dispatch === undefined
      ? 'guild_delete'
      : data.identify_dispatch
  const { ownership_key: key, bot_id: botId, guild_id: guildId } = data
  return typeof botId === 'string' &&
    typeof guildId === 'string' &&
    typeof ttlMs === 'number' &&
    Number.isSafeInteger(ttlMs) &&
    ttlMs >= 1 &&
    ttlMs <= MAX_TTL_MS &&
    SNOWFLAKE.test(botId) &&
    SNOWFLAKE.test(guildId) &&
    (key === undefined || isAuditOwnershipKey(key)) &&
    (identifyDispatch === 'guild_delete' || identifyDispatch === 'guild_create')
    ? {
        ...(key !== undefined && { ownership_key: key }),
        bot_id: botId,
        guild_id: guildId,
        ttl_ms: ttlMs,
        identify_dispatch: identifyDispatch,
      }
    : undefined
}

/**
 * Validates `wait_ms` when allowed; returns 0 when omitted.
 * @param search - Request query
 * @param allowWait - Whether `wait_ms` may be supplied
 * @returns The wait duration, or undefined when invalid
 */
function validateWait(
  search: URLSearchParams,
  allowWait: boolean
): number | undefined {
  const values = search.getAll('wait_ms')
  if (values.length === 0) return 0
  const [raw] = values
  if (!allowWait || !raw || values.length !== 1 || !/^\d{1,5}$/.test(raw))
    return undefined
  const waitMs = Number.parseInt(raw, 10)
  return waitMs <= MAX_WAIT_MS ? waitMs : undefined
}

/** Validates an exact key address; each scope field must appear exactly once. */
function validateOwnership(
  key: string,
  search: URLSearchParams,
  allowWait: boolean
): (GuildOutageOwnership & { wait_ms: number }) | undefined {
  const fields = ['bot_id', 'guild_id']
  const waitMs = validateWait(search, allowWait)
  if (
    waitMs === undefined ||
    !isAuditOwnershipKey(key) ||
    search
      .keys()
      .some((name) => !fields.includes(name) && name !== 'wait_ms') ||
    fields.some((field) => search.getAll(field).length !== 1)
  )
    return undefined
  const bot = search.get('bot_id') ?? ''
  const guild = search.get('guild_id') ?? ''
  return SNOWFLAKE.test(bot) && SNOWFLAKE.test(guild)
    ? { ownership_key: key, bot_id: bot, guild_id: guild, wait_ms: waitMs }
    : undefined
}

/** Whether a query carries no parameters at all. */
function emptyQuery(url: string): boolean {
  return new URL(url).searchParams.size === 0
}

/** Builds a Fauxcord-style control error body. */
const failure = (message: string) => ({ message, code: 0 })

/** Mounts unauthenticated Fauxcord-only guild outage controls. */
export function createGatewayGuildOutageRoutes(
  outages: GatewayGuildOutages
): Hono {
  const app = new Hono()
  app.use(
    ROOT,
    bodyLimit({
      maxSize: 16_384,
      onError: (c) => c.json(failure('413: Payload Too Large'), 413),
    })
  )
  app.post(ROOT, async (c) => {
    const request = validateRequest(await c.req.json().catch(() => undefined))
    if (!request) return c.json(failure('400: Bad Request'), 400)
    const result = outages.create(request)
    return typeof result === 'string'
      ? c.json(
          failure(result),
          result === 'UNKNOWN_SCOPE' ? 404 : result === 'LIMIT' ? 429 : 409
        )
      : c.json(result, 201)
  })
  app.get(`${ROOT}/by-key/:key`, async (c) => {
    c.header('Cache-Control', 'no-store')
    const scope = validateOwnership(
      c.req.param('key'),
      new URL(c.req.url).searchParams,
      true
    )
    if (!scope) return c.json(failure('400: Bad Request'), 400)
    const result = await outages.wait(outages.idByKey(scope), scope.wait_ms)
    if (result === 'LIMIT') return c.json(failure('LIMIT'), 429)
    return result ? c.json(result) : c.json(failure('404: Not Found'), 404)
  })
  app.post(`${ROOT}/by-key/:key/end`, (c) => {
    const scope = validateOwnership(
      c.req.param('key'),
      new URL(c.req.url).searchParams,
      false
    )
    if (!scope) return c.json(failure('400: Bad Request'), 400)
    const result = outages.endByKey(scope)
    return result ? c.json(result) : c.json(failure('404: Not Found'), 404)
  })
  app.delete(`${ROOT}/by-key/:key`, (c) => {
    const scope = validateOwnership(
      c.req.param('key'),
      new URL(c.req.url).searchParams,
      false
    )
    if (!scope) return c.json(failure('400: Bad Request'), 400)
    const result = outages.deleteByKey(scope)
    return result === 'DELETED'
      ? c.body(null, 204)
      : c.json(failure(result), result === 'LIMIT' ? 429 : 404)
  })
  app.get(`${ROOT}/:id`, async (c) => {
    c.header('Cache-Control', 'no-store')
    const search = new URL(c.req.url).searchParams
    const waitMs = validateWait(search, true)
    if (
      waitMs === undefined ||
      search.keys().some((name) => name !== 'wait_ms')
    )
      return c.json(failure('400: Bad Request'), 400)
    const result = await outages.wait(c.req.param('id'), waitMs)
    if (result === 'LIMIT') return c.json(failure('LIMIT'), 429)
    return result ? c.json(result) : c.json(failure('404: Not Found'), 404)
  })
  app.post(`${ROOT}/:id/end`, (c) => {
    if (!emptyQuery(c.req.url)) return c.json(failure('400: Bad Request'), 400)
    const result = outages.end(c.req.param('id'))
    return result ? c.json(result) : c.json(failure('404: Not Found'), 404)
  })
  app.delete(`${ROOT}/:id`, (c) =>
    outages.delete(c.req.param('id'))
      ? c.body(null, 204)
      : c.json(failure('404: Not Found'), 404)
  )
  return app
}
