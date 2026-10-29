import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createTestGatewayServer, seedBot, seedGuild } from '../test-helpers'
import type { GatewayPayload } from './protocol'

/** One wire connection and every frame received on it. */
interface Client {
  ws: WebSocket
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Public heartbeat observations for only the current gated RESUME. */
interface Observation {
  id: string
  ttl_ms: number
  expires_at: number
  awaiting_resume: boolean
  pause_resume: boolean
  pending_resume: boolean
  pending_resume_heartbeats: number
  pending_resume_last_heartbeat_at: number | null
}

const ROOT = '/_test/gateway-event-controls'
const TOKEN = 'Bot pending-heartbeats'
const BOT = '111111111111111111'

describe('heartbeats on a gated RESUME', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let guild: string
  let sessionId: string
  let client: Client
  const clients: Client[] = []

  /** Calls the real HTTP control API. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<Response> {
    return fetch(server.url.replace('ws://', 'http://') + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Opens a fresh unbound connection and waits for HELLO. */
  async function open(): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    const target = { ws, frames }
    clients.push(target)
    await once(ws, 'message')
    return target
  }

  /** Sends a heartbeat and waits for its ACK as an ordered frame fence. */
  async function heartbeat(target: Client): Promise<void> {
    const ack = once(target.ws, 'message', {
      signal: AbortSignal.timeout(2000),
    })
    target.ws.send(JSON.stringify({ op: 1, d: null }))
    const [raw] = (await ack) as [Buffer]
    expect(JSON.parse(raw.toString())).toMatchObject({ op: 11, d: null })
  }

  /** Reads the public snapshot. */
  async function inspect(id: string): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }

  /** Creates a control for the identified session. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      session_id: sessionId,
      events: ['GUILD_MEMBER_UPDATE'],
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  /** Disconnects the owner and closes its resume gate. */
  async function pause(id: string, target = client): Promise<number> {
    const closed = once(target.ws, 'close')
    const response = await request(`${ROOT}/${id}/disconnect`, 'POST', {
      pause_resume: true,
    })
    expect(response.status).toBe(200)
    const checkpoint = (await response.json()) as { sequence: number }
    await closed
    return checkpoint.sequence
  }

  /** Sends RESUME without sending a heartbeat or waiting for RESUMED. */
  function resume(target: Client, sequence: number, token = TOKEN): void {
    target.ws.send(
      JSON.stringify({
        op: 6,
        d: { token, session_id: sessionId, seq: sequence },
      })
    )
  }

  beforeEach(async () => {
    server = await createTestGatewayServer({ heartbeatIntervalMs: 500 })
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    client = await open()
    const ready = once(client.ws, 'message')
    client.ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: 0 } }))
    await ready
    sessionId = String(client.frames.at(-1)?.d?.session_id)
  })

  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('keeps the gated session alive beyond two intervals, then reaps it when heartbeats stop', async () => {
    // A short interval exercises the production timeout without a minute-long test.
    await heartbeat(client)
    const session = server.sessionManager.get(sessionId)
    assert.ok(session)
    const originalSocket = session.ws
    const id = await arm()
    const sequence = await pause(id)
    const pending = await open()
    resume(pending, sequence)
    const started = Date.now()
    let count = 0
    while (
      Date.now() - started <=
      server.sessionManager.heartbeatTimeoutMs + 250
    ) {
      await heartbeat(pending)
      count += 1
      await delay(100)
    }
    const observed = await inspect(id)
    expect(observed).toMatchObject({
      awaiting_resume: true,
      pause_resume: true,
      pending_resume: true,
      pending_resume_heartbeats: count,
      pending_resume_last_heartbeat_at: session.lastHeartbeatAt,
    })
    expect(session.lastHeartbeatAckAt).toBe(session.lastHeartbeatAt)
    expect(session.ws).toBe(originalSocket)
    expect(pending.frames.some((frame) => frame.t === 'RESUMED')).toBe(false)
    const closed = once(pending.ws, 'close')
    const [code, reason] = (await closed) as [number, Buffer]
    expect(code).toBe(1000)
    expect(reason.toString()).toBe('Gateway control canceled')
    expect(server.sessionManager.get(sessionId)).toBeUndefined()
    const missing = await request(`${ROOT}/${id}`)
    expect(missing.status).toBe(404)
  }, 10_000)

  it.each(['IDENTIFY', 'RESUME'] as const)(
    'does not close a pending socket repurposed by %s when the old session times out',
    async (operation) => {
      const id = await arm()
      const sequence = await pause(id)
      const pending = await open()
      resume(pending, sequence)
      await heartbeat(pending)
      let replacementId: string
      if (operation === 'RESUME') {
        const other = await open()
        const ready = once(other.ws, 'message')
        other.ws.send(
          JSON.stringify({ op: 2, d: { token: TOKEN, intents: 0 } })
        )
        await ready
        replacementId = String(other.frames.at(-1)?.d?.session_id)
        const resumed = once(pending.ws, 'message')
        pending.ws.send(
          JSON.stringify({
            op: 6,
            d: {
              token: TOKEN,
              session_id: replacementId,
              seq: other.frames.at(-1)?.s,
            },
          })
        )
        await resumed
        expect(pending.frames.at(-1)?.t).toBe('RESUMED')
      } else {
        const ready = once(pending.ws, 'message')
        pending.ws.send(
          JSON.stringify({ op: 2, d: { token: TOKEN, intents: 0 } })
        )
        await ready
        expect(pending.frames.at(-1)?.t).toBe('READY')
        replacementId = String(pending.frames.at(-1)?.d?.session_id)
      }
      expect(await inspect(id)).toMatchObject({
        pending_resume: false,
        pending_resume_heartbeats: 0,
        pending_resume_last_heartbeat_at: null,
      })
      const started = Date.now()
      while (
        Date.now() - started <=
        server.sessionManager.heartbeatTimeoutMs + 250
      ) {
        await heartbeat(pending)
        await delay(100)
      }
      expect(server.sessionManager.get(sessionId)).toBeUndefined()
      expect(server.sessionManager.get(replacementId)).toBeDefined()
      expect(pending.ws.readyState).toBe(WebSocket.OPEN)
      const missing = await request(`${ROOT}/${id}`)
      expect(missing.status).toBe(404)
    },
    10_000
  )

  it('resets observations for each pending socket and clears them when the gate opens', async () => {
    const id = await arm()
    expect(await inspect(id)).toMatchObject({
      pending_resume_heartbeats: 0,
      pending_resume_last_heartbeat_at: null,
    })
    const sequence = await pause(id)
    const first = await open()
    resume(first, sequence)
    const before = Date.now()
    await heartbeat(first)
    await heartbeat(first)
    const observed = await inspect(id)
    expect(observed.pending_resume_heartbeats).toBe(2)
    expect(observed.pending_resume_last_heartbeat_at).toBeGreaterThanOrEqual(
      before
    )
    expect(observed.pending_resume_last_heartbeat_at).toBeLessThanOrEqual(
      Date.now()
    )
    const closed = once(first.ws, 'close')
    first.ws.close()
    await closed
    const second = await open()
    resume(second, sequence)
    await expect
      .poll(async () => {
        const observation = await inspect(id)
        return observation.pending_resume
      })
      .toBe(true)
    expect(await inspect(id)).toMatchObject({
      pending_resume_heartbeats: 0,
      pending_resume_last_heartbeat_at: null,
    })
    await heartbeat(second)
    const secondObservation = await inspect(id)
    expect(secondObservation.pending_resume_heartbeats).toBe(1)
    const resumed = once(second.ws, 'message')
    const response = await request(`${ROOT}/${id}/resume`, 'POST', {})
    expect(response.status).toBe(200)
    await resumed
    await heartbeat(second)
    expect(second.frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
    expect(await inspect(id)).toMatchObject({
      awaiting_resume: false,
      pause_resume: false,
      pending_resume: false,
      pending_resume_heartbeats: 0,
      pending_resume_last_heartbeat_at: null,
    })
    // A second controlled reconnect on the same control starts fresh too.
    const nextSequence = await pause(id, second)
    const third = await open()
    resume(third, nextSequence)
    await heartbeat(third)
    const thirdObservation = await inspect(id)
    expect(thirdObservation.pending_resume_heartbeats).toBe(1)
  })

  it('ACKs unbound and rejected RESUME heartbeats without refreshing the session', async () => {
    const id = await arm()
    const sequence = await pause(id)
    const session = server.sessionManager.get(sessionId)
    assert.ok(session)
    const lastHeartbeatAt = session.lastHeartbeatAt
    const unbound = await open()
    await heartbeat(unbound)
    const invalid = once(unbound.ws, 'message')
    resume(unbound, sequence, 'Bot wrong-token')
    await invalid
    await heartbeat(unbound)
    expect(session.lastHeartbeatAt).toBe(lastHeartbeatAt)
    expect(await inspect(id)).toMatchObject({
      pending_resume: false,
      pending_resume_heartbeats: 0,
      pending_resume_last_heartbeat_at: null,
    })
  })

  it('preserves silenced bound heartbeat observations without ACKs', async () => {
    const id = await arm()
    const session = server.sessionManager.get(sessionId)
    assert.ok(session)
    await heartbeat(client)
    server.sessionManager.silence(session.ws)
    const lastAckAt = session.lastHeartbeatAckAt
    assert.ok(lastAckAt)
    const ackCount = client.frames.filter((frame) => frame.op === 11).length
    await delay(5)
    client.ws.send(JSON.stringify({ op: 1, d: 0 }))
    await expect.poll(() => session.lastHeartbeatAt).toBeGreaterThan(lastAckAt)
    expect(session.lastHeartbeatAckAt).toBe(lastAckAt)
    expect(client.frames.filter((frame) => frame.op === 11)).toHaveLength(
      ackCount
    )
    const observation = await inspect(id)
    expect(observation.pending_resume_heartbeats).toBe(0)
  })

  it('accepts a 180000 ms TTL, retains the default, and rejects larger values', async () => {
    const defaultId = await arm()
    const defaultObservation = await inspect(defaultId)
    expect(defaultObservation.ttl_ms).toBe(30_000)
    await request(`${ROOT}/${defaultId}`, 'DELETE')
    const before = Date.now()
    const id = await arm({ ttl_ms: 180_000 })
    const observed = await inspect(id)
    expect(observed.ttl_ms).toBe(180_000)
    expect(observed.expires_at).toBeGreaterThanOrEqual(before + 180_000)
    await request(`${ROOT}/${id}`, 'DELETE')
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT,
      events: ['GUILD_MEMBER_UPDATE'],
      ttl_ms: 180_001,
    })
    expect(response.status).toBe(400)
  })
})
