import path from 'node:path'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
  /** Present only for explicit bounded modes. */
  state?: 'armed' | 'delaying' | 'exhausted' | 'expired'
  expires_at?: string
  outcomes?: RestFaultOutcomes
}

/** SQLite representation; legacy selectors use an empty query key. */
interface StoredRestFault extends Omit<
  RestFault,
  'query' | 'expires_at' | 'outcomes'
> {
  query: string
  options: string
  outcomes: string
  expires_at: number
  owner_token: string | null
  pending_owners: string
}

/** Completed and in-flight attempt evidence for explicit fault modes. */
export interface RestFaultOutcomes {
  pending: number
  delayed: number
  responded: number
  cancelled: number
  disconnected: number
}

/** Creates independent zeroed counters for a bounded control. */
function emptyOutcomes(): RestFaultOutcomes {
  return { pending: 0, delayed: 0, responded: 0, cancelled: 0, disconnected: 0 }
}

/** Resources for one delayed attempt, removed as soon as it finishes. */
interface PendingAttempt {
  id: string
  finish: (outcome: 'responded' | 'cancelled' | 'disconnected') => void
  timer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
}

/** Runtime identities are retained only while they own live resources. */
const activeOwners = new Map<string, RestFaultRuntime>()

/** Persisted resource owner, never exposed by the control API. */
interface PendingOwner {
  pid: number
  count: number
}

/** Checks whether a process can still own a delay without sending it a signal. */
function ownerIsAlive(id: string, owner: PendingOwner): boolean {
  if (owner.pid === process.pid)
    return activeOwners.get(id)?.ownsPending() ?? false
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Recovers abandoned waits while preserving live owners on other connections. */
export function recoverRestFaultOutcomes(db: Database): void {
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, outcomes, pending_owners FROM test_rest_faults
      WHERE COALESCE(json_extract(outcomes, '$.pending'), 0) > 0`
      )
      .all() as {
      id: string
      outcomes: string
      pending_owners: string
    }[]
    for (const row of rows) {
      const outcomes = {
        ...emptyOutcomes(),
        ...JSON.parse(row.outcomes),
      } as RestFaultOutcomes
      const owners = JSON.parse(row.pending_owners) as Record<
        string,
        PendingOwner
      >
      const live: Record<string, PendingOwner> = {}
      let pending = 0
      for (const [id, owner] of Object.entries(owners)) {
        if (!ownerIsAlive(id, owner)) {
          continue
        }

        live[id] = owner
        pending += owner.count
      }
      if (pending === outcomes.pending) continue
      outcomes.cancelled += outcomes.pending - pending
      outcomes.pending = pending
      db.prepare(
        'UPDATE test_rest_faults SET outcomes = ?, pending_owners = ? WHERE id = ?'
      ).run(JSON.stringify(outcomes), JSON.stringify(live), row.id)
    }
  }).immediate()
}

/** Owns only live request resources; configuration and counters stay in SQLite. */
export class RestFaultRuntime {
  private pending = new Set<PendingAttempt>()
  private ownerId = randomUUID()
  private monitor?: ReturnType<typeof setInterval>
  private databaseKey: Database | string
  isClosed = false

  /** Associates resources with the existing database-scoped fault system. */
  constructor(private db: Database) {
    this.databaseKey = db
    if (db.name && db.name !== ':memory:') {
      try {
        this.databaseKey = realpathSync(db.name)
      } catch {
        // SQLite connections can outlive unlinked database files.
        this.databaseKey = path.resolve(db.name)
      }
    }
  }

  /** Distinguishes a live local resource owner from a crashed/closed connection. */
  ownsPending(): boolean {
    return this.db.open && this.pending.size > 0
  }

  /** Updates counters and pending ownership in one SQLite transaction. */
  record(id: string, changes: Partial<RestFaultOutcomes>): void {
    if (!this.db.open) return
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `UPDATE test_rest_faults SET outcomes = json_set(outcomes,
      '$.pending', COALESCE(json_extract(outcomes, '$.pending'), 0) + ?,
      '$.delayed', COALESCE(json_extract(outcomes, '$.delayed'), 0) + ?,
      '$.responded', COALESCE(json_extract(outcomes, '$.responded'), 0) + ?,
      '$.cancelled', COALESCE(json_extract(outcomes, '$.cancelled'), 0) + ?,
      '$.disconnected', COALESCE(json_extract(outcomes, '$.disconnected'), 0) + ?)
      WHERE id = ?`
          )
          .run(
            changes.pending ?? 0,
            changes.delayed ?? 0,
            changes.responded ?? 0,
            changes.cancelled ?? 0,
            changes.disconnected ?? 0,
            id
          )
        if (!changes.pending) return
        const ownerPath = `$."${this.ownerId}"`
        this.db
          .prepare(
            `UPDATE test_rest_faults SET pending_owners =
          CASE WHEN COALESCE(json_extract(pending_owners, ?), 0) + ? <= 0
          THEN json_remove(pending_owners, ?)
          ELSE json_set(pending_owners, ?, json_object('pid', ?, 'count',
            COALESCE(json_extract(pending_owners, ?), 0) + ?)) END
          WHERE id = ?`
          )
          .run(
            ownerPath + '.count',
            changes.pending,
            ownerPath,
            ownerPath,
            process.pid,
            ownerPath + '.count',
            changes.pending,
            id
          )
      })
      .immediate()
  }

  /** Cancels live handlers immediately after their scope/control is removed. */
  prune(): void {
    for (const owner of activeOwners.values()) {
      if (owner.databaseKey !== this.databaseKey) continue
      if (owner.db.open) owner.pruneOwn()
      else owner.shutdown(false)
    }
  }

  /** Checks only this connection's resources after shared-file invalidation. */
  private pruneOwn(): void {
    for (const attempt of this.pending) {
      const row = this.db
        .prepare('SELECT expires_at FROM test_rest_faults WHERE id = ?')
        .get(attempt.id) as { expires_at: number } | undefined
      if (!row || row.expires_at <= Date.now()) attempt.finish('cancelled')
    }
  }

  /** Waits before an error response, never resuming the mutating route. */
  async delay(fault: RestFault, signal: AbortSignal): Promise<void> {
    recoverRestFaultOutcomes(this.db)
    const reserved =
      !this.isClosed &&
      this.db
        .transaction(() => {
          const row = this.db
            .prepare(
              `SELECT COALESCE(SUM(json_extract(outcomes, '$.pending')), 0) AS pending FROM test_rest_faults`
            )
            .get() as { pending: number }
          if (row.pending >= 256) return false
          this.record(fault.id, { pending: 1, delayed: 1 })
          return true
        })
        .immediate()
    if (!reserved) {
      this.record(fault.id, { cancelled: 1 })
      return
    }
    await new Promise<void>((resolve) => {
      let finished = false
      const deadline = Date.parse(fault.expires_at ?? '') - Date.now()
      const delay = fault.delay_ms ?? 0
      const attempt: PendingAttempt = {
        id: fault.id,
        finish: (outcome) => {
          if (finished) return
          finished = true
          clearTimeout(attempt.timer)
          if (attempt.onAbort)
            signal.removeEventListener('abort', attempt.onAbort)
          this.pending.delete(attempt)
          if (this.pending.size === 0) {
            activeOwners.delete(this.ownerId)
            clearInterval(this.monitor)
            this.monitor = undefined
          }
          this.record(fault.id, { pending: -1, [outcome]: 1 })
          resolve()
        },
      }
      attempt.onAbort = () => {
        attempt.finish('disconnected')
      }
      attempt.timer = setTimeout(
        () => {
          attempt.finish(deadline <= delay ? 'cancelled' : 'responded')
        },
        Math.max(0, Math.min(delay, deadline))
      )
      attempt.timer.unref()
      this.pending.add(attempt)
      activeOwners.set(this.ownerId, this)
      this.monitor ??= setInterval(() => {
        if (this.db.open) this.pruneOwn()
        else this.shutdown(false)
      }, 25)
      this.monitor.unref()
      signal.addEventListener('abort', attempt.onAbort, { once: true })
      if (this.isClosed) attempt.finish('cancelled')
      else if (signal.aborted) attempt.onAbort()
    })
  }

  /** Releases every live delay before server drain and prohibits new controls. */
  shutdown(disarm = true): void {
    this.isClosed = true
    if (disarm && this.db.open)
      this.db
        .prepare(
          'UPDATE test_rest_faults SET remaining = 0 WHERE owner_token IS NOT NULL'
        )
        .run()
    for (const attempt of this.pending) attempt.finish('cancelled')
  }
}

const runtimes = new WeakMap<Database, RestFaultRuntime>()

/** Returns the resource owner shared by middleware and all cleanup paths. */
export function getRestFaultRuntime(db: Database): RestFaultRuntime {
  let runtime = runtimes.get(db)
  if (!runtime) {
    runtime = new RestFaultRuntime(db)
    runtimes.set(db, runtime)
  }
  return runtime
}

/** Expires unused attempts and cancels deleted or reassigned ownership. */
export function pruneRestFaults(db: Database): void {
  recoverRestFaultOutcomes(db)
  db.prepare(
    `DELETE FROM test_rest_faults WHERE owner_token IS NOT NULL AND
    (owner_token != (SELECT bot_token FROM guilds WHERE id = guild_id)
      OR (channel_id IS NOT NULL AND guild_id !=
        (SELECT guild_id FROM channels WHERE id = channel_id)))`
  ).run()
  db.prepare(
    `UPDATE test_rest_faults SET remaining = 0
    WHERE expires_at > 0 AND expires_at <= ? AND remaining > 0`
  ).run(Date.now())
  getRestFaultRuntime(db).prune()
}

/** Exposes canonical page queries without changing legacy response shapes. */
function deserializeFault(
  row: StoredRestFault | undefined
): RestFault | undefined {
  if (!row) return undefined
  const { query, options, outcomes, expires_at: expiresAt } = row
  const fault = {
    id: row.id,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    method: row.method,
    path: row.path,
    status: row.status,
    code: row.code,
    message: row.message,
    times: row.times,
    remaining: row.remaining,
    consumed: row.consumed,
  }
  // Ownership credentials are never exposed by the control API.
  const configuration = JSON.parse(options) as Partial<RestFaultRequest>
  const evidence = {
    ...emptyOutcomes(),
    ...JSON.parse(outcomes),
  } as RestFaultOutcomes
  return {
    ...fault,
    ...configuration,
    ...(configuration.mode && {
      expires_at: new Date(expiresAt).toISOString(),
      outcomes: evidence,
      state:
        evidence.pending > 0
          ? 'delaying'
          : Date.now() >= expiresAt
            ? 'expired'
            : fault.remaining === 0
              ? 'exhausted'
              : 'armed',
    }),
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
    (id, guild_id, channel_id, method, path, query, status, code, message, times, remaining, options, expires_at, owner_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    request.times,
    JSON.stringify(
      request.mode
        ? {
            mode: request.mode,
            timeout_ms: request.timeout_ms,
            retry_after: request.retry_after,
            global: request.global,
            delay_ms: request.delay_ms,
          }
        : {}
    ),
    request.mode ? Date.now() + (request.timeout_ms ?? 30_000) : 0,
    request.mode ? guild.bot_token : null
  )
  const result = deserializeFault(
    db
      .prepare('SELECT * FROM test_rest_faults WHERE id = ?')
      .get(id) as StoredRestFault
  )
  if (!result) throw new Error('Inserted REST fault is missing')
  return result
}

/** Arms an exact request within a guild; GET duplicates are scoped to its bot. */
export function createRestFault(
  db: Database,
  request: RestFaultRequest
): RestFault | 'UNKNOWN_SCOPE' | 'CONFLICT' {
  if (getRestFaultRuntime(db).isClosed) return 'CONFLICT'
  pruneRestFaults(db)
  // Serialize conflict checking and insertion across SQLite connections.
  return db.transaction(() => insertRestFault(db, request)).immediate()
}

/** Retrieves one control's configuration and exact consumption counters. */
export function getRestFault(db: Database, id: string): RestFault | undefined {
  pruneRestFaults(db)
  return deserializeFault(
    db.prepare('SELECT * FROM test_rest_faults WHERE id = ?').get(id) as
      StoredRestFault | undefined
  )
}

/** Cancels a control and removes its retained consumption history. */
export function deleteRestFault(db: Database, id: string): boolean {
  const deleted =
    db.prepare('DELETE FROM test_rest_faults WHERE id = ?').run(id).changes > 0
  getRestFaultRuntime(db).prune()
  return deleted
}

/** Atomically consumes one matching attempt, with no ordinary route side effects. */
export function consumeRestFault(
  db: Database,
  method: string,
  path: string,
  botToken?: string,
  search = new URLSearchParams()
): RestFault | undefined {
  pruneRestFaults(db)
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
      AND (f.owner_token IS NULL OR f.owner_token = ?)
      LIMIT 1
    )
    RETURNING *`
      )
      .get(method, path, query, botToken ?? null, botToken ?? null) as
      StoredRestFault | undefined
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
  getRestFaultRuntime(db).prune()
}
