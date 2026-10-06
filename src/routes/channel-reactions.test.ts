import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createChannelReactionRoutes } from './channel-reactions'
import { initializeDatabase, closeDatabase } from '../db'
import { seedBot, seedGuild, seedChannel, seedMessage } from '../test-helpers'
import type { Database } from '../db'
import type { AppEnv } from '../middleware/auth'
import { buildApp } from '../app'

describe('Channel Reactions API', () => {
  let db: Database
  let app: Hono<AppEnv>
  let channelId: string
  let token: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono<AppEnv>()
    app.route('/', createChannelReactionRoutes(db))

    token = seedBot(db)
    const guildId = seedGuild(db, token)
    channelId = seedChannel(db, guildId)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('DELETE /channels/:channelId/messages/:messageId/reactions/:emoji/:userId', () => {
    it("deletes a specific user's reaction", async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(
        db,
        channelId,
        botUserId,
        token,
        'React to me'
      )

      // Register a reaction for another user directly in the DB
      const reactingUserId = '777777777777777777'
      db.prepare("INSERT INTO users (id, username) VALUES (?, 'Reactor')").run(
        reactingUserId
      )
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, reactingUserId, '👍')

      const emoji = encodeURIComponent('👍')
      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}/reactions/${emoji}/${reactingUserId}`,
        {
          method: 'DELETE',
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(204)

      // The deleted user should not appear in the reaction user list
      const listRes = await app.request(
        `/channels/${channelId}/messages/${messageId}/reactions/${emoji}`,
        { headers: { Authorization: token } }
      )
      const users = (await listRes.json()) as { id: string }[]
      expect(users.some((u) => u.id === reactingUserId)).toBe(false)
    })
  })

  describe('PUT /channels/:channelId/messages/:messageId/reactions/:emoji/@me', () => {
    it('adds a reaction to an existing message', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(
        db,
        channelId,
        botUserId,
        token,
        'React to me'
      )

      const emoji = encodeURIComponent('👍')
      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`,
        {
          method: 'PUT',
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(204)
    })

    it('returns 404 Unknown Message when the message does not exist', async () => {
      const emoji = encodeURIComponent('👍')
      const res = await app.request(
        `/channels/${channelId}/messages/999999999999999999/reactions/${emoji}/@me`,
        {
          method: 'PUT',
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(10_008)
    })

    it('does not add a reaction through a different channel path', async () => {
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
        `/channels/${otherChannelId}/messages/${messageId}/reactions/${encodeURIComponent('👍')}/@me`,
        { method: 'PUT', headers: { Authorization: token } }
      )

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ code: 10_008 })
      const reactionCount = db
        .prepare('SELECT COUNT(*) AS count FROM reactions WHERE message_id = ?')
        .get(messageId) as { count: number }
      expect(reactionCount.count).toBe(0)
    })

    it('returns 400 for a malformed percent-encoded emoji', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'react')

      // "%E0%A4%A" is invalid percent-encoding and makes decodeURIComponent throw.
      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}/reactions/%E0%A4%A/@me`,
        {
          method: 'PUT',
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(50_035)
    })
  })

  describe('GET /channels/:channelId/messages/:messageId/reactions/:emoji', () => {
    it('lists users who reacted', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'r')
      const reactor = '777777777777777777'
      db.prepare("INSERT INTO users (id, username) VALUES (?, 'R')").run(
        reactor
      )
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, reactor, '👍')

      const emoji = encodeURIComponent('👍')
      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}/reactions/${emoji}`,
        { headers: { Authorization: token } }
      )
      expect(res.status).toBe(200)
      const users = (await res.json()) as { id: string }[]
      expect(users.some((u) => u.id === reactor)).toBe(true)
    })

    it.each(['👍🏽', 'party:123456789012345678'])(
      'separates normal and burst users for %s without changing persisted membership',
      async (emoji) => {
        const author = '111111111111111111'
        const messageId = seedMessage(db, channelId, author, token)
        const reactor = '777777777777777777'
        db.prepare("INSERT INTO users (id, username) VALUES (?, 'Human')").run(
          reactor
        )
        db.prepare(
          'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
        ).run(messageId, reactor, emoji)
        const url = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`

        for (const query of ['', '?type=0', '?type=1', '?type=0']) {
          const response = await app.request(url + query)
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toEqual(
            query === '?type=1'
              ? []
              : [expect.objectContaining({ id: reactor, bot: false })]
          )
        }
      }
    )

    it.each(['2', '-1', 'normal', '1.5', '1foo', '0foo', '', 'null'])(
      'rejects invalid reaction type "%s"',
      async (type) => {
        const messageId = seedMessage(
          db,
          channelId,
          '111111111111111111',
          token
        )
        const response = await app.request(
          `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent('👍')}?type=${type}`
        )
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
          code: 50_035,
          message: 'Invalid Form Body',
          errors: {
            type: {
              _errors: [
                {
                  code: 'BASE_TYPE_CHOICES',
                  message: 'Value must be one of (0, 1).',
                },
              ],
            },
          },
        })
      }
    )

    it('paginates normal users within the requested message and emoji only', async () => {
      const author = '111111111111111111'
      const messageId = seedMessage(db, channelId, author, token)
      const otherMessage = seedMessage(db, channelId, author, token)
      const reactors = [
        '777777777777777771',
        '777777777777777772',
        '777777777777777773',
      ]
      for (const reactor of reactors.toReversed()) {
        db.prepare("INSERT INTO users (id, username) VALUES (?, 'Human')").run(
          reactor
        )
        db.prepare(
          'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
        ).run(messageId, reactor, '👍')
      }
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, author, '👎')
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(otherMessage, author, '👍')
      const url = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent('👍')}`
      for (const type of ['', '&type=0']) {
        const first = await app.request(`${url}?limit=1${type}`)
        expect(first.status).toBe(200)
        await expect(first.json()).resolves.toEqual([
          expect.objectContaining({ id: reactors[0] }),
        ])
        const next = await app.request(
          `${url}?limit=1&after=${reactors[0]}${type}`
        )
        expect(next.status).toBe(200)
        await expect(next.json()).resolves.toEqual([
          expect.objectContaining({ id: reactors[1] }),
        ])
      }
      const burst = await app.request(
        `${url}?type=1&limit=1&after=${reactors[0]}`
      )
      expect(burst.status).toBe(200)
      await expect(burst.json()).resolves.toEqual([])
    })

    it.each(['0', '1'])('preserves GET errors for type=%s', async (type) => {
      const messageId = seedMessage(db, channelId, '111111111111111111', token)
      const malformed = await app.request(
        `/channels/${channelId}/messages/${messageId}/reactions/%E0%A4%A?type=${type}`
      )
      expect(malformed.status).toBe(400)
      await expect(malformed.json()).resolves.toMatchObject({ code: 50_035 })
      const missing = await app.request(
        `/channels/${channelId}/messages/999999999999999999/reactions/${encodeURIComponent('👍')}?type=${type}`
      )
      expect(missing.status).toBe(404)
      await expect(missing.json()).resolves.toMatchObject({ code: 10_008 })
    })

    it.each(['0', '1'])(
      'does not list reactions through a different channel path for type=%s',
      async (type) => {
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
          `/channels/${otherChannelId}/messages/${messageId}/reactions/${encodeURIComponent('👍')}?type=${type}`,
          { headers: { Authorization: token } }
        )

        expect(response.status).toBe(404)
        await expect(response.json()).resolves.toMatchObject({ code: 10_008 })
      }
    )
  })

  describe('DELETE all reactions', () => {
    it('removes every reaction on a message', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'r')
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, botUserId, '👍')

      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}/reactions`,
        { method: 'DELETE', headers: { Authorization: token } }
      )
      expect(res.status).toBe(204)

      const remaining = db
        .prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?')
        .get(messageId) as { n: number }
      expect(remaining.n).toBe(0)
    })

    it('does not remove reactions through a different channel path', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'scoped')
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, botUserId, '👍')
      const otherChannelId = seedChannel(
        db,
        seedGuild(db, token),
        '888888888888888888'
      )

      const response = await app.request(
        `/channels/${otherChannelId}/messages/${messageId}/reactions`,
        { method: 'DELETE', headers: { Authorization: token } }
      )

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ code: 10_008 })
      const after = db
        .prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?')
        .get(messageId) as { n: number }
      expect(after.n).toBe(1)
    })
  })

  describe('DELETE reactions for a specific emoji', () => {
    it('removes all reactions for one emoji', async () => {
      const botUserId = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      const messageId = seedMessage(db, channelId, botUserId, token, 'r')
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, botUserId, '👍')

      const emoji = encodeURIComponent('👍')
      const res = await app.request(
        `/channels/${channelId}/messages/${messageId}/reactions/${emoji}`,
        { method: 'DELETE', headers: { Authorization: token } }
      )
      expect(res.status).toBe(204)
    })
  })

  describe('cross-channel reaction deletions', () => {
    it.each(['@me', 'specific-user', 'emoji'])(
      'does not delete a %s reaction through a different channel path',
      async (route) => {
        const botUserId = (
          db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
            user_id: string
          }
        ).user_id
        const messageId = seedMessage(db, channelId, botUserId, token, 'scoped')
        db.prepare(
          'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
        ).run(messageId, botUserId, '👍')
        const otherChannelId = seedChannel(
          db,
          seedGuild(db, token),
          '888888888888888888'
        )
        const emoji = encodeURIComponent('👍')
        const target =
          route === 'emoji'
            ? emoji
            : `${emoji}/${route === '@me' ? route : botUserId}`

        const response = await app.request(
          `/channels/${otherChannelId}/messages/${messageId}/reactions/${target}`,
          { method: 'DELETE', headers: { Authorization: token } }
        )

        expect(response.status).toBe(404)
        await expect(response.json()).resolves.toMatchObject({ code: 10_008 })
        const remaining = db
          .prepare(
            'SELECT COUNT(*) AS count FROM reactions WHERE message_id = ?'
          )
          .get(messageId) as { count: number }
        expect(remaining.count).toBe(1)
      }
    )
  })
})

describe('reaction types in the production app', () => {
  it.each(['/api/v10', '/api', ''])(
    'filters reactions and requires authentication under "%s"',
    async (prefix) => {
      const db = initializeDatabase(':memory:')
      const server = buildApp(db, {
        baseUrl: 'http://localhost:3000',
        disableAuth: false,
      })
      try {
        const token = seedBot(db)
        const author = '111111111111111111'
        const guild = seedGuild(db, token)
        const channel = seedChannel(db, guild)
        const message = seedMessage(db, channel, author, token)
        db.prepare(
          'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
        ).run(message, author, '👍')
        const url = `${prefix}/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('👍')}`
        for (const query of ['', '?type=0', '?type=1']) {
          const response = await server.app.request(url + query, {
            headers: { Authorization: token },
          })
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toEqual(
            query === '?type=1'
              ? []
              : [expect.objectContaining({ id: author, bot: true })]
          )
          for (const headers of [
            new Headers(),
            new Headers({ Authorization: 'Bot invalid' }),
          ]) {
            const unauthorized = await server.app.request(url + query, {
              headers,
            })
            expect(unauthorized.status).toBe(401)
            await expect(unauthorized.json()).resolves.toMatchObject({
              code: 0,
              message: '401: Unauthorized',
            })
          }
        }
      } finally {
        server.shutdownRestPageHolds()
        server.unsubscribeGateway()
        server.wss.close()
        closeDatabase(db)
      }
    }
  )
})
