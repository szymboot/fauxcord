import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Database } from '../db'
import { validateAuditLogResponse } from '../validators/audit-log-response'
import {
  createAuditLogResponse,
  getAuditLogResponse,
  deleteAuditLogResponse,
} from '../services/audit-log-responses'

/** Creates bounded audit-only response controls outside Discord's fixture API. */
export function createAuditLogResponseRoutes(db: Database): Hono {
  const app = new Hono()
  app.post(
    '/_test/audit-log-responses',
    bodyLimit({
      maxSize: 65_536,
      onError: (c) =>
        c.json({ message: '413: Payload Too Large', code: 0 }, 413),
    }),
    async (c) => {
      const payload = validateAuditLogResponse(
        await c.req.json<unknown>().catch(() => undefined)
      )
      if (!payload) return c.json({ message: '400: Bad Request', code: 0 }, 400)
      const result = createAuditLogResponse(db, payload)
      if (result === 'UNKNOWN_SCOPE')
        return c.json({ message: '404: Not Found', code: 0 }, 404)
      return result === 'CONFLICT'
        ? c.json({ message: '409: Conflict', code: 0 }, 409)
        : c.json(result, 201)
    }
  )
  app.get('/_test/audit-log-responses/:id', (c) => {
    c.header('Cache-Control', 'no-store')
    const result = getAuditLogResponse(db, c.req.param('id'))
    return result
      ? c.json(result)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })
  app.delete('/_test/audit-log-responses/:id', (c) => {
    return deleteAuditLogResponse(db, c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })
  return app
}
