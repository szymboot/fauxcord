import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createRealServer,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'
import { createTestUser } from '../services/test-control'
import type { MessageObject } from '../services/messages'
import { GatewayOp } from './opcodes'

/** Buffers Gateway frames and bounds reads, including negative checks via ACK. */
function frameReader(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  return () => {
    const frame = queue.shift()
    if (frame) return Promise.resolve(frame)
    const { promise, resolve, reject } =
      Promise.withResolvers<Record<string, unknown>>()
    const timer = setTimeout(() => {
      reject(new Error('Gateway frame timed out'))
    }, 2000)
    waiters.push((next) => {
      clearTimeout(timer)
      resolve(next)
    })
    return promise
  }
}

describe('complete attachment Gateway delivery', () => {
  let close: (() => Promise<void>) | undefined
  let ws: WebSocket | undefined
  afterEach(async () => {
    ws?.terminate()
    await close?.()
  })

  it('delivers complete human snapshots, retains deleted downloads, and allows bot multipart reposts', async () => {
    const server = await createRealServer()
    close = server.close
    const token = seedBot(server.db, 'Bot image-log')
    const guildId = seedGuild(server.db, token)
    const channelId = seedChannel(server.db, guildId)
    const humanId = createTestUser(server.db, {
      username: 'Human',
      global_name: 'Real Human',
    }).id
    ws = new WebSocket(server.baseUrl.replace('http://', 'ws://'))
    const next = frameReader(ws)
    expect(await next()).toMatchObject({ op: GatewayOp.Hello })
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: {
          token,
          intents:
            GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
        },
      })
    )
    expect(await next()).toMatchObject({ t: 'READY' })
    const binary = Buffer.from([0, 255, 13, 10, 128])
    let sequence = 0
    for (const content of ['text with files', '']) {
      const response = await fetch(
        `${server.baseUrl}/_test/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            author: { id: humanId },
            content,
            remove_after_create: true,
            attachments: [
              {
                filename: 'proof #?.png',
                content_type: 'image/png',
                data: binary.toString('base64'),
              },
              {
                filename: 'proof #?.png',
                content_type: 'application/octet-stream',
                data: 'YWJj',
              },
            ],
          }),
          signal: AbortSignal.timeout(2000),
        }
      )
      expect(response.status).toBe(201)
      const human = (await response.json()) as MessageObject
      const created = await next()
      expect(created).toMatchObject({
        op: GatewayOp.Dispatch,
        t: 'MESSAGE_CREATE',
        d: {
          ...human,
          guild_id: guildId,
          author: { id: humanId, bot: false, global_name: 'Real Human' },
          member: { user: human.author },
        },
      })
      const deleted = await next()
      sequence = Number(created.s)
      expect(deleted).toEqual({
        op: GatewayOp.Dispatch,
        t: 'MESSAGE_DELETE',
        s: ++sequence,
        d: { id: human.id, channel_id: channelId, guild_id: guildId },
      })
      const form = new FormData()
      form.set('payload_json', JSON.stringify({ content: 'Deletion log' }))
      for (const [index, attachment] of human.attachments.entries()) {
        const download = await fetch(attachment.url, {
          signal: AbortSignal.timeout(2000),
        })
        expect(download.status).toBe(200)
        expect(download.headers.get('content-type')).toBe(
          attachment.content_type
        )
        const data = await download.arrayBuffer()
        expect(Buffer.from(data)).toEqual(
          index === 0 ? binary : Buffer.from('abc')
        )
        form.set(
          `files[${index}]`,
          new File([data], attachment.filename, {
            type: attachment.content_type,
          })
        )
      }
      const repost = await fetch(
        `${server.baseUrl}/api/v10/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers: { Authorization: token },
          body: form,
          signal: AbortSignal.timeout(2000),
        }
      )
      expect(repost.status).toBe(200)
      const bot = (await repost.json()) as MessageObject
      expect(bot.attachments).toHaveLength(2)
      const botEvent = await next()
      expect(botEvent).toMatchObject({
        t: 'MESSAGE_CREATE',
        s: ++sequence,
        d: { ...bot, author: { bot: true }, guild_id: guildId },
      })
      for (const [index, attachment] of bot.attachments.entries()) {
        const download = await fetch(attachment.url, {
          signal: AbortSignal.timeout(2000),
        })
        expect(Buffer.from(await download.arrayBuffer())).toEqual(
          index === 0 ? binary : Buffer.from('abc')
        )
      }
    }
    // A heartbeat ACK proves there are no stray or duplicate create dispatches.
    ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: sequence }))
    expect(await next()).toMatchObject({ op: GatewayOp.HeartbeatAck })
  })
})
