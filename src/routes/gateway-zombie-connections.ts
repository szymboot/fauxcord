import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isAuditOwnershipKey } from '../validators/audit-log-response'
import type {
  GatewayZombieConnections,
  ZombieConnectionRequest,
} from '../gateway/zombie-connections'
import {
  validateOwnership,
  validateWait,
} from './gateway-session-invalidations'

const ROOT = '/_test/gateway-zombie-connections'
/** Positive snowflake of 1-20 digits, without padding. */
const SNOWFLAKE = /^[1-9]\d{0,19}$/
/** Gateway session IDs are 32 lowercase hexadecimal characters. */
const SESSION_ID = /^[\da-f]{32}$/
/** Default and maximum zombie (and reconnect hold) duration in milliseconds. */
const DEFAULT_TTL_MS = 180_000
const MAX_TTL_MS = 300_000

/**
 * Whether a value is an accepted duration in milliseconds.
 * @param value - Candidate duration
 * @returns true for integers from 1 to MAX_TTL_MS
 */
function isDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_TTL_MS
  )
}

/**
 * Validates a zombie request; unknown fields are rejected.
 * @param value - Parsed JSON body
 * @returns The request, or undefined when invalid
 */
function validateRequest(value: unknown): ZombieConnectionRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const data = value as Record<string, unknown>
  const allowed = new Set([
    'ownership_key',
    'bot_id',
    'guild_id',
    'session_id',
    'ttl_ms',
    'hold_reconnect',
    'reconnect_hold_ttl_ms',
  ])
  if (Object.keys(data).some((key) => !allowed.has(key))) return undefined
  const ttlMs = data.ttl_ms === undefined ? DEFAULT_TTL_MS : data.ttl_ms
  const hold = data.hold_reconnect === undefined ? false : data.hold_reconnect
  // The hold TTL only means something with an opted-in hold.
  const holdMs =
    hold === true && data.reconnect_hold_ttl_ms === undefined
      ? DEFAULT_TTL_MS
      : data.reconnect_hold_ttl_ms
  const {
    ownership_key: key,
    bot_id: botId,
    guild_id: guildId,
    session_id: sessionId,
  } = data
  return typeof botId === 'string' &&
    typeof guildId === 'string' &&
    typeof sessionId === 'string' &&
    typeof hold === 'boolean' &&
    isDuration(ttlMs) &&
    (hold ? isDuration(holdMs) : holdMs === undefined) &&
    SNOWFLAKE.test(botId) &&
    SNOWFLAKE.test(guildId) &&
    SESSION_ID.test(sessionId) &&
    (key === undefined || isAuditOwnershipKey(key))
    ? {
        ...(key !== undefined && { ownership_key: key }),
        bot_id: botId,
        guild_id: guildId,
        session_id: sessionId,
        ttl_ms: ttlMs,
        hold_reconnect: hold,
        reconnect_hold_ttl_ms: hold && isDuration(holdMs) ? holdMs : null,
      }
    : undefined
}

/**
 * Whether a body is exactly the empty JSON object.
 * @param value - Parsed JSON body
 * @returns true for `{}`
 */
function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

/** Builds a Fauxcord-style control error body. */
const failure = (message: string) => ({ message, code: 0 })

/**
 * Maps a control error code to its HTTP status.
 * @param code - Control error code
 * @returns HTTP status
 */
function statusOf(code: string): 404 | 409 | 429 {
  return code === 'UNKNOWN_SCOPE' ? 404 : code === 'LIMIT' ? 429 : 409
}

/**
 * Mounts unauthenticated Fauxcord-only zombie connection controls.
 * @param zombies - Zombie connection controls of this Gateway
 * @returns Hono routes
 */
export function createGatewayZombieConnectionRoutes(
  zombies: GatewayZombieConnections
): Hono {
  const app = new Hono()
  app.use(
    `${ROOT}/*`,
    bodyLimit({
      maxSize: 16_384,
      onError: (c) => c.json(failure('413: Payload Too Large'), 413),
    })
  )
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
    const result = zombies.create(request)
    return typeof result === 'string'
      ? c.json(failure(result), statusOf(result))
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
    const result = await zombies.wait(zombies.idByKey(scope), scope.wait_ms)
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
    const result = zombies.deleteByKey(scope)
    return result === 'DELETED'
      ? c.body(null, 204)
      : c.json(failure(result), result === 'LIMIT' ? 429 : 404)
  })
  app.post(`${ROOT}/by-key/:key/release-reconnect`, async (c) => {
    const scope = validateOwnership(
      c.req.param('key'),
      new URL(c.req.url).searchParams,
      false
    )
    if (!scope || !isEmptyObject(await c.req.json().catch(() => undefined)))
      return c.json(failure('400: Bad Request'), 400)
    const result = zombies.releaseReconnect(zombies.idByKey(scope))
    return typeof result === 'string'
      ? c.json(failure(result), statusOf(result))
      : c.json(result)
  })
  app.post(`${ROOT}/:id/release-reconnect`, async (c) => {
    if (!isEmptyObject(await c.req.json().catch(() => undefined)))
      return c.json(failure('400: Bad Request'), 400)
    const result = zombies.releaseReconnect(c.req.param('id'))
    return typeof result === 'string'
      ? c.json(failure(result), statusOf(result))
      : c.json(result)
  })
  app.post(`${ROOT}/:id/end`, async (c) => {
    if (!isEmptyObject(await c.req.json().catch(() => undefined)))
      return c.json(failure('400: Bad Request'), 400)
    const result = zombies.end(c.req.param('id'))
    return typeof result === 'string'
      ? c.json(failure(result), statusOf(result))
      : c.json(result)
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
    const result = await zombies.wait(c.req.param('id'), waitMs)
    if (result === 'LIMIT') return c.json(failure('LIMIT'), 429)
    return result ? c.json(result) : c.json(failure('404: Not Found'), 404)
  })
  app.delete(`${ROOT}/:id`, (c) =>
    zombies.delete(c.req.param('id'))
      ? c.body(null, 204)
      : c.json(failure('404: Not Found'), 404)
  )
  return app
}
