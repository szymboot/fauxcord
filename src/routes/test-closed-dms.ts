import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import {
  createClosedDm,
  getClosedDm,
  deleteClosedDm,
} from '../services/closed-dms'
import { validateClosedDm, type ClosedDmRequest } from '../validators/closed-dm'

/** Exposes immediate create, inspect and remove controls for closed human DMs. */
export function createClosedDmRoutes(db: Database): Hono {
  const app = new Hono()
  app.post('/_test/closed-dms', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined)
    const errors = validateClosedDm(body)
    if (Object.keys(errors).length > 0)
      return c.json(validationError(errors).body, 400)
    const result = createClosedDm(db, body as ClosedDmRequest)
    if (result === 'UNKNOWN_GUILD')
      return c.json(
        discordError(DiscordErrorCode.UNKNOWN_GUILD, 'Unknown Guild', 404).body,
        404
      )
    if (result === 'UNKNOWN_USER')
      return c.json(
        discordError(DiscordErrorCode.UNKNOWN_USER, 'Unknown User', 404).body,
        404
      )
    return result === 'BOT_RECIPIENT'
      ? c.json(
          validationError({
            user_id: {
              _errors: [
                {
                  code: 'INVALID_RECIPIENT',
                  message: 'Recipient must be a non-bot user.',
                },
              ],
            },
          }).body,
          400
        )
      : c.json(result, 201)
  })
  app.get('/_test/closed-dms/:id', (c) => {
    c.header('Cache-Control', 'no-store')
    const fixture = getClosedDm(db, c.req.param('id'))
    return fixture
      ? c.json(fixture)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })
  app.delete('/_test/closed-dms/:id', (c) => {
    return deleteClosedDm(db, c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })
  return app
}
