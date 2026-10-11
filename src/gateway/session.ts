import type { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type { GatewayPayload } from './protocol'

/** Maximum number of events retained in the replay buffer */
const REPLAY_BUFFER_SIZE = 100

/** Default heartbeat interval (ms) announced in HELLO; matches real Discord. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 41_250

/** Socket write progress of one Gateway frame, never application completion. */
export type DispatchTransport = 'buffered' | 'queued' | 'sent' | 'failed'

/** Facts about a successful IDENTIFY, captured before READY is written. */
export interface IdentifyFacts {
  /** Sequence assigned to READY */
  readySequence: number
  /** Guild IDs listed in READY as unavailable stubs */
  guildIds: string[]
  /** Whether GUILD_CREATE dispatches follow (Guilds intent) */
  guildsIntent: boolean
}

/** Facts about a successful RESUME, captured after RESUMED was queued. */
export interface ResumeFacts {
  /** Socket the session was bound to before this RESUME */
  previousSocket: WebSocket
  /** Last sequence the client reported in RESUME */
  clientSequence: number
  /** Sequences replayed to the client, in order */
  replayedSequences: number[]
  /** Sequence assigned to the RESUMED dispatch */
  resumedSequence: number
}

/** Facts about an authenticated RESUME a test control may reject. */
export interface ResumeAttempt {
  /** Socket the RESUME arrived on */
  socket: WebSocket
  /** Last sequence the client reported in RESUME */
  clientSequence: number
  /** Buffered events the RESUME would replay, or undefined when unavailable */
  replay: { seq: number; event: GatewayPayload<unknown> }[] | undefined
}

/** Per-IDENTIFY transport observer installed by a test control. */
export interface IdentifyObserver {
  /** Observes READY's socket write */
  ready: (status: DispatchTransport) => void
  /** Observes one GUILD_CREATE envelope, returning its write observer */
  guildCreate: (
    payload: GatewayPayload<unknown>
  ) => ((status: DispatchTransport) => void) | undefined
}

/** Represents a single Gateway connection (session) */
export interface Session {
  /** Session ID (used when resuming) */
  sessionId: string
  /** ID of the connecting Bot (the user ID associated with bots.token) */
  botId: string
  /** Bot token sent in IDENTIFY */
  token: string
  /** Most recent Dispatch sequence number */
  seq: number
  /** Intent bitfield received in IDENTIFY */
  intents: number
  /** The currently connected WebSocket */
  ws: WebSocket
  /** Replay buffer used for Resume (most recent REPLAY_BUFFER_SIZE entries) */
  replayBuffer: { seq: number; event: GatewayPayload<unknown> }[]
  /** Timer that monitors the Heartbeat timeout */
  heartbeatTimer: NodeJS.Timeout | undefined
  /** Timestamp of the last received Heartbeat (ms epoch) */
  lastHeartbeatAt: number
  /** Timestamp of the last HEARTBEAT_ACK written for this session (ms epoch) */
  lastHeartbeatAckAt: number | undefined
}

/**
 * Manages the creation, lookup, removal, and replay buffer of Gateway
 * sessions.
 */
export class SessionManager {
  /**
   * @param heartbeatIntervalMs - Heartbeat interval (ms) announced in HELLO;
   * sessions without a heartbeat for twice this long are closed and removed
   */
  constructor(
    readonly heartbeatIntervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS
  ) {}

  /** Test-only interception after native sequencing; true holds the envelope. */
  captureDispatch?: (
    session: Session,
    payload: GatewayPayload<unknown>
  ) => boolean
  /** Clears captures when a session is removed or its connection is replaced. */
  invalidateEventControls?: (sessionId: string) => void

  /** Clears a socket's deferred resumes when it establishes another session. */
  invalidatePendingResume?: (socket: WebSocket) => void

  /** Rebinds explicitly reconnecting controls; ordinary replacement invalidates. */
  resumeEventControls?: (session: Session, socket: WebSocket) => void
  /** Defers a validated RESUME while a test deliberately buffers native updates. */
  gateResume?: (
    session: Session,
    socket: WebSocket,
    retry: () => void
  ) => boolean
  /** Records transport progress separately from consuming application completion. */
  observeDispatch?: (
    session: Session,
    payload: GatewayPayload<unknown>,
    source: 'native' | 'release' | 'replay' | 'resume'
  ) => ((status: DispatchTransport) => void) | undefined
  /** Observes a successful IDENTIFY; returns undefined when nothing is watching. */
  observeIdentify?: (
    session: Session,
    facts: IdentifyFacts
  ) => IdentifyObserver | undefined
  /** Observes a RESUME rejected because its session no longer exists. */
  observeRejectedResume?: (sessionId: string) => void
  /**
   * Lets a test control answer an authenticated RESUME with INVALID_SESSION
   * (`d: false`) instead of replaying; returns the op 9 write observer when
   * the RESUME is rejected, or undefined to continue normally.
   */
  rejectResume?: (
    session: Session,
    attempt: ResumeAttempt
  ) => ((status: DispatchTransport) => void) | undefined
  /** Observes a successful RESUME after its replay and RESUMED were queued. */
  observeResume?: (session: Session, facts: ResumeFacts) => void
  /** Observes a HEARTBEAT that a silenced connection left unacknowledged. */
  observeSilencedHeartbeat?: (session: Session, sequence: unknown) => void
  /** Observes a dispatch withheld from a silenced connection. */
  observeSilencedDispatch?: (
    session: Session,
    payload: GatewayPayload<unknown>
  ) => void

  private readonly silencedSockets = new WeakSet<WebSocket>()
  private readonly removalListeners = new Set<(session: Session) => void>()

  /**
   * Silences an open connection (test-only zombie): the server keeps it open
   * but writes neither HEARTBEAT_ACK nor dispatches to it; dispatches are
   * buffered for RESUME as for a closed socket.
   * @param socket - Connection to silence
   */
  silence(socket: WebSocket): void {
    this.silencedSockets.add(socket)
  }

  /**
   * Lets a silenced connection receive writes again.
   * @param socket - Connection to restore
   */
  unsilence(socket: WebSocket): void {
    this.silencedSockets.delete(socket)
  }

  /**
   * Whether writes to the connection are currently withheld.
   * @param socket - Connection to check
   * @returns true while the connection is silenced
   */
  isSilenced(socket: WebSocket): boolean {
    return this.silencedSockets.has(socket)
  }

  /**
   * Registers a listener called synchronously whenever a session is removed.
   * @param listener - Callback receiving the removed session
   * @returns Function that unregisters the listener
   */
  onRemove(listener: (session: Session) => void): () => void {
    this.removalListeners.add(listener)
    return () => {
      this.removalListeners.delete(listener)
    }
  }

  private readonly connectionGenerations = new WeakMap<WebSocket, number>()

  /** Returns the socket's session generation for deferred-operation ownership. */
  connectionGeneration(socket: WebSocket): number {
    return this.connectionGenerations.get(socket) ?? 0
  }

  /** Invalidates deferred attempts before a successful IDENTIFY or RESUME binds. */
  establishConnection(socket: WebSocket): void {
    this.connectionGenerations.set(
      socket,
      this.connectionGeneration(socket) + 1
    )
    this.invalidatePendingResume?.(socket)
  }

  private readonly sessionsById = new Map<string, Session>()
  private readonly sessionIdsByBotId = new Map<string, Set<string>>()

  /**
   * Creates and registers a new session.
   * @param params - Session initialization parameters
   * @returns The created session
   */
  create(params: {
    botId: string
    token: string
    intents: number
    ws: WebSocket
  }): Session {
    const session: Session = {
      sessionId: randomUUID().replaceAll('-', ''),
      botId: params.botId,
      token: params.token,
      seq: 0,
      intents: params.intents,
      ws: params.ws,
      replayBuffer: [],
      heartbeatTimer: undefined,
      lastHeartbeatAt: Date.now(),
      lastHeartbeatAckAt: undefined,
    }
    this.sessionsById.set(session.sessionId, session)
    const set = this.sessionIdsByBotId.get(session.botId) ?? new Set<string>()
    set.add(session.sessionId)
    this.sessionIdsByBotId.set(session.botId, set)
    return session
  }

  /**
   * Looks up a session by its session ID.
   * @param sessionId - Session ID
   * @returns The session, or undefined if it doesn't exist
   */
  get(sessionId: string): Session | undefined {
    return this.sessionsById.get(sessionId)
  }

  /**
   * Gets all sessions belonging to the given Bot ID.
   * @param botId - Bot ID
   * @returns Array of sessions
   */
  getByBotId(botId: string): Session[] {
    const ids = this.sessionIdsByBotId.get(botId)
    return ids
      ? [...ids]
          .map((id) => this.sessionsById.get(id))
          .filter((s): s is Session => s !== undefined)
      : []
  }

  /**
   * Gets all currently connected sessions.
   * @returns Array of sessions
   */
  getAll(): Session[] {
    return this.sessionsById.values().toArray()
  }

  /**
   * Removes a session.
   * @param sessionId - ID of the session to remove
   */
  remove(sessionId: string): void {
    const session = this.sessionsById.get(sessionId)
    if (!session) return
    this.invalidateEventControls?.(sessionId)
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer)
    this.sessionsById.delete(sessionId)
    this.sessionIdsByBotId.get(session.botId)?.delete(sessionId)
    for (const listener of this.removalListeners) listener(session)
  }

  /**
   * Advances the sequence number by one and returns it.
   * @param session - Target session
   * @returns The new sequence number
   */
  nextSeq(session: Session): number {
    session.seq += 1
    return session.seq
  }

  /**
   * Appends an event to the replay buffer, discarding the oldest event once
   * the size limit is exceeded.
   * @param session - Target session
   * @param event - Event to append
   */
  pushToReplayBuffer(session: Session, event: GatewayPayload<unknown>): void {
    session.replayBuffer.push({ seq: event.s ?? session.seq, event })
    if (session.replayBuffer.length > REPLAY_BUFFER_SIZE) {
      session.replayBuffer.shift()
    }
  }

  /**
   * Gets the events after the given seq for replay.
   * @param session - Target session
   * @param seq - Last seq the client received
   * @returns The events to replay, or undefined if seq is older than the
   * buffer and can no longer be reconstructed
   */
  replayFrom(
    session: Session,
    seq: number
  ): { seq: number; event: GatewayPayload<unknown> }[] | undefined {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > session.seq)
      return undefined
    if (session.replayBuffer.length === 0) {
      return seq === session.seq ? [] : undefined
    }
    const oldestSeq = session.replayBuffer[0]?.seq ?? 0
    return seq < oldestSeq - 1
      ? undefined
      : session.replayBuffer.filter((entry) => entry.seq > seq)
  }
}
