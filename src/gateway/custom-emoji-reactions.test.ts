import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
  seedEmoji,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'

const TOKEN = 'Bot custom-emoji-reactions'
const BOT = '111111111111111111'
const HUMAN = '888888888888888888'
const SECOND = '999999999999999999'
const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
const PNG = 'data:image/png;base64,iVBORw0KGgo='

/** Connected client with an ordered, bounded reader and current sequence. */
interface Client {
  ws: WebSocket
  next: () => Promise<GatewayPayload<Record<string, unknown>>>
  seq: number
}

/** Buffers bursts and limits every read so a missing dispatch fails promptly. */
function reader(ws: WebSocket): Client['next'] {
  const frames: GatewayPayload<Record<string, unknown>>[] = []
  const waiters: ((frame: GatewayPayload<Record<string, unknown>>) => void)[] =
    []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as GatewayPayload<
      Record<string, unknown>
    >
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else frames.push(frame)
  })
  return () =>
    new Promise((resolve, reject) => {
      const frame = frames.shift()
      if (frame) {
        resolve(frame)
        return
      }
      const timer = setTimeout(() => {
        reject(new Error('Gateway frame timed out'))
      }, 2000)
      waiters.push((next) => {
        clearTimeout(timer)
        resolve(next)
      })
    })
}

describe('custom guild emoji reactions over real HTTP and WebSocket', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let channel: string
  let message: string
  let client: Client
  const sockets: WebSocket[] = []

  /** Calls controls without credentials, and native routes as the setup bot. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(!path.startsWith('/_test/') && { Authorization: TOKEN }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2000),
    })
  }

  /** Awaits a response and returns only its HTTP status. */
  async function statusOf(response: Promise<Response>): Promise<number> {
    const resolved = await response
    return resolved.status
  }

  /** Identifies with reaction, message and expression intents (no Guilds). */
  async function connect(): Promise<Client> {
    const ws = new WebSocket(server.url)
    sockets.push(ws)
    const next = reader(ws)
    const hello = await next()
    expect(hello.op).toBe(10)
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: TOKEN,
          intents:
            GatewayIntentBits.GuildMessageReactions |
            GatewayIntentBits.GuildExpressions,
        },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    return { ws, next, seq: Number(ready.s) }
  }

  /** Ordered heartbeat ACK proves no unconsumed event was dispatched. */
  async function fence(): Promise<void> {
    client.ws.send(JSON.stringify({ op: 1, d: client.seq }))
    const ack = await client.next()
    expect(ack.op).toBe(11)
  }

  /** Reads the next dispatch, asserting its name and sequence. */
  async function dispatch(name: string): Promise<Record<string, unknown>> {
    const frame = await client.next()
    expect(frame).toMatchObject({ op: 0, t: name, s: ++client.seq })
    return frame.d
  }

  /** Creates an emoji through native REST, the silent seed path. */
  async function createEmoji(name: string, image = PNG): Promise<string> {
    const response = await request(`/guilds/${guild}/emojis`, 'POST', {
      name,
      image,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  /** Adds a human reaction through the test-control producer. */
  async function react(user: string, emoji: string): Promise<Response> {
    return request(
      `/_test/channels/${channel}/messages/${message}/reactions`,
      'POST',
      { user_id: user, emoji }
    )
  }

  /** Builds a native reaction route with a URL-encoded emoji segment. */
  function reactionPath(emoji: string, suffix = ''): string {
    return `/api/v10/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(emoji)}${suffix}`
  }

  /** Reads the message's aggregated reactions through native REST. */
  async function messageReactions(): Promise<unknown> {
    const response = await request(
      `/api/v10/channels/${channel}/messages/${message}`
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { reactions?: unknown }).reactions
  }

  /** Lists reaction user IDs for an emoji path segment. */
  async function reactionUsers(emoji: string): Promise<string[]> {
    const response = await request(reactionPath(emoji))
    expect(response.status).toBe(200)
    return ((await response.json()) as { id: string }[]).map((u) => u.id)
  }

  /** Reads persisted reaction rows. */
  function rows(): unknown[] {
    return server.db
      .prepare('SELECT user_id, emoji FROM reactions ORDER BY id')
      .all()
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    channel = seedChannel(server.db, guild)
    message = seedMessage(server.db, channel, BOT, TOKEN)
    for (const id of [HUMAN, SECOND]) {
      expect(
        await statusOf(
          request('/_test/users', 'POST', { id, username: `h${id}` })
        )
      ).toBe(201)
      expect(
        await statusOf(
          request(`/_test/guilds/${guild}/members/${id}`, 'POST', {})
        )
      ).toBe(201)
    }
    client = await connect()
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    await server.close()
  })

  it('keeps custom identity across add, rename, list, remove and clear', async () => {
    const id = await createEmoji('party')
    await fence() // Emoji creation is a silent seed.

    expect(await statusOf(react(HUMAN, `party:${id}`))).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_ADD')).toMatchObject({
      user_id: HUMAN,
      guild_id: guild,
      channel_id: channel,
      message_id: message,
      emoji: { id, name: 'party', animated: false },
      member: { user: { id: HUMAN } },
      message_author_id: BOT,
      burst: false,
      type: 0,
    })
    expect(rows()).toEqual([{ user_id: HUMAN, emoji: `custom:${id}` }])
    expect(await messageReactions()).toEqual([
      {
        count: 1,
        count_details: { burst: 0, normal: 1 },
        me: false,
        me_burst: false,
        emoji: { id, name: 'party', animated: false },
        burst_colors: [],
      },
    ])

    const renamed = await request(`/guilds/${guild}/emojis/${id}`, 'PATCH', {
      name: 'fiesta',
    })
    expect(renamed.status).toBe(200)
    expect(await dispatch('GUILD_EMOJIS_UPDATE')).toEqual({
      guild_id: guild,
      emojis: [
        expect.objectContaining({ id, name: 'fiesta', animated: false }),
      ],
    })
    for (const body of [{}, { name: 'fiesta' }, { roles: [] }]) {
      const unchanged = await request(
        `/guilds/${guild}/emojis/${id}`,
        'PATCH',
        body
      )
      expect(unchanged.status).toBe(200)
    }
    await fence() // No-op modifications dispatch nothing.

    // The renamed emoji may arrive under either name; identity is the ID.
    expect(await statusOf(react(SECOND, `fiesta:${id}`))).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_ADD')).toMatchObject({
      user_id: SECOND,
      emoji: { id, name: 'fiesta', animated: false },
    })
    expect(await statusOf(react(HUMAN, `fiesta:${id}`))).toBe(204) // Duplicate.
    await fence()
    expect(await reactionUsers(`party:${id}`)).toEqual([HUMAN, SECOND])
    expect(await reactionUsers(`fiesta:${id}`)).toEqual([HUMAN, SECOND])
    expect(await messageReactions()).toMatchObject([
      { count: 2, emoji: { id, name: 'fiesta', animated: false } },
    ])

    const removed = await request(
      reactionPath(`party:${id}`, `/${SECOND}`),
      'DELETE'
    )
    expect(removed.status).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_REMOVE')).toEqual({
      user_id: SECOND,
      channel_id: channel,
      message_id: message,
      guild_id: guild,
      emoji: { id, name: 'fiesta', animated: false },
      burst: false,
      type: 0,
    })

    expect(
      await statusOf(request(reactionPath(`fiesta:${id}`), 'DELETE'))
    ).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_REMOVE_EMOJI')).toEqual({
      channel_id: channel,
      message_id: message,
      guild_id: guild,
      emoji: { id, name: 'fiesta', animated: false },
    })
    expect(rows()).toEqual([])
    expect(await messageReactions()).toBeUndefined()
    await fence()
  })

  it('adds and removes the bot reaction with a custom emoji through @me', async () => {
    const id = await createEmoji('party')
    expect(
      await statusOf(request(reactionPath(`party:${id}`, '/@me'), 'PUT'))
    ).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_ADD')).toMatchObject({
      user_id: BOT,
      emoji: { id, name: 'party', animated: false },
    })
    expect(rows()).toEqual([{ user_id: BOT, emoji: `custom:${id}` }])
    expect(
      await statusOf(request(reactionPath(`other:${id}`, '/@me'), 'DELETE'))
    ).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_REMOVE')).toMatchObject({
      user_id: BOT,
      emoji: { id, name: 'party', animated: false },
    })
    expect(rows()).toEqual([])
    await fence()
  })

  it('reports animated emoji from GIF uploads in both name:id and a:name:id forms', async () => {
    const id = await createEmoji('dance', GIF)
    const emoji = await request(`/guilds/${guild}/emojis/${id}`)
    expect(await emoji.json()).toMatchObject({ id, animated: true })
    for (const [image, animated] of [
      ['data:IMAGE/GIF;base64,R0lGODlhAQABAAAAACw=', true],
      ['data:image/giffoo;base64,AAAA', false],
      ['data:image/png;base64,iVBORw0KGgo=', false],
    ] as const) {
      const created = await request(`/guilds/${guild}/emojis`, 'POST', {
        name: 'probe',
        image,
      })
      expect(await created.json()).toMatchObject({ animated })
    }

    expect(await statusOf(react(HUMAN, `a:dance:${id}`))).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_ADD')).toMatchObject({
      emoji: { id, name: 'dance', animated: true },
    })
    expect(await statusOf(react(SECOND, `dance:${id}`))).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_ADD')).toMatchObject({
      emoji: { id, name: 'dance', animated: true },
    })
    expect(await reactionUsers(`a:dance:${id}`)).toEqual([HUMAN, SECOND])
    expect(await messageReactions()).toMatchObject([
      { count: 2, emoji: { id, name: 'dance', animated: true } },
    ])
    await fence()
  })

  it('rejects unknown and foreign custom emoji with 400 Unknown Emoji and no state', async () => {
    const otherGuild = seedGuild(server.db, TOKEN, '222222222222222223')
    const foreign = seedEmoji(server.db, otherGuild, null, 'foreign')
    for (const emoji of ['ghost:123456789012345678', `foreign:${foreign}`]) {
      const response = await react(HUMAN, emoji)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: 'Unknown Emoji',
        code: 10_014,
      })
    }
    const put = await request(
      reactionPath('ghost:123456789012345678', '/@me'),
      'PUT'
    )
    expect(put.status).toBe(400)
    expect(await put.json()).toEqual({ message: 'Unknown Emoji', code: 10_014 })
    expect(rows()).toEqual([])
    await fence()
  })

  it('lets the bot react with emoji from any guild of its setup', async () => {
    const otherGuild = seedGuild(server.db, TOKEN, '222222222222222223')
    const sibling = seedEmoji(server.db, otherGuild, null, 'sibling')
    expect(
      await statusOf(request(reactionPath(`sibling:${sibling}`, '/@me'), 'PUT'))
    ).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_ADD')).toMatchObject({
      emoji: { id: sibling, name: 'sibling', animated: false },
    })
  })

  it('removes reactions of a deleted emoji using the path name as fallback', async () => {
    const id = await createEmoji('party')
    expect(await statusOf(react(HUMAN, `party:${id}`))).toBe(204)
    await dispatch('MESSAGE_REACTION_ADD')
    expect(
      await statusOf(request(`/guilds/${guild}/emojis/${id}`, 'DELETE'))
    ).toBe(204)
    expect(await messageReactions()).toMatchObject([
      { count: 1, emoji: { id, name: null, animated: false } },
    ])
    expect(
      await statusOf(
        request(reactionPath(`party:${id}`, `/${HUMAN}`), 'DELETE')
      )
    ).toBe(204)
    expect(await dispatch('MESSAGE_REACTION_REMOVE')).toMatchObject({
      emoji: { id, name: 'party', animated: false },
    })
    expect(rows()).toEqual([])
  })

  it('keeps Unicode reaction payloads unchanged', async () => {
    expect(await statusOf(react(HUMAN, '👍🏽'))).toBe(204)
    const added = await dispatch('MESSAGE_REACTION_ADD')
    expect(added.emoji).toStrictEqual({ id: null, name: '👍🏽' })
    expect(await messageReactions()).toMatchObject([
      { emoji: { id: null, name: '👍🏽' } },
    ])
    expect(rows()).toEqual([{ user_id: HUMAN, emoji: '👍🏽' }])

    // A non-numeric `custom:` string stays an exact Unicode-style key.
    expect(
      await statusOf(request(reactionPath('custom:foo', '/@me'), 'PUT'))
    ).toBe(204)
    const raw = await dispatch('MESSAGE_REACTION_ADD')
    expect(raw.emoji).toStrictEqual({ id: null, name: 'custom:foo' })
    expect(await messageReactions()).toMatchObject([
      { emoji: { id: null, name: 'custom:foo' } },
      { emoji: { id: null, name: '👍🏽' } },
    ])
  })
})
