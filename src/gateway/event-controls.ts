import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Database } from '../db'
import type { Session, SessionManager } from './session'
import type { GatewayPayload } from './protocol'
import { encodePayload } from './protocol'
import { deliverDispatch, writeDispatch } from './dispatch'
import { sendReconnect } from './server'

/** Native dispatches supported by the narrow test capture control. */
export const CONTROL_EVENTS = [
  'GUILD_MEMBER_UPDATE',
  'MESSAGE_CREATE',
  'MESSAGE_DELETE',
  'MESSAGE_DELETE_BULK',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
  'VOICE_STATE_UPDATE',
] as const

/** Exact scope and bounded capture policy supplied by a test. */
export interface EventControlRequest {
  ownership_key?: string
  guild_id: string
  bot_id: string
  /** Optional exact session; omission requires one unambiguous live owner. */
  session_id?: string
  /** Optional exact member selector, only for member update captures. */
  member_id?: string
  /** Requires explicit consuming-client acknowledgements for delivery barriers. */
  application_ack?: boolean
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

/** Exact public address known before sending a keyed creation request. */
export interface EventControlOwnership {
  ownership_key: string
  bot_id: string
  guild_id: string
  session_id: string
}

/** Bounded lifetime reservation; null IDs permanently prevent resurrection. */
interface OwnershipReservation extends EventControlOwnership {
  policy?: string
  id: string | null
}

/** Compares the complete immutable public owner address. */
function sameOwner(
  owner: EventControlOwnership,
  scope: EventControlOwnership
): boolean {
  return (
    owner.bot_id === scope.bot_id &&
    owner.guild_id === scope.guild_id &&
    owner.session_id === scope.session_id
  )
}

/** Normalizes event sets and default policy fields before retry comparison. */
function policyKey(request: EventControlRequest): string {
  return JSON.stringify({
    events: request.events.toSorted((left, right) => left.localeCompare(right)),
    member_id: request.member_id ?? null,
    application_ack: request.application_ack ?? false,
    hold: request.hold,
    allow_original_sequence: request.allow_original_sequence,
    limit: request.limit,
    ttl_ms: request.ttl_ms,
  })
}

/** One bounded transport attempt with an independent application barrier. */
interface DeliveryObservation {
  id: string
  sequence: number | null
  source: 'native' | 'release' | 'replay' | 'resume'
  transport: 'buffered' | 'queued' | 'sent' | 'failed'
  application: 'not_requested' | 'pending' | 'acknowledged'
  ack_token?: string
}

/** Immutable native envelope plus its delivery observation. */
interface CapturedEvent {
  id: string
  envelope: GatewayPayload<unknown>
  state: 'held' | 'delivered' | 'released'
  deliveries: number
  last_sequence: number | null
  delivery_records: DeliveryObservation[]
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
  awaiting_resume: boolean
  pause_resume: boolean
  pending_resume?: {
    socket: WebSocket
    retry: () => void
    onClose: () => void
    generation: number
  }
  delivery_observations: number
  delivery_observations_skipped: number
}

/** Manages test captures locally to one assembled Gateway and database. */
export class GatewayEventControls {
  private readonly controls = new Map<string, EventControl>()
  private readonly owners = new Map<string, OwnershipReservation>()
  private readonly capturedPayloads = new WeakMap<
    object,
    { controlId: string; eventId: string }
  >()
  private readonly closeListeners = new Map<WebSocket, () => void>()

  /** Installs capture and session invalidation hooks on this Gateway only. */
  constructor(
    private readonly db: Database,
    private readonly manager: SessionManager
  ) {
    manager.captureDispatch = (session, envelope) =>
      this.capture(session, envelope)
    manager.observeDispatch = (session, payload, source) =>
      this.observeDelivery(session, payload, source)
    manager.invalidatePendingResume = (socket) => {
      for (const control of this.controls.values()) {
        const pending = control.pending_resume
        if (pending?.socket !== socket) continue
        socket.off('close', pending.onClose)
        control.pending_resume = undefined
      }
    }
    manager.gateResume = (session, socket, retry) => {
      this.prune()
      const control = this.controls
        .values()
        .find(
          (entry) =>
            entry.session === session &&
            entry.awaiting_resume &&
            entry.pause_resume
        )
      if (!control) return false
      if (
        control.pending_resume ||
        this.controls
          .values()
          .some((owner) => owner.pending_resume?.socket === socket) ||
        manager.getAll().some((owner) => owner.ws === socket)
      ) {
        socket.send(encodePayload({ op: 9, d: false }))
        return true
      }
      /** Clears a closed pending connection without opening the resume gate. */
      const onClose = (): void => {
        control.pending_resume = undefined
      }
      control.pending_resume = {
        socket,
        retry,
        onClose,
        generation: manager.connectionGeneration(socket),
      }
      socket.once('close', onClose)
      return true
    }
    manager.resumeEventControls = (session, socket) => {
      for (const control of this.controls.values()) {
        if (control.session !== session) continue
        if (!control.awaiting_resume || !this.isLive(control)) {
          this.delete(control.id)
          continue
        }
        const oldSocket = control.socket
        control.socket = socket
        control.awaiting_resume = false
        this.detachUnusedListener(oldSocket)
        this.attachListener(socket)
      }
    }
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
      (control.awaiting_resume ||
        control.socket.readyState === WebSocket.OPEN) &&
      this.hasScope(control, control.session)
    )
  }

  /** Resolves a guild to its registered bot without exposing credentials. */
  private hasScope(
    request: Pick<EventControlRequest, 'bot_id' | 'guild_id'>,
    session: Session
  ): boolean {
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
  create(request: EventControlRequest): string | object {
    this.prune()
    if (request.ownership_key !== undefined) {
      if (!request.session_id) return 'CONFLICT'
      const owner = this.owners.get(request.ownership_key)
      if (owner) {
        return sameOwner(owner, request as EventControlOwnership) &&
          owner.policy === policyKey(request) &&
          owner.id
          ? (this.inspect(owner.id) ?? 'RETIRED')
          : 'CONFLICT'
      }
      if (this.owners.size >= 4096) return 'LIMIT'
    }
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
    if (
      request.member_id !== undefined &&
      !this.db
        .prepare(
          'SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?'
        )
        .get(request.guild_id, request.member_id)
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
            (control.member_id === undefined ||
              request.member_id === undefined ||
              control.member_id === request.member_id) &&
            control.events.some((event) => request.events.includes(event))
        )
    )
      return 'CONFLICT'
    const id = randomUUID()
    const timer = setTimeout(() => this.delete(id), request.ttl_ms)
    timer.unref()
    this.attachListener(session.ws)
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
      awaiting_resume: false,
      pause_resume: false,
      delivery_observations: 0,
      delivery_observations_skipped: 0,
    })
    if (request.ownership_key !== undefined) {
      this.owners.set(request.ownership_key, {
        ownership_key: request.ownership_key,
        bot_id: request.bot_id,
        guild_id: request.guild_id,
        session_id: session.sessionId,
        policy: policyKey(request),
        id,
      })
      return this.inspect(id) ?? 'RETIRED'
    }
    return { ...request, session_id: session.sessionId, id }
  }

  /** Recovers only the exact owner's live evidence, without exposing credentials. */
  inspectByKey(scope: EventControlOwnership): object | undefined {
    this.prune()
    const owner = this.owners.get(scope.ownership_key)
    return owner && sameOwner(owner, scope) && owner.id
      ? this.inspect(owner.id)
      : undefined
  }

  /** Atomically closes ownership even when deletion precedes body parsing of POST. */
  deleteByKey(
    scope: EventControlOwnership
  ): 'DELETED' | 'UNKNOWN_SCOPE' | 'LIMIT' {
    this.prune()
    const owner = this.owners.get(scope.ownership_key)
    if (owner) {
      if (!sameOwner(owner, scope)) return 'UNKNOWN_SCOPE'
      if (owner.id) this.delete(owner.id)
      return 'DELETED'
    }
    const session = this.manager.get(scope.session_id)
    if (session?.botId !== scope.bot_id || !this.hasScope(scope, session))
      return 'UNKNOWN_SCOPE'
    if (this.owners.size >= 4096) return 'LIMIT'
    this.owners.set(scope.ownership_key, {
      ...scope,
      id: null,
    })
    return 'DELETED'
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
    const data = envelope.d as {
      guild_id?: unknown
      user?: { id?: unknown }
    } | null
    const control = this.controls
      .values()
      .find(
        (candidate) =>
          candidate.session === session &&
          candidate.guild_id === data?.guild_id &&
          (candidate.member_id === undefined ||
            candidate.member_id === data.user?.id) &&
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
    const eventId = randomUUID()
    this.capturedPayloads.set(envelope, { controlId: control.id, eventId })
    control.events_captured.push({
      id: eventId,
      envelope: JSON.parse(serialized) as GatewayPayload<unknown>,
      state: control.hold ? 'held' : 'delivered',
      deliveries: 0,
      last_sequence: null,
      delivery_records: [],
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
          ...(control.ownership_key !== undefined && {
            ownership_key: control.ownership_key,
          }),
          guild_id: control.guild_id,
          bot_id: control.bot_id,
          session_id: control.session_id,
          events: control.events,
          member_id: control.member_id,
          application_ack: control.application_ack ?? false,
          awaiting_resume: control.awaiting_resume,
          pause_resume: control.pause_resume,
          pending_resume: control.pending_resume !== undefined,
          delivery_observations_skipped: control.delivery_observations_skipped,
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
    if (control.awaiting_resume || control.socket.readyState !== WebSocket.OPEN)
      return 'INVALID_STATE'
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
      this.capturedPayloads.set(payload, { controlId: id, eventId: event.id })
      const source = replay ? 'replay' : 'release'
      if (original) {
        writeDispatch(this.manager, control.session, payload, source)
      } else {
        payload.s = this.manager.nextSeq(control.session)
        deliverDispatch(this.manager, control.session, payload, source)
      }
      event.state = replay ? event.state : 'released'
      control.operations += 1
    }
    return this.inspect(id) ?? 'UNKNOWN_SCOPE'
  }

  /** Tracks an attempted write; send callbacks cannot acknowledge application work. */
  private observeDelivery(
    session: Session,
    payload: GatewayPayload<unknown>,
    source: DeliveryObservation['source']
  ): ((status: DeliveryObservation['transport']) => void) | undefined {
    this.prune()
    const reference = this.capturedPayloads.get(payload)
    const control = reference && this.controls.get(reference.controlId)
    const event = control?.events_captured.find(
      (entry) => entry.id === reference?.eventId
    )
    if (!event || control?.session !== session) return undefined
    event.deliveries += 1
    event.last_sequence = payload.s ?? null
    if (control.delivery_observations >= 200) {
      control.delivery_observations_skipped += 1
      return undefined
    }
    control.delivery_observations += 1
    const delivery: DeliveryObservation = {
      id: randomUUID(),
      sequence: payload.s ?? null,
      source,
      transport: 'queued',
      application: control.application_ack ? 'pending' : 'not_requested',
      ...(control.application_ack && { ack_token: randomUUID() }),
    }
    event.delivery_records.push(delivery)
    return (status) => {
      delivery.transport = status
    }
  }

  /** Explicit client/harness assertion that this exact delivered callback finished. */
  acknowledge(id: string, deliveryId: string, token: string): string | object {
    this.prune()
    const control = this.controls.get(id)
    if (!control) return 'UNKNOWN_SCOPE'
    const delivery = control.events_captured
      .flatMap((event) => event.delivery_records)
      .find((entry) => entry.id === deliveryId)
    if (delivery?.ack_token !== token) return 'UNKNOWN_DELIVERY'
    if (delivery.transport !== 'sent') return 'INVALID_STATE'
    delivery.application = 'acknowledged'
    return this.inspect(id) ?? 'UNKNOWN_SCOPE'
  }

  /** Disconnects one owner deterministically while preserving only this control. */
  disconnect(id: string, pauseResume = false): string | object {
    this.prune()
    const control = this.controls.get(id)
    if (!control) return 'UNKNOWN_SCOPE'
    if (control.awaiting_resume || control.socket.readyState !== WebSocket.OPEN)
      return 'INVALID_STATE'
    if (control.operations >= 100) return 'LIMIT'
    control.operations += 1
    control.awaiting_resume = true
    control.pause_resume = pauseResume
    const sequence = control.session.seq
    sendReconnect(control.session)
    return {
      session_id: control.session_id,
      sequence,
      awaiting_resume: true,
      pause_resume: control.pause_resume,
    }
  }

  /** Opens the gate and retries one waiting authenticated protocol RESUME. */
  resume(id: string): string | object {
    this.prune()
    const control = this.controls.get(id)
    if (!control) return 'UNKNOWN_SCOPE'
    if (!control.awaiting_resume || !control.pause_resume)
      return 'INVALID_STATE'
    control.pause_resume = false
    const pending = control.pending_resume
    control.pending_resume = undefined
    if (pending) {
      pending.socket.off('close', pending.onClose)
      if (
        pending.socket.readyState === WebSocket.OPEN &&
        this.manager.connectionGeneration(pending.socket) === pending.generation
      )
        pending.retry()
    }
    return this.inspect(id) ?? 'UNKNOWN_SCOPE'
  }

  /** Installs one bounded listener per controlled socket. */
  private attachListener(socket: WebSocket): void {
    if (this.closeListeners.has(socket)) return
    /** Ordinary disconnect cancels; an explicitly requested resume retains scope. */
    const onClose = (): void => {
      for (const control of this.controls.values()) {
        if (control.socket === socket && !control.awaiting_resume)
          this.delete(control.id)
      }
    }
    this.closeListeners.set(socket, onClose)
    socket.once('close', onClose)
  }

  /** Removes connection listeners as soon as their last control is gone. */
  private detachUnusedListener(socket: WebSocket): void {
    if (this.controls.values().some((control) => control.socket === socket))
      return
    const listener = this.closeListeners.get(socket)
    if (listener) socket.off('close', listener)
    this.closeListeners.delete(socket)
  }

  /** Cancels a control and drops its held events and observation history. */
  delete(id: string): boolean {
    const control = this.controls.get(id)
    if (!control) return false
    clearTimeout(control.timer)
    this.controls.delete(id)
    if (control.ownership_key !== undefined) {
      const owner = this.owners.get(control.ownership_key)
      if (owner) owner.id = null
    }
    if (control.pending_resume) {
      const pending = control.pending_resume
      pending.socket.off('close', pending.onClose)
      if (
        this.manager.connectionGeneration(pending.socket) === pending.generation
      )
        pending.socket.close(1000, 'Gateway control canceled')
      control.pending_resume = undefined
    }
    this.detachUnusedListener(control.socket)
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

  /** Invalidates captures immediately before a deleted guild can be recreated. */
  deleteGuild(guildId: string): void {
    for (const control of this.controls.values()) {
      if (control.guild_id === guildId) this.delete(control.id)
    }
  }
}
