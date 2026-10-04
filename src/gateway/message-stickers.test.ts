import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
} from '../test-helpers'
import { createGuildSticker } from '../services/guild-advanced'
import { createTestUser } from '../services/test-control'
import type { MessageObject } from '../services/messages'
import { GatewayOp } from './opcodes'

/**
 * Buffers frames arriving in bursts and bounds every wait to two seconds.
 * @param ws - Client WebSocket
 * @returns Reader for the next Gateway frame
 */
function createMessageReader(
  ws: WebSocket
): () => Promise<Record<string, unknown>> {
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
      const queued = queue.shift()
      if (queued) {
        resolve(queued)
        return
      }
      const timer = setTimeout(() => {
        reject(new Error('Gateway frame timed out'))
      }, 2000)
      waiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
}

describe('message sticker Gateway delivery', () => {
  let close: (() => Promise<void>) | undefined
  const sockets: WebSocket[] = []
  afterEach(async () => {
    for (const ws of sockets) ws.terminate()
    sockets.length = 0
    await close?.()
    close = undefined
  })

  it.each([true, false])(
    'delivers native sticker create, update and delete events (fixture=%s)',
    async (fixture) => {
      const server = await createTestGatewayServer()
      close = server.close
      const token = seedBot(server.db, 'Bot stickers')
      const guild = seedGuild(server.db, token)
      const channel = seedChannel(server.db, guild)
      const human = createTestUser(server.db, { username: 'Human' }).id
      const stickers = [1, 2, 3].map(
        (i) =>
          createGuildSticker(server.db, guild, human, { name: `Sticker ${i}` })
            .id
      )
      const ws = new WebSocket(server.url)
      sockets.push(ws)
      const next = createMessageReader(ws)
      const hello = await next()
      expect(hello.op).toBe(GatewayOp.Hello)
      ws.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: { token, intents: GatewayIntentBits.GuildMessages },
        })
      )
      const ready = await next()
      expect(ready.t).toBe('READY')
      const http = server.url.replace('ws://', 'http://')
      const path = fixture
        ? `/_test/channels/${channel}/messages`
        : `/api/v10/channels/${channel}/messages`
      const headers = {
        Authorization: token,
        'Content-Type': 'application/json',
      }
      const response = await fetch(`${http}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sticker_ids: stickers,
          ...(fixture && { author: { id: human } }),
        }),
        signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(fixture ? 201 : 200)
      const message = (await response.json()) as MessageObject
      expect(message.content).toBe('')
      expect(message.sticker_items).toEqual(
        stickers.map((id, i) => ({
          id,
          name: `Sticker ${i + 1}`,
          format_type: 1,
        }))
      )
      const created = await next()
      expect(created).toMatchObject({
        op: GatewayOp.Dispatch,
        t: 'MESSAGE_CREATE',
        d: { ...message, guild_id: guild },
      })
      const edited = await fetch(`${http}${path}/${message.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ content: 'edited' }),
        signal: AbortSignal.timeout(2000),
      })
      expect(edited.status).toBe(200)
      const updated = (await edited.json()) as MessageObject
      expect(updated.sticker_items).toEqual(message.sticker_items)
      expect(await next()).toMatchObject({
        t: 'MESSAGE_UPDATE',
        s: Number(created.s) + 1,
        d: { ...updated, guild_id: guild },
      })
      const response1 = await fetch(
        `${http}/api/v10/channels/${channel}/messages/${message.id}`,
        { method: 'DELETE', headers, signal: AbortSignal.timeout(2000) }
      )
      expect(response1.status).toBe(204)
      expect(await next()).toMatchObject({
        t: 'MESSAGE_DELETE',
        s: Number(created.s) + 2,
        d: { id: message.id, channel_id: channel, guild_id: guild },
      })
      if (fixture) {
        const removed = await fetch(`${http}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            author: { id: human },
            sticker_ids: stickers,
            remove_after_create: true,
          }),
          signal: AbortSignal.timeout(2000),
        })
        expect(removed.status).toBe(201)
        const snapshot = (await removed.json()) as MessageObject
        expect(await next()).toMatchObject({
          t: 'MESSAGE_CREATE',
          d: { ...snapshot, sticker_items: message.sticker_items },
        })
        expect(await next()).toMatchObject({
          t: 'MESSAGE_DELETE',
          d: { id: snapshot.id },
        })
        const response2 = await fetch(
          `${http}/api/v10/channels/${channel}/messages/${snapshot.id}`,
          { headers, signal: AbortSignal.timeout(2000) }
        )
        expect(response2.status).toBe(404)
      }
      // Bound the sequence and catch any duplicate native message dispatches.
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      const response3 = await next()
      expect(response3.op).toBe(GatewayOp.HeartbeatAck)
      expect(
        server.db.prepare('SELECT COUNT(*) FROM message_stickers').pluck().get()
      ).toBe(0)
    }
  )
})
