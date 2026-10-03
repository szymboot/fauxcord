/**
 * Interactions API routing
 *
 * Implements POST /interactions/:id/:token/callback (the initial response
 * to an interaction). This endpoint requires no Bot/Bearer authentication —
 * the interaction token itself is the credential, matching real Discord.
 */

import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import { handleInteractionCallback } from '../services/interactions'
import type { InteractionCallbackPayload } from '../services/interactions'
import { validateInteractionCallback } from '../validators/interaction'

/**
 * Creates the Interactions API routes.
 * @param db - Database
 * @param baseUrl - Base URL
 * @returns Hono router instance
 */
export function createInteractionRoutes(db: Database, baseUrl: string): Hono {
  const app = new Hono()

  // POST /interactions/:interactionId/:interactionToken/callback
  app.post(
    '/interactions/:interactionId/:interactionToken/callback',
    async (c) => {
      const { interactionId, interactionToken } = c.req.param()
      const payload: unknown = await c.req.json().catch(() => null)
      const errors = validateInteractionCallback(payload)
      if (Object.keys(errors).length > 0) {
        return c.json(validationError(errors).body, 400)
      }

      const result = handleInteractionCallback(
        db,
        interactionId,
        interactionToken,
        payload as InteractionCallbackPayload,
        baseUrl
      )

      if (!result.ok) {
        if (result.reason === 'not_found') {
          const err = discordError(
            DiscordErrorCode.UNKNOWN_INTERACTION,
            'Unknown Interaction',
            404
          )
          return c.json(err.body, 404)
        }
        const err = discordError(
          DiscordErrorCode.INTERACTION_ALREADY_ACKNOWLEDGED,
          'Interaction has already been acknowledged',
          400
        )
        return c.json(err.body, 400)
      }

      return c.req.query('with_response') === 'true'
        ? c.json(result.response)
        : c.body(null, 204)
    }
  )

  return app
}
