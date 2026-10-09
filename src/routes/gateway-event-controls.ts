import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isAuditOwnershipKey } from '../validators/audit-log-response'
import {
  CONTROL_EVENTS,
  type EventControlRequest,
  type EventControlOwnership,
  type EventControlSessionScope,
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
    member_id: memberId,
  } = data
  if (
    typeof guildId !== 'string' ||
    typeof botId !== 'string' ||
    (data.ownership_key !== undefined &&
      (sessionId === undefined || !isAuditOwnershipKey(data.ownership_key))) ||
    !/^[1-9]\d{0,19}$/.test(guildId) ||
    !/^[1-9]\d{0,19}$/.test(botId) ||
    (sessionId !== undefined &&
      (typeof sessionId !== 'string' || !/^[\da-f]{32}$/.test(sessionId))) ||
    (memberId !== undefined &&
      (typeof memberId !== 'string' || !/^[1-9]\d{0,19}$/.test(memberId))) ||
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
    new Set(events).size !== events.length ||
    (memberId !== undefined &&
      (events.length !== 1 || events[0] !== 'GUILD_MEMBER_UPDATE'))
  )
    return undefined
  const applicationAck =
    data.application_ack === undefined ? false : data.application_ack
  const hold = data.hold === undefined ? false : data.hold
  const allowOriginalSequence =
    data.allow_original_sequence === undefined
      ? false
      : data.allow_original_sequence
  const limit = data.limit === undefined ? 20 : data.limit
  const ttlMs = data.ttl_ms === undefined ? 30_000 : data.ttl_ms
  return typeof applicationAck !== 'boolean' ||
    typeof hold !== 'boolean' ||
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
        ...(data.ownership_key !== undefined && {
          ownership_key: data.ownership_key,
        }),
        guild_id: guildId,
        bot_id: botId,
        session_id: sessionId,
        events,
        member_id: memberId,
        application_ack: applicationAck,
        hold,
        allow_original_sequence: allowOriginalSequence,
        limit,
        ttl_ms: ttlMs,
      }
}

/** Validates discovery scope without collapsing duplicate query values. */
function validateSessionScope(
  search: URLSearchParams
): EventControlSessionScope | undefined {
  const bot = search.get('bot_id')
  const guild = search.get('guild_id')
  const session = search.get('session_id')
  return bot !== null &&
    guild !== null &&
    search.keys().toArray().length === (session === null ? 2 : 3) &&
    ['bot_id', 'guild_id'].every(
      (field) => search.getAll(field).length === 1
    ) &&
    bot.trim() === bot &&
    /^[1-9]\d{0,19}$/.test(bot) &&
    guild.trim() === guild &&
    /^[1-9]\d{0,19}$/.test(guild) &&
    (session === null ||
      (search.getAll('session_id').length === 1 &&
        session.length === 32 &&
        /^[\da-f]{32}$/.test(session)))
    ? {
        bot_id: bot,
        guild_id: guild,
        ...(session !== null && { session_id: session }),
      }
    : undefined
}

/** Validates an exact key address, requiring the already selected session. */
function validateOwnership(
  key: string,
  search: URLSearchParams
): EventControlOwnership | undefined {
  const scope = validateSessionScope(search)
  return scope?.session_id !== undefined && isAuditOwnershipKey(key)
    ? { ...scope, ownership_key: key, session_id: scope.session_id }
    : undefined
}

/** Mounts unauthenticated Fauxcord-only capture, inspection and delivery controls. */
export function createGatewayEventControlRoutes(
  controls: GatewayEventControls
): Hono {
  const app = new Hono()
  app.use(
    '/_test/gateway-event-controls',
    bodyLimit({
      maxSize: 16_384,
      onError: (c) =>
        c.json({ message: '413: Payload Too Large', code: 0 }, 413),
    })
  )
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
  app.get('/_test/gateway-event-controls/session', (c) => {
    c.header('Cache-Control', 'no-store')
    const scope = validateSessionScope(new URL(c.req.url).searchParams)
    if (!scope) return c.json({ message: '400: Bad Request', code: 0 }, 400)
    const result = controls.inspectSession(scope)
    return typeof result === 'string'
      ? c.json(
          { message: result, code: 0 },
          result === 'UNKNOWN_SCOPE' ? 404 : 409
        )
      : c.json(result)
  })
  app.get('/_test/gateway-event-controls/by-key/:key', (c) => {
    c.header('Cache-Control', 'no-store')
    const scope = validateOwnership(
      c.req.param('key'),
      new URL(c.req.url).searchParams
    )
    if (!scope) return c.json({ message: '400: Bad Request', code: 0 }, 400)
    const result = controls.inspectByKey(scope)
    return result
      ? c.json(result)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })
  app.delete('/_test/gateway-event-controls/by-key/:key', (c) => {
    const scope = validateOwnership(
      c.req.param('key'),
      new URL(c.req.url).searchParams
    )
    if (!scope) return c.json({ message: '400: Bad Request', code: 0 }, 400)
    const result = controls.deleteByKey(scope)
    return result === 'DELETED'
      ? c.body(null, 204)
      : c.json({ message: result, code: 0 }, result === 'LIMIT' ? 429 : 404)
  })
  app.get('/_test/gateway-event-controls/:id', (c) => {
    c.header('Cache-Control', 'no-store')
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
  for (const action of ['disconnect', 'resume', 'ack']) {
    app.post(`/_test/gateway-event-controls/:id/${action}`, async (c) => {
      const raw: unknown = await c.req.json().catch(() => undefined)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return c.json({ message: '400: Bad Request', code: 0 }, 400)
      const body = raw as Record<string, unknown>
      if (
        action === 'ack'
          ? typeof body.delivery_id !== 'string' ||
            !/^[\da-f-]{36}$/.test(body.delivery_id) ||
            typeof body.ack_token !== 'string' ||
            !/^[\da-f-]{36}$/.test(body.ack_token)
          : action === 'resume'
            ? Object.keys(body).length > 0
            : Object.keys(body).some((key) => key !== 'pause_resume') ||
              (body.pause_resume !== undefined &&
                typeof body.pause_resume !== 'boolean')
      )
        return c.json({ message: '400: Bad Request', code: 0 }, 400)
      const result =
        action === 'disconnect'
          ? controls.disconnect(c.req.param('id'), body.pause_resume === true)
          : action === 'resume'
            ? controls.resume(c.req.param('id'))
            : controls.acknowledge(
                c.req.param('id'),
                String(body.delivery_id),
                String(body.ack_token)
              )
      return typeof result === 'string'
        ? c.json(
            { message: result, code: 0 },
            result === 'LIMIT' ? 429 : result === 'INVALID_STATE' ? 409 : 404
          )
        : c.json(result)
    })
  }
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
