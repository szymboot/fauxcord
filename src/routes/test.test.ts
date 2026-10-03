import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestRoutes } from './test'
import { initializeDatabase, closeDatabase } from '../db'
import {
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
  seedWebhook,
} from '../test-helpers'
import { createTestUser } from '../services/test-control'
import { getUser, getBotUser } from '../services/users'
import { getGuildMember, getGuildMembers } from '../services/guild-members'
import { createPoll } from '../services/polls'
import { createCommand } from '../services/application-commands'
import { gatewayBus } from '../gateway/bus'
import type { Database } from '../db'

const BASE_URL = 'http://localhost:3000'

describe('Test Control API', () => {
  let db: Database
  let app: Hono

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono()
    app.route('/', createTestRoutes(db, BASE_URL))
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('POST /_test/setup', () => {
    it('stores the bot fixture global name in the user profile', async () => {
      const res = await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'Bot display-name',
          user: { username: 'TestBot', global_name: 'Bot Display Name' },
        }),
      })
      expect(res.status).toBe(201)
      expect(getBotUser(db, 'Bot display-name')?.global_name).toBe(
        'Bot Display Name'
      )
    })

    it.each(['New Name', null, undefined])(
      'preserves or updates a pre-registered profile when setup global_name=%s',
      async (globalName) => {
        const user = createTestUser(db, {
          username: 'TestHuman',
          global_name: 'Original Name',
        })
        const res = await app.request('/_test/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: 'Bot reused-user',
            user: { id: user.id, global_name: globalName },
          }),
        })
        expect(res.status).toBe(201)
        expect(getUser(db, user.id)).toMatchObject({
          bot: true,
          global_name: globalName === undefined ? 'Original Name' : globalName,
        })
      }
    )

    it('sets up the test environment', async () => {
      const res = await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'Bot testtoken',
          user: { id: '111111111111111111', username: 'TestBot' },
          guilds: [
            {
              id: '222222222222222222',
              name: 'Test Guild',
              channels: [
                { id: '333333333333333333', name: 'general', type: 0 },
              ],
            },
          ],
        }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        token: string
        user: Record<string, unknown>
        guilds: { channels: Record<string, unknown>[] }[]
      }
      expect(body.token).toBe('Bot testtoken')
      expect(body.user.id).toBe('111111111111111111')
      expect(body.guilds[0].channels[0].id).toBe('333333333333333333')
    })

    it('auto-generates IDs when omitted', async () => {
      const res = await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'Bot autotoken',
          guilds: [
            {
              name: 'Auto Guild',
              channels: [{ name: 'auto-channel', type: 0 }],
            },
          ],
        }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        guilds: { id: unknown; channels: { id: unknown }[] }[]
      }
      expect(body.guilds[0].id).toBeTruthy()
      expect(body.guilds[0].channels[0].id).toBeTruthy()
    })

    it('registers the bot as a member of every created guild', async () => {
      // Real Discord API: a bot present in a guild always appears in that
      // guild's member list. Without a guild_members row, GET/PATCH/PUT/DELETE
      // /guilds/{id}/members/{bot_id}* all 404 for the bot itself, breaking
      // any client library that manages its own guild member (e.g. self
      // role assignment) — confirmed via a real Discord.Net compat run
      // (compat/dotnet-discordnet) where RestGuild.GetUserAsync(botId)
      // silently returned null because of exactly this gap.
      const res = await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'Bot membertoken',
          user: { id: '111111111111111111', username: 'TestBot' },
          guilds: [{ id: '222222222222222222', name: 'Test Guild' }],
        }),
      })
      expect(res.status).toBe(201)

      const memberRow = db
        .prepare(
          'SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?'
        )
        .get('222222222222222222', '111111111111111111')
      expect(memberRow).toBeTruthy()
    })

    it('returns 409 for a duplicate token', async () => {
      const setupBody = JSON.stringify({
        token: 'Bot duplicatetoken',
        guilds: [],
      })

      await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: setupBody,
      })

      const res = await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: setupBody,
      })
      expect(res.status).toBe(409)
    })

    it('forces bot=1 when the user id was already registered as a non-bot user', async () => {
      // POST /_test/users can create a non-bot user (bot=0) with an
      // explicit id ahead of time. If a later /_test/setup call reuses that
      // same id as the bot's own user.id, the row must end up bot=1 -- it
      // must not silently keep the stale bot=0 value (regression for #120).
      await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: '666666666666666666',
          username: 'Collider',
        }),
      })

      const res = await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'Bot collisiontoken',
          user: { id: '666666666666666666', username: 'CollisionBot' },
          guilds: [],
        }),
      })
      expect(res.status).toBe(201)

      const row = db
        .prepare('SELECT bot FROM users WHERE id = ?')
        .get('666666666666666666') as { bot: number }
      expect(row.bot).toBe(1)
    })
  })

  describe('POST /_test/users', () => {
    it.each(['Display Name', null, undefined])(
      'persists global_name=%s and serializes it in user and member views',
      async (globalName) => {
        const res = await app.request('/_test/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'TestHuman',
            global_name: globalName,
          }),
        })
        expect(res.status).toBe(201)
        const { id } = (await res.json()) as { id: string }
        const expected = globalName ?? null
        expect(
          db.prepare('SELECT global_name FROM users WHERE id = ?').get(id)
        ).toEqual({ global_name: expected })
        expect(getUser(db, id)?.global_name).toBe(expected)
        const token = seedBot(db)
        const guild = seedGuild(db, token)
        db.prepare(
          'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
        ).run(guild, id)
        expect(getGuildMember(db, guild, id)?.user.global_name).toBe(expected)
        expect(
          getGuildMembers(db, guild, 100).find((m) => m.user.id === id)?.user
            .global_name
        ).toBe(expected)
      }
    )

    it.each([42, true, {}, []])(
      'rejects invalid global_name=%s',
      async (globalName) => {
        for (const endpoint of ['/_test/users', '/_test/setup']) {
          const res = await app.request(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              endpoint === '/_test/users'
                ? { username: 'TestHuman', global_name: globalName }
                : {
                    token: 'Bot invalid-name',
                    user: { global_name: globalName },
                  }
            ),
          })
          expect(res.status).toBe(400)
          expect(await res.json()).toEqual({
            message: '400: Bad Request',
            code: 0,
          })
        }
        expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual(
          { count: 0 }
        )
      }
    )

    it('registers a non-bot user with an auto-generated ID', async () => {
      const res = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'TestHuman' }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        id: string
        username: string
        discriminator: string
      }
      expect(body.id).toBeTruthy()
      expect(body.username).toBe('TestHuman')
      expect(body.discriminator).toBe('0')

      const row = db
        .prepare('SELECT bot FROM users WHERE id = ?')
        .get(body.id) as { bot: number }
      expect(row.bot).toBe(0)
    })

    it('registers a non-bot user with an explicit ID', async () => {
      const res = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: '555555555555555555',
          username: 'TestHuman',
          discriminator: '1234',
        }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string; discriminator: string }
      expect(body.id).toBe('555555555555555555')
      expect(body.discriminator).toBe('1234')
    })

    it('returns 409 when the explicit ID already exists', async () => {
      const payload = JSON.stringify({
        id: '555555555555555555',
        username: 'TestHuman',
      })
      await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      const res = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      expect(res.status).toBe(409)
    })

    it('returns 400 when username is missing', async () => {
      const res = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /_test/reset', () => {
    it('resets all data', async () => {
      const res = await app.request('/_test/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(204)
    })
  })

  describe('GET /_test/messages/:channelId', () => {
    it('retrieves messages for a channel', async () => {
      const res = await app.request('/_test/messages/333333333333333333')
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toHaveProperty('messages')
      expect(Array.isArray(body.messages)).toBe(true)
    })
  })

  describe('GET /_test/webhooks/:channelId', () => {
    it('returns the documented webhook envelope', async () => {
      const token = seedBot(db)
      const guildId = seedGuild(db, token)
      const channelId = seedChannel(db, guildId)
      const { webhookId, webhookToken } = seedWebhook(
        db,
        channelId,
        guildId,
        'Control Webhook'
      )

      const res = await app.request(`/_test/webhooks/${channelId}`)

      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        webhooks?: { id: string; name: string; token: string }[]
      }
      expect(body.webhooks).toHaveLength(1)
      expect(body.webhooks?.[0]).toMatchObject({
        id: webhookId,
        name: 'Control Webhook',
        token: webhookToken,
      })
    })
  })

  describe('POST /_test/channels/:channelId/messages', () => {
    const channelId = '333333333333333333'

    beforeEach(async () => {
      await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'Bot msgtoken',
          user: { id: '111111111111111111', username: 'TestBot' },
          guilds: [
            {
              id: '222222222222222222',
              name: 'Test Guild',
              channels: [{ id: channelId, name: 'general', type: 0 }],
            },
          ],
        }),
      })
    })

    it('injects a message authored by a pre-registered non-bot user', async () => {
      const userRes = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'TestHuman' }),
      })
      const user = (await userRes.json()) as { id: string }

      const res = await app.request(`/_test/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello from a human!',
          author: { id: user.id },
        }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        content: string
        author: { id: string; bot: boolean }
      }
      expect(body.content).toBe('Hello from a human!')
      expect(body.author.id).toBe(user.id)
      expect(body.author.bot).toBe(false)

      const memberRow = db
        .prepare(
          'SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?'
        )
        .get('222222222222222222', user.id)
      expect(memberRow).toBeTruthy()
    })

    it('returns 404 for an unknown channel', async () => {
      const userRes = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'TestHuman' }),
      })
      const user = (await userRes.json()) as { id: string }

      const res = await app.request(
        '/_test/channels/999999999999999999/messages',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'Hello',
            author: { id: user.id },
          }),
        }
      )
      expect(res.status).toBe(404)
    })

    it('returns 404 for an unregistered author id', async () => {
      const res = await app.request(`/_test/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello',
          author: { id: '999999999999999999' },
        }),
      })
      expect(res.status).toBe(404)
    })

    it('returns 400 when content is missing', async () => {
      const userRes = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'TestHuman' }),
      })
      const user = (await userRes.json()) as { id: string }

      const res = await app.request(`/_test/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: { id: user.id } }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /_test/interactions', () => {
    it('creates a test interaction and returns 201', async () => {
      // Setup: register a bot/guild/command first via the existing test flow
      await app.request('/_test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'Bot interactiontoken',
          user: { id: '555555555555555555', username: 'IBot' },
          guilds: [
            {
              id: '666666666666666666',
              name: 'IGuild',
              channels: [{ id: '777777777777777777', name: 'general' }],
            },
          ],
        }),
      })
      const { createCommand } = await import('../services/application-commands')
      createCommand(db, '555555555555555555', '666666666666666666', {
        name: 'ping',
        description: 'x',
      })

      const res = await app.request('/_test/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: '555555555555555555',
          command_name: 'ping',
          guild_id: '666666666666666666',
          channel_id: '777777777777777777',
        }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        data: { name: string }
        locale: string
      }
      expect(body.data.name).toBe('ping')
      expect(body.locale).toBe('en-US')
    })

    it.each(['pl', 'en-GB', 'pt-BR', 'es-419', 'zh-CN'])(
      'serializes the requested locale %s for a global command',
      async (locale) => {
        seedBot(db)
        createCommand(db, '111111111111111111', null, {
          name: 'ping',
          description: 'x',
        })
        const res = await app.request('/_test/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            application_id: '111111111111111111',
            command_name: 'ping',
            locale,
          }),
        })
        expect(res.status).toBe(201)
        expect(await res.json()).toMatchObject({
          locale,
          data: { name: 'ping' },
        })
      }
    )

    it.each([
      '',
      ' ',
      'en',
      'en-us',
      'not-a-locale',
      'toString',
      null,
      42,
      {},
      [],
    ])(
      'rejects invalid locale %j without creating or dispatching an interaction',
      async (locale) => {
        seedBot(db)
        createCommand(db, '111111111111111111', null, {
          name: 'ping',
          description: 'x',
        })
        const spy = vi.fn()
        gatewayBus.on('interaction.create', spy)
        try {
          const res = await app.request('/_test/interactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              application_id: '111111111111111111',
              command_name: 'ping',
              locale,
            }),
          })
          expect(res.status).toBe(400)
          expect(await res.json()).toMatchObject({
            code: 50_035,
            errors: { locale: { _errors: expect.any(Array) } },
          })
          expect(
            db.prepare('SELECT COUNT(*) FROM interactions').pluck().get()
          ).toBe(0)
          expect(spy).not.toHaveBeenCalled()
        } finally {
          gatewayBus.off('interaction.create', spy)
        }
      }
    )

    it('returns 404 for an unregistered command name', async () => {
      const res = await app.request('/_test/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: '000000000000000000',
          command_name: 'does-not-exist',
          locale: 'pl',
        }),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /_test/polls/:messageId/votes', () => {
    it('injects a vote and returns 204', async () => {
      const bot = seedBot(db, 'Bot testtoken')
      const guild = seedGuild(db, bot)
      const channel = seedChannel(db, guild)
      const message = seedMessage(db, channel, '111111111111111111', bot)
      createPoll(db, message, { question: 'Q', answers: [{ text: 'A' }] })
      const user = createTestUser(db, { username: 'Mallory' })

      const res = await app.request(`/_test/polls/${message}/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer_id: 1, user_id: user.id }),
      })

      expect(res.status).toBe(204)
    })

    it('returns 404 for an unknown message', async () => {
      const res = await app.request('/_test/polls/999999999999999999/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer_id: 1, user_id: '111' }),
      })

      expect(res.status).toBe(404)
    })

    it('returns 400 when answer_id or user_id is missing', async () => {
      const res = await app.request('/_test/polls/999999999999999999/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
    })
  })
})
