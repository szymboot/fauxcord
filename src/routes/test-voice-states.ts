import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError } from '../errors'
import { setTestGuildVoiceState } from '../services/voice-states'
import { publishGuildVoiceStateMutation } from '../services/voice-state-events'

/** Creates the dedicated synthetic voice-state fixture route. */
export function createTestVoiceStateRoutes(db: Database): Hono {
  const app = new Hono()
  app.patch('/_test/guilds/:guildId/voice-states/:userId', async (c) => {
    const { guildId, userId } = c.req.param()
    const result = setTestGuildVoiceState(
      db,
      guildId,
      userId,
      await c.req.json<unknown>().catch(() => undefined)
    )
    if (typeof result !== 'string') {
      publishGuildVoiceStateMutation(db, result)
      return c.json(result.state)
    }
    if (result === 'INVALID_INPUT')
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    const errors = {
      UNKNOWN_GUILD: [DiscordErrorCode.UNKNOWN_GUILD, 'Unknown Guild'],
      UNKNOWN_USER: [DiscordErrorCode.UNKNOWN_USER, 'Unknown User'],
      UNKNOWN_MEMBER: [DiscordErrorCode.UNKNOWN_MEMBER, 'Unknown Member'],
      UNKNOWN_CHANNEL: [DiscordErrorCode.UNKNOWN_CHANNEL, 'Unknown Channel'],
    } as const
    const [code, message] = errors[result]
    return c.json(discordError(code, message, 404).body, 404)
  })
  return app
}
