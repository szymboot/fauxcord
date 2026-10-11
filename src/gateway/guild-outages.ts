import { randomUUID } from 'node:crypto'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { Database } from '../db'
import { buildGuildCreatePayload } from '../services/guilds'
import type {
  DispatchTransport,
  IdentifyGuildOutage,
  Session,
  SessionManager,
} from './session'
import type { GatewayPayload } from './protocol'
import { sendDispatch } from './dispatch'
import { hasIntent } from './intents'

/** Maximum outage records (active and retained) per Gateway instance. */
const MAX_LIVE = 32
/** Maximum ownership reservations (active, retired and tombstoned). */
const MAX_OWNERS = 4096
/** Maximum GUILD_DELETE / GUILD_CREATE observations retained per outage. */
const MAX_DISPATCHES = 50
/** Maximum voice-state summaries retained per recovery GUILD_CREATE. */
const MAX_VOICE_STATES = 100
/** Maximum concurrent long-poll waiters per Gateway instance. */
const MAX_WAITERS = 64
/** How long evidence of a recovered outage stays inspectable. */
export const RETAIN_MS = 120_000

/** Dispatches whose guild is identified by `d.id` instead of `d.guild_id`. */
const GUILD_OBJECT_EVENTS = new Set([
  'GUILD_CREATE',
  'GUILD_UPDATE',
  'GUILD_DELETE',
])

/** Unavailable stub event sent to sessions that IDENTIFY during an outage. */
export type IdentifyDispatch = 'guild_delete' | 'guild_create'

/** Validated outage request; the key is optional, TTL bounds the outage. */
export interface GuildOutageRequest {
  ownership_key?: string
  bot_id: string
  guild_id: string
  ttl_ms: number
  /** Defaults to `guild_delete` */
  identify_dispatch?: IdentifyDispatch
}

/** Exact public owner address known before sending a keyed POST. */
export interface GuildOutageOwnership {
  ownership_key: string
  bot_id: string
  guild_id: string
}

/** Compact voice-state facts copied from one recovery GUILD_CREATE. */
interface VoiceStateSummary {
  user_id: string
  channel_id: string | null
  session_id: string | null
  self_stream: boolean
  self_video: boolean
}

/** Observation of one outage GUILD_DELETE written to a session. */
interface GuildDeleteObservation {
  session_id: string
  /** `outage_start` for live sessions, `identify` for sessions created during it */
  trigger: 'outage_start' | 'identify'
  sequence: number | null
  /** READY sequence of the identifying session (`identify` trigger only) */
  ready_sequence: number | null
  transport: DispatchTransport
  dispatched_at: number
}

/**
 * Observation of one GUILD_CREATE written to a session: the recovery snapshot,
 * or an unavailable stub for a session that IDENTIFYed during the outage.
 */
interface GuildCreateObservation {
  session_id: string
  trigger: 'recovery' | 'identify'
  /** True for the `{ id, unavailable: true }` stub (`identify` trigger) */
  unavailable: boolean
  sequence: number | null
  /** READY sequence of the identifying session (`identify` trigger only) */
  ready_sequence: number | null
  transport: DispatchTransport
  dispatched_at: number
  member_count: number
  channel_count: number
  voice_states: VoiceStateSummary[]
  voice_states_total: number
}

/** How a recovered outage ended. */
type EndReason = 'request' | 'ttl'

/** One outage and its bounded delivery evidence. */
interface OutageRecord {
  id: string
  ownership_key: string | null
  bot_id: string
  guild_id: string
  ttl_ms: number
  identify_dispatch: IdentifyDispatch
  /** Normalized setup token owning the guild (never exposed). */
  token: string
  status: 'unavailable' | 'recovered'
  ended_by: EndReason | null
  started_at: number
  expires_at: number
  ended_at: number | null
  retained_until: number | null
  /**
   * Whether recovery dispatched at least one GUILD_CREATE snapshot; false when
   * the guild left the setup or no session of the setup holds the Guilds intent
   */
  recovery_snapshot: boolean | null
  /** True while recovery dispatches are still being registered. */
  recovering: boolean
  timer: NodeJS.Timeout
  guild_deletes: GuildDeleteObservation[]
  guild_deletes_skipped: number
  guild_creates: GuildCreateObservation[]
  guild_creates_skipped: number
  suppressed: number
  suppressed_by_event: Map<string, number>
}

/** Bounded lifetime reservation; a null ID permanently prevents resurrection. */
interface OwnershipReservation extends GuildOutageOwnership {
  ttl_ms?: number
  identify_dispatch?: IdentifyDispatch
  id: string | null
}

/** Normalizes IDENTIFY tokens to the stored "Bot "-prefixed setup form. */
function normalizeToken(token: string): string {
  return token.startsWith('Bot ') ? token : `Bot ${token}`
}

/** Key of an active outage: one setup token and one guild. */
function activeKey(token: string, guildId: string): string {
  return `${token}\0${guildId}`
}

/**
 * Resolves the guild a dispatch belongs to: `guild_id`, or `id` for events
 * whose payload is the guild itself.
 */
function dispatchGuildId(eventName: string, data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as { guild_id?: unknown; id?: unknown }
  if (typeof record.guild_id === 'string') return record.guild_id
  return GUILD_OBJECT_EVENTS.has(eventName) && typeof record.id === 'string'
    ? record.id
    : undefined
}

/** Copies only bounded public facts from a GUILD_CREATE envelope. */
function summarizeGuildCreate(
  session: Session,
  payload: GatewayPayload<unknown>,
  trigger: GuildCreateObservation['trigger'],
  readySequence: number | null
): GuildCreateObservation {
  const data = payload.d as {
    unavailable?: unknown
    member_count?: unknown
    channels?: unknown
    voice_states?: unknown
  }
  const states = Array.isArray(data.voice_states)
    ? (data.voice_states as Record<string, unknown>[])
    : []
  return {
    session_id: session.sessionId,
    trigger,
    unavailable: data.unavailable === true,
    sequence: payload.s ?? null,
    ready_sequence: readySequence,
    transport: 'queued',
    dispatched_at: Date.now(),
    member_count: typeof data.member_count === 'number' ? data.member_count : 0,
    channel_count: Array.isArray(data.channels) ? data.channels.length : 0,
    voice_states: states.slice(0, MAX_VOICE_STATES).map((state) => ({
      user_id: String(state.user_id),
      channel_id:
        typeof state.channel_id === 'string' ? state.channel_id : null,
      session_id:
        typeof state.session_id === 'string' ? state.session_id : null,
      self_stream: state.self_stream === true,
      self_video: state.self_video === true,
    })),
    voice_states_total: states.length,
  }
}

/** Whether every recorded frame finished its socket write attempt. */
function settledTransports(record: OutageRecord): boolean {
  return [...record.guild_deletes, ...record.guild_creates].every(
    (entry) => entry.transport !== 'queued'
  )
}

/**
 * Test-only control that simulates a Discord outage of one guild for one bot
 * setup: GUILD_DELETE `unavailable: true`, silence while unavailable, and a
 * fresh GUILD_CREATE snapshot on recovery.
 */
export class GatewayGuildOutages {
  private readonly records = new Map<string, OutageRecord>()
  /** Active outage record IDs by setup token and guild. */
  private readonly active = new Map<string, string>()
  private readonly owners = new Map<string, OwnershipReservation>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private waiterCount = 0

  /** Installs dispatch suppression and IDENTIFY hooks on this Gateway only. */
  constructor(
    private readonly db: Database,
    private readonly manager: SessionManager
  ) {
    manager.suppressDispatch = (session, eventName, data) =>
      this.suppress(session, eventName, data)
    manager.identifyGuildOutages = (session, guildIds, readySequence) =>
      this.identify(session, guildIds, readySequence)
  }

  /** Returns the active outage affecting a session's view of a guild. */
  private activeFor(
    session: Session,
    guildId: string
  ): OutageRecord | undefined {
    const id = this.active.get(
      activeKey(normalizeToken(session.token), guildId)
    )
    const record = id ? this.records.get(id) : undefined
    return record?.bot_id === session.botId ? record : undefined
  }

  /**
   * Drops every native dispatch of an unavailable guild for in-scope sessions,
   * except GUILD_DELETE (the outage signal, or the bot losing the guild).
   */
  private suppress(
    session: Session,
    eventName: string,
    data: unknown
  ): boolean {
    if (this.active.size === 0) return false
    const guildId = dispatchGuildId(eventName, data)
    if (!guildId) return false
    // GUILD_DELETE is never suppressed: with `unavailable: true` it is the
    // outage signal itself, without it the bot lost the guild (left, kicked,
    // banned or deleted), which Discord reports even for unavailable guilds.
    if (eventName === 'GUILD_DELETE') return false
    // The IDENTIFY-time unavailable GUILD_CREATE stub is an outage signal too.
    if (
      eventName === 'GUILD_CREATE' &&
      (data as { unavailable?: unknown }).unavailable === true
    )
      return false
    const record = this.activeFor(session, guildId)
    if (!record) return false
    record.suppressed += 1
    record.suppressed_by_event.set(
      eventName,
      (record.suppressed_by_event.get(eventName) ?? 0) + 1
    )
    return true
  }

  /** Maps READY guilds in an active outage to the unavailable stub to send. */
  private identify(
    session: Session,
    guildIds: string[],
    readySequence: number
  ): Map<string, IdentifyGuildOutage> {
    const result = new Map<string, IdentifyGuildOutage>()
    if (this.active.size === 0) return result
    for (const guildId of guildIds) {
      const record = this.activeFor(session, guildId)
      if (!record) continue
      result.set(
        guildId,
        record.identify_dispatch === 'guild_create'
          ? {
              event: 'GUILD_CREATE',
              observe: (payload) =>
                this.observeCreate(
                  record,
                  session,
                  payload,
                  'identify',
                  readySequence
                ),
            }
          : {
              event: 'GUILD_DELETE',
              observe: (payload) =>
                this.observeDelete(
                  record,
                  session,
                  payload,
                  'identify',
                  readySequence
                ),
            }
      )
    }
    return result
  }

  /** Records one GUILD_DELETE envelope and returns its write observer. */
  private observeDelete(
    record: OutageRecord,
    session: Session,
    payload: GatewayPayload<unknown>,
    trigger: GuildDeleteObservation['trigger'],
    readySequence: number | null
  ): ((status: DispatchTransport) => void) | undefined {
    if (record.guild_deletes.length >= MAX_DISPATCHES) {
      record.guild_deletes_skipped += 1
      return undefined
    }
    const entry: GuildDeleteObservation = {
      session_id: session.sessionId,
      trigger,
      sequence: payload.s ?? null,
      ready_sequence: readySequence,
      transport: 'queued',
      dispatched_at: Date.now(),
    }
    record.guild_deletes.push(entry)
    return (status) => {
      entry.transport = status
      this.notify(record.id)
    }
  }

  /** Records one GUILD_CREATE envelope and returns its write observer. */
  private observeCreate(
    record: OutageRecord,
    session: Session,
    payload: GatewayPayload<unknown>,
    trigger: GuildCreateObservation['trigger'],
    readySequence: number | null
  ): ((status: DispatchTransport) => void) | undefined {
    if (record.guild_creates.length >= MAX_DISPATCHES) {
      record.guild_creates_skipped += 1
      return undefined
    }
    const entry = summarizeGuildCreate(session, payload, trigger, readySequence)
    record.guild_creates.push(entry)
    return (status) => {
      entry.transport = status
      this.notify(record.id)
    }
  }

  /** Registered sessions (live or awaiting RESUME) of the outage's setup. */
  private sessionsInScope(
    record: Pick<OutageRecord, 'bot_id' | 'token'>
  ): Session[] {
    return this.manager
      .getByBotId(record.bot_id)
      .filter((session) => normalizeToken(session.token) === record.token)
  }

  /** Returns the normalized setup token when the bot owns the guild. */
  private ownerToken(botId: string, guildId: string): string | undefined {
    const row = this.db
      .prepare(
        'SELECT g.bot_token AS token FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ? AND b.user_id = ?'
      )
      .get(guildId, botId) as { token: string } | undefined
    return row?.token
  }

  /**
   * Starts an outage (GUILD_DELETE `unavailable: true` to every registered
   * session of the setup holding the Guilds intent), or returns the existing
   * record for an identical keyed retry.
   */
  create(request: GuildOutageRequest): string | object {
    const identifyDispatch = request.identify_dispatch ?? 'guild_delete'
    const key = request.ownership_key
    const owner = key === undefined ? undefined : this.owners.get(key)
    if (owner) {
      return owner.bot_id === request.bot_id &&
        owner.guild_id === request.guild_id &&
        owner.ttl_ms === request.ttl_ms &&
        owner.identify_dispatch === identifyDispatch &&
        owner.id
        ? (this.inspect(owner.id) ?? 'CONFLICT')
        : 'CONFLICT'
    }
    if (key !== undefined && this.owners.size >= MAX_OWNERS) return 'LIMIT'
    const token = this.ownerToken(request.bot_id, request.guild_id)
    if (!token) return 'UNKNOWN_SCOPE'
    if (this.active.has(activeKey(token, request.guild_id))) return 'BUSY'
    if (this.records.size >= MAX_LIVE) return 'LIMIT'

    const id = randomUUID()
    const now = Date.now()
    const timer = setTimeout(() => this.end(id, 'ttl'), request.ttl_ms)
    timer.unref()
    const record: OutageRecord = {
      id,
      ownership_key: key ?? null,
      bot_id: request.bot_id,
      guild_id: request.guild_id,
      ttl_ms: request.ttl_ms,
      identify_dispatch: identifyDispatch,
      token,
      status: 'unavailable',
      ended_by: null,
      started_at: now,
      expires_at: now + request.ttl_ms,
      ended_at: null,
      retained_until: null,
      recovery_snapshot: null,
      recovering: false,
      timer,
      guild_deletes: [],
      guild_deletes_skipped: 0,
      guild_creates: [],
      guild_creates_skipped: 0,
      suppressed: 0,
      suppressed_by_event: new Map(),
    }
    this.records.set(id, record)
    if (key !== undefined) {
      this.owners.set(key, {
        ownership_key: key,
        bot_id: request.bot_id,
        guild_id: request.guild_id,
        ttl_ms: request.ttl_ms,
        identify_dispatch: identifyDispatch,
        id,
      })
    }
    // GUILD_DELETE is written before suppression starts, through the normal
    // sequencing and replay buffer, so a RESUME replays it in order.
    for (const session of this.sessionsInScope(record)) {
      if (!hasIntent(session.intents, GatewayIntentBits.Guilds)) continue
      sendDispatch(
        this.manager,
        session,
        'GUILD_DELETE',
        { id: record.guild_id, unavailable: true },
        (payload) =>
          this.observeDelete(record, session, payload, 'outage_start', null)
      )
    }
    this.active.set(activeKey(token, record.guild_id), id)
    return this.inspect(id) ?? 'CONFLICT'
  }

  /**
   * Ends an active outage: suppression stops, then every registered session
   * of the setup holding the Guilds intent receives a GUILD_CREATE snapshot
   * of the guild's current state. Evidence is retained for RETAIN_MS.
   * @returns The record, or undefined when unknown
   */
  end(id: string, reason: EndReason = 'request'): object | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    if (record.status === 'unavailable') {
      this.recover(record, reason)
      clearTimeout(record.timer)
      record.retained_until = (record.ended_at ?? Date.now()) + RETAIN_MS
      record.timer = setTimeout(() => this.retire(id), RETAIN_MS)
      record.timer.unref()
      this.notify(id)
    }
    return this.inspect(id)
  }

  /** Stops suppression and dispatches recovery GUILD_CREATE snapshots. */
  private recover(record: OutageRecord, reason: EndReason): void {
    this.active.delete(activeKey(record.token, record.guild_id))
    record.status = 'recovered'
    record.ended_by = reason
    record.ended_at = Date.now()
    // A reused setup may have moved the guild to another bot token meanwhile;
    // its snapshot must never reach the original setup's sessions.
    const guild =
      this.ownerToken(record.bot_id, record.guild_id) === record.token
        ? buildGuildCreatePayload(this.db, record.guild_id)
        : null
    record.recovery_snapshot = false
    if (!guild) return
    // Waiters must not settle on an early session's synchronous transport
    // status before every recovery GUILD_CREATE has been registered.
    record.recovering = true
    try {
      for (const session of this.sessionsInScope(record)) {
        if (!hasIntent(session.intents, GatewayIntentBits.Guilds)) continue
        sendDispatch(this.manager, session, 'GUILD_CREATE', guild, (payload) =>
          this.observeCreate(record, session, payload, 'recovery', null)
        )
        // Counted per dispatch, independent of the bounded evidence list.
        record.recovery_snapshot = true
      }
    } finally {
      record.recovering = false
    }
  }

  /** Returns public evidence only; never a token. */
  inspect(id: string): object | undefined {
    const record = this.records.get(id)
    return record
      ? structuredClone({
          id: record.id,
          ownership_key: record.ownership_key,
          bot_id: record.bot_id,
          guild_id: record.guild_id,
          status: record.status,
          ended_by: record.ended_by,
          ttl_ms: record.ttl_ms,
          identify_dispatch: record.identify_dispatch,
          started_at: record.started_at,
          expires_at: record.expires_at,
          ended_at: record.ended_at,
          retained_until: record.retained_until,
          recovery_snapshot: record.recovery_snapshot,
          guild_deletes: record.guild_deletes,
          guild_deletes_skipped: record.guild_deletes_skipped,
          guild_creates: record.guild_creates,
          guild_creates_skipped: record.guild_creates_skipped,
          suppressed_dispatches: record.suppressed,
          suppressed_by_event: Object.fromEntries(record.suppressed_by_event),
        })
      : undefined
  }

  /** Resolves the exact owner's record ID by its pre-chosen key. */
  idByKey(scope: GuildOutageOwnership): string | null {
    const owner = this.owners.get(scope.ownership_key)
    return owner?.bot_id === scope.bot_id && owner.guild_id === scope.guild_id
      ? owner.id
      : null
  }

  /**
   * Waits (bounded) until the outage recovered and every recorded frame
   * finished its write attempt, or the record retires, then inspects it.
   */
  async wait(
    id: string | null,
    waitMs: number
  ): Promise<object | undefined | 'LIMIT'> {
    const record = id ? this.records.get(id) : undefined
    if (!record) return undefined
    /** Whether the record retired, or recovered with all writes settled. */
    const settled = (): boolean => {
      const current = this.records.get(record.id)
      return (
        !current ||
        (current.status === 'recovered' &&
          !current.recovering &&
          settledTransports(current))
      )
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

  /** Ends the outage if active (with recovery GUILD_CREATE), then discards it. */
  delete(id: string): boolean {
    if (!this.records.has(id)) return false
    this.end(id, 'request')
    return this.retire(id)
  }

  /** Ends and discards a keyed outage by its owner address. */
  endByKey(scope: GuildOutageOwnership): object | undefined {
    const id = this.idByKey(scope)
    return id ? this.end(id, 'request') : undefined
  }

  /**
   * Closes ownership by key: ends and discards an applied outage, or
   * tombstones an unused key so a delayed POST can never start an outage.
   */
  deleteByKey(
    scope: GuildOutageOwnership
  ): 'DELETED' | 'UNKNOWN_SCOPE' | 'LIMIT' {
    const owner = this.owners.get(scope.ownership_key)
    if (owner) {
      if (owner.bot_id !== scope.bot_id || owner.guild_id !== scope.guild_id)
        return 'UNKNOWN_SCOPE'
      if (owner.id) this.delete(owner.id)
      return 'DELETED'
    }
    if (!this.ownerToken(scope.bot_id, scope.guild_id)) return 'UNKNOWN_SCOPE'
    if (this.owners.size >= MAX_OWNERS) return 'LIMIT'
    this.owners.set(scope.ownership_key, { ...scope, id: null })
    return 'DELETED'
  }

  /**
   * Drops a record without dispatching anything and wakes waiters; the
   * ownership key stays closed.
   */
  private retire(id: string): boolean {
    const record = this.records.get(id)
    if (!record) return false
    clearTimeout(record.timer)
    this.records.delete(id)
    if (this.active.get(activeKey(record.token, record.guild_id)) === id)
      this.active.delete(activeKey(record.token, record.guild_id))
    if (record.ownership_key !== null) {
      const owner = this.owners.get(record.ownership_key)
      if (owner) owner.id = null
    }
    this.notify(id)
    return true
  }

  /**
   * Discards all records, or those of one normalized setup token. Active
   * outages of guilds that still exist first recover with GUILD_CREATE, so a
   * connected client is never left with a permanently unavailable guild;
   * `recover: false` (Gateway shutdown) discards silently.
   */
  reset(token?: string, recover = true): void {
    for (const record of this.records.values()) {
      if (token && record.token !== normalizeToken(token)) continue
      if (recover && record.status === 'unavailable')
        this.recover(record, 'request')
      this.retire(record.id)
    }
  }

  /** Discards records of a deleted guild silently (it has no snapshot). */
  deleteGuild(guildId: string): void {
    for (const record of this.records.values()) {
      if (record.guild_id === guildId) this.retire(record.id)
    }
  }
}
