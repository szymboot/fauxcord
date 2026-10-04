import { Hono } from 'hono'
import {
  CONTROL_EVENTS,
  type EventControlRequest,
  type GatewayEventControls,
} from '../gateway/event-controls'

/** Validates exact numeric scope IDs and the bounded capture policy. */
function validateControl(value: unknown): EventControlRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const data = value as Record<string, unknown>
  const {
    guild_id: guildId,
    bot_id: botId,
    session_id: sessionId,
    events,
  } = data
  if (
    typeof guildId !== 'string' ||
    typeof botId !== 'string' ||
    typeof sessionId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(guildId) ||
    !/^[1-9]\d{0,19}$/.test(botId) ||
    !/^[\da-f]{32}$/.test(sessionId) ||
    !Array.isArray(events) ||
    events.length === 0 ||
    events.length > CONTROL_EVENTS.length ||
    events.some(
      (event: unknown) =>
        !(
          typeof event === 'string' &&
          CONTROL_EVENTS.includes(event as (typeof CONTROL_EVENTS)[number])
        )
    ) ||
    new Set(events).size !== events.length
  )
    return undefined
  const hold = data.hold === undefined ? false : data.hold
  const allowOriginalSequence =
    data.allow_original_sequence === undefined
      ? false
      : data.allow_original_sequence
  const limit = data.limit === undefined ? 20 : data.limit
  const ttlMs = data.ttl_ms === undefined ? 30_000 : data.ttl_ms
  return typeof hold !== 'boolean' ||
    typeof allowOriginalSequence !== 'boolean' ||
    typeof limit !== 'number' ||
    typeof ttlMs !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 60_000
    ? undefined
    : {
        guild_id: guildId,
        bot_id: botId,
        session_id: sessionId,
        events,
        hold,
        allow_original_sequence: allowOriginalSequence,
        limit,
        ttl_ms: ttlMs,
      }
}

/** Mounts unauthenticated Fauxcord-only capture, inspection and delivery controls. */
export function createGatewayEventControlRoutes(
  controls: GatewayEventControls
): Hono {
  const app = new Hono()
  app.post('/_test/gateway-event-controls', async (c) => {
    const request = validateControl(await c.req.json().catch(() => undefined))
    if (!request) return c.json({ message: '400: Bad Request', code: 0 }, 400)
    const result = controls.create(request)
    return typeof result === 'string'
      ? c.json(
          { message: result, code: 0 },
          result === 'UNKNOWN_SCOPE' ? 404 : result === 'LIMIT' ? 429 : 409
        )
      : c.json(result, 201)
  })
  app.get('/_test/gateway-event-controls/:id', (c) => {
    const result = controls.inspect(c.req.param('id'))
    return result
      ? c.json(result)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })
  app.delete('/_test/gateway-event-controls/:id', (c) =>
    controls.delete(c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  )
  for (const action of ['release', 'replay']) {
    app.post(`/_test/gateway-event-controls/:id/${action}`, async (c) => {
      const raw: unknown = await c.req.json().catch(() => undefined)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return c.json({ message: '400: Bad Request', code: 0 }, 400)
      const body = raw as Record<string, unknown>
      const ids = body.event_ids
      const mode = body.sequence === undefined ? 'new' : body.sequence
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 100 ||
        (action === 'replay' && ids.length !== 1) ||
        ids.some(
          (id: unknown) =>
            !(typeof id === 'string' && /^[\da-f-]{36}$/.test(id))
        ) ||
        new Set(ids).size !== ids.length ||
        (mode !== 'new' && mode !== 'original')
      )
        return c.json({ message: '400: Bad Request', code: 0 }, 400)
      const result = controls.deliver(
        c.req.param('id'),
        ids,
        action === 'replay',
        mode === 'original'
      )
      return typeof result === 'string'
        ? c.json(
            { message: result, code: 0 },
            result === 'LIMIT' ? 429 : result === 'INVALID_STATE' ? 409 : 404
          )
        : c.json(result)
    })
  }
  return app
}
