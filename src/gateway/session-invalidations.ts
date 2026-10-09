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
/** Maximum replacement IDENTIFYs retained per observation. */
const MAX_IDENTIFIES = 4
/** Maximum GUILD_CREATE summaries retained per IDENTIFY. */
const MAX_GUILD_CREATES = 50
/** Maximum voice-state summaries retained per GUILD_CREATE. */
const MAX_VOICE_STATES = 100
/** Maximum concurrent long-poll waiters per Gateway instance. */
const MAX_WAITERS = 64

/** Exact keyed request; every field is required except the observation TTL. */
export interface SessionInvalidationRequest {
  ownership_key: string
  bot_id: string
  guild_id: string
  session_id: string
  ttl_ms: number
}

/** Exact public owner address known before sending a keyed POST. */
export type SessionInvalidationOwnership = Omit<
  SessionInvalidationRequest,
  'ttl_ms'
>

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
  guild_creates: GuildCreateObservation[]
  guild_creates_skipped: number
}

/** One applied invalidation and its bounded replacement evidence. */
interface InvalidationRecord extends SessionInvalidationRequest {
  id: string
  /** Normalized setup token of the invalidated session (never exposed). */
  token: string
  /** Invalidated socket; IDENTIFYs on it are not replacements. */
  socket: WebSocket
  sequence: number
  transport: DispatchTransport
  invalidated_at: number
  expires_at: number
  timer: NodeJS.Timeout
  identifies: IdentifyObservation[]
  identifies_skipped: number
  resumes_rejected: number
}

/** Bounded lifetime reservation; a null ID permanently prevents resurrection. */
interface OwnershipReservation extends SessionInvalidationOwnership {
  ttl_ms?: number
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

/** Whether a replacement's first IDENTIFY wrote READY and every GUILD_CREATE. */
function isComplete(identify: IdentifyObservation): boolean {
  if (identify.ready.transport !== 'sent') return false
  return identify.guilds_intent
    ? identify.ready.guild_ids.every((guildId) =>
        identify.guild_creates.some(
          (entry) => entry.guild_id === guildId && entry.transport === 'sent'
        )
      )
    : true
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
        if (record.session_id !== sessionId) continue
        record.resumes_rejected += 1
        this.notify(record.id)
      }
    }
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
          'SELECT 1 FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ? AND b.user_id = ?' +
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
   * 4009) or returns the existing observation for an identical keyed retry.
   */
  create(request: SessionInvalidationRequest): string | object {
    const owner = this.owners.get(request.ownership_key)
    if (owner) {
      return sameOwner(owner, request) &&
        owner.ttl_ms === request.ttl_ms &&
        owner.id
        ? (this.inspect(owner.id) ?? 'CONFLICT')
        : 'CONFLICT'
    }
    if (this.owners.size >= MAX_OWNERS) return 'LIMIT'
    const session = this.manager.get(request.session_id)
    if (!session || !this.inScope(session, request)) return 'UNKNOWN_SCOPE'
    if (session.ws.readyState !== WebSocket.OPEN) return 'INVALID_STATE'
    if (this.records.size >= MAX_LIVE) return 'LIMIT'

    const id = randomUUID()
    const now = Date.now()
    const timer = setTimeout(() => this.retire(id), request.ttl_ms)
    timer.unref()
    const record: InvalidationRecord = {
      ...request,
      id,
      token: normalizeToken(session.token),
      socket: session.ws,
      sequence: session.seq,
      transport: 'queued',
      invalidated_at: now,
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
      id,
    })
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

  /** Records IDENTIFYs by the invalidated setup token on any other socket. */
  private observeIdentify(
    session: Session,
    facts: IdentifyFacts
  ): IdentifyObserver | undefined {
    const token = normalizeToken(session.token)
    const entries: IdentifyObservation[] = []
    for (const record of this.records.values()) {
      if (
        record.token !== token ||
        record.bot_id !== session.botId ||
        record.socket === session.ws
      )
        continue
      if (record.identifies.length >= MAX_IDENTIFIES) {
        record.identifies_skipped += 1
        continue
      }
      const entry: IdentifyObservation = {
        session_id: session.sessionId,
        intents: session.intents,
        identified_at: Date.now(),
        guilds_intent: facts.guildsIntent,
        ready: {
          sequence: facts.readySequence,
          guild_ids: [...facts.guildIds],
          transport: 'queued',
        },
        guild_creates: [],
        guild_creates_skipped: 0,
      }
      record.identifies.push(entry)
      entries.push(entry)
      this.notify(record.id)
    }
    return entries.length === 0
      ? undefined
      : {
          ready: (status) => {
            for (const entry of entries) entry.ready.transport = status
            this.notifyAll()
          },
          guildCreate: (payload) => {
            const observations: GuildCreateObservation[] = []
            for (const entry of entries) {
              if (entry.guild_creates.length >= MAX_GUILD_CREATES) {
                entry.guild_creates_skipped += 1
                continue
              }
              const observation = summarizeGuildCreate(payload)
              entry.guild_creates.push(observation)
              observations.push(observation)
            }
            return observations.length === 0
              ? undefined
              : (status) => {
                  for (const observation of observations)
                    observation.transport = status
                  this.notifyAll()
                }
          },
        }
  }

  /** Returns public evidence only; never a token or socket. */
  inspect(id: string): object | undefined {
    const record = this.records.get(id)
    return record
      ? structuredClone({
          id: record.id,
          ownership_key: record.ownership_key,
          bot_id: record.bot_id,
          guild_id: record.guild_id,
          session_id: record.session_id,
          sequence: record.sequence,
          op: GatewayOp.InvalidSession,
          resumable: false,
          close_code: GatewayCloseCode.SessionTimedOut,
          transport: record.transport,
          status:
            record.identifies.length > 0 ? 'identified' : 'awaiting_identify',
          ttl_ms: record.ttl_ms,
          invalidated_at: record.invalidated_at,
          expires_at: record.expires_at,
          identifies: record.identifies.map((entry) => ({
            ...entry,
            complete: isComplete(entry),
          })),
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
   * Waits (bounded) until the first replacement IDENTIFY wrote READY and
   * every GUILD_CREATE, or the observation retires, then inspects it.
   */
  async wait(
    id: string | null,
    waitMs: number
  ): Promise<object | undefined | 'LIMIT'> {
    const record = id ? this.records.get(id) : undefined
    if (!record) return undefined
    /** Whether the observation retired or its first replacement settled. */
    const settled = (): boolean => {
      const current = this.records.get(record.id)
      const first = current?.identifies.at(0)
      return !current || (first !== undefined && isComplete(first))
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

  /** Wakes every waiter; transport callbacks may be shared across records. */
  private notifyAll(): void {
    const ids = this.waiters.keys().toArray()
    for (const id of ids) this.notify(id)
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
