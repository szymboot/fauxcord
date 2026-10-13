import { randomUUID } from 'node:crypto'
import type { Database } from '../db'
import type { ClosedDmRequest } from '../validators/closed-dm'

/** Public inspection state; the owning setup token remains private. */
export interface ClosedDm extends ClosedDmRequest {
  id: string
  bot_id: string
}

/** Removes restrictions whose cleanup guild has changed setup ownership. */
export function pruneClosedDms(db: Database): void {
  db.prepare(
    `DELETE FROM test_closed_dms WHERE owner_token !=
      (SELECT bot_token FROM guilds WHERE id = guild_id)`
  ).run()
}

/** Creates or returns the existing restriction for a guild/user pair. */
export function createClosedDm(
  db: Database,
  payload: ClosedDmRequest
): ClosedDm | 'UNKNOWN_GUILD' | 'UNKNOWN_USER' | 'BOT_RECIPIENT' {
  const guild = db
    .prepare(
      `SELECT g.bot_token, b.user_id FROM guilds g
     JOIN bots b ON b.token = g.bot_token WHERE g.id = ?`
    )
    .get(payload.guild_id) as { bot_token: string; user_id: string } | undefined
  if (!guild) return 'UNKNOWN_GUILD'
  const user = db
    .prepare('SELECT bot FROM users WHERE id = ?')
    .get(payload.user_id) as { bot: number } | undefined
  if (!user) return 'UNKNOWN_USER'
  if (user.bot) return 'BOT_RECIPIENT'
  pruneClosedDms(db)
  db.prepare(
    `INSERT OR IGNORE INTO test_closed_dms
     (id, guild_id, user_id, bot_id, owner_token) VALUES (?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    payload.guild_id,
    payload.user_id,
    guild.user_id,
    guild.bot_token
  )
  return db
    .prepare(
      'SELECT id, guild_id, user_id, bot_id FROM test_closed_dms WHERE guild_id = ? AND user_id = ?'
    )
    .get(payload.guild_id, payload.user_id) as ClosedDm
}

/** Inspects a restriction, hiding controls retired by guild reassignment. */
export function getClosedDm(db: Database, id: string): ClosedDm | undefined {
  pruneClosedDms(db)
  return db
    .prepare(
      'SELECT id, guild_id, user_id, bot_id FROM test_closed_dms WHERE id = ?'
    )
    .get(id) as ClosedDm | undefined
}

/** Removes an existing restriction, returning false for an unknown control. */
export function deleteClosedDm(db: Database, id: string): boolean {
  pruneClosedDms(db)
  return (
    db.prepare('DELETE FROM test_closed_dms WHERE id = ?').run(id).changes > 0
  )
}

/** Clears restrictions globally or for the exact owning setup token. */
export function resetClosedDms(db: Database, token?: string): void {
  if (token)
    db.prepare('DELETE FROM test_closed_dms WHERE owner_token = ?').run(token)
  else db.exec('DELETE FROM test_closed_dms')
}

/** Checks only 1:1 DMs containing the sending bot and restricted human user. */
export function isDmClosed(
  db: Database,
  channelId: string,
  token: string
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM test_closed_dms f
     JOIN guilds g ON g.id = f.guild_id AND g.bot_token = f.owner_token
     JOIN channels c ON c.id = ? AND c.type = 1 AND c.guild_id IS NULL
     JOIN channel_recipients human ON human.channel_id = c.id AND human.user_id = f.user_id
     JOIN channel_recipients bot ON bot.channel_id = c.id AND bot.user_id = f.bot_id
     WHERE f.owner_token = ? AND
       (SELECT COUNT(*) FROM channel_recipients WHERE channel_id = c.id) = 2
     LIMIT 1`
      )
      .get(channelId, token)
  )
}
