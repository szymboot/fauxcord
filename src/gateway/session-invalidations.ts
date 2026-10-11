import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Database } from '../db'
import type {
  DispatchTransport,
  IdentifyFacts,
  IdentifyObserver,
  Session,
  SessionManager,
} from './session'
import type { GatewayPayload } from './protocol'
import { encodePayload } from './protocol'
import { GatewayCloseCode, GatewayOp } from './opcodes'

/** Maximum live (unexpired) invalidation observations per Gateway instance. */
const MAX_LIVE = 32
/** Maximum ownership reservations (active, retired and tombstoned). */
const MAX_OWNERS = 4096
/** Maximum replacement attempts retained; older failed ones are evicted. */
const MAX_IDENTIFIES = 4
/** Maximum GUILD_CREATE summaries retained per IDENTIFY. */
const MAX_GUILD_CREATES = 50
/** Maximum voice-state summaries retained per GUILD_CREATE. */
const MAX_VOICE_STATES = 100
/** Maximum concurrent long-poll waiters per Gateway instance. */
const MAX_WAITERS = 64

/**
 * When the invalidation applies: `immediate` invalidates the live session
 * now; `resume` arms a rejection of the session's next authenticated RESUME.
 */
export type InvalidationTrigger = 'immediate' | 'resume'

/** Exact keyed request; every field is required except TTL and trigger. */
export interface SessionInvalidationRequest {
  ownership_key: string
  bot_id: string
  guild_id: string
  session_id: string
  ttl_ms: number
  /** Defaults to `immediate`. */
  trigger?: InvalidationTrigger
}

/** Exact public owner address known before sending a keyed POST. */
export type SessionInvalidationOwnership = Omit<
  SessionInvalidationRequest,
  'ttl_ms' | 'trigger'
>

/** First/last sequence of buffered dispatches that were never replayed. */
interface DiscardedRange {
  count: number
  first_sequence: number | null
  last_sequence: number | null
}

/** Evidence of how a `resume`-triggered invalidation was applied. */
interface ResumeRejection {
  /**
   * `forced`: an authenticated RESUME was answered with op 9 `d: false`;
   * `session_removed`: the session disappeared first (e.g. heartbeat timeout),
   * so any later RESUME is rejected naturally.
   */
  reason: 'forced' | 'session_removed'
  at: number
  /** Sequence the client reported in RESUME (null for `session_removed`). */
  client_sequence: number | null
  /** Whether the replay buffer could still have served that RESUME. */
  replay_available: boolean | null
  /** Buffered dispatches after the client's sequence, discarded unsent. */
  discarded: DiscardedRange | null
}

/** Compact voice-state facts copied from one written GUILD_CREATE. */
interface VoiceStateSummary {
  user_id: string
  channel_id: string | null
  session_id: string | null
  self_stream: boolean
  self_video: boolean
}

/** Observation of one GUILD_CREATE written to a replacement session. */
interface GuildCreateObservation {
  guild_id: string
  sequence: number | null
  transport: DispatchTransport
  member_count: number
  channel_count: number
  voice_states: VoiceStateSummary[]
  voice_states_total: number
}

/** Observation of one IDENTIFY by the invalidated session's setup token. */
interface IdentifyObservation {
  session_id: string
  intents: number
  identified_at: number
  guilds_intent: boolean
  ready: {
    sequence: number
    guild_ids: string[]
    transport: DispatchTransport
  }
  /** READY guilds in a simulated outage; they get GUILD_DELETE instead. */
  unavailable_guild_ids: string[]
  guild_creates: GuildCreateObservation[]
  guild_creates_skipped: number
}

/** Internal attempt state; delivery is tracked independently of summaries. */
interface IdentifyAttempt extends IdentifyObservation {
  /** Guild IDs whose GUILD_CREATE write completed, beyond the summary cap. */
  sentGuildIds: Set<string>
  /** Whether any GUILD_CREATE could not be written to this socket. */
  guildCreateFailed: boolean
}

/** Progress of one replacement attempt. */
type AttemptState = 'pending' | 'complete' | 'failed'

/** One invalidation (applied or armed) and its bounded replacement evidence. */
interface InvalidationRecord extends SessionInvalidationRequest {
  trigger: InvalidationTrigger
  id: string
  /** Normalized setup token of the invalidated session (never exposed). */
  token: string
  /** Whether the invalidation has been applied (always for `immediate`). */
  applied: boolean
  /** Invalidated socket; IDENTIFYs on it are not replacements. */
  socket: WebSocket | undefined
  sequence: number | null
  transport: DispatchTransport | null
  invalidated_at: number | null
  resume_rejection: ResumeRejection | null
  expires_at: number
  timer: NodeJS.Timeout
  identifies: IdentifyAttempt[]
  identifies_skipped: number
  resumes_rejected: number
}

/** Bounded lifetime reservation; a null ID permanently prevents resurrection. */
interface OwnershipReservation extends SessionInvalidationOwnership {
  ttl_ms?: number
  trigger?: InvalidationTrigger
  id: string | null
}

/** Normalizes IDENTIFY tokens to the stored "Bot "-prefixed setup form. */
function normalizeToken(token: string): string {
  return token.startsWith('Bot ') ? token : `Bot ${token}`
}

/** Compares the complete immutable public owner address. */
function sameOwner(
  owner: SessionInvalidationOwnership,
  scope: SessionInvalidationOwnership
): boolean {
  return (
    owner.bot_id === scope.bot_id &&
    owner.guild_id === scope.guild_id &&
    owner.session_id === scope.session_id
  )
}

/**
 * Classifies an attempt: complete once READY and a GUILD_CREATE for every
 * available READY guild (not in a simulated outage) were written; failed when any of them could not be written
 * (including a socket that closed before the snapshot finished).
 */
function attemptState(attempt: IdentifyAttempt): AttemptState {
  if (attempt.ready.transport === 'failed' || attempt.guildCreateFailed)
    return 'failed'
  if (attempt.ready.transport !== 'sent') return 'pending'
  return !attempt.guilds_intent ||
    attempt.ready.guild_ids.every(
      (guildId) =>
        attempt.unavailable_guild_ids.includes(guildId) ||
        attempt.sentGuildIds.has(guildId)
    )
    ? 'complete'
    : 'pending'
}

/** Summarizes buffered sequences as a count and first/last range. */
function discardedRange(sequences: number[]): DiscardedRange {
  return {
    count: sequences.length,
    first_sequence: sequences.at(0) ?? null,
    last_sequence: sequences.at(-1) ?? null,
  }
}

/** Whether an observation still awaits its replacement IDENTIFY. */
function isOpen(record: InvalidationRecord): boolean {
  return record.identifies.every(
    (attempt) => attemptState(attempt) !== 'complete'
  )
}

/** Projects an attempt to its public, credential-free shape. */
function publicAttempt(attempt: IdentifyAttempt): object {
  const state = attemptState(attempt)
  return {
    session_id: attempt.session_id,
    intents: attempt.intents,
    identified_at: attempt.identified_at,
    guilds_intent: attempt.guilds_intent,
    ready: attempt.ready,
    unavailable_guild_ids: attempt.unavailable_guild_ids,
    guild_creates: attempt.guild_creates,
    guild_creates_sent: attempt.sentGuildIds.size,
    guild_creates_skipped: attempt.guild_creates_skipped,
    state,
    complete: state === 'complete',
  }
}

/** Copies only bounded public facts from a GUILD_CREATE envelope. */
function summarizeGuildCreate(
  payload: GatewayPayload<unknown>
): GuildCreateObservation {
  const data = payload.d as {
    id?: unknown
    member_count?: unknown
    channels?: unknown
    voice_states?: unknown
  }
  const states = Array.isArray(data.voice_states)
    ? (data.voice_states as Record<string, unknown>[])
    : []
  return {
    guild_id: String(data.id),
    sequence: payload.s ?? null,
    transport: 'queued',
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

/**
 * Test-only control that invalidates one exact live Gateway session so that
 * its client must IDENTIFY again, then observes that replacement IDENTIFY.
 */
export class GatewaySessionInvalidations {
  private readonly records = new Map<string, InvalidationRecord>()
  private readonly owners = new Map<string, OwnershipReservation>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private waiterCount = 0

  /** Installs IDENTIFY and RESUME observers on this Gateway only. */
  constructor(
    private readonly db: Database,
    private readonly manager: SessionManager
  ) {
    manager.observeIdentify = (session, facts) =>
      this.observeIdentify(session, facts)
    manager.observeRejectedResume = (sessionId) => {
      for (const record of this.records.values()) {
        if (record.session_id !== sessionId || !record.applied) continue
        record.resumes_rejected += 1
        this.notify(record.id)
      }
    }
    manager.rejectResume = (session, attempt) => {
      const record = this.armedFor(session)
      if (!record || !this.inScope(session, record)) return undefined
      const now = Date.now()
      record.applied = true
      record.invalidated_at = now
      record.sequence = session.seq
      record.transport = 'queued'
      record.resumes_rejected += 1
      record.resume_rejection = {
        reason: 'forced',
        at: now,
        client_sequence: attempt.clientSequence,
        replay_available: attempt.replay !== undefined,
        discarded: discardedRange(
          session.replayBuffer
            .filter((entry) => entry.seq > attempt.clientSequence)
            .map((entry) => entry.seq)
        ),
      }
      // Discarding the session drops its replay buffer: the dispatches
      // generated during the gap are never delivered individually.
      this.manager.remove(session.sessionId)
      this.notify(record.id)
      return (status) => {
        record.transport = status
        this.notify(record.id)
      }
    }
    manager.onRemove((session) => {
      const record = this.armedFor(session)
      if (!record) return
      const now = Date.now()
      record.applied = true
      record.invalidated_at = now
      record.sequence = session.seq
      record.resume_rejection = {
        reason: 'session_removed',
        at: now,
        client_sequence: null,
        replay_available: null,
        discarded: null,
      }
      this.notify(record.id)
    })
  }

  /** Returns the armed (not yet applied) `resume` record for a session. */
  private armedFor(session: Session): InvalidationRecord | undefined {
    return this.records
      .values()
      .find(
        (record) =>
          !record.applied &&
          record.session_id === session.sessionId &&
          record.token === normalizeToken(session.token)
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
    scope: Pick<SessionInvalidationRequest, 'bot_id' | 'guild_id'>
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
   * Invalidates one exact live session (INVALID_SESSION `d: false`, then close
   * 4009), arms the rejection of its next RESUME, or returns the existing
   * observation for an identical keyed retry.
   */
  create(input: SessionInvalidationRequest): string | object {
    const request = { ...input, trigger: input.trigger ?? 'immediate' }
    const owner = this.owners.get(request.ownership_key)
    if (owner) {
      return sameOwner(owner, request) &&
        owner.ttl_ms === request.ttl_ms &&
        owner.trigger === request.trigger &&
        owner.id
        ? (this.inspect(owner.id) ?? 'CONFLICT')
        : 'CONFLICT'
    }
    if (this.owners.size >= MAX_OWNERS) return 'LIMIT'
    const session = this.manager.get(request.session_id)
    if (!session || !this.inScope(session, request)) return 'UNKNOWN_SCOPE'
    const immediate = request.trigger === 'immediate'
    // A silenced (zombie) connection cannot receive op 9 either.
    if (
      immediate &&
      (session.ws.readyState !== WebSocket.OPEN ||
        this.manager.isSilenced(session.ws))
    )
      return 'INVALID_STATE'
    if (this.records.size >= MAX_LIVE) return 'LIMIT'
    // A replacement IDENTIFY carries no link to the session it replaces, so
    // only one open observation per setup token keeps attribution exact.
    const token = normalizeToken(session.token)
    if (
      this.records
        .values()
        .some((record) => record.token === token && isOpen(record))
    )
      return 'BUSY'

    const id = randomUUID()
    const now = Date.now()
    const timer = setTimeout(() => this.retire(id), request.ttl_ms)
    timer.unref()
    const record: InvalidationRecord = {
      ...request,
      id,
      token,
      applied: immediate,
      // A replacement after a rejected RESUME may IDENTIFY on any socket,
      // including the one that carried the RESUME.
      socket: immediate ? session.ws : undefined,
      sequence: immediate ? session.seq : null,
      transport: immediate ? 'queued' : null,
      invalidated_at: immediate ? now : null,
      resume_rejection: null,
      expires_at: now + request.ttl_ms,
      timer,
      identifies: [],
      identifies_skipped: 0,
      resumes_rejected: 0,
    }
    this.records.set(id, record)
    this.owners.set(request.ownership_key, {
      ownership_key: request.ownership_key,
      bot_id: request.bot_id,
      guild_id: request.guild_id,
      session_id: request.session_id,
      ttl_ms: request.ttl_ms,
      trigger: request.trigger,
      id,
    })
    if (!immediate) return this.inspect(id) ?? 'CONFLICT'
    // Removing the session first makes the invalidation atomic: no further
    // dispatch can reach it, and any RESUME naming it gets INVALID_SESSION.
    this.manager.remove(session.sessionId)
    try {
      session.ws.send(
        encodePayload({ op: GatewayOp.InvalidSession, d: false }),
        (error) => {
          record.transport = error ? 'failed' : 'sent'
          this.notify(id)
        }
      )
      session.ws.close(GatewayCloseCode.SessionTimedOut, 'Session invalidated')
    } catch {
      record.transport = 'failed'
    }
    return this.inspect(id) ?? 'CONFLICT'
  }

  /**
   * Attributes a successful IDENTIFY by the invalidated setup token on another
   * socket to the open observation, unless a pending or complete attempt
   * already exists (failed attempts allow a retry to be attributed).
   */
  private observeIdentify(
    session: Session,
    facts: IdentifyFacts
  ): IdentifyObserver | undefined {
    const token = normalizeToken(session.token)
    const record = this.records
      .values()
      .find(
        (candidate) =>
          candidate.applied &&
          candidate.token === token &&
          candidate.bot_id === session.botId &&
          candidate.socket !== session.ws &&
          candidate.identifies.every(
            (attempt) => attemptState(attempt) === 'failed'
          )
      )
    if (!record) return undefined
    // Only failed attempts precede this one, so evicting the oldest keeps
    // history bounded without ever blocking a later successful replacement.
    if (record.identifies.length >= MAX_IDENTIFIES) {
      record.identifies.shift()
      record.identifies_skipped += 1
    }
    const attempt: IdentifyAttempt = {
      session_id: session.sessionId,
      intents: session.intents,
      identified_at: Date.now(),
      guilds_intent: facts.guildsIntent,
      ready: {
        sequence: facts.readySequence,
        guild_ids: [...facts.guildIds],
        transport: 'queued',
      },
      unavailable_guild_ids: [...facts.unavailableGuildIds],
      guild_creates: [],
      guild_creates_skipped: 0,
      sentGuildIds: new Set(),
      guildCreateFailed: false,
    }
    record.identifies.push(attempt)
    this.notify(record.id)
    return {
      ready: (status) => {
        attempt.ready.transport = status
        this.notify(record.id)
      },
      guildCreate: (payload) => {
        const summary = summarizeGuildCreate(payload)
        if (attempt.guild_creates.length < MAX_GUILD_CREATES)
          attempt.guild_creates.push(summary)
        else attempt.guild_creates_skipped += 1
        return (status) => {
          summary.transport = status
          if (status === 'sent') attempt.sentGuildIds.add(summary.guild_id)
          else if (status === 'failed' || status === 'buffered')
            attempt.guildCreateFailed = true
          this.notify(record.id)
        }
      },
    }
  }

  /** Returns public evidence only; never a token or socket. */
  inspect(id: string): object | undefined {
    const record = this.records.get(id)
    const replacement = record?.identifies.find(
      (attempt) => attemptState(attempt) === 'complete'
    )
    return record
      ? structuredClone({
          id: record.id,
          ownership_key: record.ownership_key,
          bot_id: record.bot_id,
          guild_id: record.guild_id,
          session_id: record.session_id,
          trigger: record.trigger,
          sequence: record.sequence,
          op: GatewayOp.InvalidSession,
          resumable: false,
          close_code:
            record.trigger === 'immediate'
              ? GatewayCloseCode.SessionTimedOut
              : null,
          transport: record.transport,
          status: record.applied
            ? replacement
              ? 'identified'
              : record.identifies.some(
                    (attempt) => attemptState(attempt) === 'pending'
                  )
                ? 'identifying'
                : 'awaiting_identify'
            : 'armed',
          resume_rejection: record.resume_rejection,
          replacement: replacement ? publicAttempt(replacement) : null,
          ttl_ms: record.ttl_ms,
          invalidated_at: record.invalidated_at,
          expires_at: record.expires_at,
          identifies: record.identifies.map((attempt) =>
            publicAttempt(attempt)
          ),
          identifies_skipped: record.identifies_skipped,
          resumes_rejected: record.resumes_rejected,
        })
      : undefined
  }

  /** Resolves the exact owner's live observation ID by its pre-chosen key. */
  idByKey(scope: SessionInvalidationOwnership): string | null {
    const owner = this.owners.get(scope.ownership_key)
    return owner && sameOwner(owner, scope) ? owner.id : null
  }

  /**
   * Waits (bounded) until a replacement IDENTIFY wrote READY and every
   * GUILD_CREATE, or the observation retires, then inspects it.
   */
  async wait(
    id: string | null,
    waitMs: number
  ): Promise<object | undefined | 'LIMIT'> {
    const record = id ? this.records.get(id) : undefined
    if (!record) return undefined
    /** Whether the observation retired or has a complete replacement. */
    const settled = (): boolean => {
      const current = this.records.get(record.id)
      return !current || !isOpen(current)
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

  /** Wakes waiters of one observation so they re-check their condition. */
  private notify(id: string): void {
    const checks = this.waiters.get(id) ?? []
    for (const check of checks) check()
  }

  /** Retires an observation by ID; the invalidation itself is irreversible. */
  delete(id: string): boolean {
    return this.retire(id)
  }

  /**
   * Closes ownership by key: retires an applied observation, or tombstones an
   * unused key so a delayed POST can never invalidate a session.
   */
  deleteByKey(
    scope: SessionInvalidationOwnership
  ): 'DELETED' | 'UNKNOWN_SCOPE' | 'LIMIT' {
    const owner = this.owners.get(scope.ownership_key)
    if (owner) {
      if (!sameOwner(owner, scope)) return 'UNKNOWN_SCOPE'
      if (owner.id) this.retire(owner.id)
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
    this.records.delete(id)
    const owner = this.owners.get(record.ownership_key)
    if (owner) owner.id = null
    this.notify(id)
    return true
  }

  /** Retires all observations, or those of one normalized setup token. */
  reset(token?: string): void {
    for (const record of this.records.values()) {
      if (!token || record.token === token) this.retire(record.id)
    }
  }

  /** Retires observations scoped to a deleted guild. */
  deleteGuild(guildId: string): void {
    for (const record of this.records.values()) {
      if (record.guild_id === guildId) this.retire(record.id)
    }
  }
}
