import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import { lookupDmChannel, openDmChannel } from '../services/dm-channels'
import {
  validateDmChannelRequest,
  type DmChannelRequest,
} from '../validators/dm-channel'

/**
 * Builds the Discord-format response for a rejected DM channel target.
 * @param error - Target rejection from the DM channel service
 * @returns Status and body to send
 */
function targetError(
  error: 'UNKNOWN_GUILD' | 'UNKNOWN_USER' | 'BOT_RECIPIENT'
): {
  status: 400 | 404
  body: object
} {
  if (error === 'UNKNOWN_GUILD')
    return {
      status: 404,
      body: discordError(DiscordErrorCode.UNKNOWN_GUILD, 'Unknown Guild', 404)
        .body,
    }
  return error === 'UNKNOWN_USER'
    ? {
        status: 404,
        body: discordError(DiscordErrorCode.UNKNOWN_USER, 'Unknown User', 404)
          .body,
      }
    : {
        status: 400,
        body: validationError({
          user_id: {
            _errors: [
              {
                code: 'INVALID_RECIPIENT',
                message: 'Recipient must be a non-bot user.',
              },
            ],
          },
        }).body,
      }
}

/** Exposes side-effect-free lookup and human-initiated open for bot↔human DMs. */
export function createDmChannelRoutes(db: Database): Hono {
  const app = new Hono()
  app.get('/_test/dm-channels', (c) => {
    c.header('Cache-Control', 'no-store')
    // Repeated parameters stay arrays so the validator rejects them.
    const query = Object.fromEntries(
      Object.entries(c.req.queries()).map(([key, values]) => [
        key,
        values.length === 1 ? values[0] : values,
      ])
    )
    const errors = validateDmChannelRequest(query)
    if (Object.keys(errors).length > 0)
      return c.json(validationError(errors).body, 400)
    const result = lookupDmChannel(db, query as unknown as DmChannelRequest)
    if (typeof result === 'string') {
      const { status, body } = targetError(result)
      return c.json(body, status)
    }
    return result
      ? c.json(result)
      : c.json(
          discordError(DiscordErrorCode.UNKNOWN_CHANNEL, 'Unknown Channel', 404)
            .body,
          404
        )
  })
  app.post('/_test/dm-channels', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined)
    const errors = validateDmChannelRequest(body)
    if (Object.keys(errors).length > 0)
      return c.json(validationError(errors).body, 400)
    const result = openDmChannel(db, body as DmChannelRequest)
    if (typeof result === 'string') {
      const { status, body: error } = targetError(result)
      return c.json(error, status)
    }
    return c.json(result.channel, result.created ? 201 : 200)
  })
  return app
}
