import type { MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Database } from '../db'
import { consumeRestFault } from '../services/rest-faults'

/** Intercepts configured authenticated requests before their route can mutate state. */
export function createRestFaultMiddleware(db: Database): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path.replace(/^\/api(?:\/v10)?(?=\/)/, '')
    const fault = consumeRestFault(db, c.req.method, path)
    if (fault) {
      return c.json(
        { message: fault.message, code: fault.code },
        fault.status as ContentfulStatusCode
      )
    }
    await next()
  }
}
