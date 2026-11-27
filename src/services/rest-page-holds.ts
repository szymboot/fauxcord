import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import {
  isRestMessagePagePath,
  type RestPageHoldRequest,
} from '../validators/rest-page-hold'

/** Observable lifecycle of a one-shot page hold. */
type HoldState =
  'armed' | 'holding' | 'released' | 'timed_out' | 'disconnected' | 'cancelled'

/** Request-arrival evidence, never evidence of an importer's persisted state. */
export interface RestPageHold extends RestPageHoldRequest {
  id: string
  guild_id: string
  state: HoldState
  arrived: number
  arrived_at: string | null
  expires_at: string
  finished_at: string | null
}

/** Private in-process resources; never persisted or exposed by the API. */
interface HoldEntry {
  status: RestPageHold
  token: string
  /** Selected channel of a message history hold; absent for guild pages. */
  channelId?: string
  deadline: number
  timer: ReturnType<typeof setTimeout>
  resume?: () => void
}

/** Guild channel types with a message history: text, voice, announcement, threads and stage. */
const MESSAGE_CHANNEL_TYPES = new Set([0, 2, 5, 10, 11, 12, 13])

/** Manages bounded, single-request holds and their retained status evidence. */
export class RestPageHolds {
  private entries = new Map<string, HoldEntry>()
  private closed = false

  /** Binds controls to one database's guild ownership. */
  constructor(private db: Database) {}

  /** Finishes once, disarming retries and clearing all request/timer resources. */
  private finish(entry: HoldEntry, state: HoldState): void {
    if (!['armed', 'holding'].includes(entry.status.state)) return
    entry.status.state = state
    entry.status.finished_at = new Date().toISOString()
    clearTimeout(entry.timer)
    const resume = entry.resume
    entry.resume = undefined
    resume?.()
  }

  /** Looks up a channel's current type and guild. */
  private channel(
    channelId: string
  ): { guild_id: string | null; type: number } | undefined {
    return this.db
      .prepare('SELECT guild_id, type FROM channels WHERE id = ?')
      .get(channelId) as { guild_id: string | null; type: number } | undefined
  }

  /** Whether a control's guild keeps its owner and its channel stays in it. */
  private hasCurrentScope(entry: HoldEntry): boolean {
    const guild = this.db
      .prepare('SELECT bot_token FROM guilds WHERE id = ?')
      .get(entry.status.guild_id) as { bot_token: string } | undefined
    return (
      guild?.bot_token === entry.token &&
      (entry.channelId === undefined ||
        this.channel(entry.channelId)?.guild_id === entry.status.guild_id)
    )
  }

  /**
   * Removes controls whose scope has gone away or changed ownership, unblocking
   * their requests. Call after such a change commits.
   */
  pruneScopes(): void {
    for (const [id, entry] of this.entries) {
      if (!this.hasCurrentScope(entry)) this.remove(id)
    }
  }

  /** Removes out-of-scope controls and expires those past their deadline. */
  private prune(): void {
    this.pruneScopes()
    for (const entry of this.entries.values()) {
      if (Date.now() >= entry.deadline) this.finish(entry, 'timed_out')
    }
  }

  /** Arms a unique exact cursor for the guild's current owning bot. */
  create(
    request: RestPageHoldRequest
  ): RestPageHold | 'UNKNOWN_SCOPE' | 'UNSUPPORTED_SCOPE' | 'CONFLICT' {
    if (this.closed) return 'CONFLICT'
    this.prune()
    const resourceId = request.path.split('/', 3)[2]
    let guildId = resourceId
    let channelId: string | undefined
    if (isRestMessagePagePath(request.path)) {
      const channel = this.channel(resourceId)
      if (!channel) return 'UNKNOWN_SCOPE'
      // A hold binds to a guild's owning bot, which DM channels do not have.
      if (!channel.guild_id || !MESSAGE_CHANNEL_TYPES.has(channel.type))
        return 'UNSUPPORTED_SCOPE'
      guildId = channel.guild_id
      channelId = resourceId
    }
    const guild = this.db
      .prepare('SELECT bot_token FROM guilds WHERE id = ?')
      .get(guildId) as { bot_token: string } | undefined
    if (!guild) return 'UNKNOWN_SCOPE'
    for (const entry of this.entries.values()) {
      if (
        ['armed', 'holding'].includes(entry.status.state) &&
        entry.status.path === request.path &&
        entry.status.after === request.after &&
        entry.status.before === request.before &&
        entry.status.around === request.around
      )
        return 'CONFLICT'
    }
    const deadline = Date.now() + request.timeout_ms
    const status: RestPageHold = {
      ...request,
      id: generateSnowflake(),
      guild_id: guildId,
      state: 'armed',
      arrived: 0,
      arrived_at: null,
      expires_at: new Date(deadline).toISOString(),
      finished_at: null,
    }
    const entry: HoldEntry = {
      status,
      token: guild.bot_token,
      channelId,
      deadline,
      timer: setTimeout(() => {
        this.finish(entry, 'timed_out')
      }, request.timeout_ms),
    }
    entry.timer.unref()
    this.entries.set(status.id, entry)
    return { ...status }
  }

  /** Returns current status without leaking credentials or internal resources. */
  get(id: string): RestPageHold | undefined {
    if (this.closed) return undefined
    this.prune()
    const entry = this.entries.get(id)
    return entry ? { ...entry.status } : undefined
  }

  /** Explicitly disarms an armed or held request, retaining arrival evidence. */
  release(id: string): RestPageHold | undefined {
    const status = this.get(id)
    if (!status) return undefined
    const entry = this.entries.get(id)
    if (!entry) return undefined
    this.finish(entry, 'released')
    return { ...entry.status }
  }

  /** Cancels and removes a control, unblocking its native request handler. */
  remove(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.finish(entry, 'cancelled')
    return this.entries.delete(id)
  }

  /** Clears holds and retained evidence globally or for one bot/guild. */
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

  /** Claims only the first exact request and waits until release or cancellation. */
  async wait(
    path: string,
    query: URLSearchParams,
    token: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    if (this.closed || signal.aborted) return
    this.prune()
    for (const entry of this.entries.values()) {
      // `around` is an unrelated parameter on guild pages.
      const cursors =
        entry.channelId === undefined
          ? (['after', 'before'] as const)
          : (['after', 'before', 'around'] as const)
      if (
        entry.status.state !== 'armed' ||
        entry.token !== token ||
        entry.status.path !== path ||
        cursors.some(
          (name) =>
            query.getAll(name).length > 1 ||
            query.get(name) !== entry.status[name]
        )
      )
        continue
      entry.status.state = 'holding'
      entry.status.arrived = 1
      entry.status.arrived_at = new Date().toISOString()
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
      return
    }
  }
}

/** Controllers are isolated per database and shared by its routes and lifecycle. */
const controllers = new WeakMap<Database, RestPageHolds>()

/** Gets the database's in-process page controls without changing fault semantics. */
export function getRestPageHolds(db: Database): RestPageHolds {
  let controller = controllers.get(db)
  if (!controller) {
    controller = new RestPageHolds(db)
    controllers.set(db, controller)
  }
  return controller
}
