import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import { normalizeAuditResponseQuery } from '../validators/audit-log-response'
import type { AuditLogResponseRequest } from '../validators/audit-log-response'

/** Public configuration and consumption evidence; no bot credentials. */
export interface AuditLogResponse extends AuditLogResponseRequest {
  id: string
  remaining: number
  consumed: number
  expires_at: string
  consumed_at: string | null
  state: 'armed' | 'exhausted' | 'expired'
}

/** Stored JSON selectors and entries, with a wall-clock expiration deadline. */
interface StoredAuditLogResponse extends Omit<
  AuditLogResponse,
  'query' | 'entries' | 'state'
> {
  query: string
  entries: string
}

/** Deserializes bounded data and computes lifecycle without changing counters. */
function deserialize(
  row: StoredAuditLogResponse | undefined
): AuditLogResponse | undefined {
  return row
    ? {
        ...row,
        query: JSON.parse(row.query) as AuditLogResponseRequest['query'],
        entries: JSON.parse(row.entries) as AuditLogResponseRequest['entries'],
        state:
          row.remaining === 0
            ? 'exhausted'
            : row.expires_at <= new Date().toISOString()
              ? 'expired'
              : 'armed',
      }
    : undefined
}

/** Arms an exact audit read for the selected guild's current owner bot. */
export function createAuditLogResponse(
  db: Database,
  request: AuditLogResponseRequest
): AuditLogResponse | 'UNKNOWN_SCOPE' | 'CONFLICT' {
  return db
    .transaction((): AuditLogResponse | 'UNKNOWN_SCOPE' | 'CONFLICT' => {
      const scope = db
        .prepare(
          `SELECT g.id FROM guilds g JOIN bots b ON b.token = g.bot_token
      WHERE g.id = ? AND b.user_id = ?`
        )
        .get(request.guild_id, request.bot_id)
      if (!scope) return 'UNKNOWN_SCOPE'
      const query = JSON.stringify(request.query)
      const now = new Date().toISOString()
      if (
        db
          .prepare(
            `SELECT id FROM test_audit_log_responses WHERE guild_id = ? AND bot_id = ?
      AND query = ? AND remaining > 0 AND expires_at > ?`
          )
          .get(request.guild_id, request.bot_id, query, now)
      )
        return 'CONFLICT'
      const id = generateSnowflake()
      const expiresAt = new Date(Date.now() + request.ttl_ms).toISOString()
      db.prepare(
        `INSERT INTO test_audit_log_responses
      (id, guild_id, bot_id, query, entries, times, ttl_ms, remaining, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        request.guild_id,
        request.bot_id,
        query,
        JSON.stringify(request.entries),
        request.times,
        request.ttl_ms,
        request.times,
        expiresAt
      )
      return {
        ...request,
        id,
        remaining: request.times,
        consumed: 0,
        expires_at: expiresAt,
        consumed_at: null,
        state: 'armed',
      }
    })
    .immediate()
}

/** Reads retained evidence, including exhausted and expired controls. */
export function getAuditLogResponse(
  db: Database,
  id: string
): AuditLogResponse | undefined {
  return deserialize(
    db
      .prepare('SELECT * FROM test_audit_log_responses WHERE id = ?')
      .get(id) as StoredAuditLogResponse | undefined
  )
}

/** Atomically claims only authenticated, valid, exact audit read queries. */
export function consumeAuditLogResponse(
  db: Database,
  guildId: string,
  token: string | undefined,
  search: URLSearchParams
): AuditLogResponse | undefined {
  for (const key of search.keys()) {
    if (search.getAll(key).length > 1) return undefined
  }
  const query = normalizeAuditResponseQuery(Object.fromEntries(search))
  if (!query || !token) return undefined
  const now = new Date().toISOString()
  return deserialize(
    db
      .prepare(
        `UPDATE test_audit_log_responses
    SET remaining = remaining - 1, consumed = consumed + 1, consumed_at = ?
    WHERE id = (
      SELECT r.id FROM test_audit_log_responses r
      JOIN guilds g ON g.id = r.guild_id JOIN bots b ON b.token = g.bot_token
      WHERE r.guild_id = ? AND r.bot_id = b.user_id AND b.token = ?
      AND r.query = ? AND r.remaining > 0 AND r.expires_at > ? LIMIT 1
    ) RETURNING *`
      )
      .get(now, guildId, token, JSON.stringify(query), now) as
      StoredAuditLogResponse | undefined
  )
}

/** Removes a control and its evidence; subsequent reads use ordinary fixtures. */
export function deleteAuditLogResponse(db: Database, id: string): boolean {
  return (
    db.prepare('DELETE FROM test_audit_log_responses WHERE id = ?').run(id)
      .changes > 0
  )
}

/** Clears controls and history globally or in one bot's guilds. */
export function resetAuditLogResponses(db: Database, token?: string): void {
  if (token)
    db.prepare(
      `DELETE FROM test_audit_log_responses WHERE guild_id IN
    (SELECT id FROM guilds WHERE bot_token = ?)`
    ).run(token)
  else db.exec('DELETE FROM test_audit_log_responses')
}
