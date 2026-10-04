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
import { createGuildSticker } from '../services/guild-advanced'
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
  it.each([true, false])(
    'delivers combined snapshots and retains downloads after native single/bulk deletion (human=%s)',
    async (human) => {
      const server = await createRealServer()
      close = server.close
      const botId = '111111111111111111'
      const token = seedBot(server.db, 'Bot combined-gateway', botId)
      const guildId = seedGuild(server.db, token)
      server.db
        .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
        .run(guildId, botId)
      const channelId = seedChannel(server.db, guildId)
      const humanId = createTestUser(server.db, { username: 'Human' }).id
      const sticker = createGuildSticker(server.db, guildId, humanId, {
        name: 'Evidence sticker',
        tags: 'wave',
      })
      const stickerItems = [
        { id: sticker.id, name: 'Evidence sticker', format_type: 1 },
      ]
      const binary = Buffer.from([0, 255, 13, 10, 128])
      ws = new WebSocket(server.baseUrl.replace('http://', 'ws://'))
      const next = frameReader(ws)
      expect(await next()).toMatchObject({ op: GatewayOp.Hello })
      ws.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: {
            token,
            intents:
              GatewayIntentBits.GuildMessages |
              GatewayIntentBits.MessageContent,
          },
        })
      )
      expect(await next()).toMatchObject({ t: 'READY' })
      let sequence = 0
      const rest = `${server.baseUrl}/api/v10/channels/${channelId}/messages`

      /** Sends a combined message and verifies the first native create frame. */
      async function sendCombined(content?: string): Promise<MessageObject> {
        const payload = { content, sticker_ids: [sticker.id] }
        const form = new FormData()
        form.set('payload_json', JSON.stringify(payload))
        form.set(
          'files[0]',
          new File([binary], 'proof #?.bin', { type: 'image/png' })
        )
        const response = await fetch(
          human
            ? `${server.baseUrl}/_test/channels/${channelId}/messages`
            : rest,
          {
            method: 'POST',
            headers: human
              ? { 'Content-Type': 'application/json' }
              : { Authorization: token },
            body: human
              ? JSON.stringify({
                  ...payload,
                  author: { id: humanId },
                  attachments: [
                    {
                      filename: 'proof #?.bin',
                      content_type: 'image/png',
                      data: binary.toString('base64'),
                    },
                  ],
                })
              : form,
            signal: AbortSignal.timeout(2000),
          }
        )
        expect(response.status).toBe(human ? 201 : 200)
        const message = (await response.json()) as MessageObject
        expect(message.sticker_items).toEqual(stickerItems)
        expect(message.attachments).toHaveLength(1)
        expect(message.author.bot).toBe(!human)
        const created = await next()
        if (sequence === 0) sequence = Number(created.s) - 1
        expect(created).toMatchObject({
          t: 'MESSAGE_CREATE',
          s: ++sequence,
          d: {
            ...message,
            guild_id: guildId,
            sticker_items: stickerItems,
            member: { user: message.author },
          },
        })
        return message
      }

      /** Downloads the original bytes after the message and sticker rows disappear. */
      async function verifyDeletedDownload(
        message: MessageObject
      ): Promise<void> {
        const missing = await fetch(`${rest}/${message.id}`, {
          headers: { Authorization: token },
          signal: AbortSignal.timeout(2000),
        })
        expect(missing.status).toBe(404)
        const download = await fetch(message.attachments[0].url, {
          signal: AbortSignal.timeout(2000),
        })
        expect(download.status).toBe(200)
        expect(download.headers.get('content-type')).toBe('image/png')
        expect(Buffer.from(await download.arrayBuffer())).toEqual(binary)
      }

      const first = await sendCombined('Caption plus both')
      const single = await fetch(`${rest}/${first.id}`, {
        method: 'DELETE',
        headers: { Authorization: token },
        signal: AbortSignal.timeout(2000),
      })
      expect(single.status).toBe(204)
      expect(await next()).toEqual({
        op: GatewayOp.Dispatch,
        t: 'MESSAGE_DELETE',
        s: ++sequence,
        d: { id: first.id, channel_id: channelId, guild_id: guildId },
      })
      await verifyDeletedDownload(first)
      const second = await sendCombined()
      const third = await sendCombined('')
      const bulk = await fetch(`${rest}/bulk-delete`, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [second.id, third.id] }),
        signal: AbortSignal.timeout(2000),
      })
      expect(bulk.status).toBe(204)
      expect(await next()).toEqual({
        op: GatewayOp.Dispatch,
        t: 'MESSAGE_DELETE_BULK',
        s: ++sequence,
        d: {
          ids: [second.id, third.id],
          channel_id: channelId,
          guild_id: guildId,
        },
      })
      await verifyDeletedDownload(second)
      await verifyDeletedDownload(third)
      expect(server.db.prepare('SELECT * FROM messages').all()).toEqual([])
      expect(server.db.prepare('SELECT * FROM message_stickers').all()).toEqual(
        []
      )
      expect(server.db.prepare('SELECT * FROM attachments').all()).toEqual([])
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: sequence }))
      expect(await next()).toMatchObject({ op: GatewayOp.HeartbeatAck })
    }
  )
})
