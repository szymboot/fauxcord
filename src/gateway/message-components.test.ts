import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
} from '../test-helpers'
import { GatewayOp } from './opcodes'

/** Buffers frames, including events arriving before their HTTP response. */
function createReader(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  return () =>
    new Promise((resolve, reject) => {
      const frame = queue.shift()
      if (frame) {
        resolve(frame)
        return
      }
      const timer = setTimeout(() => {
        reject(new Error('Gateway frame timed out'))
      }, 2000)
      waiters.push((next) => {
        clearTimeout(timer)
        resolve(next)
      })
    })
}

describe('persisted message components over HTTP and Gateway', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>> | undefined
  let ws: WebSocket | undefined
  afterEach(async () => {
    ws?.terminate()
    await server?.close()
  })

  it('dispatches create, replacement, omission and clear snapshots; rejects invalid edits without dispatch', async () => {
    server = await createTestGatewayServer()
    const token = seedBot(server.db)
    const channel = seedChannel(server.db, seedGuild(server.db, token))
    const http = server.url.replace('ws://', 'http://')
    const path = `/api/v10/channels/${channel}/messages`
    /** Sends an authenticated message request through the live server. */
    const request = (route: string, method: string, body: unknown) =>
      fetch(http + route, {
        method,
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      })
    ws = new WebSocket(server.url)
    const next = createReader(ws)
    expect(await next().then((frame) => frame.op)).toBe(GatewayOp.Hello)
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token, intents: GatewayIntentBits.GuildMessages },
      })
    )
    expect(await next().then((frame) => frame.t)).toBe('READY')
    const buy = {
      type: 2,
      style: 1,
      label: 'Buy',
      custom_id: 'shop_item_buy_42',
    }
    const returnButton = {
      type: 2,
      style: 4,
      label: 'Return',
      custom_id: 'shop_item_return_42',
    }
    const components = [{ type: 1, components: [buy, returnButton] }]
    const created = await request(path, 'POST', { components })
    expect(created.status).toBe(200)
    const message = (await created.json()) as {
      id: string
      components: unknown[]
    }
    expect(await next()).toMatchObject({
      t: 'MESSAGE_CREATE',
      d: { id: message.id, components: message.components },
    })
    for (const payload of [
      { components: [{ type: 1, components: [buy] }] },
      { content: 'buttons retained' },
      { components: [] },
    ]) {
      const edited = await request(path + '/' + message.id, 'PATCH', payload)
      expect(edited.status).toBe(200)
      const result = (await edited.json()) as { components: unknown[] }
      const expected = payload.components ?? [{ type: 1, components: [buy] }]
      expect(result.components).toMatchObject(expected)
      expect(result.components).toHaveLength(expected.length)
      expect(await next()).toMatchObject({
        t: 'MESSAGE_UPDATE',
        d: { id: message.id, components: result.components },
      })
    }
    for (const [route, method] of [
      [path, 'POST'],
      [path + '/' + message.id, 'PATCH'],
    ]) {
      const rejected = await request(route, method, {
        content: 'rejected',
        components: [{ type: 1, components: [buy, buy] }],
      })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ code: 50_035 })
    }
    // A heartbeat orders the stream and proves no rejected-write dispatch escaped.
    ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
    expect(await next().then((frame) => frame.op)).toBe(GatewayOp.HeartbeatAck)
  })
})
