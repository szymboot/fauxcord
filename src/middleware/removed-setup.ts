import type { MiddlewareHandler } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError } from '../errors'
import type { AppEnv } from './auth'

/**
 * Resolves the guild a native REST path belongs to: `/guilds/:id…`,
 * `/users/@me/guilds/:id/member`, `/applications/:id/guilds/:id…`, and the
 * guild resources addressed by their own ID (`/channels/:id…`,
 * `/webhooks/:id…` and `/invites/:code`).
 * @param db - Database
 * @param path - Request path without a version prefix
 * @returns The guild ID, or undefined for paths outside any guild
 */
function pathGuildId(db: Database, path: string): string | undefined {
  const guild =
    /^\/guilds\/([^/]+)/.exec(path) ??
    /^\/users\/@me\/guilds\/([^/]+)\/member(?:\/|$)/.exec(path) ??
    /^\/applications\/[^/]+\/guilds\/([^/]+)/.exec(path)
  if (guild) return guild[1]
  const channel = /^\/channels\/([^/]+)/.exec(path)
  if (channel) {
    const row = db
      .prepare('SELECT guild_id FROM channels WHERE id = ?')
      .get(channel[1]) as { guild_id: string | null } | undefined
    return row?.guild_id ?? undefined
  }
  const webhook = /^\/webhooks\/([^/]+)/.exec(path)
  if (webhook) {
    const row = db
      .prepare(
        `SELECT c.guild_id FROM webhooks w JOIN channels c ON c.id = w.channel_id
         WHERE w.id = ?`
      )
      .get(webhook[1]) as { guild_id: string | null } | undefined
    return row?.guild_id ?? undefined
  }
  const invite = /^\/invites\/([^/]+)/.exec(path)
  if (!invite) return undefined
  const row = db
    .prepare(
      `SELECT c.guild_id FROM invites i JOIN channels c ON c.id = i.channel_id
       WHERE i.code = ?`
    )
    .get(invite[1]) as { guild_id: string | null } | undefined
  return row?.guild_id ?? undefined
}

/**
 * Denies guild-scoped native REST to a setup that was removed from a guild
 * which another setup has since taken over. The takeover re-attaches the
 * guild (and, for the same bot user ID, restores its membership and
 * permissions), so without this a removed setup's token would regain access.
 * While the guild is merely detached under the removed setup itself, routes
 * keep their ordinary existence-based behavior (documented emulator
 * limitation). Unauthenticated test controls and Bearer callers whose OAuth2
 * client is not linked to a setup are unaffected.
 * @param db - Database
 * @returns Hono middleware, mounted after authentication
 */
export function createRemovedSetupMiddleware(
  db: Database
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const accessToken = c.get('accessToken')
    const setupToken =
      c.get('bot')?.token ??
      (accessToken
        ? (
            db
              .prepare(
                'SELECT bot_token FROM oauth2_clients WHERE client_id = ?'
              )
              .get(accessToken.client_id) as
              { bot_token: string | null } | undefined
          )?.bot_token
        : undefined)
    if (
      setupToken &&
      db
        .prepare('SELECT 1 FROM guild_bot_removals WHERE bot_token = ? LIMIT 1')
        .get(setupToken)
    ) {
      const path = c.req.path.replace(/^\/api(?:\/v10)?(?=\/)/, '')
      const guildId = pathGuildId(db, path)
      if (
        guildId !== undefined &&
        db
          .prepare(
            `SELECT 1 FROM guild_bot_removals r JOIN guilds g ON g.id = r.guild_id
             WHERE r.guild_id = ? AND r.bot_token = ? AND g.bot_token != r.bot_token`
          )
          .get(guildId, setupToken)
      )
        return c.json(
          discordError(DiscordErrorCode.MISSING_ACCESS, 'Missing Access', 403)
            .body,
          403
        )
    }
    await next()
  }
}
