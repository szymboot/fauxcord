import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import type { RestFaultRequest } from '../validators/rest-fault'

/** Stored fault counters retained after exhaustion until cancellation or reset. */
export interface RestFault extends RestFaultRequest {
  id: string
  guild_id: string
  channel_id: string | null
  remaining: number
  consumed: number
}

/** Arms an exact request within an existing guild, rejecting active duplicates. */
export function createRestFault(
  db: Database,
  request: RestFaultRequest
): RestFault | 'UNKNOWN_SCOPE' | 'CONFLICT' {
  const parts = request.path.split('/')
  const channelId = parts[1] === 'channels' ? parts[2] : null
  const guild = channelId
    ? (db
        .prepare('SELECT guild_id AS id FROM channels WHERE id = ?')
        .get(channelId) as { id: string | null } | undefined)
    : (db.prepare('SELECT id FROM guilds WHERE id = ?').get(parts[2]) as
        { id: string } | undefined)
  if (!guild?.id) return 'UNKNOWN_SCOPE'
  if (
    db
      .prepare(
        'SELECT id FROM test_rest_faults WHERE method = ? AND path = ? AND remaining > 0'
      )
      .get(request.method, request.path)
  )
    return 'CONFLICT'
  const id = generateSnowflake()
  db.prepare(
    `INSERT INTO test_rest_faults
    (id, guild_id, channel_id, method, path, status, code, message, times, remaining)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    guild.id,
    channelId,
    request.method,
    request.path,
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

/** Retrieves one control's configuration and exact consumption counters. */
export function getRestFault(db: Database, id: string): RestFault | undefined {
  return db.prepare('SELECT * FROM test_rest_faults WHERE id = ?').get(id) as
    RestFault | undefined
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
  path: string
): RestFault | undefined {
  // SQLite's single statement is atomic, including concurrent HTTP attempts.
  return db
    .prepare(
      `UPDATE test_rest_faults
    SET remaining = remaining - 1, consumed = consumed + 1
    WHERE method = ? AND path = ? AND remaining > 0
    RETURNING *`
    )
    .get(method, path) as RestFault | undefined
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
