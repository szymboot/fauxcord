import type { GatewayPayload } from './protocol'
import { GatewayOp } from './opcodes'
import { encodePayload } from './protocol'
import { hasIntent } from './intents'
import type { DispatchTransport, Session, SessionManager } from './session'

/** Combines optional transport observers into one callback. */
function combineObservers(
  first: ((status: DispatchTransport) => void) | undefined,
  second: ((status: DispatchTransport) => void) | undefined
): ((status: DispatchTransport) => void) | undefined {
  return !first || !second
    ? (first ?? second)
    : (status) => {
        first(status)
        second(status)
      }
}

/** Writes an envelope and observes socket progress, never application completion. */
export function writeDispatch(
  manager: SessionManager,
  session: Session,
  payload: GatewayPayload<unknown>,
  source: 'native' | 'release' | 'replay' | 'resume' = 'native',
  onStatus?: (status: DispatchTransport) => void
): void {
  const observe = combineObservers(
    manager.observeDispatch?.(session, payload, source),
    onStatus
  )
  if (session.ws.readyState !== 1) {
    observe?.('buffered')
    return
  }
  observe?.('queued')
  try {
    if (observe) {
      session.ws.send(encodePayload(payload), (error) => {
        observe(error ? 'failed' : 'sent')
      })
    } else {
      session.ws.send(encodePayload(payload))
    }
  } catch {
    observe?.('failed')
  }
}

/** Delivers a sequenced envelope without invoking test capture again. */
export function deliverDispatch(
  manager: SessionManager,
  session: Session,
  payload: GatewayPayload<unknown>,
  source: 'native' | 'release' | 'replay' = 'native',
  onStatus?: (status: DispatchTransport) => void
): void {
  manager.pushToReplayBuffer(session, payload)
  writeDispatch(manager, session, payload, source, onStatus)
}

/**
 * Sends a Dispatch (op0) event to a single session, updating its seq and
 * replay buffer.
 * @param manager - Session manager
 * @param session - Destination session
 * @param eventName - Dispatch event name (e.g. "MESSAGE_CREATE")
 * @param data - Event data
 * @param observe - Optional observer of this uncaptured envelope's transport
 */
export function sendDispatch(
  manager: SessionManager,
  session: Session,
  eventName: string,
  data: unknown,
  observe?: (
    payload: GatewayPayload<unknown>
  ) => ((status: DispatchTransport) => void) | undefined
): void {
  const seq = manager.nextSeq(session)
  const payload = {
    op: GatewayOp.Dispatch as number,
    t: eventName,
    s: seq,
    d: data,
  }
  if (manager.captureDispatch?.(session, payload)) return
  deliverDispatch(manager, session, payload, 'native', observe?.(payload))
}

/**
 * Broadcasts a Dispatch event to all sessions belonging to the given Bot.
 * If requiredIntent is given, only sessions holding that Intent receive it.
 * @param manager - Session manager
 * @param botId - ID of the destination Bot
 * @param eventName - Dispatch event name
 * @param data - Event data
 * @param requiredIntent - Intent bit required to receive the event (sent
 * unconditionally if omitted)
 * @param token - Optional normalized ("Bot "-prefixed) setup token to isolate
 * sessions sharing a Bot ID
 */
export function broadcastToBot(
  manager: SessionManager,
  botId: string,
  eventName: string,
  data: unknown,
  requiredIntent?: number,
  token?: string
): void {
  for (const session of manager.getByBotId(botId)) {
    if (token !== undefined) {
      const sessionToken = session.token.startsWith('Bot ')
        ? session.token
        : `Bot ${session.token}`
      if (sessionToken !== token) continue
    }
    if (
      requiredIntent !== undefined &&
      !hasIntent(session.intents, requiredIntent)
    ) {
      continue
    }
    sendDispatch(manager, session, eventName, data)
  }
}

/**
 * Broadcasts a Dispatch event to all connected sessions. If requiredIntent
 * is given, only sessions holding that Intent receive it.
 * @param manager - Session manager
 * @param eventName - Dispatch event name
 * @param data - Event data
 * @param requiredIntent - Intent bit required to receive the event (sent
 * unconditionally if omitted)
 */
export function broadcastToAll(
  manager: SessionManager,
  eventName: string,
  data: unknown,
  requiredIntent?: number
): void {
  for (const session of manager.getAll()) {
    if (
      requiredIntent !== undefined &&
      !hasIntent(session.intents, requiredIntent)
    ) {
      continue
    }
    sendDispatch(manager, session, eventName, data)
  }
}
