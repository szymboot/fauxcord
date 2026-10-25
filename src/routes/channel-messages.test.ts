import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createChannelMessageRoutes } from './channel-messages'
import { initializeDatabase, closeDatabase } from '../db'
import {
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
  seedAnnouncementChannel,
  createFullTestApp,
  seedWebhook,
  seedInteraction,
} from '../test-helpers'
import type { Database } from '../db'
import type { AppEnv } from '../middleware/auth'

const BASE_URL = 'http://localhost:3000'

describe('Channel Messages API', () => {
  let db: Database
  let app: Hono<AppEnv>
  let channelId: string
  let token: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono<AppEnv>()
    app.route('/', createChannelMessageRoutes(db, BASE_URL))

    token = seedBot(db)
    const guildId = seedGuild(db, token)
    channelId = seedChannel(db, guildId)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('POST /channels/:channelId/messages', () => {
    it('sends a message', async () => {
      const res = await app.request(`/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Hello, World!' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.content).toBe('Hello, World!')
      expect(body.channel_id).toBe(channelId)
    })

    it('returns 400 for an empty message', async () => {
      const res = await app.request(`/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe(50_006)
    })

    it('returns 400 when content exceeds 2000 characters', async () => {
      const res = await app.request(`/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'a'.repeat(2001) }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe(50_035)
    })
  })

  describe('GET /channels/:channelId/messages', () => {
    it('retrieves a list of messages', async () => {
      // Post a message first
      await app.request(`/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Test message' }),
      })

      const res = await app.request(`/channels/${channelId}/messages`, {
        headers: { Authorization: token },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as unknown[]
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBeGreaterThan(0)
    })

    it('limit parameter works correctly', async () => {
      // Post 5 messages
      for (let i = 0; i < 5; i++) {
        await app.request(`/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: `Message ${i}` }),
        })
      }

      const res = await app.request(`/channels/${channelId}/messages?limit=3`, {
        headers: { Authorization: token },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as unknown[]
      expect(body.length).toBe(3)
    })
  })

  describe('DELETE /channels/:channelId/messages/:messageId', () => {
    it('deletes a message', async () => {
      // Post a message
      const postRes = await app.request(`/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'To delete' }),
      })
      const { id: messageId } = await postRes.json()

      const deleteRes = await app.request(
        `/channels/${channelId}/messages/${messageId}`,
        {
          method: 'DELETE',
          headers: { Authorization: token },
        }
      )
      expect(deleteRes.status).toBe(204)
    })
  })

  describe('GET /channels/:channelId/messages/:messageId', () => {
    it('retrieves a single message', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'single')

      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}`,
        { headers: { Authorization: token } }
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id: string; content: string }
      expect(body.id).toBe(messageId)
      expect(body.content).toBe('single')
    })

    it('returns 404 for a non-existent message', async () => {
      const res = await app.request(
        `/channels/${channelId}/messages/999999999999999999`,
        { headers: { Authorization: token } }
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(10_008)
    })

    it('does not return a message through a different channel path', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'scoped')
      const otherChannelId = seedChannel(
        db,
        seedGuild(db, token),
        '888888888888888888'
      )

      const response = await app.request(
        `/channels/${otherChannelId}/messages/${messageId}`,
        { headers: { Authorization: token } }
      )

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ code: 10_008 })
    })
  })

  describe('PATCH /channels/:channelId/messages/:messageId', () => {
    it('edits an existing message', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'before')

      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: 'after' }),
        }
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { content: string }
      expect(body.content).toBe('after')
    })

    it('returns 404 when editing a non-existent message', async () => {
      const res = await app.request(
        `/channels/${channelId}/messages/999999999999999999`,
        {
          method: 'PATCH',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: 'x' }),
        }
      )
      expect(res.status).toBe(404)
    })

    it('does not edit a message through a different channel path', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'before')
      const otherChannelId = seedChannel(
        db,
        seedGuild(db, token),
        '888888888888888888'
      )

      const response = await app.request(
        `/channels/${otherChannelId}/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: 'wrong channel edit' }),
        }
      )

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ code: 10_008 })
      const row = db
        .prepare('SELECT content FROM messages WHERE id = ?')
        .get(messageId) as { content: string }
      expect(row.content).toBe('before')
    })

    it('returns 400 when the edited content exceeds the limit', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'before')

      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: 'a'.repeat(2001) }),
        }
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(50_035)
    })
  })

  describe('POST /channels/:channelId/messages/bulk-delete', () => {
    it('bulk-deletes messages', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const id1 = seedMessage(db, channelId, botUserId, token, 'a')
      const id2 = seedMessage(db, channelId, botUserId, token, 'b')

      const res = await app.request(
        `/channels/${channelId}/messages/bulk-delete`,
        {
          method: 'POST',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ messages: [id1, id2] }),
        }
      )
      expect(res.status).toBe(204)
    })

    it('returns 400 when fewer than 2 messages are provided', async () => {
      const res = await app.request(
        `/channels/${channelId}/messages/bulk-delete`,
        {
          method: 'POST',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ messages: ['123456789012345678'] }),
        }
      )
      expect(res.status).toBe(400)
    })

    it('does not delete messages that belong to a different channel', async () => {
      const otherChannelId = seedChannel(db, seedGuild(db, token), 'other')

      // Post one message in each channel.
      const postTo = async (cid: string, content: string): Promise<string> => {
        const res = await app.request(`/channels/${cid}/messages`, {
          method: 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        })
        const { id } = (await res.json()) as { id: string }
        return id
      }
      const msgA = await postTo(channelId, 'in target channel')
      const msgB = await postTo(otherChannelId, 'in other channel')

      // Bulk-delete both IDs via the target channel; msgB must survive.
      const res = await app.request(
        `/channels/${channelId}/messages/bulk-delete`,
        {
          method: 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [msgA, msgB] }),
        }
      )
      expect(res.status).toBe(204)

      const survivor = await app.request(
        `/channels/${otherChannelId}/messages/${msgB}`,
        { headers: { Authorization: token } }
      )
      expect(survivor.status).toBe(200)
    })
  })

  describe('POST /channels/:channelId/messages/:messageId/crosspost', () => {
    it('sets the CROSSPOSTED flag on an announcement channel message', async () => {
      const bot = seedBot(db, 'Bot testtoken')
      const guild = seedGuild(db, bot)
      const channel = seedAnnouncementChannel(db, guild)
      const message = seedMessage(db, channel, '111111111111111111', bot)

      const res = await app.request(
        `/channels/${channel}/messages/${message}/crosspost`,
        { method: 'POST', headers: { Authorization: 'Bot testtoken' } }
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, number>
      expect(body.flags & 2).toBe(2)
    })

    it('returns 400 CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE for a text channel', async () => {
      const bot = seedBot(db, 'Bot testtoken')
      const guild = seedGuild(db, bot)
      const channel = seedChannel(db, guild)
      const message = seedMessage(db, channel, '111111111111111111', bot)

      const res = await app.request(
        `/channels/${channel}/messages/${message}/crosspost`,
        { method: 'POST', headers: { Authorization: 'Bot testtoken' } }
      )

      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe(50_024)
    })

    it('returns 404 for an unknown message', async () => {
      const bot = seedBot(db, 'Bot testtoken')
      const guild = seedGuild(db, bot)
      const channel = seedAnnouncementChannel(db, guild)

      const res = await app.request(
        `/channels/${channel}/messages/999999999999999999/crosspost`,
        { method: 'POST', headers: { Authorization: 'Bot testtoken' } }
      )

      expect(res.status).toBe(404)
    })
  })
})

describe('POST /channels/:channelId/messages with poll', () => {
  let db: Database
  let app: Hono<AppEnv>

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono<AppEnv>()
    app.route('/', createChannelMessageRoutes(db, BASE_URL))
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('creates a message with an attached poll', async () => {
    const bot = seedBot(db, 'Bot testtoken')
    const guild = seedGuild(db, bot)
    const channel = seedChannel(db, guild)

    const res = await app.request(`/channels/${channel}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot testtoken',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        poll: {
          question: { text: 'Best pizza?' },
          answers: [
            { poll_media: { text: 'Margherita' } },
            { poll_media: { text: 'Pepperoni' } },
          ],
        },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      poll: { question: { text: string }; answers: unknown[] }
    }
    expect(body.poll.question.text).toBe('Best pizza?')
    expect(body.poll.answers).toHaveLength(2)
  })

  it('returns 400 for an invalid poll payload', async () => {
    const bot = seedBot(db, 'Bot testtoken')
    const guild = seedGuild(db, bot)
    const channel = seedChannel(db, guild)

    const res = await app.request(`/channels/${channel}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot testtoken',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        poll: { question: { text: '' }, answers: [] },
      }),
    })

    expect(res.status).toBe(400)
  })
})

describe('message components through channel routes', () => {
  let context: ReturnType<typeof createFullTestApp>
  let path: string
  let channelId: string
  let token: string
  const components = [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Buy', custom_id: 'shop_item_buy_42' },
        {
          type: 2,
          style: 4,
          label: 'Return',
          custom_id: 'shop_item_return_42',
          disabled: false,
          emoji: { name: '↩️' },
        },
        {
          type: 2,
          style: 5,
          label: 'Details',
          url: 'https://example.com/item/42',
        },
      ],
    },
  ]
  beforeEach(() => {
    context = createFullTestApp()
    token = seedBot(context.db)
    channelId = seedChannel(context.db, seedGuild(context.db, token))
    path = `/channels/${channelId}/messages`
  })
  afterEach(() => {
    context.cleanup()
  })

  /** Sends an authenticated JSON request through the assembled application. */
  function request(
    route: string,
    method = 'GET',
    body?: unknown,
    authorization = token
  ) {
    return context.app.request(route, {
      method,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }
  /** Reads a successful JSON response and fails locally on an unexpected status. */
  async function json<T = unknown>(
    route: string,
    method = 'GET',
    body?: unknown
  ): Promise<T> {
    const response = await request(route, method, body)
    expect(response.status).toBe(200)
    return (await response.json()) as T
  }
  /** Reads the status without accessing a member on an await expression. */
  async function status(
    route: string,
    method: string,
    body?: unknown,
    authorization = token
  ): Promise<number> {
    const response = await request(route, method, body, authorization)
    return response.status
  }

  it.each(['/api/v10', '/api', ''])(
    'returns stored buttons in create, edit, single reads and paginated lists through %s',
    async (prefix) => {
      const original = await json<{ id: string; components: unknown[] }>(
        prefix + path,
        'POST',
        { components }
      )
      expect(original.components).toMatchObject(components)
      const stored = original.components
      const later = await json<{ id: string }>(prefix + path, 'POST', {
        content: 'later',
      })
      for (const query of [
        '',
        '?limit=1&before=' + later.id,
        '?limit=1&after=0',
        '?limit=1&around=' + original.id,
      ]) {
        const messages = await json<{ id: string; components: unknown[] }[]>(
          prefix + path + query
        )
        expect(
          messages.find((message) => message.id === original.id)?.components
        ).toEqual(stored)
      }
      expect(await json(prefix + path + '/' + original.id)).toMatchObject({
        components: stored,
      })
      expect(await json('/_test/messages/' + channelId)).toMatchObject({
        messages: [
          { id: original.id, components: stored },
          { id: later.id, components: [] },
        ],
      })
      expect(
        await json(prefix + path + '/' + original.id, 'PATCH', {
          content: 'keeps buttons',
        })
      ).toMatchObject({ components: stored })
      const buyOnly = [{ type: 1, components: [components[0].components[0]] }]
      expect(
        await json(prefix + path + '/' + original.id, 'PATCH', {
          components: buyOnly,
        })
      ).toMatchObject({ components: buyOnly })
      expect(await json(prefix + path + '/' + original.id)).toMatchObject({
        components: buyOnly,
      })
      for (const clear of [[], null]) {
        expect(
          await json(prefix + path + '/' + original.id, 'PATCH', {
            components: clear,
          })
        ).toMatchObject({ components: [] })
      }
    }
  )

  it('persists style-specific fields when irrelevant optional fields are null', async () => {
    const input = [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Buy', custom_id: 'buy', url: null },
          {
            type: 2,
            style: 5,
            label: 'Link',
            url: 'https://example.com',
            custom_id: null,
          },
        ],
      },
    ]
    const expected = [
      {
        type: 1,
        id: 0,
        components: [
          { type: 2, id: 0, style: 1, label: 'Buy', custom_id: 'buy' },
          {
            type: 2,
            id: 0,
            style: 5,
            label: 'Link',
            url: 'https://example.com',
          },
        ],
      },
    ]
    const message = await json<{ id: string; components: unknown[] }>(
      path,
      'POST',
      { components: input }
    )
    expect(message.components).toEqual(expected)
    expect(await json(path + '/' + message.id)).toMatchObject({
      components: expected,
    })
    const edited = await json<{ components: unknown[] }>(
      path + '/' + message.id,
      'PATCH',
      { components: input }
    )
    expect(edited.components).toEqual(expected)
  })

  it('rejects invalid creates and edits without changing content or buttons', async () => {
    const original = await json<{ id: string }>(path, 'POST', {
      content: 'original',
      components,
    })
    const invalid = [
      { type: 1, components: [{ type: 2, style: 1, label: 'Missing ID' }] },
    ]
    for (const [route, method] of [
      [path, 'POST'],
      [path + '/' + original.id, 'PATCH'],
    ]) {
      const rejected = await request(route, method, {
        content: 'invalid change',
        components: invalid,
      })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({
        code: 50_035,
        message: 'Invalid Form Body',
        errors: {
          'components.0.components.0.custom_id': {
            _errors: [{ code: 'BASE_TYPE_REQUIRED' }],
          },
        },
      })
    }
    expect(await json(path + '/' + original.id)).toEqual(original)
    expect(await json(path)).toHaveLength(1)
  })

  it('preserves authentication, unknown-message and unknown-channel errors', async () => {
    expect(await status(path, 'POST', { components }, 'Bot unknown')).toBe(401)
    expect(await status('/channels/0/messages', 'POST', { components })).toBe(
      404
    )
    expect(await status(path + '/0', 'PATCH', { components })).toBe(404)
  })

  it('stores callback, original response, followup and webhook components consistently', async () => {
    const guild = (
      context.db
        .prepare('SELECT guild_id FROM channels WHERE id = ?')
        .get(channelId) as { guild_id: string }
    ).guild_id
    const application = (
      context.db
        .prepare('SELECT user_id FROM bots WHERE token = ?')
        .get(token) as { user_id: string }
    ).user_id
    const { interactionId, interactionToken } = seedInteraction(
      context.db,
      application,
      channelId,
      application
    )
    const callbackPath = `/interactions/${interactionId}/${interactionToken}/callback`
    const followupPath = `/webhooks/${application}/${interactionToken}`
    const invalid = [{ type: 1, components: [] }]
    expect(
      await status(callbackPath, 'POST', {
        type: 4,
        data: { components: invalid },
      })
    ).toBe(400)
    expect(
      await status(callbackPath, 'POST', { type: 4, data: { components } })
    ).toBe(204)
    const originalPath = followupPath + '/messages/@original'
    expect(await json(originalPath)).toMatchObject({ components })
    expect(
      await json(originalPath, 'PATCH', { content: 'keeps callback buttons' })
    ).toMatchObject({ components })
    expect(await status(originalPath, 'PATCH', { components: invalid })).toBe(
      400
    )
    expect(await json(originalPath, 'PATCH', { components: [] })).toMatchObject(
      { components: [] }
    )
    const { webhookId, webhookToken } = seedWebhook(
      context.db,
      channelId,
      guild
    )
    for (const webhookPath of [
      followupPath,
      `/webhooks/${webhookId}/${webhookToken}`,
    ]) {
      expect(
        await status(webhookPath + '?wait=true', 'POST', {
          components: invalid,
        })
      ).toBe(400)
      const message = await json<{ id: string }>(
        webhookPath + '?wait=true',
        'POST',
        { components }
      )
      expect(message).toMatchObject({ components })
      const editPath = webhookPath + '/messages/' + message.id
      expect(await status(editPath, 'PATCH', { components: invalid })).toBe(400)
      expect(
        await json(editPath, 'PATCH', { content: 'keeps buttons' })
      ).toMatchObject({ components })
      expect(await json(editPath, 'PATCH', { components: [] })).toMatchObject({
        components: [],
      })
    }
  })

  it('exposes components through both pin APIs and clears them with scoped resets', async () => {
    const message = await json<{ id: string; components: unknown[] }>(
      path,
      'POST',
      { components }
    )
    expect(
      await status(`/channels/${channelId}/pins/${message.id}`, 'PUT')
    ).toBe(204)
    expect(await json(`/channels/${channelId}/pins`)).toMatchObject([
      { id: message.id, components: message.components },
    ])
    expect(await json(path + '/pins')).toMatchObject({
      items: [{ message: { id: message.id, components: message.components } }],
    })
    expect(await status('/_test/reset', 'POST', { token })).toBe(204)
    expect(await json(path)).toEqual([])
    expect(await json(path, 'POST', { content: 'after reset' })).toMatchObject({
      components: [],
    })
  })
})
