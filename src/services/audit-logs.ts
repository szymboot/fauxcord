import type {
  APIAuditLog,
  APIAuditLogEntry,
  APIUser,
} from 'discord-api-types/v10'
import type { Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import { generateSnowflake } from '../snowflake'
import type { InviteObject } from './invites'
import { getUser } from './users'
import { getGuildDispatchScope } from './voice-state-publisher'
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

/** One `changes` item of an INVITE_DELETE entry; only `old_value` is set. */
export type InviteDeleteAuditChange =
  | { key: 'code'; old_value: string }
  | { key: 'channel_id'; old_value: string }
  | { key: 'inviter_id'; old_value: string }
  | { key: 'uses'; old_value: number }
  | { key: 'max_uses'; old_value: number }
  | { key: 'max_age'; old_value: number }
  | { key: 'temporary'; old_value: boolean }

/**
 * Stored Discord INVITE_DELETE entry. An invite has no snowflake, so Discord
 * sends a `null` `target_id` and describes the invite only through `changes`.
 */
export interface InviteDeleteAuditEntry {
  id: string
  action_type: 42
  user_id: string
  target_id: null
  changes: InviteDeleteAuditChange[]
  reason?: string
}

/** Any audit entry Fauxcord stores. */
export type StoredAuditEntry = MessageDeleteAuditEntry | InviteDeleteAuditEntry

/** Audit response with only the referenced users in the selected page. */
export interface AuditLogPage {
  audit_log_entries: StoredAuditEntry[]
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
  action_type: number
  user_id: string
  target_id: string | null
  channel_id: string | null
  count: string | null
  reason: string | null
  changes: string | null
}

/** Serializes a stored entry using Discord's string-valued options. */
function toAuditEntry(row: AuditLogRow): StoredAuditEntry {
  return row.action_type === 42
    ? ({
        id: row.id,
        action_type: 42,
        user_id: row.user_id,
        target_id: null,
        changes: JSON.parse(row.changes ?? '[]') as InviteDeleteAuditChange[],
        ...(row.reason !== null && { reason: row.reason }),
      } satisfies APIAuditLogEntry)
    : ({
        id: row.id,
        action_type: 72,
        user_id: row.user_id,
        target_id: row.target_id ?? '',
        options: { channel_id: row.channel_id ?? '', count: row.count ?? '' },
      } satisfies APIAuditLogEntry)
}

/** Inputs for recording an INVITE_DELETE audit entry. */
export interface InviteDeleteAuditInput {
  /** Guild whose audit log receives the entry. */
  guildId: string
  /** User who deleted the invite (a bot, or a human for moderator controls). */
  actorId: string
  /** The deleted invite, as returned by `deleteInvite`. */
  invite: InviteObject
  /** Audit log reason (`X-Audit-Log-Reason`); omitted when absent or empty. */
  reason?: string | null
}

/**
 * Builds the `changes` of an INVITE_DELETE entry from the deleted invite.
 * Discord's invite exceptions replace `channel.id` with a `channel_id` key and
 * name the inviter `inviter_id`; every value is the pre-deletion `old_value`.
 * @param invite - The deleted invite
 * @returns Change objects in Discord's invite key order
 */
function inviteDeleteChanges(invite: InviteObject): InviteDeleteAuditChange[] {
  return [
    { key: 'code', old_value: invite.code },
    { key: 'channel_id', old_value: invite.channel.id },
    ...(invite.inviter
      ? [{ key: 'inviter_id', old_value: invite.inviter.id } as const]
      : []),
    { key: 'uses', old_value: invite.uses },
    { key: 'max_uses', old_value: invite.max_uses },
    { key: 'max_age', old_value: invite.max_age },
    { key: 'temporary', old_value: invite.temporary },
  ]
}

/**
 * Publishes GUILD_AUDIT_LOG_ENTRY_CREATE for an entry created by an action.
 * Nothing is published for a guild without a registered bot. Never call it
 * for seeded fixtures.
 * @param db - Database
 * @param guildId - Guild whose audit log received the entry
 * @param entry - The created entry
 */
function publishAuditLogEntryCreate(
  db: Database,
  guildId: string,
  entry: StoredAuditEntry
): void {
  const scope = getGuildDispatchScope(db, guildId)
  if (!scope) return
  gatewayBus.emit('guild.audit.log.entry.create', { guildId, entry, scope })
}

/**
 * Records the INVITE_DELETE audit entry of a committed invite deletion and
 * dispatches GUILD_AUDIT_LOG_ENTRY_CREATE for it. Call this after
 * `deleteInvite` has deleted the invite (and published INVITE_DELETE), so the
 * event order is INVITE_DELETE then GUILD_AUDIT_LOG_ENTRY_CREATE. Callers must
 * not call it for exhaustion, expiry, 404s, fixtures or cleanup. Must not run
 * inside an open transaction: the event could otherwise escape a rollback.
 * @param db - Database (no transaction may be open)
 * @param input - Guild, actor, deleted invite and optional reason
 * @returns The created entry
 */
export function recordInviteDeleteAuditEntry(
  db: Database,
  input: InviteDeleteAuditInput
): InviteDeleteAuditEntry {
  if (db.inTransaction) {
    throw new Error(
      'recordInviteDeleteAuditEntry must not run inside an open transaction'
    )
  }
  const entry: InviteDeleteAuditEntry = {
    id: generateSnowflake(),
    action_type: 42,
    user_id: input.actorId,
    target_id: null,
    changes: inviteDeleteChanges(input.invite),
    ...(input.reason && { reason: input.reason }),
  }
  db.prepare(
    `INSERT INTO guild_audit_log_entries
    (id, guild_id, user_id, target_id, action_type, reason, changes)
    VALUES (?, ?, ?, NULL, 42, ?, ?)`
  ).run(
    entry.id,
    input.guildId,
    entry.user_id,
    entry.reason ?? null,
    JSON.stringify(entry.changes)
  )
  publishAuditLogEntryCreate(db, input.guildId, entry)
  return entry
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
  if (query.action_type !== undefined) {
    conditions.push('action_type = ?')
    parameters.push(query.action_type)
  }
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
      `SELECT id, action_type, user_id, target_id, channel_id, count, reason, changes
    FROM guild_audit_log_entries
    WHERE ${conditions.join(' AND ')} ORDER BY length(id) ${direction}, id ${direction} LIMIT ?`
    )
    .all(...parameters, query.limit ?? 50) as AuditLogRow[]
  const userIds = new Set(
    rows.flatMap((row) => {
      const entry = toAuditEntry(row)
      const referenced = [row.user_id]
      if (entry.action_type === 72) referenced.push(entry.target_id)
      else {
        // An invite is described only by `changes`; its inviter is a
        // referenced user, so clients can resolve it from `users`.
        for (const change of entry.changes) {
          if (change.key === 'inviter_id') referenced.push(change.old_value)
        }
      }
      return referenced
    })
  )
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
