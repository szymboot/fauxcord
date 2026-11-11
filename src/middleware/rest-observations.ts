import type { MiddlewareHandler } from 'hono'
import type { Database } from '../db'
import type { AppEnv } from './auth'
import { resolveRestFaultRequestTarget } from '../services/rest-faults'
import { getRestObservations } from '../services/rest-observations'

/**
 * Counts requests matching an active REST observation and records their final
 * response status. It only reads the request and the finished response, so it
 * never fails, delays or alters anything: mount it before every middleware
 * that can answer a request itself (latency, rate limits, faults, holds) so
 * such requests are counted too.
 */
export function createRestObservationMiddleware(
  db: Database
): MiddlewareHandler<AppEnv> {
  const observations = getRestObservations(db)
  return async (c, next) => {
    if (!observations.hasAny()) {
      await next()
      return
    }
    const bot = c.get('bot')
    const accessToken = c.get('accessToken')
    const target = resolveRestFaultRequestTarget(
      db,
      c.req.method,
      c.req.path,
      bot?.user_id
    )
    const matched = target.forgedInteractionPath
      ? []
      : observations.match({
          method: c.req.method,
          path: target.path,
          interactionOwner: target.interactionOwner,
          botToken: bot?.token,
          clientId: accessToken?.client_id,
        })
    if (matched.length === 0) {
      await next()
      return
    }
    let status = 500
    try {
      await next()
      status = c.res.status
    } finally {
      observations.record(matched, {
        method: c.req.method,
        path: target.path,
        status,
        // Interaction-token routes act on behalf of the owning bot.
        credential: accessToken ? 'bearer' : 'bot',
      })
    }
  }
}
