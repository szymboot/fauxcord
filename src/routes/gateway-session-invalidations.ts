import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isAuditOwnershipKey } from '../validators/audit-log-response'
import type {
  GatewaySessionInvalidations,
  SessionInvalidationOwnership,
  SessionInvalidationRequest,
} from '../gateway/session-invalidations'

const ROOT = '/_test/gateway-session-invalidations'
/** Positive snowflake of 1-20 digits, without padding. */
const SNOWFLAKE = /^[1-9]\d{0,19}$/
/** Gateway session IDs are 32 lowercase hexadecimal characters. */
const SESSION_ID = /^[\da-f]{32}$/
/** Default and maximum observation lifetime in milliseconds. */
const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 120_000
/** Maximum long-poll duration in milliseconds. */
const MAX_WAIT_MS = 30_000

/** Validates an exact keyed invalidation request; unknown fields are rejected. */
function validateRequest(
  value: unknown
): SessionInvalidationRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const data = value as Record<string, unknown>
  const allowed = new Set([
    'ownership_key',
    'bot_id',
    'guild_id',
    'session_id',
    'ttl_ms',
  ])
  if (Object.keys(data).some((key) => !allowed.has(key))) return undefined
  const ttlMs = data.ttl_ms === undefined ? DEFAULT_TTL_MS : data.ttl_ms
  const {
    ownership_key: key,
    bot_id: botId,
    guild_id: guildId,
    session_id: sessionId,
  } = data
  return typeof botId === 'string' &&
    typeof guildId === 'string' &&
    typeof sessionId === 'string' &&
    typeof ttlMs === 'number' &&
    ttlMs >= 1 &&
    ttlMs <= MAX_TTL_MS &&
    Number.isSafeInteger(ttlMs) &&
    SNOWFLAKE.test(botId) &&
    SNOWFLAKE.test(guildId) &&
    SESSION_ID.test(sessionId) &&
    isAuditOwnershipKey(key)
    ? {
        ownership_key: key,
        bot_id: botId,
        guild_id: guildId,
        session_id: sessionId,
        ttl_ms: ttlMs,
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
): (SessionInvalidationOwnership & { wait_ms: number }) | undefined {
  const fields = ['bot_id', 'guild_id', 'session_id']
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
  const session = search.get('session_id') ?? ''
  return SNOWFLAKE.test(bot) &&
    SNOWFLAKE.test(guild) &&
    SESSION_ID.test(session)
    ? {
        ownership_key: key,
        bot_id: bot,
        guild_id: guild,
        session_id: session,
        wait_ms: waitMs,
      }
    : undefined
}

/** Builds a Fauxcord-style control error body. */
const failure = (message: string) => ({ message, code: 0 })

/** Mounts unauthenticated Fauxcord-only forced re-IDENTIFY controls. */
export function createGatewaySessionInvalidationRoutes(
  invalidations: GatewaySessionInvalidations
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
    const result = invalidations.create(request)
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
    const result = await invalidations.wait(
      invalidations.idByKey(scope),
      scope.wait_ms
    )
    if (result === 'LIMIT') return c.json(failure('LIMIT'), 429)
    return result ? c.json(result) : c.json(failure('404: Not Found'), 404)
  })
  app.delete(`${ROOT}/by-key/:key`, (c) => {
    const scope = validateOwnership(
      c.req.param('key'),
      new URL(c.req.url).searchParams,
      false
    )
    if (!scope) return c.json(failure('400: Bad Request'), 400)
    const result = invalidations.deleteByKey(scope)
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
    const result = await invalidations.wait(c.req.param('id'), waitMs)
    if (result === 'LIMIT') return c.json(failure('LIMIT'), 429)
    return result ? c.json(result) : c.json(failure('404: Not Found'), 404)
  })
  app.delete(`${ROOT}/:id`, (c) =>
    invalidations.delete(c.req.param('id'))
      ? c.body(null, 204)
      : c.json(failure('404: Not Found'), 404)
  )
  return app
}
