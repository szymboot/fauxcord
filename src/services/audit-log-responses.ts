import { createHash } from 'node:crypto'
import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import { normalizeAuditResponseQuery } from '../validators/audit-log-response'
import type {
  AuditLogResponseRequest,
  AuditResponseOwnership,
  AuditResponseValue,
} from '../validators/audit-log-response'

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

/** Durable reservation; a null response ID means cleanup permanently closed it. */
interface StoredOwnership extends AuditResponseOwnership {
  token_hash: string
  response_id: string | null
}

/** Hashes the exact token so reservations do not retain plaintext credentials. */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Compares JSON by value while retaining array order and unusual object keys. */
function canonicalJson(value: AuditResponseValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return Array.isArray(value)
    ? '[' + value.map((child) => canonicalJson(child)).join(',') + ']'
    : '{' +
        Object.keys(value)
          .toSorted(
            (left, right) => Number(left > right) - Number(left < right)
          )
          .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
          .join(',') +
        '}'
}

/** Resolves the selected bot's exact current guild token. */
function scopeToken(
  db: Database,
  scope: { bot_id: string; guild_id: string }
): string | undefined {
  const row = db
    .prepare(
      `SELECT b.token FROM guilds g JOIN bots b ON b.token = g.bot_token
    WHERE g.id = ? AND b.user_id = ?`
    )
    .get(scope.guild_id, scope.bot_id) as { token: string } | undefined
  return row?.token
}

/** Looks up a reservation independently of the control's lifetime. */
function getOwnership(db: Database, key: string): StoredOwnership | undefined {
  return db
    .prepare(
      'SELECT * FROM test_audit_log_response_owners WHERE ownership_key = ?'
    )
    .get(key) as StoredOwnership | undefined
}

/** Checks immutable scope without requiring the guild or token to still exist. */
function sameScope(
  owner: StoredOwnership,
  scope: Pick<AuditResponseOwnership, 'bot_id' | 'guild_id'>
): boolean {
  return owner.bot_id === scope.bot_id && owner.guild_id === scope.guild_id
}

/** Deserializes bounded data and computes lifecycle without changing counters. */
function deserialize(
  db: Database,
  row: StoredAuditLogResponse | undefined
): AuditLogResponse | undefined {
  const owner = row
    ? (db
        .prepare(
          'SELECT ownership_key FROM test_audit_log_response_owners WHERE response_id = ?'
        )
        .get(row.id) as { ownership_key: string } | undefined)
    : undefined
  return row
    ? {
        ...row,
        ...(owner && { ownership_key: owner.ownership_key }),
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

/** Reads retained evidence, including exhausted and expired controls. */
export function getAuditLogResponse(
  db: Database,
  id: string
): AuditLogResponse | undefined {
  return deserialize(
    db,
    db
      .prepare('SELECT * FROM test_audit_log_responses WHERE id = ?')
      .get(id) as StoredAuditLogResponse | undefined
  )
}

/** Arms an exact audit read for the selected guild's current owner bot. */
export function createAuditLogResponse(
  db: Database,
  request: AuditLogResponseRequest
): AuditLogResponse | 'UNKNOWN_SCOPE' | 'CONFLICT' {
  return db
    .transaction((): AuditLogResponse | 'UNKNOWN_SCOPE' | 'CONFLICT' => {
      const owner = request.ownership_key
        ? getOwnership(db, request.ownership_key)
        : undefined
      if (owner && (!sameScope(owner, request) || !owner.response_id))
        return 'CONFLICT'
      const token = scopeToken(db, request)
      if (!token) return owner ? 'CONFLICT' : 'UNKNOWN_SCOPE'
      if (owner?.response_id) {
        const existing = getAuditLogResponse(db, owner.response_id)
        return existing &&
          owner.token_hash === tokenHash(token) &&
          JSON.stringify(existing.query) === JSON.stringify(request.query) &&
          canonicalJson(existing.entries) === canonicalJson(request.entries) &&
          existing.times === request.times &&
          existing.ttl_ms === request.ttl_ms
          ? existing
          : 'CONFLICT'
      }
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
      if (request.ownership_key) {
        db.prepare(
          `INSERT INTO test_audit_log_response_owners
          (ownership_key, bot_id, guild_id, token_hash, response_id) VALUES (?, ?, ?, ?, ?)`
        ).run(
          request.ownership_key,
          request.bot_id,
          request.guild_id,
          tokenHash(token),
          id
        )
      }
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
    db,
    db
      .prepare(
        `UPDATE test_audit_log_responses
    SET remaining = remaining - 1, consumed = consumed + 1, consumed_at = ?
    WHERE id = (
      SELECT r.id FROM test_audit_log_responses r
      JOIN guilds g ON g.id = r.guild_id JOIN bots b ON b.token = g.bot_token
      WHERE r.guild_id = ? AND r.bot_id = b.user_id AND b.token = ?
      AND NOT EXISTS (SELECT 1 FROM test_audit_log_response_owners o
        WHERE o.response_id = r.id AND o.token_hash <> ?)
      AND r.query = ? AND r.remaining > 0 AND r.expires_at > ? LIMIT 1
    ) RETURNING *`
      )
      .get(
        now,
        guildId,
        token,
        tokenHash(token),
        JSON.stringify(query),
        now
      ) as StoredAuditLogResponse | undefined
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

/** Recovers retained configuration and evidence using only a known key and scope. */
export function getAuditLogResponseByKey(
  db: Database,
  scope: AuditResponseOwnership
): AuditLogResponse | undefined {
  const owner = getOwnership(db, scope.ownership_key)
  return owner && sameScope(owner, scope) && owner.response_id
    ? getAuditLogResponse(db, owner.response_id)
    : undefined
}

/** Closes a key atomically, including when cleanup arrives before an ambiguous POST. */
export function deleteAuditLogResponseByKey(
  db: Database,
  scope: AuditResponseOwnership
): boolean {
  return db
    .transaction(() => {
      const owner = getOwnership(db, scope.ownership_key)
      if (owner) {
        if (!sameScope(owner, scope)) return false
        if (owner.response_id) deleteAuditLogResponse(db, owner.response_id)
        return true
      }
      const token = scopeToken(db, scope)
      if (!token) return false
      db.prepare(
        `INSERT INTO test_audit_log_response_owners
      (ownership_key, bot_id, guild_id, token_hash) VALUES (?, ?, ?, ?)`
      ).run(scope.ownership_key, scope.bot_id, scope.guild_id, tokenHash(token))
      return true
    })
    .immediate()
}
