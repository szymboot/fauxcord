import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFullTestApp } from '../test-helpers'
import { gatewayBus } from '../gateway/bus'
import type { ClosedDm } from '../services/closed-dms'
import { addChannelRecipient, createGroupDmChannel } from '../services/channels'
import { createTestUser, setupTestEnvironment } from '../services/test-control'

const token = 'Bot closed-dms'
const otherToken = 'Bot other-dms'
const botId = '111111111111111111'
const guildId = '222222222222222222'
const channelId = '333333333333333333'
const userId = '444444444444444444'
const otherUserId = '555555555555555555'
const otherGuildId = '666666666666666666'

describe('Closed DM fixtures', () => {
  let context: ReturnType<typeof createFullTestApp>

  beforeEach(() => {
    context = createFullTestApp()
    setupTestEnvironment(context.db, {
      token,
      user: { id: botId, username: 'Bot' },
      guilds: [
        {
          id: guildId,
          name: 'Guild',
          channels: [{ id: channelId, name: 'general' }],
        },
      ],
    })
    setupTestEnvironment(context.db, {
      token: otherToken,
      user: { id: '777777777777777777', username: 'OtherBot' },
      guilds: [{ id: otherGuildId, name: 'Other Guild' }],
    })
    createTestUser(context.db, { id: userId, username: 'Human' })
    createTestUser(context.db, { id: otherUserId, username: 'OtherHuman' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    context.cleanup()
  })

  /** Creates a persistent restriction owned by the guild's setup bot. */
  function closeDms(scope = guildId, recipient = userId) {
    return context.app.request('/_test/closed-dms', {
      method: 'POST',
      body: JSON.stringify({ guild_id: scope, user_id: recipient }),
    })
  }

  /** Reads an HTTP status after the request has completed. */
  async function status(
    request: Response | Promise<Response>
  ): Promise<number> {
    const response = await request
    return response.status
  }

  /** Creates a restriction and reads its typed inspection response. */
  async function createFixture(scope = guildId): Promise<ClosedDm> {
    const response = await closeDms(scope)
    expect(response.status).toBe(201)
    return (await response.json()) as ClosedDm
  }

  /** Creates or reuses a DM using the native authenticated REST API. */
  async function createDm(recipient = userId, botToken = token) {
    const response = await context.app.request('/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: botToken },
      body: JSON.stringify({ recipient_id: recipient }),
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { id: string }).id
  }

  /** Sends an embed through the native message endpoint. */
  function send(channel: string, botToken = token, prefix = '/api/v10') {
    return context.app.request(`${prefix}/channels/${channel}/messages`, {
      method: 'POST',
      headers: { Authorization: botToken },
      body: JSON.stringify({ embeds: [{ description: 'Private result' }] }),
    })
  }

  it('keeps DM creation successful but rejects sends without persistence or dispatch', async () => {
    const created = await closeDms()
    expect(created.status).toBe(201)
    const fixture = (await created.json()) as ClosedDm
    expect(fixture).toEqual({
      id: expect.any(String),
      guild_id: guildId,
      bot_id: botId,
      user_id: userId,
    })
    const duplicate = await closeDms()
    expect(await duplicate.json()).toEqual(fixture)
    const inspected = await context.app.request(
      `/_test/closed-dms/${fixture.id}`
    )
    expect(inspected.status).toBe(200)
    expect(inspected.headers.get('Cache-Control')).toBe('no-store')
    expect(await inspected.json()).toEqual(fixture)

    const dm = await createDm()
    expect(await createDm()).toBe(dm)
    const dispatch = vi.spyOn(gatewayBus, 'emit')
    for (const prefix of ['/api/v10', '/api', '']) {
      const response = await send(dm, token, prefix)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        message: 'Cannot send messages to this user',
        code: 50_007,
      })
    }
    expect(context.db.prepare('SELECT * FROM messages').all()).toEqual([])
    expect(context.db.prepare('SELECT * FROM embeds').all()).toEqual([])
    expect(
      context.db
        .prepare('SELECT last_message_id FROM channels WHERE id = ?')
        .get(dm)
    ).toEqual({ last_message_id: null })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('leaves other users, other bots and guild channels unaffected', async () => {
    const dm = await createDm()
    await closeDms()
    expect(await status(send(dm))).toBe(403)
    expect(await status(send(await createDm(otherUserId)))).toBe(200)
    expect(
      await status(send(await createDm(userId, otherToken), otherToken))
    ).toBe(200)
    expect(await status(send(channelId))).toBe(200)
    const groupDm = createGroupDmChannel(context.db, botId)
    addChannelRecipient(context.db, groupDm.id, userId)
    expect(await status(send(groupDm.id))).toBe(200)
  })

  it('isolates setup tokens even when they share a bot user ID', async () => {
    const dm = await createDm()
    await closeDms()
    setupTestEnvironment(context.db, {
      token: 'Bot shared-id',
      user: { id: botId, username: 'Bot' },
      guilds: [],
    })
    expect(await status(send(dm, 'Bot shared-id'))).toBe(200)
    expect(await status(send(dm))).toBe(403)
  })

  it('blocks multipart sends without storing attachments', async () => {
    await closeDms()
    const dm = await createDm()
    const body = new FormData()
    body.set('payload_json', JSON.stringify({ content: 'Private file' }))
    body.set(
      'files[0]',
      new File(['private'], 'result.txt', { type: 'text/plain' })
    )
    const dispatch = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(
      `/api/v10/channels/${dm}/messages`,
      {
        method: 'POST',
        headers: { Authorization: token },
        body,
      }
    )
    expect(response.status).toBe(403)
    for (const table of ['messages', 'attachments', 'attachment_files'])
      expect(context.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('restores delivery when removed', async () => {
    const fixture = await createFixture()
    const dm = await createDm()
    expect(await status(send(dm))).toBe(403)
    expect(
      await status(
        context.app.request(`/_test/closed-dms/${fixture.id}`, {
          method: 'DELETE',
        })
      )
    ).toBe(204)
    expect(
      await status(context.app.request(`/_test/closed-dms/${fixture.id}`))
    ).toBe(404)
    expect(
      await status(
        context.app.request(`/_test/closed-dms/${fixture.id}`, {
          method: 'DELETE',
        })
      )
    ).toBe(404)
    const dispatch = vi.spyOn(gatewayBus, 'emit')
    expect(await status(send(dm))).toBe(200)
    expect(dispatch).toHaveBeenCalledWith(
      'message.create',
      expect.objectContaining({ channelId: dm })
    )
    expect(
      context.db.prepare('SELECT * FROM messages WHERE channel_id = ?').all(dm)
    ).toHaveLength(1)
  })

  it.each(['reset-token', 'reset-all', 'delete-setup', 'delete-guild'])(
    'cleans restrictions with %s',
    async (cleanup) => {
      const fixture = await createFixture()
      const otherFixture = await createFixture(otherGuildId)
      const dm = await createDm()
      const response = cleanup.startsWith('reset')
        ? await context.app.request('/_test/reset', {
            method: 'POST',
            body: JSON.stringify(cleanup === 'reset-token' ? { token } : {}),
          })
        : cleanup === 'delete-setup'
          ? await context.app.request(
              `/_test/setup/${encodeURIComponent(token)}`,
              { method: 'DELETE' }
            )
          : await context.app.request(`/api/v10/guilds/${guildId}`, {
              method: 'DELETE',
              headers: { Authorization: token },
            })
      expect(response.status).toBe(204)
      expect(
        await status(context.app.request(`/_test/closed-dms/${fixture.id}`))
      ).toBe(404)
      expect(
        await status(
          context.app.request(`/_test/closed-dms/${otherFixture.id}`)
        )
      ).toBe(cleanup === 'reset-all' ? 404 : 200)
      if (cleanup === 'delete-setup') {
        setupTestEnvironment(context.db, {
          token,
          user: { id: botId, username: 'Bot' },
          guilds: [{ id: guildId, name: 'Guild' }],
        })
      }
      expect(await status(send(dm))).toBe(200)
    }
  )

  it('removes restrictions when the cleanup guild changes setup ownership', async () => {
    const fixture = await createFixture()
    const dm = await createDm()
    setupTestEnvironment(context.db, {
      token: 'Bot reassigned-dms',
      user: { id: '777777777777777777', username: 'OtherBot' },
      guilds: [{ id: guildId, name: 'Reassigned' }],
    })
    expect(
      await status(context.app.request(`/_test/closed-dms/${fixture.id}`))
    ).toBe(404)
    expect(await status(send(dm))).toBe(200)
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { guild_id: guildId },
    { guild_id: 123, user_id: userId },
    { guild_id: '0', user_id: userId },
    { guild_id: guildId, user_id: 'bad' },
    { guild_id: guildId, user_id: '0444444444444444444' },
    { guild_id: guildId, user_id: '444444444444444444444' },
    { guild_id: guildId, user_id: userId, all_bots: true },
  ])('rejects malformed fixture %j atomically', async (body) => {
    const response = await context.app.request('/_test/closed-dms', {
      method: 'POST',
      body: body === undefined ? '{' : JSON.stringify(body),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      message: 'Invalid Form Body',
      code: 50_035,
      errors: expect.any(Object),
    })
    expect(await status(send(await createDm()))).toBe(200)
  })

  it('rejects unknown guilds, unknown users and bot recipients', async () => {
    expect(await status(closeDms('999999999999999999'))).toBe(404)
    const unknown = await closeDms(guildId, '999999999999999999')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 10_013 })
    const bot = await closeDms(guildId, botId)
    expect(bot.status).toBe(400)
    expect(await bot.json()).toMatchObject({ code: 50_035 })
  })

  it('retains native authentication and unknown channel errors', async () => {
    await closeDms()
    expect(await status(send(await createDm(), 'Bot invalid'))).toBe(401)
    expect(await status(send('999999999999999999'))).toBe(404)
  })
})
