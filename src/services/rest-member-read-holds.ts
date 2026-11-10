import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import type { RestMemberReadHoldRequest } from '../validators/rest-member-read-hold'

/** Observable lifecycle of a one-shot member-read snapshot hold. */
type HoldState =
  'armed' | 'holding' | 'released' | 'timed_out' | 'disconnected' | 'cancelled'

/** Request-arrival evidence for a held member read. */
export interface RestMemberReadHold extends RestMemberReadHoldRequest {
  id: string
  state: HoldState
  arrived: number
  arrived_at: string | null
  /** HTTP status of the captured snapshot; null until a request is held. */
  snapshot_status: number | null
  expires_at: string
  finished_at: string | null
}

/** Private in-process resources; never persisted or exposed by the API. */
interface HoldEntry {
  status: RestMemberReadHold
  token: string
  deadline: number
  timer: ReturnType<typeof setTimeout>
  /** True once a request owns this one-shot control. */
  claimed: boolean
  claimedAt?: string
  resume?: () => void
}

/** Opaque handle to a claimed control, held by the request middleware. */
export interface MemberReadClaim {
  readonly entry: HoldEntry
}

/** Manages one-shot member-read snapshot holds and their status evidence. */
export class RestMemberReadHolds {
  private entries = new Map<string, HoldEntry>()
  private closed = false

  /** Binds controls to one database's guild ownership. */
  constructor(private db: Database) {}

  /** Finishes once, disarming retries and clearing request/timer resources. */
  private finish(entry: HoldEntry, state: HoldState): void {
    if (!['armed', 'holding'].includes(entry.status.state)) return
    entry.status.state = state
    entry.status.finished_at = new Date().toISOString()
    clearTimeout(entry.timer)
    const resume = entry.resume
    entry.resume = undefined
    resume?.()
  }

  /** Removes controls whose guild has gone away or changed owner. */
  private prune(): void {
    for (const [id, entry] of this.entries) {
      const guild = this.db
        .prepare('SELECT bot_token FROM guilds WHERE id = ?')
        .get(entry.status.guild_id) as { bot_token: string } | undefined
      if (guild?.bot_token !== entry.token) {
        this.finish(entry, 'cancelled')
        this.entries.delete(id)
      } else if (Date.now() >= entry.deadline) {
        this.finish(entry, 'timed_out')
      }
    }
  }

  /** Arms a unique exact guild/user selector for the guild's owning bot. */
  create(
    request: RestMemberReadHoldRequest
  ): RestMemberReadHold | 'UNKNOWN_SCOPE' | 'CONFLICT' {
    if (this.closed) return 'CONFLICT'
    this.prune()
    const guild = this.db
      .prepare('SELECT bot_token FROM guilds WHERE id = ?')
      .get(request.guild_id) as { bot_token: string } | undefined
    if (!guild) return 'UNKNOWN_SCOPE'
    for (const entry of this.entries.values()) {
      if (
        ['armed', 'holding'].includes(entry.status.state) &&
        entry.status.guild_id === request.guild_id &&
        entry.status.user_id === request.user_id
      )
        return 'CONFLICT'
    }
    const deadline = Date.now() + request.timeout_ms
    const status: RestMemberReadHold = {
      ...request,
      id: generateSnowflake(),
      state: 'armed',
      arrived: 0,
      arrived_at: null,
      snapshot_status: null,
      expires_at: new Date(deadline).toISOString(),
      finished_at: null,
    }
    const entry: HoldEntry = {
      status,
      token: guild.bot_token,
      deadline,
      claimed: false,
      timer: setTimeout(() => {
        this.finish(entry, 'timed_out')
      }, request.timeout_ms),
    }
    entry.timer.unref()
    this.entries.set(status.id, entry)
    return { ...status }
  }

  /** Returns current status without leaking credentials or resources. */
  get(id: string): RestMemberReadHold | undefined {
    if (this.closed) return undefined
    this.prune()
    const entry = this.entries.get(id)
    return entry ? { ...entry.status } : undefined
  }

  /** Disarms an armed control or resumes a held request, keeping evidence. */
  release(id: string): RestMemberReadHold | undefined {
    if (!this.get(id)) return undefined
    const entry = this.entries.get(id)
    if (!entry) return undefined
    this.finish(entry, 'released')
    return { ...entry.status }
  }

  /** Cancels and removes a control, resuming its held request. */
  remove(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.finish(entry, 'cancelled')
    return this.entries.delete(id)
  }

  /** Clears holds and evidence globally or for one bot/guild. */
  reset(token?: string, guildId?: string): void {
    for (const [id, entry] of this.entries) {
      if (
        (token === undefined || entry.token === token) &&
        (guildId === undefined || entry.status.guild_id === guildId)
      )
        this.remove(id)
    }
  }

  /** Unblocks requests before the HTTP server drains and prevents rearming. */
  shutdown(): void {
    this.closed = true
    this.reset()
  }

  /**
   * Atomically claims the armed control matching an exact request. Only the
   * first matching request claims it; later ones are never held.
   */
  claim(
    guildId: string,
    userId: string,
    token: string | undefined,
    signal: AbortSignal
  ): MemberReadClaim | undefined {
    if (token === undefined || this.closed || signal.aborted) return undefined
    this.prune()
    for (const entry of this.entries.values()) {
      if (
        entry.status.state !== 'armed' ||
        entry.claimed ||
        entry.token !== token ||
        entry.status.guild_id !== guildId ||
        entry.status.user_id !== userId
      )
        continue
      entry.claimed = true
      entry.claimedAt = new Date().toISOString()
      return { entry }
    }
    return undefined
  }

  /** Gives up a claim whose native handler failed before a snapshot existed. */
  abandon(claim: MemberReadClaim): void {
    this.finish(claim.entry, 'cancelled')
  }

  /**
   * Publishes arrival evidence for a captured snapshot and waits until the
   * control is released, removed, times out, or the client disconnects.
   */
  async hold(
    claim: MemberReadClaim,
    snapshotStatus: number,
    signal: AbortSignal
  ): Promise<void> {
    const entry = claim.entry
    const wasArmed = entry.status.state === 'armed'
    entry.status.arrived = 1
    entry.status.arrived_at = entry.claimedAt ?? new Date().toISOString()
    entry.status.snapshot_status = snapshotStatus
    if (!wasArmed) return
    entry.status.state = 'holding'
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        this.finish(entry, 'disconnected')
      }
      entry.resume = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }
}

/** Controllers are isolated per database and shared by routes and lifecycle. */
const controllers = new WeakMap<Database, RestMemberReadHolds>()

/**
 * Gets the database's in-process member-read hold controller.
 * @param db - Database
 * @returns The shared controller for this database
 */
export function getRestMemberReadHolds(db: Database): RestMemberReadHolds {
  let controller = controllers.get(db)
  if (!controller) {
    controller = new RestMemberReadHolds(db)
    controllers.set(db, controller)
  }
  return controller
}
