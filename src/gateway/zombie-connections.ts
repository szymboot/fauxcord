import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Database } from '../db'
import type { Session, SessionManager } from './session'
import { GatewayCloseCode } from './opcodes'

/** Maximum live zombie records per Gateway instance. */
const MAX_LIVE = 32
/** Maximum ownership reservations (active, retired and tombstoned). */
const MAX_OWNERS = 4096
/** Maximum concurrent long-poll waiters per Gateway instance. */
const MAX_WAITERS = 64
/** Evidence retention after the zombie phase ended (ms). */
export const ZOMBIE_RETENTION_MS = 120_000

/** Validated request; `ownership_key` is optional. */
export interface ZombieConnectionRequest {
  ownership_key?: string
  bot_id: string
  guild_id: string
  session_id: string
  /** Maximum zombie duration (ms); the server closes the socket after it. */
  ttl_ms: number
}

/** Exact public owner address known before sending a keyed POST. */
export interface ZombieConnectionOwnership {
  ownership_key: string
  bot_id: string
  guild_id: string
  session_id: string
}

/** Lifecycle of one zombie connection record. */
type ZombieStatus = 'zombie' | 'awaiting_resume' | 'resumed' | 'session_lost'

/** Why the zombie phase ended. */
type ZombieEnd =
  'client_close' | 'end' | 'ttl' | 'resume' | 'session_removed' | 'canceled'

/** First/last sequence of a contiguous set of dispatches. */
interface SequenceRange {
  count: number
  first_sequence: number | null
  last_sequence: number | null
}

/** One silenced connection and the evidence of its detection and RESUME. */
interface ZombieRecord {
  id: string
  ownership_key?: string
  bot_id: string
  guild_id: string
  session_id: string
  ttl_ms: number
  /** Normalized setup token of the session (never exposed). */
  token: string
  session: Session
  socket: WebSocket
  status: ZombieStatus
  sequence: number
  started_at: number
  zombie_expires_at: number
  expires_at: number
  last_ack_at: number | null
  heartbeats_unacknowledged: number
  last_heartbeat_at: number | null
  last_heartbeat_sequence: number | null
  dispatches_withheld: SequenceRange
  ended_at: number | null
  ended_by: ZombieEnd | null
  close: {
    at: number
    code: number
    initiated_by: 'client' | 'server'
  } | null
  resume: {
    at: number
    client_sequence: number
    replayed: SequenceRange
    resumed_sequence: number
  } | null
  session_removed_at: number | null
  timer: NodeJS.Timeout
  onClose: (code: number) => void
}

/** Bounded lifetime reservation; a null ID permanently prevents resurrection. */
interface OwnershipReservation extends ZombieConnectionOwnership {
  ttl_ms?: number
  id: string | null
}

/** Normalizes IDENTIFY tokens to the stored "Bot "-prefixed setup form. */
function normalizeToken(token: string): string {
  return token.startsWith('Bot ') ? token : `Bot ${token}`
}

/** Compares the complete immutable public owner address. */
function sameOwner(
  owner: ZombieConnectionOwnership,
  scope: ZombieConnectionOwnership
): boolean {
  return (
    owner.bot_id === scope.bot_id &&
    owner.guild_id === scope.guild_id &&
    owner.session_id === scope.session_id
  )
}

/** Summarizes an ordered list of sequences. */
function rangeOf(sequences: number[]): SequenceRange {
  return {
    count: sequences.length,
    first_sequence: sequences.at(0) ?? null,
    last_sequence: sequences.at(-1) ?? null,
  }
}

/** Whether no further protocol evidence can arrive for this record. */
function isSettled(record: ZombieRecord): boolean {
  return record.status === 'resumed' || record.status === 'session_lost'
}

/**
 * Test-only control that turns one exact live Gateway connection into a
 * "zombie": the socket stays open, but the server stops answering heartbeats
 * and stops writing dispatches, which are buffered for RESUME instead.
 */
export class GatewayZombieConnections {
  private readonly records = new Map<string, ZombieRecord>()
  private readonly owners = new Map<string, OwnershipReservation>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private waiterCount = 0

  /** Installs heartbeat, dispatch, RESUME and removal observers. */
  constructor(
    private readonly db: Database,
    private readonly manager: SessionManager
  ) {
    manager.observeSilencedHeartbeat = (session, sequence) => {
      const record = this.zombieOf(session)
      if (!record) return
      record.heartbeats_unacknowledged += 1
      record.last_heartbeat_at = Date.now()
      record.last_heartbeat_sequence =
        typeof sequence === 'number' ? sequence : null
      this.notify(record.id)
    }
    manager.observeSilencedDispatch = (session, payload) => {
      const record = this.zombieOf(session)
      if (!record || typeof payload.s !== 'number') return
      const withheld = record.dispatches_withheld
      withheld.count += 1
      withheld.first_sequence ??= payload.s
      withheld.last_sequence = payload.s
      this.notify(record.id)
    }
    manager.observeResume = (session, facts) => {
      for (const record of this.records.values()) {
        if (record.session !== session || isSettled(record)) continue
        if (record.status === 'zombie') {
          // The client resumed on a new connection without closing the
          // silenced one; that dead connection is dropped.
          this.endZombie(record, 'resume', true)
        }
        record.status = 'resumed'
        record.resume = {
          at: Date.now(),
          client_sequence: facts.clientSequence,
          replayed: rangeOf(facts.replayedSequences),
          resumed_sequence: facts.resumedSequence,
        }
        this.notify(record.id)
      }
    }
    manager.onRemove((session) => {
      for (const record of this.records.values()) {
        if (record.session !== session || isSettled(record)) continue
        if (record.status === 'zombie') {
          this.endZombie(record, 'session_removed', false)
          this.dropOrphan(record)
        }
        record.status = 'session_lost'
        record.session_removed_at = Date.now()
        this.notify(record.id)
      }
    })
  }

  /**
   * Closes a formerly silenced socket whose session was removed (e.g. its
   * RESUME on another connection was rejected), unless the same socket has
   * just IDENTIFYed a new session, which happens synchronously after removal.
   * Close code 4009 tells the client its session is gone.
   * @param record - Record whose session was removed
   */
  private dropOrphan(record: ZombieRecord): void {
    const { socket } = record
    queueMicrotask(() => {
      if (
        socket.readyState !== WebSocket.OPEN ||
        this.manager.getAll().some((session) => session.ws === socket)
      )
        return
      record.close ??= {
        at: Date.now(),
        code: GatewayCloseCode.SessionTimedOut,
        initiated_by: 'server',
      }
      try {
        socket.close(
          GatewayCloseCode.SessionTimedOut,
          'Session no longer valid'
        )
      } catch {
        // Already closing; nothing else to release.
      }
      this.notify(record.id)
    })
  }

  /** Returns the record currently silencing the session's connection. */
  private zombieOf(session: Session): ZombieRecord | undefined {
    return this.records
      .values()
      .find(
        (record) =>
          record.session === session &&
          record.status === 'zombie' &&
          record.socket === session.ws
      )
  }

  /** Whether the bot is the registered owner of the guild's setup. */
  private botOwnsGuild(
    botId: string,
    guildId: string,
    token?: string
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ? AND g.bot_present = 1 AND b.user_id = ?' +
            (token === undefined ? '' : ' AND b.token = ?')
        )
        .get(guildId, botId, ...(token === undefined ? [] : [token]))
    )
  }

  /** Whether a registered session belongs to the bot and guild setup scope. */
  private inScope(
    session: Session,
    scope: Pick<ZombieConnectionRequest, 'bot_id' | 'guild_id'>
  ): boolean {
    return (
      session.botId === scope.bot_id &&
      this.botOwnsGuild(
        scope.bot_id,
        scope.guild_id,
        normalizeToken(session.token)
      )
    )
  }

  /**
   * Silences one exact live connection, or returns the existing record for an
   * identical keyed retry.
   * @param request - Validated request
   * @returns The public record, or an error code
   */
  create(request: ZombieConnectionRequest): string | object {
    if (request.ownership_key !== undefined) {
      const owner = this.owners.get(request.ownership_key)
      if (owner) {
        return sameOwner(owner, request as ZombieConnectionOwnership) &&
          owner.ttl_ms === request.ttl_ms &&
          owner.id
          ? (this.inspect(owner.id) ?? 'CONFLICT')
          : 'CONFLICT'
      }
      if (this.owners.size >= MAX_OWNERS) return 'LIMIT'
    }
    const session = this.manager.get(request.session_id)
    if (!session || !this.inScope(session, request)) return 'UNKNOWN_SCOPE'
    if (
      session.ws.readyState !== WebSocket.OPEN ||
      this.manager.isSilenced(session.ws)
    )
      return 'INVALID_STATE'
    if (this.records.size >= MAX_LIVE) return 'LIMIT'

    const id = randomUUID()
    const now = Date.now()
    const timer = setTimeout(() => {
      this.expire(id)
    }, request.ttl_ms)
    timer.unref()
    const socket = session.ws
    /** Records how and when the silenced connection closed. */
    const onClose = (code: number): void => {
      const record = this.records.get(id)
      if (!record) return
      // Server-initiated drops are recorded before closing, so a close that
      // arrives while still silenced was started by the client.
      const byClient = record.status === 'zombie'
      if (byClient) this.endZombie(record, 'client_close')
      record.close ??= {
        at: Date.now(),
        code,
        initiated_by: byClient ? 'client' : 'server',
      }
      this.notify(id)
    }
    const record: ZombieRecord = {
      ...request,
      id,
      token: normalizeToken(session.token),
      session,
      socket,
      status: 'zombie',
      sequence: session.seq,
      started_at: now,
      zombie_expires_at: now + request.ttl_ms,
      expires_at: now + request.ttl_ms + ZOMBIE_RETENTION_MS,
      last_ack_at: session.lastHeartbeatAckAt ?? null,
      heartbeats_unacknowledged: 0,
      last_heartbeat_at: null,
      last_heartbeat_sequence: null,
      dispatches_withheld: rangeOf([]),
      ended_at: null,
      ended_by: null,
      close: null,
      resume: null,
      session_removed_at: null,
      timer,
      onClose,
    }
    this.records.set(id, record)
    if (request.ownership_key !== undefined) {
      this.owners.set(request.ownership_key, {
        ownership_key: request.ownership_key,
        bot_id: request.bot_id,
        guild_id: request.guild_id,
        session_id: request.session_id,
        ttl_ms: request.ttl_ms,
        id,
      })
    }
    socket.once('close', onClose)
    this.manager.silence(socket)
    return this.inspect(id) ?? 'CONFLICT'
  }

  /**
   * Ends the zombie phase. When the connection is still open the server
   * drops it with close code 4000 (Unknown error, reconnect allowed), so the
   * client RESUMEs and receives the buffered dispatches.
   * @param record - Record in the `zombie` state
   * @param reason - Why the phase ended
   * @param closeSocket - Whether to drop a still-open connection
   */
  private endZombie(
    record: ZombieRecord,
    reason: ZombieEnd,
    closeSocket = true
  ): void {
    const now = Date.now()
    this.manager.unsilence(record.socket)
    record.status = 'awaiting_resume'
    record.ended_at = now
    record.ended_by = reason
    record.expires_at = now + ZOMBIE_RETENTION_MS
    clearTimeout(record.timer)
    record.timer = setTimeout(() => {
      this.retire(record.id)
    }, ZOMBIE_RETENTION_MS)
    record.timer.unref()
    if (closeSocket && record.socket.readyState === WebSocket.OPEN) {
      record.close = {
        at: now,
        code: GatewayCloseCode.UnknownError,
        initiated_by: 'server',
      }
      try {
        record.socket.close(
          GatewayCloseCode.UnknownError,
          'Zombie connection dropped'
        )
      } catch {
        // The socket may already be closing; the close listener still runs.
      }
    }
    this.notify(record.id)
  }

  /** TTL: ends an active zombie phase, or retires a finished record. */
  private expire(id: string): void {
    const record = this.records.get(id)
    if (!record) return
    if (record.status === 'zombie') this.endZombie(record, 'ttl')
    else this.retire(id)
  }

  /**
   * Explicitly ends an active zombie phase (server drops the connection).
   * @param id - Record ID
   * @returns The public record, or an error code
   */
  end(id: string): string | object {
    const record = this.records.get(id)
    if (!record) return 'UNKNOWN_SCOPE'
    if (record.status !== 'zombie') return 'INVALID_STATE'
    this.endZombie(record, 'end')
    return this.inspect(id) ?? 'UNKNOWN_SCOPE'
  }

  /** Returns public evidence only; never a token or socket. */
  inspect(id: string): object | undefined {
    const record = this.records.get(id)
    return record
      ? structuredClone({
          id: record.id,
          ...(record.ownership_key !== undefined && {
            ownership_key: record.ownership_key,
          }),
          bot_id: record.bot_id,
          guild_id: record.guild_id,
          session_id: record.session_id,
          status: record.status,
          ttl_ms: record.ttl_ms,
          sequence: record.sequence,
          started_at: record.started_at,
          zombie_expires_at: record.zombie_expires_at,
          expires_at: record.expires_at,
          last_ack_at: record.last_ack_at,
          heartbeats_unacknowledged: record.heartbeats_unacknowledged,
          last_heartbeat_at: record.last_heartbeat_at,
          last_heartbeat_sequence: record.last_heartbeat_sequence,
          dispatches_withheld: record.dispatches_withheld,
          ended_at: record.ended_at,
          ended_by: record.ended_by,
          close: record.close,
          resume: record.resume,
          session_removed_at: record.session_removed_at,
        })
      : undefined
  }

  /** Resolves the exact owner's live record ID by its pre-chosen key. */
  idByKey(scope: ZombieConnectionOwnership): string | null {
    const owner = this.owners.get(scope.ownership_key)
    return owner && sameOwner(owner, scope) ? owner.id : null
  }

  /**
   * Waits (bounded) until the record is settled (`resumed` or
   * `session_lost`) or retires, then inspects it.
   * @param id - Record ID
   * @param waitMs - Maximum wait
   * @returns The record, undefined when unknown, or LIMIT
   */
  async wait(
    id: string | null,
    waitMs: number
  ): Promise<object | undefined | 'LIMIT'> {
    const record = id ? this.records.get(id) : undefined
    if (!record) return undefined
    /** Whether the record retired or reached a final status. */
    const settled = (): boolean => {
      const current = this.records.get(record.id)
      return !current || isSettled(current)
    }
    if (waitMs === 0 || settled()) return this.inspect(record.id)
    if (this.waiterCount >= MAX_WAITERS) return 'LIMIT'
    this.waiterCount += 1
    const set = this.waiters.get(record.id) ?? new Set<() => void>()
    this.waiters.set(record.id, set)
    const woken = Promise.withResolvers<undefined>()
    /** Re-evaluates the settle condition after each observed change. */
    const check = (): void => {
      if (settled()) woken.resolve(undefined)
    }
    set.add(check)
    const timer = setTimeout(() => {
      woken.resolve(undefined)
    }, waitMs)
    timer.unref()
    try {
      await woken.promise
    } finally {
      clearTimeout(timer)
      set.delete(check)
      if (set.size === 0 && this.waiters.get(record.id) === set)
        this.waiters.delete(record.id)
      this.waiterCount -= 1
    }
    return this.inspect(record.id)
  }

  /** Wakes waiters of one record so they re-check their condition. */
  private notify(id: string): void {
    const checks = this.waiters.get(id) ?? []
    for (const check of checks) check()
  }

  /**
   * Ends an active zombie phase (dropping the connection) and retires the
   * record.
   * @param id - Record ID
   * @returns true when a record was retired
   */
  delete(id: string): boolean {
    const record = this.records.get(id)
    if (record?.status === 'zombie') this.endZombie(record, 'canceled')
    return this.retire(id)
  }

  /**
   * Closes ownership by key: retires an applied record, or tombstones an
   * unused key so a delayed POST can never silence a connection.
   * @param scope - Exact owner address
   * @returns DELETED, UNKNOWN_SCOPE or LIMIT
   */
  deleteByKey(
    scope: ZombieConnectionOwnership
  ): 'DELETED' | 'UNKNOWN_SCOPE' | 'LIMIT' {
    const owner = this.owners.get(scope.ownership_key)
    if (owner) {
      if (!sameOwner(owner, scope)) return 'UNKNOWN_SCOPE'
      if (owner.id) this.delete(owner.id)
      return 'DELETED'
    }
    const session = this.manager.get(scope.session_id)
    if (
      session
        ? !this.inScope(session, scope)
        : !this.botOwnsGuild(scope.bot_id, scope.guild_id)
    )
      return 'UNKNOWN_SCOPE'
    if (this.owners.size >= MAX_OWNERS) return 'LIMIT'
    this.owners.set(scope.ownership_key, { ...scope, id: null })
    return 'DELETED'
  }

  /** Drops evidence and wakes waiters; the ownership key stays closed. */
  private retire(id: string): boolean {
    const record = this.records.get(id)
    if (!record) return false
    clearTimeout(record.timer)
    record.socket.off('close', record.onClose)
    this.records.delete(id)
    if (record.ownership_key !== undefined) {
      const owner = this.owners.get(record.ownership_key)
      if (owner) owner.id = null
    }
    this.notify(id)
    return true
  }

  /**
   * Cancels all records, or those of one normalized setup token; an active
   * zombie connection is dropped so its client can RESUME.
   * @param token - Optional normalized setup token
   */
  reset(token?: string): void {
    for (const record of this.records.values()) {
      if (!token || record.token === token) this.delete(record.id)
    }
  }

  /**
   * Cancels records scoped to a deleted guild.
   * @param guildId - Deleted guild ID
   */
  deleteGuild(guildId: string): void {
    for (const record of this.records.values()) {
      if (record.guild_id === guildId) this.delete(record.id)
    }
  }
}
