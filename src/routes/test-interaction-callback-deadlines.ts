import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import {
  createInteractionCallbackDeadline,
  deleteInteractionCallbackDeadline,
  getInteractionCallbackDeadline,
} from '../services/interaction-callback-deadlines'
import {
  validateInteractionCallbackDeadline,
  type InteractionCallbackDeadlineRequest,
} from '../validators/interaction-callback-deadline'

/**
 * Exposes arm, inspect and disarm controls for the opt-in 3-second initial
 * interaction callback deadline of a guild.
 * @param db - Database
 * @returns Hono router instance
 */
export function createInteractionCallbackDeadlineRoutes(db: Database): Hono {
  const app = new Hono()
  app.post('/_test/interaction-callback-deadlines', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined)
    const errors = validateInteractionCallbackDeadline(body)
    if (Object.keys(errors).length > 0)
      return c.json(validationError(errors).body, 400)
    const result = createInteractionCallbackDeadline(
      db,
      body as InteractionCallbackDeadlineRequest
    )
    if (result === 'UNKNOWN_GUILD')
      return c.json(
        discordError(DiscordErrorCode.UNKNOWN_GUILD, 'Unknown Guild', 404).body,
        404
      )
    return result === 'DUPLICATE'
      ? c.json({ message: '409: Conflict', code: 0 }, 409)
      : c.json(result, 201)
  })
  app.get('/_test/interaction-callback-deadlines/:id', (c) => {
    c.header('Cache-Control', 'no-store')
    const control = getInteractionCallbackDeadline(db, c.req.param('id'))
    return control
      ? c.json(control)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })
  app.delete('/_test/interaction-callback-deadlines/:id', (c) =>
    deleteInteractionCallbackDeadline(db, c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  )
  return app
}
