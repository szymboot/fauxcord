import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Database } from '../db'
import type { Session, SessionManager } from './session'
import type { GatewayPayload } from './protocol'
import { encodePayload } from './protocol'
import { deliverDispatch } from './dispatch'

/** Native dispatches supported by the narrow test capture control. */
export const CONTROL_EVENTS = [
  'MESSAGE_DELETE',
  'MESSAGE_DELETE_BULK',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
] as const

/** Exact scope and bounded capture policy supplied by a test. */
export interface EventControlRequest {
  guild_id: string
  bot_id: string
  /** Optional exact session; omission requires one unambiguous live owner. */
  session_id?: string
  events: string[]
  hold: boolean
  allow_original_sequence: boolean
  limit: number
  ttl_ms: number
}

/** Validated policy pinned to one resolved session for its entire lifetime. */
interface ResolvedEventControlRequest extends EventControlRequest {
  session_id: string
}

/** Immutable native envelope plus its delivery observation. */
interface CapturedEvent {
  id: string
  envelope: GatewayPayload<unknown>
  state: 'held' | 'delivered' | 'released'
  deliveries: number
  last_sequence: number | null
}

/** One live-session capture, with a fixed lifetime and memory budget. */
interface EventControl extends ResolvedEventControlRequest {
  id: string
  expires_at: number
  events_captured: CapturedEvent[]
  skipped: number
  bytes: number
  operations: number
  timer: NodeJS.Timeout
  session: Session
  socket: WebSocket
}

/** Manages test captures locally to one assembled Gateway and database. */
export class GatewayEventControls {
  private readonly controls = new Map<string, EventControl>()
  private readonly closeListeners = new Map<WebSocket, () => void>()

  /** Installs capture and session invalidation hooks on this Gateway only. */
  constructor(
    private readonly db: Database,
    private readonly manager: SessionManager
  ) {
    manager.captureDispatch = (session, envelope) =>
      this.capture(session, envelope)
    manager.invalidateEventControls = (sessionId) => {
      for (const control of this.controls.values()) {
        if (control.session_id === sessionId) this.delete(control.id)
      }
    }
  }

  /** Verifies that the original live connection still owns the guild scope. */
  private isLive(control: EventControl): boolean {
    return (
      control.expires_at > Date.now() &&
      this.manager.get(control.session_id) === control.session &&
      control.session.ws === control.socket &&
      control.socket.readyState === WebSocket.OPEN &&
      this.hasScope(control, control.session)
    )
  }

  /** Resolves a guild to its registered bot without exposing credentials. */
  private hasScope(request: EventControlRequest, session: Session): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ? AND b.user_id = ? AND b.token = ?'
        )
        .get(
          request.guild_id,
          request.bot_id,
          session.token.startsWith('Bot ')
            ? session.token
            : `Bot ${session.token}`
        )
    )
  }

  /** Creates a capture for one existing session; overlapping captures conflict. */
  create(
    request: EventControlRequest
  ): string | (ResolvedEventControlRequest & { id: string }) {
    this.prune()
    const candidates =
      request.session_id === undefined
        ? this.manager
            .getByBotId(request.bot_id)
            .filter(
              (candidate) =>
                candidate.ws.readyState === WebSocket.OPEN &&
                this.hasScope(request, candidate)
            )
        : [this.manager.get(request.session_id)].filter(
            (candidate): candidate is Session => candidate !== undefined
          )
    if (candidates.length > 1) return 'AMBIGUOUS_SESSION'
    const session = candidates.at(0)
    if (
      session?.botId !== request.bot_id ||
      session.ws.readyState !== WebSocket.OPEN ||
      !this.hasScope(request, session)
    )
      return 'UNKNOWN_SCOPE'
    if (this.controls.size >= 32) return 'LIMIT'
    if (
      this.controls
        .values()
        .some(
          (control) =>
            control.session_id === session.sessionId &&
            control.guild_id === request.guild_id &&
            control.events.some((event) => request.events.includes(event))
        )
    )
      return 'CONFLICT'
    const id = randomUUID()
    const timer = setTimeout(() => this.delete(id), request.ttl_ms)
    timer.unref()
    if (!this.closeListeners.has(session.ws)) {
      const socket = session.ws
      /** Discards all controls tied to the disconnected connection. */
      const onClose = (): void => {
        for (const control of this.controls.values()) {
          if (control.socket === socket) this.delete(control.id)
        }
      }
      this.closeListeners.set(socket, onClose)
      socket.once('close', onClose)
    }
    this.controls.set(id, {
      ...request,
      session_id: session.sessionId,
      id,
      expires_at: Date.now() + request.ttl_ms,
      events_captured: [],
      skipped: 0,
      bytes: 0,
      operations: 0,
      timer,
      session,
      socket: session.ws,
    })
    return { ...request, session_id: session.sessionId, id }
  }

  /** Removes stale controls, discarding held events without delivering them. */
  private prune(): void {
    for (const control of this.controls.values()) {
      if (!this.isLive(control)) this.delete(control.id)
    }
  }

  /** Captures only native, intent-filtered dispatches matching the exact scope. */
  private capture(
    session: Session,
    envelope: GatewayPayload<unknown>
  ): boolean {
    this.prune()
    const data = envelope.d as { guild_id?: unknown } | null
    const control = this.controls
      .values()
      .find(
        (candidate) =>
          candidate.session === session &&
          candidate.guild_id === data?.guild_id &&
          candidate.events.includes(envelope.t ?? '')
      )
    if (!control) return false
    const serialized = encodePayload(envelope)
    const bytes = Buffer.byteLength(serialized)
    if (
      control.events_captured.length >= control.limit ||
      control.bytes + bytes > 262_144
    ) {
      control.skipped += 1
      return false
    }
    control.bytes += bytes
    control.events_captured.push({
      id: randomUUID(),
      envelope: JSON.parse(serialized) as GatewayPayload<unknown>,
      state: control.hold ? 'held' : 'delivered',
      deliveries: control.hold ? 0 : 1,
      last_sequence: control.hold ? null : (envelope.s ?? null),
    })
    return control.hold
  }

  /** Returns payload snapshots and counters, never a token or socket. */
  inspect(id: string): object | undefined {
    this.prune()
    const control = this.controls.get(id)
    return control
      ? structuredClone({
          id: control.id,
          guild_id: control.guild_id,
          bot_id: control.bot_id,
          session_id: control.session_id,
          events: control.events,
          hold: control.hold,
          allow_original_sequence: control.allow_original_sequence,
          limit: control.limit,
          ttl_ms: control.ttl_ms,
          expires_at: control.expires_at,
          events_captured: control.events_captured,
          skipped: control.skipped,
          bytes: control.bytes,
          operations: control.operations,
        })
      : undefined
  }

  /** Releases held events in requested order or duplicates one delivered event. */
  deliver(
    id: string,
    ids: string[],
    replay: boolean,
    original: boolean
  ): string | object {
    this.prune()
    const control = this.controls.get(id)
    if (!control) return 'UNKNOWN_SCOPE'
    if (original && !control.allow_original_sequence) return 'INVALID_STATE'
    if (control.operations + ids.length > 100) return 'LIMIT'
    const entries = ids.map((eventId) =>
      control.events_captured.find((event) => event.id === eventId)
    )
    if (entries.some((event) => !event)) return 'UNKNOWN_EVENT'
    const captured = entries as CapturedEvent[]
    if (
      captured.some((event) =>
        replay ? event.state === 'held' : event.state !== 'held'
      )
    )
      return 'INVALID_STATE'
    for (const event of captured) {
      const payload = structuredClone(event.envelope)
      if (original) {
        control.socket.send(encodePayload(payload))
      } else {
        payload.s = this.manager.nextSeq(control.session)
        deliverDispatch(this.manager, control.session, payload)
      }
      event.state = replay ? event.state : 'released'
      event.deliveries += 1
      event.last_sequence = payload.s ?? null
      control.operations += 1
    }
    return this.inspect(id) ?? 'UNKNOWN_SCOPE'
  }

  /** Cancels a control and drops its held events and observation history. */
  delete(id: string): boolean {
    const control = this.controls.get(id)
    if (!control) return false
    clearTimeout(control.timer)
    this.controls.delete(id)
    if (
      !this.controls.values().some((other) => other.socket === control.socket)
    ) {
      const listener = this.closeListeners.get(control.socket)
      if (listener) control.socket.off('close', listener)
      this.closeListeners.delete(control.socket)
    }
    return true
  }

  /** Clears all controls or those owned by a reset/deleted setup token. */
  reset(token?: string): void {
    for (const control of this.controls.values()) {
      if (
        !token ||
        (control.session.token.startsWith('Bot ')
          ? control.session.token
          : `Bot ${control.session.token}`) === token
      ) {
        this.delete(control.id)
      }
    }
  }
}
