import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedMember,
} from '../test-helpers'
import { GatewayOp } from './opcodes'

/**
 * Queues every incoming WebSocket message as it arrives, so that messages
 * sent back-to-back by the server in the same synchronous burst (e.g. READY
 * immediately followed by GUILD_CREATE) are never dropped. A sequence of
 * `ws.once('message', ...)` calls made *after* the fact would miss a second
 * frame that arrived before the next listener was registered.
 * @param ws - The WebSocket to read from
 * @returns A function that resolves with the next queued message
 */
function createMessageReader(
  ws: WebSocket
): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: ((message: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) {
      waiter(message)
    } else {
      queue.push(message)
    }
  })
  return () =>
    new Promise((resolve) => {
      const queued = queue.shift()
      if (queued) {
        resolve(queued)
      } else {
        waiters.push(resolve)
      }
    })
}

describe('GUILD_MEMBER_REMOVE dispatch (integration)', () => {
  let close: (() => Promise<void>) | undefined
  let ws: WebSocket | undefined
  afterEach(async () => {
    ws?.terminate()
    ws = undefined
    await close?.()
    close = undefined
  })

  it.each([false, true])(
    'delivers a complete user with boolean bot=%s over the websocket after REST removal',
    async (bot) => {
      const { db, url, close: c } = await createTestGatewayServer()
      close = c
      const token = seedBot(db)
      const guildId = seedGuild(db, token)
      const userId = '555555555555555555'
      if (bot) seedBot(db, 'Bot departing-bot', userId)
      seedMember(db, guildId, userId)
      db.prepare(
        'UPDATE users SET username = ?, discriminator = ?, avatar = ? WHERE id = ?'
      ).run('DepartingMember', '1234', 'avatar-hash', userId)

      ws = new WebSocket(url)
      const nextMessage = createMessageReader(ws)
      const hello = await nextMessage()
      expect(hello.op).toBe(GatewayOp.Hello)
      ws.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: {
            token,
            intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
          },
        })
      )
      const ready = await nextMessage()
      expect(ready.t).toBe('READY')
      const guildCreate = await nextMessage()
      expect(guildCreate.t).toBe('GUILD_CREATE')

      const response = await fetch(
        `${url.replace('ws://', 'http://')}/api/v10/guilds/${guildId}/members/${userId}`,
        { method: 'DELETE', headers: { Authorization: token } }
      )
      expect(response.status).toBe(204)

      const dispatch = await nextMessage()
      expect(dispatch).toEqual({
        op: GatewayOp.Dispatch,
        t: 'GUILD_MEMBER_REMOVE',
        s: Number(guildCreate.s) + 1,
        d: {
          guild_id: guildId,
          user: {
            id: userId,
            username: 'DepartingMember',
            discriminator: '1234',
            avatar: 'avatar-hash',
            bot,
            flags: 0,
            public_flags: 0,
            global_name: null,
            primary_guild: null,
          },
        },
      })
    }
  )
})

describe('CHANNEL_CREATE dispatch (integration)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('delivers CHANNEL_CREATE over the websocket after a REST channel is created', async () => {
    const { db, url, close: c } = await createTestGatewayServer()
    close = c
    const bot = seedBot(db, 'Bot gwtoken2')
    const guild = seedGuild(db, bot, '411111111111111111')

    const ws = new WebSocket(url)
    const nextMessage = createMessageReader(ws)
    await nextMessage() // HELLO

    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token: 'Bot gwtoken2', intents: GatewayIntentBits.Guilds },
      })
    )
    await nextMessage() // READY
    // With the Guilds intent, READY is immediately followed by a GUILD_CREATE
    // for the pre-existing seeded guild (mirroring real Discord's post-READY
    // guild-availability dispatch) -- consume it before listening for the
    // CHANNEL_CREATE this test actually cares about.
    await nextMessage() // GUILD_CREATE

    // Create a channel via REST
    const httpUrl = url.replace('ws://', 'http://')
    await fetch(`${httpUrl}/api/v10/guilds/${guild}/channels`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot gwtoken2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'new-channel', type: 0 }),
    })

    const dispatch = await nextMessage()
    expect(dispatch.t).toBe('CHANNEL_CREATE')
    expect((dispatch.d as { name: string }).name).toBe('new-channel')

    ws.close()
  })
})

describe('GUILD_CREATE dispatch after READY (integration)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('dispatches GUILD_CREATE for guilds the bot already belongs to, when the Guilds intent is set', async () => {
    const { db, url, close: c } = await createTestGatewayServer()
    close = c
    const bot = seedBot(db, 'Bot preexisting-guild')
    const guild = seedGuild(db, bot, 'PreexistingGuild')

    const ws = new WebSocket(url)
    const nextMessage = createMessageReader(ws)
    await nextMessage() // HELLO

    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: {
          token: 'Bot preexisting-guild',
          intents: GatewayIntentBits.Guilds,
        },
      })
    )
    await nextMessage() // READY

    const dispatch = await nextMessage()
    expect(dispatch.t).toBe('GUILD_CREATE')
    expect((dispatch.d as { id: string }).id).toBe(guild)

    ws.close()
  })

  it('does not dispatch GUILD_CREATE for pre-existing guilds without the Guilds intent', async () => {
    const { db, url, close: c } = await createTestGatewayServer()
    close = c
    const bot = seedBot(db, 'Bot preexisting-guild-nointent')
    seedGuild(db, bot, 'PreexistingGuildNoIntent')

    const ws = new WebSocket(url)
    const nextMessage = createMessageReader(ws)
    await nextMessage() // HELLO

    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token: 'Bot preexisting-guild-nointent', intents: 0 },
      })
    )
    await nextMessage() // READY

    // No further message should arrive; race the next message against a
    // short timeout to confirm GUILD_CREATE is withheld without the intent.
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout')
      }, 200)
    })
    expect(await Promise.race([nextMessage(), timeout])).toBe('timeout')

    ws.close()
  })
})
