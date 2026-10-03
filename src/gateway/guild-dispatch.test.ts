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
import { getGuildMember, updateGuildMember } from '../services/guild-members'
import { toDiscordTimestamp } from '../timestamp'

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

describe('guild member timeout Gateway state (integration)', () => {
  let close: (() => Promise<void>) | undefined
  let ws: WebSocket | undefined
  afterEach(async () => {
    ws?.terminate()
    ws = undefined
    await close?.()
    close = undefined
  })

  it('delivers persisted deadlines in GUILD_CREATE and set/change/clear member updates', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const userId = seedMember(server.db, guildId)
    const first = new Date(Date.now() + 60_000).toISOString()
    const second = new Date(Date.now() + 120_000).toISOString()
    updateGuildMember(server.db, guildId, userId, {
      nick: 'Retained',
      communication_disabled_until: first,
    })
    const original = getGuildMember(server.db, guildId, userId)
    ws = new WebSocket(server.url)
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
    const initial = await nextMessage()
    expect(initial.t).toBe('GUILD_CREATE')
    expect((initial.d as { members: unknown[] }).members).toContainEqual(
      original
    )

    for (const deadline of [second, first, null]) {
      const response = await fetch(
        `${server.url.replace('ws://', 'http://')}/api/v10/guilds/${guildId}/members/${userId}`,
        {
          method: 'PATCH',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ communication_disabled_until: deadline }),
        }
      )
      expect(response.status).toBe(200)
      const expected = {
        ...original,
        communication_disabled_until:
          deadline === null ? null : toDiscordTimestamp(new Date(deadline)),
      }
      expect(await response.json()).toEqual(expected)
      const dispatch = await nextMessage()
      expect(dispatch.t).toBe('GUILD_MEMBER_UPDATE')
      expect(dispatch.d).toEqual({ ...expected, guild_id: guildId })
    }
  })
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
  let ownerSocket: WebSocket | undefined
  afterEach(async () => {
    ownerSocket?.terminate()
    ownerSocket = undefined
    await close?.()
    close = undefined
  })

  it('dispatches explicit human owners and default bot owners with their own member identities', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const httpUrl = server.url.replace('ws://', 'http://')
    const ownerId = '555555555555555555'
    const botId = '111111111111111111'
    const humanGuildId = '222222222222222222'
    const defaultGuildId = '333333333333333333'
    const registration = await fetch(`${httpUrl}/_test/users`, {
      method: 'POST',
      body: JSON.stringify({
        id: ownerId,
        username: 'HumanOwner',
        discriminator: '1234',
        global_name: 'Owner Display Name',
      }),
    })
    expect(registration.status).toBe(201)
    const setup = await fetch(`${httpUrl}/_test/setup`, {
      method: 'POST',
      body: JSON.stringify({
        token: 'Bot human-owner',
        user: { id: botId, username: 'FixtureBot' },
        guilds: [
          { id: humanGuildId, name: 'Human Guild', owner_id: ownerId },
          { id: defaultGuildId, name: 'Default Guild' },
        ],
      }),
    })
    expect(setup.status).toBe(201)
    ownerSocket = new WebSocket(server.url)
    const nextMessage = createMessageReader(ownerSocket)
    await nextMessage() // HELLO
    ownerSocket.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: {
          token: 'human-owner',
          intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
        },
      })
    )
    const ready = await nextMessage()
    expect(ready.t).toBe('READY')
    expect(ready.d).toMatchObject({ user: { id: botId, bot: true } })
    const dispatches = [await nextMessage(), await nextMessage()]
    for (const dispatch of dispatches) expect(dispatch.t).toBe('GUILD_CREATE')
    const humanGuild = dispatches.find(
      (dispatch) => (dispatch.d as { id: string }).id === humanGuildId
    )
    const memberResponse = await fetch(
      `${httpUrl}/api/v10/guilds/${humanGuildId}/members/${ownerId}`,
      { headers: { Authorization: 'Bot human-owner' } }
    )
    expect(memberResponse.status).toBe(200)
    const ownerMember = await memberResponse.json()
    expect(ownerMember).toMatchObject({
      user: {
        id: ownerId,
        username: 'HumanOwner',
        discriminator: '1234',
        global_name: 'Owner Display Name',
        bot: false,
      },
    })
    expect(humanGuild?.d).toMatchObject({
      owner_id: ownerId,
      member_count: 2,
      members: expect.arrayContaining([
        ownerMember,
        expect.objectContaining({
          user: expect.objectContaining({ id: botId, bot: true }),
        }),
      ]),
    })
    const defaultGuild = dispatches.find(
      (dispatch) => (dispatch.d as { id: string }).id === defaultGuildId
    )
    expect(defaultGuild?.d).toMatchObject({
      owner_id: botId,
      member_count: 1,
      members: [
        expect.objectContaining({
          user: expect.objectContaining({ id: botId, bot: true }),
        }),
      ],
    })
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

describe('global names in member Gateway state (integration)', () => {
  let close: (() => Promise<void>) | undefined
  let ws: WebSocket | undefined
  afterEach(async () => {
    ws?.close()
    await close?.()
    close = undefined
    ws = undefined
  })

  it.each(['Display Name', null, undefined])(
    'preserves global_name=%s from GUILD_CREATE through nickname set/change/clear',
    async (globalName) => {
      const server = await createTestGatewayServer()
      close = server.close
      const httpUrl = server.url.replace('ws://', 'http://')
      const headers = { 'Content-Type': 'application/json' }
      const setup = await fetch(`${httpUrl}/_test/setup`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          token: 'Bot global-name',
          user: { global_name: 'Bot Display Name' },
          guilds: [{ id: '222222222222222222', name: 'Test Guild' }],
        }),
      })
      expect(setup.status).toBe(201)
      const registration = await fetch(`${httpUrl}/_test/users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          username: 'TestHuman',
          global_name: globalName,
        }),
      })
      expect(registration.status).toBe(201)
      const { id } = (await registration.json()) as { id: string }
      const guild = '222222222222222222'
      const join = await fetch(
        `${httpUrl}/_test/guilds/${guild}/members/${id}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ nick: null }),
        }
      )
      expect(join.status).toBe(201)
      expect(await join.json()).toMatchObject({
        nick: null,
        user: { id, global_name: globalName ?? null },
      })
      ws = new WebSocket(server.url)
      const nextMessage = createMessageReader(ws)
      const hello = await nextMessage()
      expect(hello.op).toBe(GatewayOp.Hello)
      ws.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: {
            token: 'global-name',
            intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
          },
        })
      )
      const ready = await nextMessage()
      expect(ready.t).toBe('READY')
      expect(
        (ready.d as { user: { global_name: string } }).user.global_name
      ).toBe('Bot Display Name')
      const initial = await nextMessage()
      expect(initial.t).toBe('GUILD_CREATE')
      const data = initial.d as {
        members: {
          nick: string | null
          user: { id: string; global_name: string | null }
        }[]
      }
      expect(data.members.find((m) => m.user.id === id)).toMatchObject({
        nick: null,
        user: { id, global_name: globalName ?? null },
      })
      const authHeaders = { ...headers, Authorization: 'Bot global-name' }
      const userResponse = await fetch(`${httpUrl}/api/v10/users/${id}`, {
        headers: authHeaders,
      })
      expect(userResponse.status).toBe(200)
      expect(await userResponse.json()).toMatchObject({
        global_name: globalName ?? null,
      })
      const list = await fetch(
        `${httpUrl}/api/v10/guilds/${guild}/members?limit=100`,
        { headers: authHeaders }
      )
      expect(list.status).toBe(200)
      expect(await list.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            user: expect.objectContaining({
              id,
              global_name: globalName ?? null,
            }),
          }),
        ])
      )
      for (const nick of ['First Nick', 'Second Nick', null]) {
        const response = await fetch(
          `${httpUrl}/api/v10/guilds/${guild}/members/${id}`,
          {
            method: 'PATCH',
            headers: authHeaders,
            body: JSON.stringify({ nick }),
          }
        )
        expect(response.status).toBe(200)
        const expected = { nick, user: { id, global_name: globalName ?? null } }
        expect(await response.json()).toMatchObject(expected)
        const dispatch = await nextMessage()
        expect(dispatch.t).toBe('GUILD_MEMBER_UPDATE')
        expect(dispatch.d).toMatchObject({ guild_id: guild, ...expected })
        const member = await fetch(
          `${httpUrl}/api/v10/guilds/${guild}/members/${id}`,
          { headers: authHeaders }
        )
        expect(member.status).toBe(200)
        expect(await member.json()).toMatchObject(expected)
      }
    }
  )
})
