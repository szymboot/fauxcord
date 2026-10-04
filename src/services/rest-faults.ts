import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import {
  isRestFaultPagePath,
  normalizeRestFaultQuery,
  type RestFaultRequest,
} from '../validators/rest-fault'

/** Stored fault counters retained after exhaustion until cancellation or reset. */
export interface RestFault extends RestFaultRequest {
  id: string
  guild_id: string
  channel_id: string | null
  remaining: number
  consumed: number
}

/** SQLite representation; legacy selectors use an empty query key. */
interface StoredRestFault extends Omit<RestFault, 'query'> {
  query: string
}

/** Exposes canonical page queries without changing legacy response shapes. */
function deserializeFault(
  row: StoredRestFault | undefined
): RestFault | undefined {
  if (!row) return undefined
  const { query, ...fault } = row
  return {
    ...fault,
    ...(query && { query: JSON.parse(query) as RestFaultRequest['query'] }),
  }
}

/** Resolves ownership and inserts a control inside the caller's transaction. */
function insertRestFault(
  db: Database,
  request: RestFaultRequest
): RestFault | 'UNKNOWN_SCOPE' | 'CONFLICT' {
  const query = request.query ? JSON.stringify(request.query) : ''
  const parts = request.path.split('/')
  const channelId = parts[1] === 'channels' ? parts[2] : null
  const guild = channelId
    ? (db
        .prepare(
          `SELECT g.id, g.bot_token FROM channels c
          JOIN guilds g ON g.id = c.guild_id WHERE c.id = ?`
        )
        .get(channelId) as { id: string; bot_token: string } | undefined)
    : (db
        .prepare('SELECT id, bot_token FROM guilds WHERE id = ?')
        .get(parts[1] === 'users' ? request.guild_id : parts[2]) as
        { id: string; bot_token: string } | undefined)
  if (!guild?.id) return 'UNKNOWN_SCOPE'
  if (
    db
      .prepare(
        `SELECT f.id FROM test_rest_faults f JOIN guilds g ON g.id = f.guild_id
         WHERE f.method = ? AND f.path = ? AND f.query = ? AND f.remaining > 0
         AND (f.method != 'GET' OR g.bot_token = ?)`
      )
      .get(request.method, request.path, query, guild.bot_token)
  )
    return 'CONFLICT'
  const id = generateSnowflake()
  db.prepare(
    `INSERT INTO test_rest_faults
    (id, guild_id, channel_id, method, path, query, status, code, message, times, remaining)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    guild.id,
    channelId,
    request.method,
    request.path,
    query,
    request.status,
    request.code,
    request.message,
    request.times,
    request.times
  )
  return {
    ...request,
    id,
    guild_id: guild.id,
    channel_id: channelId,
    remaining: request.times,
    consumed: 0,
  }
}

/** Arms an exact request within a guild; GET duplicates are scoped to its bot. */
export function createRestFault(
  db: Database,
  request: RestFaultRequest
): RestFault | 'UNKNOWN_SCOPE' | 'CONFLICT' {
  // Serialize conflict checking and insertion across SQLite connections.
  return db.transaction(() => insertRestFault(db, request)).immediate()
}

/** Retrieves one control's configuration and exact consumption counters. */
export function getRestFault(db: Database, id: string): RestFault | undefined {
  return deserializeFault(
    db.prepare('SELECT * FROM test_rest_faults WHERE id = ?').get(id) as
      StoredRestFault | undefined
  )
}

/** Cancels a control and removes its retained consumption history. */
export function deleteRestFault(db: Database, id: string): boolean {
  return (
    db.prepare('DELETE FROM test_rest_faults WHERE id = ?').run(id).changes > 0
  )
}

/** Atomically consumes one matching attempt, with no ordinary route side effects. */
export function consumeRestFault(
  db: Database,
  method: string,
  path: string,
  botToken?: string,
  search = new URLSearchParams()
): RestFault | undefined {
  let query = ''
  if (method === 'GET' && isRestFaultPagePath(path)) {
    const values: Record<string, string> = {}
    for (const key of ['limit', 'after', 'before', 'around']) {
      const entries = search.getAll(key)
      if (entries.length > 1) return undefined
      const first = entries.at(0)
      if (first !== undefined) values[key] = first
    }
    const normalized = normalizeRestFaultQuery(path, values)
    if (!normalized) return undefined
    query = JSON.stringify(normalized)
  }
  // SQLite's single statement is atomic, including concurrent HTTP attempts.
  return deserializeFault(
    db
      .prepare(
        `UPDATE test_rest_faults
    SET remaining = remaining - 1, consumed = consumed + 1
    WHERE id = (
      SELECT f.id FROM test_rest_faults f JOIN guilds g ON g.id = f.guild_id
      WHERE f.method = ? AND f.path = ? AND f.query = ? AND f.remaining > 0
      AND (f.method != 'GET' OR g.bot_token = ?)
      LIMIT 1
    )
    RETURNING *`
      )
      .get(method, path, query, botToken ?? null) as StoredRestFault | undefined
  )
}

/** Clears controls and history globally or only in a bot's current guilds. */
export function resetRestFaults(db: Database, token?: string): void {
  if (token) {
    db.prepare(
      `DELETE FROM test_rest_faults WHERE guild_id IN
      (SELECT id FROM guilds WHERE bot_token = ?)`
    ).run(token)
  } else {
    db.exec('DELETE FROM test_rest_faults')
  }
}
