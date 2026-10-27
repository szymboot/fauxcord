import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
  seedGroupDmChannel,
} from '../test-helpers'
import { getOrCreateDmChannel } from '../services/channels'
import { GatewayOp } from './opcodes'

describe('MESSAGE_CREATE dispatch (integration)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('delivers MESSAGE_CREATE over the websocket after a REST message is created', async () => {
    const { db, url, close: c } = await createTestGatewayServer()
    close = c
    const bot = seedBot(db, 'Bot gwtoken')
    const guild = seedGuild(db, bot, 'GWGuild')
    const channel = seedChannel(db, guild, 'general')

    const ws = new WebSocket(url)
    await new Promise((resolve) => ws.once('message', resolve)) // Consume HELLO

    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token: 'Bot gwtoken', intents: GatewayIntentBits.GuildMessages },
      })
    )
    await new Promise((resolve) => ws.once('message', resolve)) // Consume READY

    const dispatchPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (raw: Buffer) => {
        resolve(JSON.parse(raw.toString()))
      })
    })

    // Create a message via REST
    const httpUrl = url.replace('ws://', 'http://')
    await fetch(`${httpUrl}/api/v10/channels/${channel}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot gwtoken',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'hello gateway' }),
    })

    const dispatch = await dispatchPromise
    expect(dispatch.t).toBe('MESSAGE_CREATE')
    expect((dispatch.d as { content: string }).content).toBe('hello gateway')

    ws.close()
  })
})

/** A Gateway frame as parsed from the socket. */
interface Frame {
  op: number
  t?: string
  d: Record<string, unknown>
}

/** Identified Gateway client that records every dispatch it receives. */
interface DmClient {
  ws: WebSocket
  /** Dispatch frames received so far, after the last fence. */
  dispatches: Frame[]
  /** Round-trips a heartbeat so every earlier dispatch has been received. */
  fence: () => Promise<void>
}

/**
 * Connects and identifies a bot, recording every dispatch it receives.
 * @param url - Gateway WebSocket URL
 * @param token - Bot token
 * @param intents - Intents bitfield sent in IDENTIFY
 * @returns The identified client
 */
async function connectDmClient(
  url: string,
  token: string,
  intents: number
): Promise<DmClient> {
  const ws = new WebSocket(url)
  const dispatches: Frame[] = []
  const acks: (() => void)[] = []
  const { promise: readyPromise, resolve: ready } =
    Promise.withResolvers<undefined>()
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Frame
    if (frame.op === GatewayOp.HeartbeatAck) acks.shift()?.()
    else if (frame.t === 'READY') ready(undefined)
    else if (frame.op === GatewayOp.Dispatch) dispatches.push(frame)
  })
  await new Promise((resolve) => ws.once('open', resolve))
  ws.send(JSON.stringify({ op: GatewayOp.Identify, d: { token, intents } }))
  await readyPromise
  return {
    ws,
    dispatches,
    fence: () =>
      new Promise((resolve) => {
        acks.push(resolve)
        ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      }),
  }
}

const BOT_A_TOKEN = 'Bot dm-bot-a'
const BOT_A_ID = '111111111111111111'
const BOT_B_TOKEN = 'Bot dm-bot-b'
const BOT_B_ID = '222222222222222222'
const HUMAN_ID = '333333333333333333'
const EMOJI = '%F0%9F%90%9D'

describe('DM channel dispatch routing (integration)', () => {
  let close: (() => Promise<void>) | undefined
  const clients: DmClient[] = []
  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    await close?.()
    close = undefined
  })

  /** Boots a server with two bots, a human, and a DM between bot A and them. */
  async function setup() {
    const server = await createTestGatewayServer()
    close = server.close
    const { db, url } = server
    seedBot(db, BOT_A_TOKEN, BOT_A_ID)
    seedBot(db, BOT_B_TOKEN, BOT_B_ID)
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(
      HUMAN_ID,
      'human'
    )
    const dm = getOrCreateDmChannel(db, BOT_A_ID, HUMAN_ID).id
    const http = url.replace('ws://', 'http://')
    /** Calls a REST or test-control route as a bot token. */
    const call = (
      method: string,
      path: string,
      token = BOT_A_TOKEN,
      body?: unknown
    ): Promise<Response> =>
      fetch(`${http}${path}`, {
        method,
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    /** Calls a route and returns only its HTTP status. */
    const status = (
      method: string,
      path: string,
      token = BOT_A_TOKEN,
      body?: unknown
    ): Promise<number> =>
      call(method, path, token, body).then((res) => res.status)
    /** Calls a route and returns its parsed JSON body. */
    const json = <T>(
      method: string,
      path: string,
      token = BOT_A_TOKEN,
      body?: unknown
    ): Promise<T> =>
      call(method, path, token, body).then((res) => res.json() as Promise<T>)
    /** Connects a bot and tracks it for cleanup. */
    const connect = async (
      token: string,
      intents: number
    ): Promise<DmClient> => {
      const client = await connectDmClient(url, token, intents)
      clients.push(client)
      return client
    }
    /** Injects a human-authored message through the test control. */
    const inject = (channelId: string, content: string) =>
      json<{ id: string }>(
        'POST',
        `/_test/channels/${channelId}/messages`,
        BOT_A_TOKEN,
        { content, author: { id: HUMAN_ID } }
      )
    return { db, call, status, json, connect, inject, dm }
  }

  it('delivers a human-injected DM only to the recipient bot holding DirectMessages', async () => {
    const { connect, inject, dm } = await setup()
    const recipient = await connect(
      BOT_A_TOKEN,
      GatewayIntentBits.DirectMessages
    )
    const guildOnly = await connect(
      BOT_A_TOKEN,
      GatewayIntentBits.GuildMessages
    )
    const unrelated = await connect(
      BOT_B_TOKEN,
      GatewayIntentBits.DirectMessages
    )

    const message = await inject(dm, '!ping')
    for (const client of [recipient, guildOnly, unrelated]) await client.fence()

    expect(recipient.dispatches).toHaveLength(1)
    expect(recipient.dispatches[0].t).toBe('MESSAGE_CREATE')
    expect(recipient.dispatches[0].d).toMatchObject({
      id: message.id,
      channel_id: dm,
      content: '!ping',
      author: { id: HUMAN_ID },
    })
    expect(recipient.dispatches[0].d).not.toHaveProperty('guild_id')
    expect(recipient.dispatches[0].d).not.toHaveProperty('member')
    expect(guildOnly.dispatches).toEqual([])
    expect(unrelated.dispatches).toEqual([])
  })

  it('routes bot-sent DM messages to the recipient bot, not to other bots', async () => {
    const { status, connect, dm } = await setup()
    const recipient = await connect(
      BOT_A_TOKEN,
      GatewayIntentBits.DirectMessages
    )
    const unrelated = await connect(
      BOT_B_TOKEN,
      GatewayIntentBits.DirectMessages
    )
    // A bot holding both intents still only receives its own DMs.
    const both = await connect(
      BOT_B_TOKEN,
      GatewayIntentBits.DirectMessages | GatewayIntentBits.GuildMessages
    )

    expect(
      await status('POST', `/api/v10/channels/${dm}/messages`, undefined, {
        content: 'pong',
      })
    ).toBe(200)
    for (const client of [recipient, unrelated, both]) await client.fence()

    expect(recipient.dispatches.map((f) => f.t)).toEqual(['MESSAGE_CREATE'])
    expect(recipient.dispatches[0].d).toMatchObject({ content: 'pong' })
    expect(recipient.dispatches[0].d).not.toHaveProperty('guild_id')
    expect(unrelated.dispatches).toEqual([])
    expect(both.dispatches).toEqual([])
  })

  it('delivers MESSAGE_UPDATE and MESSAGE_DELETE of a DM to recipients with DirectMessages only', async () => {
    const { status, json, connect, inject, dm } = await setup()
    const recipient = await connect(
      BOT_A_TOKEN,
      GatewayIntentBits.DirectMessages
    )
    const guildOnly = await connect(
      BOT_A_TOKEN,
      GatewayIntentBits.GuildMessages
    )
    const unrelated = await connect(
      BOT_B_TOKEN,
      GatewayIntentBits.DirectMessages
    )

    const human = await inject(dm, 'first')
    expect(
      await status(
        'PATCH',
        `/_test/channels/${dm}/messages/${human.id}`,
        undefined,
        {
          content: 'edited',
        }
      )
    ).toBe(200)
    const sent = await json<{ id: string }>(
      'POST',
      `/api/v10/channels/${dm}/messages`,
      undefined,
      { content: 'mine' }
    )
    const path = `/api/v10/channels/${dm}/messages/${sent.id}`
    expect(
      await status('PATCH', path, undefined, { content: 'mine edited' })
    ).toBe(200)
    expect(await status('DELETE', path)).toBe(204)
    for (const client of [recipient, guildOnly, unrelated]) await client.fence()

    expect(recipient.dispatches.map((f) => f.t)).toEqual([
      'MESSAGE_CREATE',
      'MESSAGE_UPDATE',
      'MESSAGE_CREATE',
      'MESSAGE_UPDATE',
      'MESSAGE_DELETE',
    ])
    expect(recipient.dispatches[1].d).toMatchObject({
      id: human.id,
      content: 'edited',
    })
    expect(recipient.dispatches[1].d).not.toHaveProperty('guild_id')
    expect(recipient.dispatches[4].d).toEqual({
      id: sent.id,
      channel_id: dm,
    })
    expect(guildOnly.dispatches).toEqual([])
    expect(unrelated.dispatches).toEqual([])
  })

  it('delivers DM reaction add, remove and clears to recipients with DirectMessageReactions only', async () => {
    const { status, connect, inject, dm } = await setup()
    const message = await inject(dm, 'react to me')
    const recipient = await connect(
      BOT_A_TOKEN,
      GatewayIntentBits.DirectMessageReactions
    )
    const guildOnly = await connect(
      BOT_A_TOKEN,
      GatewayIntentBits.GuildMessageReactions
    )
    const unrelated = await connect(
      BOT_B_TOKEN,
      GatewayIntentBits.DirectMessageReactions
    )

    const base = `/api/v10/channels/${dm}/messages/${message.id}/reactions`
    expect(await status('PUT', `${base}/${EMOJI}/@me`)).toBe(204)
    expect(await status('DELETE', `${base}/${EMOJI}/@me`)).toBe(204)
    expect(await status('PUT', `${base}/${EMOJI}/@me`)).toBe(204)
    expect(await status('DELETE', `${base}/${EMOJI}`)).toBe(204)
    expect(await status('PUT', `${base}/${EMOJI}/@me`)).toBe(204)
    expect(await status('DELETE', base)).toBe(204)
    for (const client of [recipient, guildOnly, unrelated]) await client.fence()

    expect(recipient.dispatches.map((f) => f.t)).toEqual([
      'MESSAGE_REACTION_ADD',
      'MESSAGE_REACTION_REMOVE',
      'MESSAGE_REACTION_ADD',
      'MESSAGE_REACTION_REMOVE_EMOJI',
      'MESSAGE_REACTION_ADD',
      'MESSAGE_REACTION_REMOVE_ALL',
    ])
    for (const frame of recipient.dispatches) {
      expect(frame.d).toMatchObject({ channel_id: dm, message_id: message.id })
      expect(frame.d).not.toHaveProperty('guild_id')
      expect(frame.d).not.toHaveProperty('member')
    }
    expect(guildOnly.dispatches).toEqual([])
    expect(unrelated.dispatches).toEqual([])
  })

  it('delivers group-DM events only to bot recipients of the group', async () => {
    const { db, connect, inject } = await setup()
    const group = seedGroupDmChannel(db)
    db.prepare(
      'INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?), (?, ?)'
    ).run(group, BOT_A_ID, group, HUMAN_ID)
    const recipient = await connect(
      BOT_A_TOKEN,
      GatewayIntentBits.DirectMessages
    )
    const unrelated = await connect(
      BOT_B_TOKEN,
      GatewayIntentBits.DirectMessages
    )

    await inject(group, 'hello group')
    for (const client of [recipient, unrelated]) await client.fence()

    expect(recipient.dispatches.map((f) => f.t)).toEqual(['MESSAGE_CREATE'])
    expect(unrelated.dispatches).toEqual([])
  })

  it('keeps guild-channel dispatch unchanged for every bot with GuildMessages', async () => {
    const { db, connect, inject } = await setup()
    const guild = seedGuild(db, BOT_A_TOKEN, 'DMGuild')
    const channel = seedChannel(db, guild, 'general')
    db.prepare(
      'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
    ).run(guild, HUMAN_ID)
    const guildBot = await connect(BOT_A_TOKEN, GatewayIntentBits.GuildMessages)
    const otherBot = await connect(BOT_B_TOKEN, GatewayIntentBits.GuildMessages)
    const dmOnly = await connect(BOT_A_TOKEN, GatewayIntentBits.DirectMessages)

    await inject(channel, 'in guild')
    for (const client of [guildBot, otherBot, dmOnly]) await client.fence()

    expect(guildBot.dispatches.map((f) => f.t)).toEqual(['MESSAGE_CREATE'])
    expect(guildBot.dispatches[0].d).toMatchObject({
      guild_id: guild,
      content: 'in guild',
    })
    // Existing guild routing is a broadcast to every GuildMessages session.
    expect(otherBot.dispatches.map((f) => f.t)).toEqual(['MESSAGE_CREATE'])
    expect(dmOnly.dispatches).toEqual([])
  })
})
