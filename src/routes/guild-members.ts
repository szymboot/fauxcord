/**
 * Guild members API routing
 *
 * Implements the /guilds/:guildId/members/* endpoints.
 */

import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import { getGuild } from '../services/guilds'
import { getRole } from '../services/guild-roles'
import {
  getGuildMember,
  getGuildMembers,
  updateGuildMember,
  removeGuildMember,
  addMemberRole,
  removeMemberRole,
} from '../services/guild-members'
import {
  validateGuildMemberUpdate,
  type GuildMemberUpdatePayload,
} from '../validators/guild'
import {
  requireEntity,
  parseLimitQuery,
  parseJsonBody,
} from '../lib/route-helpers'
import type { AppEnv } from '../middleware/auth'
import {
  checkVoiceModeration,
  hasVoiceChange,
  modifyGuildMember,
  type VoiceModerationError,
} from '../services/voice-moderation'

/** Discord error code, message and HTTP status per voice moderation failure. */
const VOICE_MODERATION_ERRORS: Record<
  VoiceModerationError,
  readonly [number, string, 400 | 403 | 404]
> = {
  NOT_CONNECTED: [
    DiscordErrorCode.TARGET_USER_NOT_CONNECTED_TO_VOICE,
    'Target user is not connected to voice.',
    400,
  ],
  UNKNOWN_CHANNEL: [DiscordErrorCode.UNKNOWN_CHANNEL, 'Unknown Channel', 404],
  INVALID_CHANNEL_TYPE: [
    DiscordErrorCode.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE,
    'Cannot execute action on this channel type',
    400,
  ],
  MISSING_PERMISSIONS: [
    DiscordErrorCode.MISSING_PERMISSIONS,
    'Missing Permissions',
    403,
  ],
}

/**
 * Creates the guild members API routes.
 * @param db - Database
 * @returns Hono router instance
 */
export function createGuildMemberRoutes(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // GET /guilds/:guildId/members — List a guild's members
  app.get('/guilds/:guildId/members', (c) => {
    const { guildId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const limit = parseLimitQuery(c, 1, 1000)
    const after = c.req.query('after') ?? '0'

    const members = getGuildMembers(db, guildId, limit, after)
    return c.json(members)
  })

  // PATCH /guilds/:guildId/members/@me — Update the bot's own guild member
  // (nickname only; avatar/bio/banner from the real spec are not modeled).
  // Must be defined before the parameterized /:userId route below, and before
  // any auth-context-independent handler, since Hono uses first-match-wins
  // and "@me" would otherwise be captured by the :userId param.
  app.patch('/guilds/:guildId/members/@me', async (c) => {
    const { guildId } = c.req.param()
    const bot = c.get('bot')
    if (!bot) {
      return c.json({ message: '401: Unauthorized', code: 0 }, 401)
    }

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const payload = (await parseJsonBody(c)) as GuildMemberUpdatePayload
    // Modify Current Member only documents nick (plus unmodeled avatar,
    // banner and bio); voice moderation fields are ignored like other
    // unknown fields. Use the /:userId route to moderate the bot itself.
    const currentMemberPayload = { nick: payload.nick }
    const errors = validateGuildMemberUpdate(currentMemberPayload)
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    const updated = updateGuildMember(
      db,
      guildId,
      bot.user_id,
      currentMemberPayload
    )
    const result = requireEntity(
      c,
      updated,
      DiscordErrorCode.UNKNOWN_MEMBER,
      'Unknown Member'
    )
    return result instanceof Response ? result : c.json(result)
  })

  // GET /guilds/:guildId/members/:userId — Retrieve a specific guild member
  app.get('/guilds/:guildId/members/:userId', (c) => {
    const { guildId, userId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const member = requireEntity(
      c,
      getGuildMember(db, guildId, userId),
      DiscordErrorCode.UNKNOWN_MEMBER,
      'Unknown Member'
    )
    return member instanceof Response ? member : c.json(member)
  })

  // PATCH /guilds/:guildId/members/:userId — Update member information,
  // including server mute/deaf and voice move/disconnect (channel_id)
  app.patch('/guilds/:guildId/members/:userId', async (c) => {
    const { guildId, userId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const payload = (await parseJsonBody(c)) as GuildMemberUpdatePayload

    const errors = validateGuildMemberUpdate(payload)
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    if (payload.roles !== undefined) {
      for (const roleId of payload.roles) {
        if (!getRole(db, guildId, roleId)) {
          const err = discordError(
            DiscordErrorCode.UNKNOWN_ROLE,
            'Unknown Role',
            404
          )
          return c.json(err.body, 404)
        }
      }
    }

    if (!getGuildMember(db, guildId, userId)) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_MEMBER,
        'Unknown Member',
        404
      )
      return c.json(err.body, 404)
    }

    // Voice moderation is a bot action; an OAuth2 Bearer user has no
    // moderation permissions to evaluate here.
    const bot = c.get('bot')
    if (!bot && c.get('accessToken') && hasVoiceChange(payload)) {
      const [code, message, status] =
        VOICE_MODERATION_ERRORS.MISSING_PERMISSIONS
      return c.json(discordError(code, message, status).body, status)
    }
    // A dummy DISABLE_AUTH bot (unregistered token) has no persisted
    // permissions to evaluate, so permission checks only apply to real bots.
    const actorId =
      bot && db.prepare('SELECT 1 FROM bots WHERE token = ?').get(bot.token)
        ? bot.user_id
        : null
    const voiceError = checkVoiceModeration(
      db,
      guildId,
      userId,
      actorId,
      payload
    )
    if (voiceError) {
      const [code, message, status] = VOICE_MODERATION_ERRORS[voiceError]
      return c.json(discordError(code, message, status).body, status)
    }

    const updated = modifyGuildMember(db, guildId, userId, payload)
    const result = requireEntity(
      c,
      updated,
      DiscordErrorCode.UNKNOWN_MEMBER,
      'Unknown Member'
    )
    if (result instanceof Response) return result
    // The spec documents both 200 and 204 for this endpoint; a roles + mute
    // update without a timeout exercises the 204 branch (spec/manifest.ts).
    return payload.roles !== undefined &&
      payload.mute !== undefined &&
      payload.communication_disabled_until === undefined
      ? c.body(null, 204)
      : c.json(result)
  })

  // PUT /guilds/:guildId/members/:userId/roles/:roleId — Add a role to a member
  app.put('/guilds/:guildId/members/:userId/roles/:roleId', (c) => {
    const { guildId, userId, roleId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    if (roleId === guildId) {
      const err = discordError(
        DiscordErrorCode.INVALID_ROLE,
        'Invalid role',
        400
      )
      return c.json(err.body, 400)
    }

    if (!getRole(db, guildId, roleId)) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_ROLE,
        'Unknown Role',
        404
      )
      return c.json(err.body, 404)
    }

    const ok = addMemberRole(db, guildId, userId, roleId)
    if (!ok) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_MEMBER,
        'Unknown Member',
        404
      )
      return c.json(err.body, 404)
    }
    return c.body(null, 204)
  })

  // DELETE /guilds/:guildId/members/:userId/roles/:roleId — Remove a role from a member
  app.delete('/guilds/:guildId/members/:userId/roles/:roleId', (c) => {
    const { guildId, userId, roleId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    if (roleId === guildId) {
      const err = discordError(
        DiscordErrorCode.INVALID_ROLE,
        'Invalid role',
        400
      )
      return c.json(err.body, 400)
    }

    if (!getRole(db, guildId, roleId)) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_ROLE,
        'Unknown Role',
        404
      )
      return c.json(err.body, 404)
    }

    const ok = removeMemberRole(db, guildId, userId, roleId)
    if (!ok) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_MEMBER,
        'Unknown Member',
        404
      )
      return c.json(err.body, 404)
    }
    return c.body(null, 204)
  })

  // DELETE /guilds/:guildId/members/:userId — Kick a member
  app.delete('/guilds/:guildId/members/:userId', (c) => {
    const { guildId, userId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const removed = removeGuildMember(db, guildId, userId)
    if (!removed) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_MEMBER,
        'Unknown Member',
        404
      )
      return c.json(err.body, 404)
    }
    return c.body(null, 204)
  })

  return app
}
