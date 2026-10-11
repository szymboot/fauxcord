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

const TOKEN = 'Bot tested-bot'
const BOT = '111111111111111111'
const ACTOR = '777777777777777777'
const ACTOR_TOKEN = `Bot integration-actor-${ACTOR}`
const EMOJI = '👍'

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

describe('live auxiliary bot reactions while the tested bot is connected', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let channel: string
  let message: string
  let client: Client

  /** Calls controls without credentials, and native routes as the given bot. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token = TOKEN
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(!path.startsWith('/_test/') && { Authorization: token }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2000),
    })
  }

  /** Ordered heartbeat ACK proves no unconsumed event was dispatched. */
  async function fence(): Promise<void> {
    client.ws.send(JSON.stringify({ op: 1, d: client.seq }))
    const ack = await client.next()
    expect(ack.op).toBe(11)
  }

  /** Native reaction route for the seeded message. */
  function reactionPath(suffix = ''): string {
    return `/api/v10/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(EMOJI)}${suffix}`
  }

  /** Reads the normal reaction users through the native REST endpoint. */
  async function reactionUsers(): Promise<{ id: string; bot: boolean }[]> {
    const res = await request(reactionPath())
    expect(res.status).toBe(200)
    return (await res.json()) as { id: string; bot: boolean }[]
  }

  /** Asserts the complete native removal payload for the auxiliary bot. */
  async function expectRemoval(): Promise<void> {
    expect(await client.next()).toEqual({
      op: 0,
      t: 'MESSAGE_REACTION_REMOVE',
      s: ++client.seq,
      d: {
        user_id: ACTOR,
        channel_id: channel,
        message_id: message,
        guild_id: guild,
        emoji: { id: null, name: EMOJI },
        burst: false,
        type: 0,
      },
    })
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    guild = seedGuild(server.db, TOKEN)
    channel = seedChannel(server.db, guild)
    message = seedMessage(server.db, channel, BOT, TOKEN)

    const ws = new WebSocket(server.url)
    const next = reader(ws)
    const hello = await next()
    expect(hello.op).toBe(10)
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: TOKEN,
          intents:
            GatewayIntentBits.GuildMessages |
            GatewayIntentBits.GuildMessageReactions,
        },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    client = { ws, next, seq: Number(ready.s) }

    // Register the auxiliary bot only after the tested bot is live, exactly
    // like a harness that seeds bot members mid-scenario.
    const setup = await request('/_test/setup', 'POST', {
      token: ACTOR_TOKEN,
      user: { id: ACTOR, username: 'Actor Bot', global_name: 'Actor' },
      guilds: [],
    })
    expect(setup.status).toBe(201)
    const join = await request(
      `/api/v10/guilds/${guild}/members/${ACTOR}`,
      'PUT',
      {
        access_token: 'integration-fixture',
      }
    )
    expect(join.status).toBe(201)
    // The tested bot has no Guild Members intent, so the join is not delivered.
    await fence()
  })

  afterEach(async () => {
    client.ws.close()
    await server.close()
  })

  it('dispatches native add and remove with the bot member for @me reactions', async () => {
    const add = await request(
      reactionPath('/@me'),
      'PUT',
      undefined,
      ACTOR_TOKEN
    )
    expect(add.status).toBe(204)
    const member = getGuildMember(server.db, guild, ACTOR)
    expect(member?.user.bot).toBe(true)
    expect(await client.next()).toEqual({
      op: 0,
      t: 'MESSAGE_REACTION_ADD',
      s: ++client.seq,
      d: {
        user_id: ACTOR,
        channel_id: channel,
        message_id: message,
        guild_id: guild,
        emoji: { id: null, name: EMOJI },
        member,
        message_author_id: BOT,
        burst: false,
        type: 0,
        burst_colors: [],
      },
    })
    expect(await reactionUsers()).toMatchObject([{ id: ACTOR, bot: true }])

    // A duplicate add is a no-op without a second event.
    const duplicate = await request(
      reactionPath('/@me'),
      'PUT',
      undefined,
      ACTOR_TOKEN
    )
    expect(duplicate.status).toBe(204)
    await fence()

    const remove = await request(
      reactionPath('/@me'),
      'DELETE',
      undefined,
      ACTOR_TOKEN
    )
    expect(remove.status).toBe(204)
    await expectRemoval()
    expect(await reactionUsers()).toEqual([])

    // Removing an absent reaction emits nothing.
    await request(reactionPath('/@me'), 'DELETE', undefined, ACTOR_TOKEN)
    await fence()
  })

  it('dispatches native remove when the tested bot deletes the bot reaction', async () => {
    await request(reactionPath('/@me'), 'PUT', undefined, ACTOR_TOKEN)
    const added = await client.next()
    expect(added.t).toBe('MESSAGE_REACTION_ADD')
    client.seq++

    const remove = await request(reactionPath(`/${ACTOR}`), 'DELETE')
    expect(remove.status).toBe(204)
    await expectRemoval()
    expect(await reactionUsers()).toEqual([])
  })
})
