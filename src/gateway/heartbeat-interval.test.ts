import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { createTestGatewayServer, seedBot, seedGuild } from '../test-helpers'
import type { GatewayPayload } from './protocol'
import { broadcastToBot } from './dispatch'

/** Short interval so heartbeat timing is exercised in real time. */
const INTERVAL_MS = 200
const TOKEN = 'Bot heartbeat'
const BOT_ID = '111111111111111111'
const GUILD = '222222222222222222'

/** Real Gateway connection with every frame it received. */
interface Client {
  ws: WebSocket
  frames: GatewayPayload<Record<string, unknown> | null>[]
  closed: Promise<number>
}

describe('Configurable Gateway heartbeat interval', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  const clients: Client[] = []

  /**
   * Opens a socket and waits for HELLO.
   * @returns The connected client
   */
  async function open(): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => {
        resolve(code)
      })
    })
    const hello = once(ws, 'message')
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await hello
    const client = { ws, frames, closed }
    clients.push(client)
    return client
  }

  /**
   * Resolves once a matching frame has arrived.
   * @param client - Connection to watch
   * @param predicate - Frame matcher
   * @returns The first matching frame
   */
  async function frame(
    client: Client,
    predicate: (payload: Client['frames'][number]) => boolean
  ): Promise<Client['frames'][number]> {
    const existing = client.frames.find((entry) => predicate(entry))
    return (
      existing ??
      new Promise((resolve) => {
        /** Resolves on the first matching frame and detaches itself. */
        const listener = (raw: Buffer): void => {
          const payload = JSON.parse(raw.toString()) as Client['frames'][number]
          if (!predicate(payload)) return
          client.ws.off('message', listener)
          resolve(payload)
        }
        client.ws.on('message', listener)
      })
    )
  }

  /**
   * IDENTIFYs on a new socket and waits for READY.
   * @returns The client, its session ID and when IDENTIFY was sent (a lower
   * bound for when the server armed its heartbeat timeout)
   */
  async function identify(): Promise<{
    client: Client
    sessionId: string
    sentAt: number
  }> {
    const client = await open()
    const sentAt = Date.now()
    client.ws.send(
      JSON.stringify({
        op: 2,
        d: { token: TOKEN, intents: GatewayIntentBits.GuildVoiceStates },
      })
    )
    const ready = await frame(client, (entry) => entry.t === 'READY')
    return { client, sessionId: String(ready.d?.session_id), sentAt }
  }

  /**
   * Heartbeats like DiscordGo: every interval, unless the previous heartbeat
   * was never acknowledged, in which case it closes with 1012 (zombie).
   * @param client - Connection to drive
   * @returns Function stopping the heartbeat loop
   */
  function discordGoHeartbeat(client: Client): () => void {
    let acknowledged = true
    client.ws.on('message', (raw: Buffer) => {
      if ((JSON.parse(raw.toString()) as { op: number }).op === 11)
        acknowledged = true
    })
    const timer = setInterval(() => {
      if (client.ws.readyState !== WebSocket.OPEN) return
      if (!acknowledged) {
        client.ws.close(1012)
        return
      }
      acknowledged = false
      client.ws.send(JSON.stringify({ op: 1, d: null }))
    }, INTERVAL_MS)
    return () => {
      clearInterval(timer)
    }
  }

  beforeEach(async () => {
    server = await createTestGatewayServer({ heartbeatIntervalMs: INTERVAL_MS })
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT_ID)
    seedGuild(server.db, TOKEN, GUILD)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('announces the configured interval in HELLO', async () => {
    const client = await open()
    expect(client.frames[0]).toMatchObject({
      op: 10,
      d: { heartbeat_interval: INTERVAL_MS },
    })
  })

  it('closes with 4009 and removes the session after two intervals without a heartbeat', async () => {
    const { client, sessionId, sentAt } = await identify()
    expect(await client.closed).toBe(4009)
    // The timeout is armed after IDENTIFY was sent, so this never undercounts.
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(2 * INTERVAL_MS - 5)
    expect(server.sessionManager.get(sessionId)).toBeUndefined()
  })

  it('lets a DiscordGo-style client detect a zombie on its own and RESUME the withheld events', async () => {
    const { client, sessionId } = await identify()
    const stop = discordGoHeartbeat(client)
    await frame(client, (entry) => entry.op === 11)
    const response = await fetch(`${base}/_test/gateway-zombie-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: BOT_ID,
        guild_id: GUILD,
        session_id: sessionId,
      }),
    })
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }
    const received = Math.max(...client.frames.map((entry) => entry.s ?? 0))
    broadcastToBot(server.sessionManager, BOT_ID, 'TEST_EVENT', { gap: 1 })

    // No server action ends the zombie: the client's missed ACK does.
    expect(await client.closed).toBe(1012)
    stop()
    // RESUME at once: the session stays resumable for only about one more
    // interval after detection.
    const resumed = await open()
    resumed.ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: sessionId, seq: received },
      })
    )
    await frame(resumed, (entry) => entry.t === 'RESUMED')
    expect(
      resumed.frames.find((entry) => entry.t === 'TEST_EVENT')
    ).toMatchObject({ s: received + 1, d: { gap: 1 } })
    const inspected = await fetch(
      `${base}/_test/gateway-zombie-connections/${id}`
    )
    const evidence = (await inspected.json()) as {
      started_at: number
      heartbeats_unacknowledged: number
      close: { at: number; code: number; initiated_by: string }
    }
    expect(evidence).toMatchObject({
      heartbeats_unacknowledged: 1,
      close: { code: 1012, initiated_by: 'client' },
    })
    // Detection takes one to two intervals after the zombie started.
    expect(evidence.close.at - evidence.started_at).toBeGreaterThanOrEqual(
      INTERVAL_MS - 20
    )
  })

  it('never reaps a zombie whose client keeps heartbeating, however long it lasts', async () => {
    const { client, sessionId } = await identify()
    const timer = setInterval(() => {
      client.ws.send(JSON.stringify({ op: 1, d: null }))
    }, INTERVAL_MS / 2)
    try {
      const response = await fetch(`${base}/_test/gateway-zombie-connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_id: BOT_ID,
          guild_id: GUILD,
          session_id: sessionId,
        }),
      })
      expect(response.status).toBe(201)
      // Several heartbeat timeouts pass without any ACK.
      await new Promise((resolve) => setTimeout(resolve, 6 * INTERVAL_MS))
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
      expect(server.sessionManager.get(sessionId)).toBeDefined()
    } finally {
      clearInterval(timer)
    }
  })
})
