import type { MiddlewareHandler } from 'hono'
import type { Database } from '../db'
import type { AppEnv } from './auth'
import {
  readRestFaultMessageIds,
  resolveRestFaultRequestTarget,
} from '../services/rest-faults'
import { getRestObservations } from '../services/rest-observations'

/**
 * Counts requests matching an active REST observation and records their final
 * response status. It only reads the request and the finished response, so it
 * never fails, delays or alters the processing of a request: mount it before
 * every middleware that can answer a request itself (latency, rate limits,
 * faults, holds) so such requests are counted too.
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
    const candidates = target.forgedInteractionPath
      ? []
      : observations.match({
          method: c.req.method,
          path: target.path,
          interactionOwner: target.interactionOwner,
          botToken: bot?.token,
          clientId: accessToken?.client_id,
        })
    if (candidates.length === 0) {
      await next()
      return
    }
    // Narrowed candidates need the body, copied before the route consumes it.
    // It is awaited only after the request has been processed: waiting first
    // would change which faults are still active when the request is matched.
    const listed = candidates.some((entry) => entry.messageId !== undefined)
      ? readRestFaultMessageIds(c.req.raw)
      : undefined
    if (listed) c.set('pendingBodyRead', listed)
    let status = 500
    try {
      await next()
      status = c.res.status
    } finally {
      const request = {
        method: c.req.method,
        path: target.path,
        status,
        // Interaction-token routes act on behalf of the owning bot.
        credential: accessToken ? ('bearer' as const) : ('bot' as const),
      }
      observations.record(
        candidates.filter((entry) => entry.messageId === undefined),
        request
      )
      if (listed) {
        const messageIds = (await listed) ?? []
        observations.record(
          candidates.filter(
            (entry) =>
              entry.messageId !== undefined &&
              messageIds.includes(entry.messageId)
          ),
          request
        )
      }
    }
  }
}
