import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase, closeDatabase, type Database } from '../db'
import { createTestRoutes } from './test'
import { createChannelRoutes } from './channels'
import { createAuthMiddleware, type AppEnv } from '../middleware/auth'
import { seedBot, seedGuild, seedChannel, seedMessage } from '../test-helpers'
import { getMessage, type MessageObject } from '../services/messages'
import { gatewayBus } from '../gateway/bus'

const BASE_URL = 'http://localhost:3000'
const TOKEN = 'Bot editing'

describe('PATCH /_test/channels/:channelId/messages/:messageId', () => {
  let db: Database
  let app: Hono<AppEnv>
  let channelId: string
  let humanId: string
  let message: MessageObject
  let path: string
  let events: unknown[]

  /** Collects updates to verify rejected requests do not emit Gateway events. */
  const collect = (event: unknown): void => {
    events.push(event)
  }

  beforeEach(async () => {
    db = initializeDatabase(':memory:')
    app = new Hono<AppEnv>()
    app.route('/', createTestRoutes(db, BASE_URL))
    app.use('*', createAuthMiddleware(db, false))
    app.route('/api/v10', createChannelRoutes(db, BASE_URL))
    const token = seedBot(db, TOKEN)
    const guildId = seedGuild(db, token)
    channelId = seedChannel(db, guildId)
    const registration = await app.request('/_test/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Human', global_name: 'Human Name' }),
    })
    expect(registration.status).toBe(201)
    humanId = ((await registration.json()) as { id: string }).id
    const injection = await app.request(
      `/_test/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'original', author: { id: humanId } }),
      }
    )
    expect(injection.status).toBe(201)
    message = (await injection.json()) as MessageObject
    path = `/_test/channels/${channelId}/messages/${message.id}`
    events = []
    gatewayBus.on('message.update', collect)
  })

  afterEach(() => {
    gatewayBus.off('message.update', collect)
    closeDatabase(db)
  })

  it.each(['edited', 'original', '', 'Zażółć 🐝 こんにちは', 'x'.repeat(2000)])(
    'persists supported content %j without changing message identity',
    async (content) => {
      const response = await app.request(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      expect(response.status).toBe(200)
      const edited = (await response.json()) as MessageObject
      expect(edited).toEqual({
        ...message,
        content,
        edited_timestamp: expect.any(String),
      })
      expect(edited.author).toMatchObject({ id: humanId, bot: false })
      const read = await app.request(
        `/api/v10/channels/${channelId}/messages/${message.id}`,
        { headers: { Authorization: TOKEN } }
      )
      expect(read.status).toBe(200)
      expect(await read.json()).toEqual(edited)
    }
  )

  it('preserves unrelated fields and ignores payload fields other than content', async () => {
    const replyId = seedMessage(db, channelId, humanId, '')
    db.prepare(
      'UPDATE messages SET pinned = 1, tts = 1, mention_everyone = 1, flags = 4, referenced_message_id = ? WHERE id = ?'
    ).run(replyId, message.id)
    db.prepare(
      'INSERT INTO embeds (message_id, data, position) VALUES (?, ?, 0)'
    ).run(message.id, JSON.stringify({ title: 'Keep this embed' }))
    db.prepare(
      'INSERT INTO attachments (id, message_id, filename, size, content_type, file_path) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('123', message.id, 'file.txt', 12, 'text/plain', '/tmp/file.txt')
    db.prepare(
      'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
    ).run(message.id, humanId, '🐝')
    const original = getMessage(db, message.id, BASE_URL)
    const response = await app.request(path, {
      method: 'PATCH',
      body: JSON.stringify({
        content: 'updated',
        id: '999',
        channel_id: '999',
        author: { id: '999', bot: true },
        embeds: null,
        flags: 0,
        attachments: [],
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...original,
      content: 'updated',
      edited_timestamp: expect.any(String),
    })
  })

  it.each([
    ['', 50_035],
    ['{', 50_035],
    ['null', 50_035],
    ['[]', 50_035],
    ['"content"', 50_035],
    ['{}', 50_035],
    ['{"content":null}', 50_035],
    ['{"content":42}', 50_035],
    ['{"content":true}', 50_035],
    ['{"content":[]}', 50_035],
    ['{"content":{}}', 50_035],
    [JSON.stringify({ content: 'x'.repeat(2001) }), 50_035],
  ])(
    'rejects invalid payload %s without mutations or dispatch',
    async (body, code) => {
      const response = await app.request(path, { method: 'PATCH', body })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code,
        errors: { content: {} },
      })
      expect(getMessage(db, message.id, BASE_URL)).toEqual(message)
      expect(events).toEqual([])
    }
  )

  it.each([
    'missing-channel',
    'other-channel',
    'missing-message',
    'deleted-message',
    'missing-author',
  ])(
    'returns a scoped target error for %s without changing the original',
    async (target) => {
      let channel = channelId
      let id = message.id
      let code = 10_008
      switch (target) {
        case 'missing-channel': {
          channel = '999'
          code = 10_003

          break
        }
        case 'other-channel': {
          const otherBot = seedBot(db, 'Bot other', '444444444444444444')
          channel = seedChannel(
            db,
            seedGuild(db, otherBot, '555555555555555555'),
            '666666666666666666'
          )

          break
        }
        case 'deleted-message': {
          db.prepare('DELETE FROM messages WHERE id = ?').run(id)

          break
        }
        case 'missing-author': {
          db.prepare('DELETE FROM guild_members WHERE user_id = ?').run(humanId)
          db.prepare('DELETE FROM users WHERE id = ?').run(humanId)
          break
        }
        default: {
          id = '999'
        }
      }
      const before = getMessage(db, message.id, BASE_URL)
      const response = await app.request(
        `/_test/channels/${channel}/messages/${id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ content: 'wrong target' }),
        }
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code })
      expect(getMessage(db, message.id, BASE_URL)).toEqual(before)
      expect(events).toEqual([])
    }
  )

  it.each(['bot', 'webhook'])(
    'rejects %s-authored messages on the human control route',
    async (actor) => {
      const id =
        actor === 'bot'
          ? seedMessage(db, channelId, '111111111111111111', TOKEN)
          : seedMessage(db, channelId, humanId, 'webhook')
      const before = getMessage(db, id, BASE_URL)
      const response = await app.request(
        `/_test/channels/${channelId}/messages/${id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ content: 'wrong actor' }),
        }
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        message: 'Message author must be a non-bot user',
      })
      expect(getMessage(db, id, BASE_URL)).toEqual(before)
      expect(events).toEqual([])
    }
  )

  it('keeps normal REST authentication and authorship restrictions intact', async () => {
    const restPath = `/api/v10/channels/${channelId}/messages/${message.id}`
    const unauthenticated = await app.request(restPath, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'unauthorized' }),
    })
    expect(unauthenticated.status).toBe(401)
    const forbidden = await app.request(restPath, {
      method: 'PATCH',
      headers: { Authorization: TOKEN },
      body: JSON.stringify({ content: 'wrong actor' }),
    })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ code: 50_005 })
    expect(getMessage(db, message.id, BASE_URL)).toEqual(message)
  })
})
