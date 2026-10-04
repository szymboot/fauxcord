import type {
  APIAuditLog,
  APIAuditLogEntry,
  APIUser,
} from 'discord-api-types/v10'
import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import { getUser } from './users'
import {
  isAuditSnowflake,
  validateAuditLogFixture,
} from '../validators/audit-log'
import type { AuditLogFixture, AuditLogQuery } from '../validators/audit-log'

/** Stored subset of Discord's MESSAGE_DELETE entry. */
export interface MessageDeleteAuditEntry {
  id: string
  action_type: 72
  user_id: string
  target_id: string
  options: { channel_id: string; count: string }
}

/** Audit response with only the referenced users in the selected page. */
export interface AuditLogPage {
  audit_log_entries: MessageDeleteAuditEntry[]
  users: APIUser[]
  integrations: never[]
  webhooks: never[]
  guild_scheduled_events: never[]
  threads: never[]
  application_commands: never[]
  auto_moderation_rules: never[]
}

/** Persisted audit entry; text IDs preserve the full unsigned snowflake range. */
interface AuditLogRow {
  id: string
  user_id: string
  target_id: string
  channel_id: string
  count: string
}

/** Serializes a stored entry using Discord's string-valued options. */
function toAuditEntry(row: AuditLogRow): MessageDeleteAuditEntry {
  return {
    id: row.id,
    action_type: 72,
    user_id: row.user_id,
    target_id: row.target_id,
    options: { channel_id: row.channel_id, count: row.count },
  } satisfies APIAuditLogEntry
}

/**
 * Creates a fixture independently of message deletion or Gateway dispatch.
 * Validates IDs, users and channel ownership before writing; duplicate IDs
 * never overwrite another guild's entry. Registered users may have left a guild.
 */
export function createAuditLogEntry(
  db: Database,
  guildId: string,
  request: AuditLogFixture
):
  | MessageDeleteAuditEntry
  | 'INVALID_INPUT'
  | 'UNKNOWN_GUILD'
  | 'UNKNOWN_USER'
  | 'UNKNOWN_CHANNEL'
  | 'CONFLICT' {
  const payload = validateAuditLogFixture(request)
  if (!payload || guildId === '0' || !isAuditSnowflake(guildId))
    return 'INVALID_INPUT'
  if (!db.prepare('SELECT id FROM guilds WHERE id = ?').get(guildId))
    return 'UNKNOWN_GUILD'
  if (!getUser(db, payload.user_id) || !getUser(db, payload.target_id))
    return 'UNKNOWN_USER'
  if (
    !db
      .prepare('SELECT id FROM channels WHERE id = ? AND guild_id = ?')
      .get(payload.options.channel_id, guildId)
  )
    return 'UNKNOWN_CHANNEL'
  const id =
    payload.id ??
    (payload.timestamp === undefined
      ? generateSnowflake()
      : (
          (BigInt(new Date(payload.timestamp).getTime()) -
            1_420_070_400_000n) <<
          22n
        ).toString())
  if (db.prepare('SELECT id FROM guild_audit_log_entries WHERE id = ?').get(id))
    return 'CONFLICT'
  db.prepare(
    `INSERT INTO guild_audit_log_entries
    (id, guild_id, user_id, target_id, channel_id, count) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    guildId,
    payload.user_id,
    payload.target_id,
    payload.options.channel_id,
    payload.options.count
  )
  return {
    id,
    action_type: 72,
    user_id: payload.user_id,
    target_id: payload.target_id,
    options: payload.options,
  }
}

/**
 * Reads an isolated guild page using Discord cursor order and strict bounds.
 * Length plus lexical comparisons preserve numeric order across 64-bit IDs,
 * including values beyond SQLite's signed integer range. The default cursor
 * includes the current millisecond but omits future-dated fixtures.
 */
export function listAuditLogs(
  db: Database,
  guildId: string,
  query: AuditLogQuery = {}
): AuditLogPage {
  const conditions = ['guild_id = ?']
  const parameters: (string | number)[] = [guildId]
  for (const field of ['user_id', 'target_id'] as const) {
    if (query[field] === undefined) continue
    conditions.push(`${field} = ?`)
    parameters.push(query[field])
  }
  if (query.action_type !== undefined && query.action_type !== 72)
    conditions.push('0 = 1')
  const before =
    query.before ??
    (query.after === undefined
      ? ((BigInt(Date.now() + 1) - 1_420_070_400_000n) << 22n).toString()
      : undefined)
  for (const [cursor, operator] of [
    [before, '<'],
    [query.after, '>'],
  ] as const) {
    if (cursor === undefined) continue
    conditions.push(
      `(length(id) ${operator} ? OR (length(id) = ? AND id ${operator} ?))`
    )
    parameters.push(cursor.length, cursor.length, cursor)
  }
  const direction = query.after === undefined ? 'DESC' : 'ASC'
  const rows = db
    .prepare(
      `SELECT id, user_id, target_id, channel_id, count FROM guild_audit_log_entries
    WHERE ${conditions.join(' AND ')} ORDER BY length(id) ${direction}, id ${direction} LIMIT ?`
    )
    .all(...parameters, query.limit ?? 50) as AuditLogRow[]
  const userIds = new Set(rows.flatMap((row) => [row.user_id, row.target_id]))
  const users = [...userIds]
    .map((id) => getUser(db, id))
    .filter((user) => user !== null)
    .map((user): APIUser => ({
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
      bot: user.bot,
      global_name: user.global_name ?? null,
      flags: user.flags ?? 0,
      public_flags: user.public_flags ?? 0,
      primary_guild: null,
    }))
  return {
    audit_log_entries: rows.map((row) => toAuditEntry(row)),
    users,
    integrations: [],
    webhooks: [],
    guild_scheduled_events: [],
    threads: [],
    application_commands: [],
    auto_moderation_rules: [],
  } satisfies APIAuditLog
}
