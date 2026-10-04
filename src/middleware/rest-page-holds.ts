import type { MiddlewareHandler } from 'hono'
import type { Database } from '../db'
import type { AppEnv } from './auth'
import { getRestPageHolds } from '../services/rest-page-holds'

/** Delays selected authenticated pagination GETs before the native handler. */
export function createRestPageHoldMiddleware(
  db: Database
): MiddlewareHandler<AppEnv> {
  const holds = getRestPageHolds(db)
  return async (c, next) => {
    const path = c.req.path.replace(/^\/api(?:\/v10)?(?=\/)/, '')
    if (
      c.req.method === 'GET' &&
      /^\/guilds\/\d{1,20}\/(?:members|bans)$/.test(path)
    ) {
      await holds.wait(
        path,
        new URL(c.req.url).searchParams,
        c.get('bot')?.token,
        c.req.raw.signal
      )
      if (c.req.raw.signal.aborted) return c.body(null, 204)
    }
    await next()
  }
}
