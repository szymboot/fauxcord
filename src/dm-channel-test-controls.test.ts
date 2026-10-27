import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatewayBus } from './gateway/bus'
import { createGroupDmChannel } from './services/channels'
import { createTestUser, setupTestEnvironment } from './services/test-control'
import {
  createRealServer,
  seedBot,
  seedGuild,
  type RealServerContext,
} from './test-helpers'
import type { RestFault } from './services/rest-faults'

const token = 'Bot dm-owner'
const otherToken = 'Bot dm-other'
const sharedIdToken = 'Bot dm-shared-id'
const botId = '100000000000000001'
const otherBotId = '100000000000000002'
const guild = '222222222222222222'
const otherGuild = '222222222222222223'
const human = '444444444444444444'
const otherHuman = '555555555555555555'

/** Channel fields asserted by the DM control tests. */
interface DmChannel {
  id: string
  type: number
  guild_id: string | null
  last_message_id: string | null
  recipients: { id: string; bot: boolean }[]
}

describe('bot-scoped DM channel test controls', () => {
  let server: RealServerContext

  /** Sends real HTTP requests; controls are auth-exempt, REST calls pass auth. */
  function request(
    route: string,
    method = 'GET',
    body?: unknown,
    auth?: string
  ): Promise<Response> {
    return fetch(server.baseUrl + route, {
      method,
      headers: {
        ...(auth && { Authorization: auth }),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  }

  /** Returns the HTTP status after a request completes. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Looks up the bot↔human DM through the side-effect-free control. */
  function lookup(guildId = guild, userId = human): Promise<Response> {
    return request(`/_test/dm-channels?guild_id=${guildId}&user_id=${userId}`)
  }

  /** Opens the DM as the human through the control. */
  function open(guildId = guild, userId = human): Promise<Response> {
    return request('/_test/dm-channels', 'POST', {
      guild_id: guildId,
      user_id: userId,
    })
  }

  /** Looks up an existing DM and returns its typed channel object. */
  async function lookupChannel(...args: Parameters<typeof lookup>) {
    const response = await lookup(...args)
    expect(response.status).toBe(200)
    return (await response.json()) as DmChannel
  }

  /** Opens a DM as the human and returns its typed channel object. */
  async function openChannel(...args: Parameters<typeof open>) {
    const response = await open(...args)
    expect([200, 201]).toContain(response.status)
    return (await response.json()) as DmChannel
  }

  /** Returns only the lookup control's HTTP status. */
  async function lookupStatus(...args: Parameters<typeof lookup>) {
    const response = await lookup(...args)
    return response.status
  }

  /** Returns the looked-up channel's ID. */
  async function lookupId(...args: Parameters<typeof lookup>) {
    const channel = await lookupChannel(...args)
    return channel.id
  }

  /** Returns the ID of the DM opened as the human. */
  async function openId(...args: Parameters<typeof open>) {
    const channel = await openChannel(...args)
    return channel.id
  }

  /** Returns the looked-up channel's last message ID. */
  async function lastMessageId() {
    const channel = await lookupChannel()
    return channel.last_message_id
  }

  /** Lists recipient IDs in a stable order. */
  function recipientIds(channel: DmChannel): string[] {
    return channel.recipients
      .map((recipient) => recipient.id)
      .toSorted((a, b) => a.localeCompare(b))
  }

  /** Creates or reuses the DM through the bot's native REST endpoint. */
  async function botCreateDm(recipient = human, auth = token): Promise<string> {
    const response = await request(
      '/api/v10/users/@me/channels',
      'POST',
      { recipient_id: recipient },
      auth
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { id: string }).id
  }

  /** Injects a human-authored message through the test control. */
  function inject(channel: string, author = human, content = 'hello bot') {
    return request(`/_test/channels/${channel}/messages`, 'POST', {
      content,
      author: { id: author },
    })
  }

  /** Counts persisted private channels to detect side effects. */
  function privateChannelCount(): number {
    const row = server.db
      .prepare('SELECT COUNT(*) AS count FROM channels WHERE guild_id IS NULL')
      .get() as { count: number }
    return row.count
  }

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token, botId)
    seedBot(server.db, otherToken, otherBotId)
    seedGuild(server.db, token, guild)
    seedGuild(server.db, otherToken, otherGuild)
    createTestUser(server.db, { id: human, username: 'Human' })
    createTestUser(server.db, { id: otherHuman, username: 'OtherHuman' })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await server.close()
  })

  it('answers 404 Unknown Channel before the bot opens a DM, without side effects', async () => {
    const dispatch = vi.spyOn(gatewayBus, 'emit')
    const response = await lookup()
    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      message: 'Unknown Channel',
      code: 10_003,
    })
    expect(privateChannelCount()).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('returns the channel the bot created, in the real creation shape', async () => {
    const dm = await botCreateDm()
    const response = await lookup()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const channel = (await response.json()) as DmChannel
    const native = await request(
      '/api/v10/users/@me/channels',
      'POST',
      { recipient_id: human },
      token
    )
    expect(channel).toEqual(await native.json())
    expect(channel).toMatchObject({ id: dm, type: 1, guild_id: null })
    expect(recipientIds(channel)).toEqual([botId, human])
    expect(privateChannelCount()).toBe(1)
  })

  it('opens idempotently as the human and shares storage with the bot path', async () => {
    const dispatch = vi.spyOn(gatewayBus, 'emit')
    const created = await open()
    expect(created.status).toBe(201)
    const channel = (await created.json()) as DmChannel
    expect(channel).toMatchObject({ type: 1, guild_id: null })
    expect(recipientIds(channel)).toEqual([botId, human])
    const again = await open()
    expect(again.status).toBe(200)
    expect(((await again.json()) as DmChannel).id).toBe(channel.id)
    expect(await botCreateDm()).toBe(channel.id)
    const found = await lookup()
    expect(((await found.json()) as DmChannel).id).toBe(channel.id)
    expect(privateChannelCount()).toBe(1)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reuses a DM the bot already opened when the human opens it', async () => {
    const dm = await botCreateDm()
    const response = await open()
    expect(response.status).toBe(200)
    expect(((await response.json()) as DmChannel).id).toBe(dm)
    expect(privateChannelCount()).toBe(1)
  })

  it('neither consumes nor is blocked by POST /users/@me/channels REST faults', async () => {
    const armed = await request('/_test/rest-faults', 'POST', {
      method: 'POST',
      path: '/users/@me/channels',
      guild_id: guild,
      status: 403,
      code: 50_007,
      message: 'Cannot send messages to this user',
      times: 1,
    })
    expect(armed.status).toBe(201)
    const fault = (await armed.json()) as RestFault

    expect(
      await status(`/_test/dm-channels?guild_id=${guild}&user_id=${human}`)
    ).toBe(404)
    const created = await open()
    expect(created.status).toBe(201)
    const channel = (await created.json()) as DmChannel
    expect(await lookupStatus()).toBe(200)
    const inspected = await request(`/_test/rest-faults/${fault.id}`)
    expect(await inspected.json()).toMatchObject({ remaining: 1, consumed: 0 })

    // The armed fault still fires for the bot's real call, then the same DM returns.
    expect(
      await status(
        '/api/v10/users/@me/channels',
        'POST',
        { recipient_id: human },
        token
      )
    ).toBe(403)
    expect(await botCreateDm()).toBe(channel.id)
    const consumed = await request(`/_test/rest-faults/${fault.id}`)
    expect(await consumed.json()).toMatchObject({ remaining: 0, consumed: 1 })
  })

  it('isolates bots: each guild resolves its own bot and humans', async () => {
    const dm = await botCreateDm()
    expect(await lookupStatus(otherGuild)).toBe(404)
    const otherDm = await openChannel(otherGuild)
    expect(otherDm.id).not.toBe(dm)
    expect(recipientIds(otherDm)).toEqual([otherBotId, human])
    expect(await lookupId()).toBe(dm)
    expect(await lookupId(otherGuild)).toBe(otherDm.id)
    expect(await lookupStatus(guild, otherHuman)).toBe(404)
    expect(await botCreateDm(human, otherToken)).toBe(otherDm.id)
  })

  it('resolves the exact owning setup token when setups share a bot user ID', async () => {
    setupTestEnvironment(server.db, {
      token: sharedIdToken,
      user: { id: botId, username: 'Bot' },
      guilds: [{ id: '222222222222222224', name: 'Shared' }],
    })
    // DM storage is keyed by bot user ID, exactly like the real creation path.
    const dm = await openId('222222222222222224')
    expect(await botCreateDm(human, token)).toBe(dm)
    expect(await botCreateDm(human, sharedIdToken)).toBe(dm)
    expect(await lookupId()).toBe(dm)
    // A different bot user never sees it.
    expect(await lookupStatus(otherGuild)).toBe(404)
  })

  it.each([
    ['guild_id', { user_id: human }],
    ['user_id', { guild_id: guild }],
    ['guild_id', { guild_id: '0', user_id: human }],
    ['guild_id', { guild_id: 'bad', user_id: human }],
    ['user_id', { guild_id: guild, user_id: '0444444444444444444' }],
    ['user_id', { guild_id: guild, user_id: '444444444444444444444' }],
    ['body', { guild_id: guild, user_id: human, all_bots: true }],
  ])(
    'rejects malformed input on %s with Invalid Form Body',
    async (field, body) => {
      const before = privateChannelCount()
      const post = await request('/_test/dm-channels', 'POST', body)
      expect(post.status).toBe(400)
      expect(await post.json()).toMatchObject({
        message: 'Invalid Form Body',
        code: 50_035,
        errors: { [field]: expect.any(Object) },
      })
      const query = new URLSearchParams(
        Object.entries(body).map(([key, value]) => [key, String(value)])
      )
      const get = await request(`/_test/dm-channels?${query.toString()}`)
      expect(get.status).toBe(400)
      expect(get.headers.get('Cache-Control')).toBe('no-store')
      expect(await get.json()).toMatchObject({ code: 50_035 })
      expect(privateChannelCount()).toBe(before)
    }
  )

  it('rejects malformed JSON, non-object bodies, numeric IDs and repeated query parameters', async () => {
    expect(
      await status('/_test/dm-channels', 'POST', {
        guild_id: guild,
        user_id: 444_444_444,
      })
    ).toBe(400)
    for (const body of ['{', 'null', '[]']) {
      const response = await fetch(`${server.baseUrl}/_test/dm-channels`, {
        method: 'POST',
        body,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 50_035 })
    }
    expect(
      await status(
        `/_test/dm-channels?guild_id=${guild}&guild_id=${otherGuild}&user_id=${human}`
      )
    ).toBe(400)
    expect(await status('/_test/dm-channels')).toBe(400)
    expect(privateChannelCount()).toBe(0)
  })

  it('rejects unknown guilds, unknown users and bot recipients on both controls', async () => {
    for (const run of [
      (g: string, u: string) => lookup(g, u),
      (g: string, u: string) => open(g, u),
    ]) {
      const unknownGuild = await run('999999999999999999', human)
      expect(unknownGuild.status).toBe(404)
      expect(await unknownGuild.json()).toMatchObject({ code: 10_004 })
      const unknownUser = await run(guild, '999999999999999999')
      expect(unknownUser.status).toBe(404)
      expect(await unknownUser.json()).toMatchObject({ code: 10_013 })
      for (const bot of [botId, otherBotId]) {
        const rejected = await run(guild, bot)
        expect(rejected.status).toBe(400)
        expect(await rejected.json()).toMatchObject({
          code: 50_035,
          errors: { user_id: expect.any(Object) },
        })
      }
    }
    expect(privateChannelCount()).toBe(0)
  })

  it('lets the human send the bot a DM through the ordinary message path', async () => {
    const dm = await openId()
    const dispatch = vi.spyOn(gatewayBus, 'emit')
    const response = await inject(dm)
    expect(response.status).toBe(201)
    const message = (await response.json()) as {
      id: string
      channel_id: string
      content: string
      author: { id: string; bot?: boolean }
    }
    expect(message).toMatchObject({
      channel_id: dm,
      content: 'hello bot',
      author: { id: human, bot: false },
    })
    expect(dispatch).toHaveBeenCalledWith(
      'message.create',
      expect.objectContaining({
        channelId: dm,
        message: expect.objectContaining({ id: message.id }),
      })
    )
    expect(await lastMessageId()).toBe(message.id)
    const history = await request(
      `/api/v10/channels/${dm}/messages`,
      'GET',
      undefined,
      token
    )
    expect(
      ((await history.json()) as { id: string }[]).map((m) => m.id)
    ).toEqual([message.id])
  })

  it('stores the bot reply in the opened DM', async () => {
    const dm = await openId()
    const sent = await request(
      `/api/v10/channels/${dm}/messages`,
      'POST',
      { content: 'pong' },
      token
    )
    expect(sent.status).toBe(200)
    const history = await request(`/_test/messages/${dm}`)
    const { messages } = (await history.json()) as {
      messages: { content: string; author_token: string }[]
    }
    expect(messages).toMatchObject([{ content: 'pong', author_token: token }])
    expect(await lastMessageId()).not.toBeNull()
  })

  it('rejects injection by non-recipients without storing or dispatching', async () => {
    const dm = await openId()
    const group = createGroupDmChannel(server.db, botId).id
    const dispatch = vi.spyOn(gatewayBus, 'emit')
    for (const [channel, author] of [
      [dm, otherHuman],
      [dm, otherBotId],
      [group, human],
    ]) {
      const response = await inject(channel, author)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        message: 'Missing Access',
        code: 50_001,
      })
    }
    const attachment = await request(`/_test/channels/${dm}/messages`, 'POST', {
      author: { id: otherHuman },
      attachments: [
        { filename: 'a.txt', content_type: 'text/plain', data: 'aGVsbG8=' },
      ],
    })
    expect(attachment.status).toBe(403)
    for (const table of ['messages', 'attachments', 'attachment_files'])
      expect(server.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps unknown channel and author handling for injection', async () => {
    const dm = await openId()
    expect(
      await status('/_test/channels/999999999999999999/messages', 'POST', {
        content: 'x',
        author: { id: human },
      })
    ).toBe(404)
    const unknownAuthor = await inject(dm, '999999999999999999')
    expect(unknownAuthor.status).toBe(404)
  })
})
