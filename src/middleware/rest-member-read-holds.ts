import type { MiddlewareHandler } from 'hono'
import type { Database } from '../db'
import type { AppEnv } from './auth'
import { getRestMemberReadHolds } from '../services/rest-member-read-holds'

/**
 * Holds the next selected `GET /guilds/{id}/members/{id}` after the native
 * handler computed its response, then returns that snapshot unchanged. Mount
 * it after the REST-fault middleware so a matching fault pre-empts the hold.
 * @param db - Database
 * @returns Hono middleware, mounted after authentication
 */
export function createRestMemberReadHoldMiddleware(
  db: Database
): MiddlewareHandler<AppEnv> {
  const holds = getRestMemberReadHolds(db)
  return async (c, next) => {
    if (c.req.method !== 'GET') return next()
    const match = /^\/guilds\/(\d{1,20})\/members\/(\d{1,20})$/.exec(
      c.req.path.replace(/^\/api(?:\/v10)?(?=\/)/, '')
    )
    if (!match) return next()
    const signal = c.req.raw.signal
    const claim = holds.claim(match[1], match[2], c.get('bot')?.token, signal)
    if (!claim) return next()
    let snapshot: { status: number; headers: Headers; body: ArrayBuffer | null }
    try {
      await next()
      const native = c.res
      snapshot = {
        status: native.status,
        headers: new Headers(native.headers),
        body: native.body === null ? null : await native.arrayBuffer(),
      }
    } catch (error) {
      holds.abandon(claim)
      throw error
    }
    await holds.hold(claim, snapshot.status, signal)
    if (signal.aborted) return c.body(null, 204)
    c.res = new Response(snapshot.body, {
      status: snapshot.status,
      headers: snapshot.headers,
    })
  }
}
