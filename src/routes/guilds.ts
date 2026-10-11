/**
 * Guilds API routing
 *
 * Implements the /guilds/* endpoints (guild CRUD, channels, webhooks) and
 * composes the role/member sub-routers.
 */

import { Hono } from 'hono'
import type { Database } from '../db'
import type { GatewayEventControls } from '../gateway/event-controls'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import {
  getGuild,
  updateGuild,
  deleteGuild,
  isValidAfkChannel,
} from '../services/guilds'
import {
  getGuildChannels,
  createGuildChannel,
  isVoiceCapableChannelType,
} from '../services/channels'
import { listVoiceRegions } from '../services/catalog'
import {
  pickVoiceChannelSettings,
  validateVoiceChannelSettings,
} from '../validators/channel'
import { getGuildWebhooks } from '../services/webhooks'
import {
  validateChannelCreate,
  validateGuildAfk,
  validateGuildName,
  GUILD_LIMITS,
  type ChannelCreatePayload,
} from '../validators/guild'
import { requireEntity, parseJsonBody } from '../lib/route-helpers'
import { createGuildRoleRoutes } from './guild-roles'
import { createGuildMemberRoutes } from './guild-members'
import { createGuildEmojiRoutes } from './guild-emojis'
import { createGuildBanRoutes } from './guild-bans'
import { createGuildInviteRoutes } from './guild-invites'

/**
 * Creates the guilds API routes.
 * @param db - Database
 * @returns Hono router instance
 */
export function createGuildRoutes(
  db: Database,
  eventControls?: Pick<GatewayEventControls, 'deleteGuild'>
): Hono {
  const app = new Hono()

  // GET /guilds/:guildId — Retrieve guild information
  app.get('/guilds/:guildId', (c) => {
    const { guildId } = c.req.param()
    const withCounts = c.req.query('with_counts') === 'true'

    const guild = requireEntity(
      c,
      getGuild(db, guildId, withCounts),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    return guild instanceof Response ? guild : c.json(guild)
  })

  // PATCH /guilds/:guildId — Update guild information
  app.patch('/guilds/:guildId', async (c) => {
    const { guildId } = c.req.param()

    // Tolerate an empty/invalid/non-object JSON body (including a literal
    // `null` or an array, both of which parse without error): treat it as an
    // empty (no-op) payload rather than crashing on JSON.parse of an empty
    // body (same idiom as PATCH /users/@me and POST .../bans).
    const parsed: unknown = await c.req.json().catch(() => ({}))
    const payload: {
      name?: string
      afk_channel_id?: unknown
      afk_timeout?: unknown
    } =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : {}

    const errors = {
      ...(payload.name !== undefined && validateGuildName(payload.name)),
      ...validateGuildAfk(payload, (channelId) =>
        isValidAfkChannel(db, guildId, channelId)
      ),
    }
    // An unknown guild is reported as 404 rather than as an AFK form error.
    if (Object.keys(errors).length > 0 && getGuild(db, guildId)) {
      return c.json(validationError(errors).body, 400)
    }

    const updated = requireEntity(
      c,
      updateGuild(db, guildId, {
        name: payload.name,
        afk_channel_id: payload.afk_channel_id as string | null | undefined,
        afk_timeout: payload.afk_timeout as number | undefined,
      }),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    return updated instanceof Response ? updated : c.json(updated)
  })

  // DELETE /guilds/:guildId — Delete a guild
  app.delete('/guilds/:guildId', (c) => {
    const { guildId } = c.req.param()

    const deleted = deleteGuild(db, guildId)
    if (!deleted) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_GUILD,
        'Unknown Guild',
        404
      )
      return c.json(err.body, 404)
    }
    eventControls?.deleteGuild(guildId)
    return c.body(null, 204)
  })

  // GET /guilds/:guildId/channels — List a guild's channels
  app.get('/guilds/:guildId/channels', (c) => {
    const { guildId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const channels = getGuildChannels(db, guildId)
    return c.json(channels)
  })

  // POST /guilds/:guildId/channels — Create a channel in a guild
  app.post('/guilds/:guildId/channels', async (c) => {
    const { guildId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const channels = getGuildChannels(db, guildId)
    if (channels.length >= GUILD_LIMITS.CHANNELS_MAX) {
      const err = discordError(
        DiscordErrorCode.MAX_CHANNELS_REACHED,
        'Maximum number of guild channels reached (500)',
        400
      )
      return c.json(err.body, 400)
    }

    const payload = (await parseJsonBody(c)) as unknown as ChannelCreatePayload

    // Discord applies voice settings to voice and stage channels only.
    const voice = isVoiceCapableChannelType(payload.type ?? 0)
    const errors = {
      ...validateChannelCreate(payload),
      ...(voice &&
        validateVoiceChannelSettings(
          payload,
          payload.type ?? 0,
          guild.premium_tier,
          listVoiceRegions().map((region) => region.id)
        )),
    }
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    const newChannel = createGuildChannel(db, {
      ...(voice && pickVoiceChannelSettings(payload)),
      guildId,
      name: payload.name,
      type: payload.type,
      topic: payload.topic,
      nsfw: payload.nsfw,
      parentId: payload.parent_id,
      position: payload.position ?? channels.length,
    })

    return c.json(newChannel, 201)
  })

  // GET /guilds/:guildId/webhooks — List a guild's webhooks
  app.get('/guilds/:guildId/webhooks', (c) => {
    const { guildId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const webhooks = getGuildWebhooks(db, guildId)
    return c.json(webhooks)
  })

  app.route('/', createGuildRoleRoutes(db))
  app.route('/', createGuildMemberRoutes(db))
  app.route('/', createGuildEmojiRoutes(db))
  app.route('/', createGuildBanRoutes(db))
  app.route('/', createGuildInviteRoutes(db))

  return app
}
