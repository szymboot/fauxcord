/** Test-control service that adds a setup's bot to an existing guild. */
import type { Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import { toDiscordTimestamp } from '../timestamp'
import { buildGuildCreatePayload } from './guilds'
import { getGuildMember, type GuildMemberObject } from './guild-members'
import type { TestGuildBotJoinRequest } from '../validators/test-guild-bot'

/** Why a bot could not be added to a guild; nothing is mutated or emitted. */
export type JoinTestGuildBotError =
  | 'UNKNOWN_GUILD'
  | 'UNKNOWN_BOT'
  | 'BOT_MISMATCH'
  | 'FOREIGN_GUILD'
  | 'ALREADY_PRESENT'
  | 'UNKNOWN_ROLE'

/**
 * Adds a setup's bot to an existing guild, like a server administrator
 * authorizing the `bot` OAuth2 scope.
 *
 * The guild keeps every human member, role, channel, message and voice state
 * it already has. It must be owned by the named bot's own setup
 * (`guilds.bot_token`), which is the case for a guild prepared with
 * `bot_present: false` in setup, and for a guild the bot left or was removed
 * from. A guild owned by another setup is never taken over here; re-list it
 * through `POST /_test/setup` instead. Joining a bot that is already present
 * fails with `ALREADY_PRESENT`, mirroring the human member join conflict.
 *
 * In one transaction the guild is attached again (`bot_present = 1`), the
 * removal marker and any stale ban of the bot are cleared, and the bot's
 * member row is created with the requested roles. After commit, the setup's
 * live sessions get a full `GUILD_CREATE`, and other sessions holding the
 * members intent get `GUILD_MEMBER_ADD` for the bot (the joining setup's own
 * sessions already see the member inside `GUILD_CREATE`).
 * @param db - Database
 * @param guildId - Existing guild ID
 * @param request - Bot identity (token and/or application ID) and role IDs
 * @returns The bot's new guild member, or the reason nothing changed
 */
export function joinTestGuildBot(
  db: Database,
  guildId: string,
  request: TestGuildBotJoinRequest
): GuildMemberObject | JoinTestGuildBotError {
  const roleIds = [...new Set(request.roles)]
  const join = db.transaction(
    (): JoinTestGuildBotError | { botId: string; token: string } => {
      const guild = db
        .prepare('SELECT bot_token, bot_present FROM guilds WHERE id = ?')
        .get(guildId) as { bot_token: string; bot_present: number } | undefined
      if (!guild) return 'UNKNOWN_GUILD'

      const candidates = db
        .prepare(
          `SELECT token, user_id FROM bots
           WHERE (@token IS NULL OR token IN (@token, 'Bot ' || @token))
             AND (@application IS NULL OR user_id = @application)`
        )
        .all({
          token: request.token ?? null,
          application: request.application_id ?? null,
        }) as { token: string; user_id: string }[]
      if (candidates.length === 0) {
        // Distinguish a token and application ID naming different bots.
        if (
          request.token !== undefined &&
          request.application_id !== undefined
        ) {
          const byToken = db
            .prepare("SELECT 1 FROM bots WHERE token IN (?, 'Bot ' || ?)")
            .get(request.token, request.token)
          const byApplication = db
            .prepare('SELECT 1 FROM bots WHERE user_id = ?')
            .get(request.application_id)
          if (byToken && byApplication) return 'BOT_MISMATCH'
        }
        return 'UNKNOWN_BOT'
      }
      // Several setups may share a bot user ID; the guild's owner wins.
      const bot =
        candidates.find(({ token }) => token === guild.bot_token) ??
        candidates[0]
      if (bot.token !== guild.bot_token) return 'FOREIGN_GUILD'
      if (guild.bot_present === 1) return 'ALREADY_PRESENT'

      for (const roleId of roleIds) {
        const role = db
          .prepare('SELECT 1 FROM roles WHERE id = ? AND guild_id = ?')
          .get(roleId, guildId)
        if (!role || roleId === guildId) return 'UNKNOWN_ROLE'
      }

      db.prepare('UPDATE guilds SET bot_present = 1 WHERE id = ?').run(guildId)
      db.prepare(
        'DELETE FROM guild_bot_removals WHERE guild_id = ? AND bot_token = ?'
      ).run(guildId, bot.token)
      // An administrator who re-invites a banned bot has lifted its ban.
      db.prepare(
        'DELETE FROM guild_bans WHERE guild_id = ? AND user_id = ?'
      ).run(guildId, bot.user_id)
      db.prepare(
        'INSERT OR IGNORE INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)'
      ).run(guildId, bot.user_id, toDiscordTimestamp(new Date()))
      for (const roleId of roleIds) {
        db.prepare(
          'INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
        ).run(guildId, bot.user_id, roleId)
      }
      return { botId: bot.user_id, token: bot.token }
    }
  )()
  if (typeof join === 'string') return join

  const member = getGuildMember(db, guildId, join.botId)
  if (!member) throw new Error('Joined bot member could not be retrieved')
  const guild = buildGuildCreatePayload(db, guildId)
  if (guild)
    gatewayBus.emit('guild.create', {
      guild: guild as unknown as Record<string, unknown>,
      scope: { db, botId: join.botId, token: join.token },
    })
  gatewayBus.emit('guild.member.add', {
    guildId,
    member: member as unknown as Record<string, unknown>,
    exceptScope: { db, token: join.token },
  })
  return member
}
