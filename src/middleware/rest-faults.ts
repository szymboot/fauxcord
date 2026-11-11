import type { HttpBindings } from '@hono/node-server'
import type { MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Database } from '../db'
import type { AppEnv } from './auth'
import { isRestFaultApplicationScoped } from '../validators/rest-fault'
import {
  consumeRestFault,
  getRestFaultRuntime,
  resolveRestFaultRequestTarget,
} from '../services/rest-faults'

/**
 * Intercepts configured requests before their route can mutate state. Bot
 * routes use the calling bot; token-authorized interaction routes (outside
 * bot auth) use the bot owning the stored interaction, so they pass through
 * unchanged unless a control is armed for that exact interaction.
 * Application-scoped selectors (guild application commands and permissions,
 * guild roles) are also consumed by OAuth2 Bearer callers whose client is the
 * guild's owning application.
 */
export function createRestFaultMiddleware(
  db: Database
): MiddlewareHandler<AppEnv> {
  const runtime = getRestFaultRuntime(db)
  return async (c, next) => {
    const bot = c.get('bot')
    const target = resolveRestFaultRequestTarget(
      db,
      c.req.method,
      c.req.path,
      bot?.user_id
    )
    if (target.forgedInteractionPath) {
      await next()
      return
    }
    const { path } = target
    let recipientId: string | undefined
    if (path === '/users/@me/channels' && c.req.method === 'POST') {
      const payload: unknown = await c.req.raw
        .clone()
        .json()
        .catch(() => undefined)
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'recipient_id' in payload &&
        typeof payload.recipient_id === 'string'
      )
        recipientId = payload.recipient_id
    }
    const fault = consumeRestFault(
      db,
      c.req.method,
      path,
      target.interactionOwner ?? bot?.token,
      new URL(c.req.url).searchParams,
      recipientId,
      // Bearer callers never set `bot`; application-scoped selectors also
      // match the OAuth2 client (application) of the access token.
      isRestFaultApplicationScoped(c.req.method, path)
        ? c.get('accessToken')?.client_id
        : undefined
    )
    if (fault) {
      if (fault.mode === 'rate_limit') {
        const retry = fault.retry_after ?? 1
        c.header('Retry-After', String(Math.ceil(retry)))
        c.header('X-RateLimit-Limit', '1')
        c.header('X-RateLimit-Remaining', '0')
        c.header('X-RateLimit-Reset', String(Date.now() / 1000 + retry))
        c.header('X-RateLimit-Reset-After', String(retry))
        c.header('X-RateLimit-Bucket', `fault-${fault.id}`)
        c.header('X-RateLimit-Scope', fault.global ? 'global' : 'user')
        if (fault.global) c.header('X-RateLimit-Global', 'true')
        runtime.record(fault.id, { responded: 1 })
        return c.json(
          {
            message: fault.message,
            retry_after: retry,
            global: fault.global ?? false,
          },
          429
        )
      }
      if (fault.mode === 'disconnect') {
        const bindings = c.env as Partial<HttpBindings> | undefined
        if (!bindings?.incoming?.socket) {
          runtime.record(fault.id, { cancelled: 1 })
          return c.json(
            {
              message: 'Disconnect faults require a real Node HTTP server',
              code: 0,
            },
            501
          )
        }
        runtime.record(fault.id, { disconnected: 1 })
        bindings.incoming.socket.destroy()
        return c.body(null, 204)
      }
      if (fault.mode === 'delay') {
        await runtime.delay(fault, c.req.raw.signal)
        if (c.req.raw.signal.aborted) return c.body(null, 204)
      }
      return c.json(
        { message: fault.message, code: fault.code },
        fault.status as ContentfulStatusCode
      )
    }
    await next()
  }
}
