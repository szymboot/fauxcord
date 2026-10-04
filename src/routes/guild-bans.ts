/**
 * Guild bans API routing
 *
 * Implements the /guilds/:guildId/bans/* endpoints.
 */

import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import { getGuild } from '../services/guilds'
import {
  getGuildBan,
  getGuildBans,
  createGuildBan,
  removeGuildBan,
} from '../services/guild-bans'
import { validateBanCreate, type BanCreatePayload } from '../validators/guild'
import { requireEntity, parseLimitQuery } from '../lib/route-helpers'

/**
 * Creates the guild bans API routes.
 * @param db - Database
 * @returns Hono router instance
 */
export function createGuildBanRoutes(db: Database): Hono {
  const app = new Hono()

  // GET /guilds/:guildId/bans — List a guild's bans
  app.get('/guilds/:guildId/bans', (c) => {
    const { guildId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const limit = parseLimitQuery(c, 1000, 1000)
    const before = c.req.query('before')
    const after = c.req.query('after')

    const bans = getGuildBans(db, guildId, limit, before, after)
    return c.json(bans)
  })

  // GET /guilds/:guildId/bans/:userId — Retrieve a specific ban
  app.get('/guilds/:guildId/bans/:userId', (c) => {
    const { guildId, userId } = c.req.param()

    // Check guild existence first so a missing guild returns Unknown Guild.
    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const ban = requireEntity(
      c,
      getGuildBan(db, guildId, userId),
      DiscordErrorCode.UNKNOWN_BAN,
      'Unknown Ban'
    )
    return ban instanceof Response ? ban : c.json(ban)
  })

  // PUT /guilds/:guildId/bans/:userId — Ban a user from the guild
  app.put('/guilds/:guildId/bans/:userId', async (c) => {
    const { guildId, userId } = c.req.param()

    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    // Tolerate an empty/invalid/non-object JSON body (including a literal
    // `null` or an array, both of which parse without error): treat it as an
    // empty (no-op) payload rather than dereferencing a non-object below
    // (same idiom as PATCH /users/@me).
    const parsed: unknown = await c.req.json().catch(() => ({}))
    const payload: BanCreatePayload =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : {}

    // Legacy clients send days in the query string. Require a single decimal
    // integer; Number alone would also accept empty strings, hex, or exponents.
    const queryDays = c.req.queries('delete_message_days')
    const queryDeleteMessageDays =
      queryDays === undefined
        ? undefined
        : queryDays.length === 1 &&
            queryDays[0] !== '' &&
            !/\D/.test(queryDays[0])
          ? Number(queryDays[0])
          : NaN
    // Validate all supplied fields, including values overridden by precedence.
    const errors = {
      ...validateBanCreate({ delete_message_days: queryDeleteMessageDays }),
      ...validateBanCreate(payload),
    }
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    // The audit header wins, retaining its existing verbatim behavior. Hono
    // already decodes query values (including '+' spaces) exactly once.
    const reason =
      c.req.header('X-Audit-Log-Reason') ?? c.req.query('reason') ?? null
    // Discord accepts either delete_message_seconds or the deprecated
    // delete_message_days; normalize both to a seconds window.
    // Non-null JSON values take precedence over legacy query days, including 0.
    const deleteMessageDays =
      payload.delete_message_days ?? queryDeleteMessageDays ?? 0
    const deleteMessageSeconds =
      payload.delete_message_seconds ?? deleteMessageDays * 86_400
    createGuildBan(db, guildId, userId, reason, deleteMessageSeconds)
    return c.body(null, 204)
  })

  // DELETE /guilds/:guildId/bans/:userId — Remove a ban (unban)
  app.delete('/guilds/:guildId/bans/:userId', (c) => {
    const { guildId, userId } = c.req.param()

    // Check guild existence first so a missing guild returns Unknown Guild.
    const guild = requireEntity(
      c,
      getGuild(db, guildId),
      DiscordErrorCode.UNKNOWN_GUILD,
      'Unknown Guild'
    )
    if (guild instanceof Response) return guild

    const removed = removeGuildBan(db, guildId, userId)
    if (!removed) {
      const err = discordError(DiscordErrorCode.UNKNOWN_BAN, 'Unknown Ban', 404)
      return c.json(err.body, 404)
    }
    return c.body(null, 204)
  })

  return app
}
