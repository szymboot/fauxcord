import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../app'
import { initializeDatabase, type Database } from '../db'
import { seedBot, seedChannel, seedGuild } from '../test-helpers'
import { createTestUser } from '../services/test-control'
import { createGuildSticker } from '../services/guild-advanced'
import type { MessageObject } from '../services/messages'
import { gatewayBus } from '../gateway/bus'

const TOKEN = 'Bot combined'
const BASE_URL = 'http://localhost:3000'
const bytes = Buffer.from([0, 255, 128, 13, 10, 1])
const filename = 'evidence #?.bin'

describe.each([true, false])('attachments and stickers (human=%s)', (human) => {
  let db: Database
  let uploadPath: string
  let app: ReturnType<typeof buildApp>['app']
  let channelId: string
  let humanId: string
  let stickerIds: string[]
  let events: unknown[]

  /** Records creates and deletions, including unwanted failure side effects. */
  const collect = (event: unknown): void => {
    events.push(event)
  }

  beforeEach(async () => {
    db = initializeDatabase(':memory:')
    uploadPath = await mkdtemp(path.join(tmpdir(), 'fauxcord-combined-'))
    app = buildApp(db, {
      baseUrl: BASE_URL,
      uploadPath,
      disableAuth: false,
    }).app
    const token = seedBot(db, TOKEN)
    const guildId = seedGuild(db, token)
    channelId = seedChannel(db, guildId)
    humanId = createTestUser(db, { username: 'Human' }).id
    stickerIds = ['First sticker', 'Second sticker'].map(
      (name) =>
        createGuildSticker(db, guildId, humanId, { name, tags: 'wave' }).id
    )
    events = []
    gatewayBus.on('message.create', collect)
    gatewayBus.on('message.delete', collect)
    gatewayBus.on('message.delete.bulk', collect)
  })

  afterEach(async () => {
    gatewayBus.off('message.create', collect)
    gatewayBus.off('message.delete', collect)
    gatewayBus.off('message.delete.bulk', collect)
    db.close()
    await rm(uploadPath, { recursive: true, force: true })
  })

  /** Sends the same logical combined message as a fixture or bot multipart send. */
  async function send(
    payload: Record<string, unknown> = {},
    name = filename
  ): Promise<Response> {
    const input = { sticker_ids: stickerIds, ...payload }
    if (human) {
      return app.request(`/_test/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: { id: humanId },
          attachments: [
            {
              filename: name,
              content_type: 'image/png',
              data: bytes.toString('base64'),
            },
            { filename: name, content_type: 'text/plain', data: 'YWJj' },
          ],
          ...input,
        }),
      })
    }
    const form = new FormData()
    form.set('payload_json', JSON.stringify(input))
    form.set('files[0]', new File([bytes], name, { type: 'image/png' }))
    form.set('files[1]', new File(['abc'], name, { type: 'text/plain' }))
    return app.request(`/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: TOKEN },
      body: form,
    })
  }

  /** Verifies every returned URL retains the exact original bytes and MIME. */
  async function verifyDownloads(message: MessageObject): Promise<void> {
    for (const [index, attachment] of message.attachments.entries()) {
      const download = await app.request(attachment.url)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-type')).toBe(attachment.content_type)
      expect(Buffer.from(await download.arrayBuffer())).toEqual(
        index === 0 ? bytes : Buffer.from('abc')
      )
    }
  }

  it.each([
    { content: undefined, bulk: false },
    { content: '', bulk: true },
    { content: 'Caption and evidence', bulk: true },
  ])(
    'persists both fields, then retains downloads after deletion (%j)',
    async ({ content, bulk }) => {
      const response = await send({ content })
      expect(response.status).toBe(human ? 201 : 200)
      const message = (await response.json()) as MessageObject
      expect(message.author.bot).toBe(!human)
      if (human) expect(message.author.id).toBe(humanId)
      expect(message.content).toBe(content ?? '')
      expect(message.sticker_items).toEqual(
        stickerIds.map((id, index) => ({
          id,
          name: index === 0 ? 'First sticker' : 'Second sticker',
          format_type: 1,
        }))
      )
      expect(message.attachments).toHaveLength(2)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ message })
      await verifyDownloads(message)
      const read = await app.request(
        `/api/v10/channels/${channelId}/messages/${message.id}`,
        { headers: { Authorization: TOKEN } }
      )
      expect(await read.json()).toEqual(message)
      const inspect = await app.request(`/_test/messages/${channelId}`)
      expect(await inspect.json()).toMatchObject({
        messages: [{ id: message.id, sticker_items: message.sticker_items }],
      })

      let second: MessageObject | undefined
      if (bulk) {
        const secondResponse = await send({ content: 'Another' })
        expect(secondResponse.status).toBe(human ? 201 : 200)
        second = (await secondResponse.json()) as MessageObject
      }
      const deletion = await app.request(
        `/api/v10/channels/${channelId}/messages/${bulk ? 'bulk-delete' : message.id}`,
        {
          method: bulk ? 'POST' : 'DELETE',
          headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
          ...(second && {
            body: JSON.stringify({ messages: [message.id, second.id] }),
          }),
        }
      )
      expect(deletion.status).toBe(204)
      expect(events).toHaveLength(bulk ? 3 : 2)
      expect(events.at(-1)).toMatchObject(
        bulk
          ? { messageIds: [message.id, second?.id] }
          : { messageId: message.id }
      )
      expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
      expect(db.prepare('SELECT * FROM message_stickers').all()).toEqual([])
      expect(db.prepare('SELECT * FROM attachments').all()).toEqual([])
      await verifyDownloads(message)
      if (second) await verifyDownloads(second)
      const reset = await app.request('/_test/reset', { method: 'POST' })
      expect(reset.status).toBe(204)
      expect(db.prepare('SELECT * FROM attachment_files').all()).toEqual([])
      expect(await readdir(uploadPath)).toEqual([])
    }
  )

  it.each([
    {
      failure: 'invalid sticker input',
      payload: { sticker_ids: [1] },
      table: undefined,
    },
    {
      failure: 'unknown sticker catalog',
      payload: { sticker_ids: ['123'] },
      table: undefined,
    },
    { failure: 'sticker persistence', payload: {}, table: 'message_stickers' },
    { failure: 'attachment persistence', payload: {}, table: 'attachments' },
  ])(
    'rejects $failure with no partial rows, files, or events',
    async ({ payload, table }) => {
      if (table)
        db.exec(`CREATE TRIGGER fail_combined BEFORE INSERT ON ${table}
      WHEN (SELECT COUNT(*) FROM ${table}) = 1
      BEGIN SELECT RAISE(ABORT, 'Combined persistence failure'); END`)
      const response = await send(payload)
      expect(response.status).toBe(table ? 500 : 400)
      expect(events).toEqual([])
      for (const name of [
        'messages',
        'message_stickers',
        'attachments',
        'attachment_files',
      ]) {
        expect(db.prepare(`SELECT * FROM ${name}`).all()).toEqual([])
      }
      expect(
        db.prepare('SELECT * FROM guild_members WHERE user_id = ?').all(humanId)
      ).toEqual([])
      expect(
        db
          .prepare('SELECT last_message_id FROM channels WHERE id = ?')
          .get(channelId)
      ).toEqual({ last_message_id: null })
      expect(await readdir(uploadPath)).toEqual([])
    }
  )

  it('rejects malformed attachments without persisting sticker snapshots', async () => {
    const response = human
      ? await send({
          attachments: [{ filename, content_type: 'image/png', data: '!!!!' }],
        })
      : await send({}, '../escape.bin')
    expect(response.status).toBe(400)
    expect(events).toEqual([])
    expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
    expect(db.prepare('SELECT * FROM message_stickers').all()).toEqual([])
    expect(db.prepare('SELECT * FROM attachment_files').all()).toEqual([])
    expect(await readdir(uploadPath)).toEqual([])
  })
  if (human) {
    it.each([false, true])(
      'preserves atomic immediate-removal fixtures (failure=%s)',
      async (failure) => {
        if (failure)
          db.exec(`CREATE TRIGGER fail_remove_combined BEFORE DELETE ON messages
        BEGIN SELECT RAISE(ABORT, 'Combined removal failure'); END`)
        const response = await send({ remove_after_create: true })
        expect(response.status).toBe(failure ? 500 : 201)
        expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
        expect(db.prepare('SELECT * FROM message_stickers').all()).toEqual([])
        expect(db.prepare('SELECT * FROM attachments').all()).toEqual([])
        expect(events).toHaveLength(failure ? 0 : 2)
        if (failure) {
          expect(db.prepare('SELECT * FROM attachment_files').all()).toEqual([])
          expect(await readdir(uploadPath)).toEqual([])
        } else {
          const message = (await response.json()) as MessageObject
          expect(message.sticker_items).toHaveLength(2)
          expect(message.attachments).toHaveLength(2)
          expect(events[0]).toMatchObject({ message })
          expect(events[1]).toMatchObject({ messageId: message.id })
          await verifyDownloads(message)
        }
      }
    )
  }
})
