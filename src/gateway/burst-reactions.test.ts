import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
} from '../test-helpers'
import { getGuildMember } from '../services/guild-members'
import type { GatewayPayload } from './protocol'

const TOKEN = 'Bot burst-gateway'
const BOT = '111111111111111111'
const HUMAN = '888888888888888888'
const OTHER_TOKEN = 'Bot burst-other'
const OTHER_BOT = '444444444444444444'
const COLORS = ['#ffcc4d', '#f4900c']

/** Connected client with an ordered, bounded reader and current sequence. */
interface Client {
  ws: WebSocket
  next: () => Promise<GatewayPayload<Record<string, unknown>>>
  seq: number
}

/** Buffers frames and limits every read so a missing dispatch fails promptly. */
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

/**
 * Awaits a response and returns its status code.
 * @param response - Pending HTTP response
 * @returns HTTP status code
 */
async function statusOf(response: Promise<Response>): Promise<number> {
  const result = await response
  return result.status
}

describe('burst reactions over real HTTP and WebSocket connections', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let channel: string
  let message: string
  let client: Client
  let other: Client
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

  /** Establishes one identified session with the reaction intent. */
  async function connect(token: string): Promise<Client> {
    const ws = new WebSocket(server.url)
    sockets.push(ws)
    const next = reader(ws)
    const hello = await next()
    expect(hello.op).toBe(10)
    ws.send(
      JSON.stringify({
        op: 2,
        d: { token, intents: GatewayIntentBits.GuildMessageReactions },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    return { ws, next, seq: Number(ready.s) }
  }

  /** Ordered heartbeat ACK proves no unconsumed event was dispatched. */
  async function fence(target: Client): Promise<void> {
    target.ws.send(JSON.stringify({ op: 1, d: target.seq }))
    const ack = await target.next()
    expect(ack.op).toBe(11)
  }

  /** Reads the next dispatch and checks its name, payload and sequence. */
  async function dispatch(
    name: string,
    data: Record<string, unknown>
  ): Promise<void> {
    expect(await client.next()).toEqual({
      op: 0,
      t: name,
      s: ++client.seq,
      d: data,
    })
  }

  /** Calls the human reaction control (add with POST, removal with DELETE). */
  async function control(
    method: 'POST' | 'DELETE',
    body: Record<string, unknown>
  ): Promise<void> {
    const result = await request(
      `/_test/channels/${channel}/messages/${message}/reactions`,
      method,
      body
    )
    expect(result.status).toBe(204)
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    channel = seedChannel(server.db, guild)
    message = seedMessage(server.db, channel, BOT, TOKEN)
    seedBot(server.db, OTHER_TOKEN, OTHER_BOT)
    seedGuild(server.db, OTHER_TOKEN, '555555555555555555')
    expect(
      await statusOf(
        request('/_test/users', 'POST', { id: HUMAN, username: 'Human' })
      )
    ).toBe(201)
    expect(
      await statusOf(request(`/_test/guilds/${guild}/members/${HUMAN}`, 'POST'))
    ).toBe(201)
    client = await connect(TOKEN)
    other = await connect(OTHER_TOKEN)
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    await server.close()
  })

  it('emits native burst add/remove events beside an independent normal reaction', async () => {
    const target = {
      user_id: HUMAN,
      channel_id: channel,
      message_id: message,
      guild_id: guild,
      emoji: { id: null, name: '🐝' },
    }
    await control('POST', { user_id: HUMAN, emoji: '🐝' })
    await dispatch('MESSAGE_REACTION_ADD', {
      ...target,
      member: getGuildMember(server.db, guild, HUMAN),
      message_author_id: BOT,
      burst: false,
      type: 0,
      burst_colors: [],
    })
    await control('POST', {
      user_id: HUMAN,
      emoji: '🐝',
      burst: true,
      burst_colors: COLORS,
    })
    await dispatch('MESSAGE_REACTION_ADD', {
      ...target,
      member: getGuildMember(server.db, guild, HUMAN),
      message_author_id: BOT,
      burst: true,
      type: 1,
      burst_colors: COLORS,
    })
    // A duplicate burst add is silent; human adds reach only the setup bot.
    await control('POST', { user_id: HUMAN, emoji: '🐝', burst: true })
    await fence(client)
    await fence(other)

    const read = await request(
      `/api/v10/channels/${channel}/messages/${message}`
    )
    expect(await read.json()).toMatchObject({
      reactions: [
        {
          count: 2,
          count_details: { normal: 1, burst: 1 },
          me: false,
          me_burst: false,
          burst_colors: COLORS,
        },
      ],
    })

    // The documented REST route removes the normal membership only.
    const route = `/api/v10/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('🐝')}`
    expect(await statusOf(request(`${route}/${HUMAN}`, 'DELETE'))).toBe(204)
    await dispatch('MESSAGE_REACTION_REMOVE', {
      ...target,
      burst: false,
      type: 0,
    })
    const burstUsers = await request(`${route}?type=1`)
    expect(await burstUsers.json()).toEqual([
      expect.objectContaining({ id: HUMAN, bot: false }),
    ])

    // The test control removes the burst membership, scoped to the setup bot.
    // REST removals keep their existing unscoped delivery, so observe scoping
    // from a fresh session of another bot.
    other.ws.terminate()
    other = await connect(OTHER_TOKEN)
    await control('DELETE', { user_id: HUMAN, emoji: '🐝', burst: true })
    await dispatch('MESSAGE_REACTION_REMOVE', {
      ...target,
      burst: true,
      type: 1,
    })
    await control('DELETE', { user_id: HUMAN, emoji: '🐝', burst: true })
    await fence(client)
    await fence(other)
    expect(server.db.prepare('SELECT * FROM reactions').all()).toEqual([])
  })

  it('clears normal and burst memberships with one clear event', async () => {
    await control('POST', { user_id: HUMAN, emoji: '🐝' })
    await control('POST', { user_id: HUMAN, emoji: '🐝', burst: true })
    await client.next()
    await client.next()
    client.seq += 2
    const clear = await request(
      `/api/v10/channels/${channel}/messages/${message}/reactions`,
      'DELETE'
    )
    expect(clear.status).toBe(204)
    await dispatch('MESSAGE_REACTION_REMOVE_ALL', {
      channel_id: channel,
      message_id: message,
      guild_id: guild,
    })
    await fence(client)
    await fence(other)
    expect(server.db.prepare('SELECT * FROM reactions').all()).toEqual([])
  })
})
