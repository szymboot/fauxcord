import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import { joinTestGuildBot } from '../services/guild-bot-join'
import { validateTestGuildBotJoin } from '../validators/test-guild-bot'

/**
 * Exposes the control that adds a setup's bot to an existing guild, like an
 * administrator authorizing the `bot` OAuth2 scope.
 * @param db - Database
 * @returns Hono router instance
 */
export function createTestGuildBotRoutes(db: Database): Hono {
  const app = new Hono()
  app.post('/_test/guilds/:guildId/bot', async (c) => {
    const text = await c.req.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    const payload = parsed as Record<string, unknown>
    const errors = validateTestGuildBotJoin(payload)
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    const result = joinTestGuildBot(db, c.req.param('guildId'), payload)
    switch (result) {
      case 'UNKNOWN_GUILD': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_GUILD, 'Unknown Guild', 404)
            .body,
          404
        )
      }
      case 'UNKNOWN_BOT': {
        return c.json({ message: 'Unknown Bot', code: 0 }, 404)
      }
      case 'UNKNOWN_ROLE': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_ROLE, 'Unknown Role', 404).body,
          404
        )
      }
      case 'BOT_MISMATCH': {
        return c.json(
          validationError({
            application_id: {
              _errors: [
                {
                  code: 'BOT_MISMATCH',
                  message: 'token and application_id name different bots.',
                },
              ],
            },
          }).body,
          400
        )
      }
      case 'FOREIGN_GUILD': {
        return c.json(
          { message: 'Guild belongs to another setup', code: 0 },
          409
        )
      }
      case 'ALREADY_PRESENT': {
        return c.json(
          { message: 'Bot is already a member of the guild', code: 0 },
          409
        )
      }
      default: {
        return c.json(result, 201)
      }
    }
  })
  return app
}
