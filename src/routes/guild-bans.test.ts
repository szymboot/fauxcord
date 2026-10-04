import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createGuildBanRoutes } from './guild-bans'
import { initializeDatabase, closeDatabase } from '../db'
import {
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
  seedMember,
  seedBan,
  createFullTestApp,
} from '../test-helpers'
import type { Database } from '../db'

describe('Guild Bans API', () => {
  let db: Database
  let app: Hono
  let guildId: string
  let token: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono()
    app.route('/', createGuildBanRoutes(db))

    token = seedBot(db)
    guildId = seedGuild(db, token)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('PUT /guilds/:guildId/bans/:userId', () => {
    it('accepts the bodyless DiscordGo ban request and purges only recent target-guild messages', async () => {
      const userId = seedMember(db, guildId, '444444444444444444')
      const channelId = seedChannel(db, guildId)
      const otherChannelId = seedChannel(db, guildId, '333333333333333334')
      const otherGuildId = seedGuild(db, token, '222222222222222223')
      const foreignChannelId = seedChannel(
        db,
        otherGuildId,
        '333333333333333335'
      )
      const recentId = seedMessage(db, channelId, userId, token)
      const sixDaysId = seedMessage(db, otherChannelId, userId, token)
      const oldId = seedMessage(db, channelId, userId, token)
      const otherAuthorId = seedMessage(
        db,
        channelId,
        '111111111111111111',
        token
      )
      const foreignId = seedMessage(db, foreignChannelId, userId, token)
      db.prepare(
        "UPDATE messages SET created_at = datetime('now', '-6 days') WHERE id = ?"
      ).run(sixDaysId)
      db.prepare(
        "UPDATE messages SET created_at = datetime('now', '-8 days') WHERE id = ?"
      ).run(oldId)
      const reason = 'honeypot: café + & = / ? # 100% literal %2F'
      const query = new URLSearchParams({ reason, delete_message_days: '7' })

      const res = await app.request(
        `/guilds/${guildId}/bans/${userId}?${query}`,
        { method: 'PUT', headers: { Authorization: token } }
      )
      expect(res.status).toBe(204)

      const ban = await app.request(`/guilds/${guildId}/bans/${userId}`)
      expect(ban.status).toBe(200)
      expect(await ban.json()).toMatchObject({ user: { id: userId }, reason })
      const bans = await app.request(`/guilds/${guildId}/bans`)
      expect(bans.status).toBe(200)
      expect(await bans.json()).toEqual([
        expect.objectContaining({
          user: expect.objectContaining({ id: userId }),
          reason,
        }),
      ])
      for (const id of [recentId, sixDaysId]) {
        expect(
          db.prepare('SELECT id FROM messages WHERE id = ?').get(id)
        ).toBeUndefined()
      }
      for (const id of [oldId, otherAuthorId, foreignId]) {
        expect(
          db.prepare('SELECT id FROM messages WHERE id = ?').get(id)
        ).toEqual({ id })
      }
      expect(
        db
          .prepare(
            'SELECT user_id FROM guild_members WHERE guild_id = ? AND user_id = ?'
          )
          .get(guildId, userId)
      ).toBeUndefined()
    })

    it.each(['', 'spamming', 'literal %2F + space'])(
      'stores query reason %j exactly once',
      async (reason) => {
        const query = new URLSearchParams({ reason })
        const res = await app.request(
          `/guilds/${guildId}/bans/444444444444444444?${query}`,
          { method: 'PUT' }
        )
        expect(res.status).toBe(204)
        const ban = await app.request(
          `/guilds/${guildId}/bans/444444444444444444`
        )
        expect(await ban.json()).toMatchObject({ reason })
      }
    )

    it.each(['header reason', '', 'literal %2F'])(
      'prefers the audit header %j over the query reason without changing header decoding',
      async (reason) => {
        const res = await app.request(
          `/guilds/${guildId}/bans/444444444444444444?reason=query+reason`,
          {
            method: 'PUT',
            headers: { 'X-Audit-Log-Reason': reason },
          }
        )
        expect(res.status).toBe(204)
        const ban = await app.request(
          `/guilds/${guildId}/bans/444444444444444444`
        )
        expect(await ban.json()).toMatchObject({ reason })
      }
    )

    it.each([
      { payload: {}, queryDays: '0', purged: false },
      { payload: { delete_message_days: 0 }, queryDays: '7', purged: false },
      { payload: { delete_message_days: 1 }, queryDays: '0', purged: true },
      {
        payload: { delete_message_seconds: 0, delete_message_days: 7 },
        queryDays: '7',
        purged: false,
      },
      {
        payload: { delete_message_seconds: 3600 },
        queryDays: '0',
        purged: true,
      },
      {
        payload: { delete_message_seconds: null, delete_message_days: null },
        queryDays: '7',
        purged: true,
      },
    ])(
      'uses seconds, then JSON days, then query days: %j',
      async ({ payload, queryDays, purged }) => {
        const userId = seedMember(db, guildId)
        const channelId = seedChannel(db, guildId)
        const messageId = seedMessage(db, channelId, userId, token)
        const res = await app.request(
          `/guilds/${guildId}/bans/${userId}?delete_message_days=${queryDays}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        )
        expect(res.status).toBe(204)
        const message = db
          .prepare('SELECT id FROM messages WHERE id = ?')
          .get(messageId)
        expect(message).toEqual(purged ? undefined : { id: messageId })
      }
    )

    it.each([
      '',
      '-1',
      '8',
      '1.5',
      '1abc',
      'NaN',
      'Infinity',
      '1e0',
      '0x1',
      ' ',
      '1%0A',
      '1%20',
      '%2B1',
      '9007199254740993',
      '1&delete_message_days=7',
    ])(
      'rejects malformed query days %j without banning or purging',
      async (days) => {
        const userId = seedMember(db, guildId)
        const channelId = seedChannel(db, guildId)
        const messageId = seedMessage(db, channelId, userId, token)
        const res = await app.request(
          `/guilds/${guildId}/bans/${userId}?delete_message_days=${days}`,
          { method: 'PUT' }
        )
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({
          code: 50_035,
          errors: {
            delete_message_days: {
              _errors: [expect.objectContaining({ code: 'NUMBER_TYPE_MAX' })],
            },
          },
        })
        expect(
          db
            .prepare(
              'SELECT user_id FROM guild_bans WHERE guild_id = ? AND user_id = ?'
            )
            .get(guildId, userId)
        ).toBeUndefined()
        expect(
          db.prepare('SELECT id FROM messages WHERE id = ?').get(messageId)
        ).toEqual({ id: messageId })
        expect(
          db
            .prepare(
              'SELECT user_id FROM guild_members WHERE guild_id = ? AND user_id = ?'
            )
            .get(guildId, userId)
        ).toEqual({ user_id: userId })
      }
    )

    it.each([
      { queryDays: 'bad', payload: { delete_message_seconds: 0 } },
      { queryDays: 'bad', payload: { delete_message_days: 0 } },
      { queryDays: '7', payload: { delete_message_days: 'bad' } },
    ])(
      'validates supplied deletion fields even when overridden: %j',
      async ({ queryDays, payload }) => {
        const res = await app.request(
          `/guilds/${guildId}/bans/444444444444444444?delete_message_days=${queryDays}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        )
        expect(res.status).toBe(400)
      }
    )

    it('bans a user and returns 204', async () => {
      const userId = '444444444444444444'
      const res = await app.request(`/guilds/${guildId}/bans/${userId}`, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(204)

      const row = db
        .prepare('SELECT * FROM guild_bans WHERE guild_id = ? AND user_id = ?')
        .get(guildId, userId) as { user_id: string } | undefined
      expect(row?.user_id).toBe(userId)
    })

    it('deletes the banned user recent messages when delete_message_seconds is set', async () => {
      const userId = '444444444444444444'
      db.prepare(
        "INSERT OR IGNORE INTO users (id, username) VALUES (?, 'Target')"
      ).run(userId)
      const channelId = seedChannel(db, guildId)
      const messageId = seedMessage(db, channelId, userId, token, 'spam')

      const res = await app.request(`/guilds/${guildId}/bans/${userId}`, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete_message_seconds: 3600 }),
      })
      expect(res.status).toBe(204)

      const msg = db
        .prepare('SELECT id FROM messages WHERE id = ?')
        .get(messageId) as { id: string } | undefined
      expect(msg).toBeUndefined()
    })

    it('stores the X-Audit-Log-Reason header as the ban reason', async () => {
      const userId = '444444444444444444'
      await app.request(`/guilds/${guildId}/bans/${userId}`, {
        method: 'PUT',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          'X-Audit-Log-Reason': 'spamming',
        },
        body: JSON.stringify({}),
      })

      const res = await app.request(`/guilds/${guildId}/bans/${userId}`, {
        headers: { Authorization: token },
      })
      const body = (await res.json()) as { reason: string | null }
      expect(body.reason).toBe('spamming')
    })

    it('removes the banned user from guild membership', async () => {
      const memberId = seedMember(db, guildId, '444444444444444444')
      await app.request(`/guilds/${guildId}/bans/${memberId}`, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const member = db
        .prepare(
          'SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?'
        )
        .get(guildId, memberId)
      expect(member).toBeUndefined()
    })

    it('succeeds with an empty body (no Content-Type)', async () => {
      const res = await app.request(
        `/guilds/${guildId}/bans/444444444444444444`,
        {
          method: 'PUT',
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(204)
    })

    it('succeeds with a JSON null body (non-object payload)', async () => {
      const res = await app.request(
        `/guilds/${guildId}/bans/444444444444444444`,
        {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: 'null',
        }
      )
      expect(res.status).toBe(204)
    })

    it('succeeds with a JSON array body (non-object payload)', async () => {
      const res = await app.request(
        `/guilds/${guildId}/bans/444444444444444444`,
        {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: '[]',
        }
      )
      expect(res.status).toBe(204)
    })

    it('returns 400 when delete_message_days is out of range', async () => {
      const res = await app.request(
        `/guilds/${guildId}/bans/444444444444444444`,
        {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete_message_days: 8 }),
        }
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(50_035)
    })

    it('returns 400 when delete_message_seconds is out of range', async () => {
      const res = await app.request(
        `/guilds/${guildId}/bans/444444444444444444`,
        {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete_message_seconds: 604_801 }),
        }
      )
      expect(res.status).toBe(400)
    })

    it('returns 404 when the guild does not exist', async () => {
      const res = await app.request(
        '/guilds/999999999999999999/bans/444444444444444444',
        {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(10_004)
    })

    it('updates the reason when banning an already-banned user', async () => {
      const userId = seedBan(db, guildId, '444444444444444444', 'old reason')
      await app.request(`/guilds/${guildId}/bans/${userId}`, {
        method: 'PUT',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          'X-Audit-Log-Reason': 'new reason',
        },
        body: JSON.stringify({}),
      })
      const res = await app.request(`/guilds/${guildId}/bans/${userId}`, {
        headers: { Authorization: token },
      })
      const body = (await res.json()) as { reason: string | null }
      expect(body.reason).toBe('new reason')
    })
  })

  describe('GET /guilds/:guildId/bans/:userId', () => {
    it('returns the ban for a banned user', async () => {
      const userId = seedBan(db, guildId, '444444444444444444', 'reason here')
      const res = await app.request(`/guilds/${guildId}/bans/${userId}`, {
        headers: { Authorization: token },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        user: { id: string }
        reason: string | null
      }
      expect(body.user.id).toBe(userId)
      expect(body.reason).toBe('reason here')
    })

    it('synthesizes a user object when the banned user is not in the users table', async () => {
      const userId = '444444444444444444'
      db.prepare(
        'INSERT INTO guild_bans (guild_id, user_id, reason) VALUES (?, ?, ?)'
      ).run(guildId, userId, null)
      const res = await app.request(`/guilds/${guildId}/bans/${userId}`, {
        headers: { Authorization: token },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        user: { id: string; username: string }
      }
      expect(body.user.id).toBe(userId)
      expect(body.user.username).toBe('Unknown User')
    })

    it('returns 404 (Unknown Ban) when the user is not banned', async () => {
      const res = await app.request(
        `/guilds/${guildId}/bans/444444444444444444`,
        {
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(10_026)
    })

    it('returns 404 (Unknown Guild) when the guild does not exist', async () => {
      const res = await app.request(
        '/guilds/999999999999999999/bans/444444444444444444',
        {
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(10_004)
    })
  })

  describe('GET /guilds/:guildId/bans', () => {
    it('returns an empty array when there are no bans', async () => {
      const res = await app.request(`/guilds/${guildId}/bans`, {
        headers: { Authorization: token },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as unknown[]
      expect(body).toEqual([])
    })

    it('returns all bans ordered by user_id', async () => {
      seedBan(db, guildId, '111111111111111112')
      seedBan(db, guildId, '333333333333333334')
      seedBan(db, guildId, '222222222222222223')

      const res = await app.request(`/guilds/${guildId}/bans`, {
        headers: { Authorization: token },
      })
      const body = (await res.json()) as { user: { id: string } }[]
      expect(body.map((b) => b.user.id)).toEqual([
        '111111111111111112',
        '222222222222222223',
        '333333333333333334',
      ])
    })

    it('respects the after cursor', async () => {
      seedBan(db, guildId, '111111111111111112')
      seedBan(db, guildId, '333333333333333334')

      const res = await app.request(
        `/guilds/${guildId}/bans?after=111111111111111112`,
        { headers: { Authorization: token } }
      )
      const body = (await res.json()) as { user: { id: string } }[]
      expect(body.map((b) => b.user.id)).toEqual(['333333333333333334'])
    })

    it('respects the limit query', async () => {
      seedBan(db, guildId, '111111111111111112')
      seedBan(db, guildId, '333333333333333334')

      const res = await app.request(`/guilds/${guildId}/bans?limit=1`, {
        headers: { Authorization: token },
      })
      const body = (await res.json()) as unknown[]
      expect(body).toHaveLength(1)
    })

    it('returns 404 when the guild does not exist', async () => {
      const res = await app.request('/guilds/999999999999999999/bans', {
        headers: { Authorization: token },
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(10_004)
    })
  })

  describe('DELETE /guilds/:guildId/bans/:userId', () => {
    it('removes a ban and returns 204', async () => {
      const userId = seedBan(db, guildId, '444444444444444444')
      const res = await app.request(`/guilds/${guildId}/bans/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: token },
      })
      expect(res.status).toBe(204)

      const check = await app.request(`/guilds/${guildId}/bans/${userId}`, {
        headers: { Authorization: token },
      })
      expect(check.status).toBe(404)
    })

    it('returns 404 (Unknown Ban) when the user is not banned', async () => {
      const res = await app.request(
        `/guilds/${guildId}/bans/444444444444444444`,
        {
          method: 'DELETE',
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(10_026)
    })

    it('returns 404 (Unknown Guild) when the guild does not exist', async () => {
      const res = await app.request(
        '/guilds/999999999999999999/bans/444444444444444444',
        {
          method: 'DELETE',
          headers: { Authorization: token },
        }
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: number }
      expect(body.code).toBe(10_004)
    })
  })
})

describe('DiscordGo bans through the authenticated app', () => {
  it.each(['/api/v10', '/api', ''])(
    'accepts query parameters under %j and requires authentication',
    async (prefix) => {
      const { db, app, cleanup } = createFullTestApp()
      try {
        const token = seedBot(db)
        const guildId = seedGuild(db, token)
        const userId = seedMember(db, guildId)
        const path = `${prefix}/guilds/${guildId}/bans/${userId}?reason=honeypot+ban&delete_message_days=7`
        const unauthorized = await app.request(path, { method: 'PUT' })
        expect(unauthorized.status).toBe(401)
        const res = await app.request(path, {
          method: 'PUT',
          headers: { Authorization: token },
        })
        expect(res.status).toBe(204)
        const ban = await app.request(
          `${prefix}/guilds/${guildId}/bans/${userId}`,
          { headers: { Authorization: token } }
        )
        expect(ban.status).toBe(200)
        expect(await ban.json()).toMatchObject({ reason: 'honeypot ban' })
      } finally {
        cleanup()
      }
    }
  )
})
