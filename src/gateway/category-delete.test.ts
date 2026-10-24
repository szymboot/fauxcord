import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedMember,
  seedMessage,
} from '../test-helpers'
import {
  createGuildChannel,
  deleteChannel,
  getChannel,
  putChannelOverwrite,
} from '../services/channels'
import {
  getGuildVoiceState,
  setTestGuildVoiceState,
} from '../services/voice-states'
import { gatewayBus } from './bus'
import type { GatewayPayload } from './protocol'

/** Socket and all received Gateway envelopes, including startup frames. */
interface Client {
  ws: WebSocket
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

const TOKEN = 'Bot category-delete'
const USER = '444444444444444444'
const STAGE_USER = '444444444444444445'
const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates

describe('native category deletion', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  const clients: Client[] = []

  /** Makes an authenticated native or fixture request. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token: string | null = TOKEN
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token !== null && { Authorization: token }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Fences prior dispatches with an ordered heartbeat acknowledgement. */
  async function fence(client: Client): Promise<void> {
    const ack = new Promise<void>((resolve) => {
      /** Stops listening once the heartbeat ACK arrives. */
      const listener = (raw: Buffer): void => {
        if ((JSON.parse(raw.toString()) as GatewayPayload<unknown>).op !== 11)
          return
        client.ws.off('message', listener)
        resolve()
      }
      client.ws.on('message', listener)
    })
    client.ws.send(JSON.stringify({ op: 1, d: null }))
    await ack
  }

  /** Records a fresh session and consumes its startup frames. */
  async function connect(intents = INTENTS): Promise<Client> {
    const ws = new WebSocket(server.url)
    const client: Client = { ws, frames: [] }
    clients.push(client)
    ws.on('message', (raw: Buffer) => {
      client.frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents } }))
    await ready
    await fence(client)
    return client
  }

  /** Returns only mutation dispatches, excluding fresh-session snapshots. */
  function events(client: Client): Client['frames'] {
    return client.frames.filter(
      (frame) =>
        frame.op === 0 && !['READY', 'GUILD_CREATE'].includes(frame.t ?? '')
    )
  }

  /** Creates a channel fixture using the shared channel service. */
  function channel(
    type: number,
    parentId: string | null = null,
    guildId = guild
  ): string {
    return createGuildChannel(server.db, {
      guildId,
      type,
      name: `channel-${type}`,
      parentId,
      position: 0,
    }).id
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN)
    guild = seedGuild(server.db, TOKEN)
    seedMember(server.db, guild, USER)
    seedMember(server.db, guild, STAGE_USER)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    await server.close()
  })

  it.each(['/api/v10', '/api', ''])(
    'preserves children, messages and voice connections through %s',
    async (prefix) => {
      const category = channel(4)
      const children = [
        channel(0, category),
        channel(2, category),
        channel(13, category),
      ]
      const thread = channel(11, children[0])
      const otherCategory = channel(4)
      const sibling = channel(0, otherCategory)
      const unparented = channel(0)
      const foreignGuild = seedGuild(server.db, TOKEN, '222222222222222223')
      const foreignCategory = channel(4, null, foreignGuild)
      const foreignChild = channel(0, foreignCategory, foreignGuild)
      const unaffected = [
        thread,
        otherCategory,
        sibling,
        unparented,
        foreignCategory,
        foreignChild,
      ].map((id) => getChannel(server.db, id))
      const message = seedMessage(
        server.db,
        children[0],
        USER,
        TOKEN,
        'kept message'
      )
      putChannelOverwrite(server.db, children[0], guild, {
        type: 0,
        allow: '1024',
        deny: '0',
      })
      setTestGuildVoiceState(server.db, guild, USER, {
        channel_id: children[1],
        self_stream: true,
        self_video: true,
        emit: false,
      })
      setTestGuildVoiceState(server.db, guild, STAGE_USER, {
        channel_id: children[2],
        suppress: true,
        request_to_speak_timestamp: '2026-01-01T00:00:00.000000+00:00',
        emit: false,
      })
      const voiceBefore = [USER, STAGE_USER].map((id) =>
        getGuildVoiceState(server.db, guild, id)
      )
      const before = children.map((id) => getChannel(server.db, id))
      const deleted = getChannel(server.db, category)
      const client = await connect()
      const noGuilds = await connect(GatewayIntentBits.GuildVoiceStates)

      const response = await request(`${prefix}/channels/${category}`, 'DELETE')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(deleted)
      await fence(client)
      await fence(noGuilds)

      // Assert the set of Discord-documented events, without prescribing order.
      const dispatched = events(client)
      const updates = dispatched.filter((frame) => frame.t === 'CHANNEL_UPDATE')
      expect(updates).toHaveLength(children.length)
      for (const child of before) {
        expect(updates.find((frame) => frame.d?.id === child?.id)?.d).toEqual({
          ...child,
          parent_id: null,
        })
      }
      expect(
        dispatched
          .filter((frame) => frame.t === 'CHANNEL_DELETE')
          .map((frame) => frame.d)
      ).toEqual([deleted])
      expect(dispatched).toHaveLength(children.length + 1)
      expect(events(noGuilds)).toEqual([])
      for (const child of before) {
        const read = await request(`${prefix}/channels/${child?.id}`)
        expect(read.status).toBe(200)
        expect(await read.json()).toEqual({ ...child, parent_id: null })
      }
      const listed = await request(`${prefix}/guilds/${guild}/channels`)
      expect(listed.status).toBe(200)
      const list = (await listed.json()) as {
        id: string
        parent_id: string | null
      }[]
      expect(list.some((item) => item.id === category)).toBe(false)
      for (const id of children)
        expect(list.find((item) => item.id === id)?.parent_id).toBeNull()
      const keptMessage = await request(
        `${prefix}/channels/${children[0]}/messages/${message}`
      )
      expect(keptMessage.status).toBe(200)
      expect(await keptMessage.json()).toMatchObject({
        id: message,
        content: 'kept message',
      })
      expect(
        [USER, STAGE_USER].map((id) => getGuildVoiceState(server.db, guild, id))
      ).toEqual(voiceBefore)
      expect(
        unaffected.map((item) => getChannel(server.db, item?.id ?? ''))
      ).toEqual(unaffected)
      const missing = await request(`${prefix}/channels/${category}`)
      expect(missing.status).toBe(404)

      // A new IDENTIFY agrees with REST, so reconnects cannot restore stale parents.
      const fresh = await connect()
      const snapshot = fresh.frames.find(
        (frame) => frame.t === 'GUILD_CREATE' && frame.d?.id === guild
      )?.d
      const channels = snapshot?.channels as {
        id: string
        parent_id: string | null
      }[]
      for (const id of children)
        expect(channels.find((item) => item.id === id)?.parent_id).toBeNull()
      expect(snapshot?.voice_states).toHaveLength(2)
    }
  )

  it.each(['/api/v10', '/api', ''])(
    'handles authentication, empty, repeated and missing deletion through %s',
    async (prefix) => {
      const category = channel(4)
      const client = await connect()
      for (const token of [null, 'Bot invalid']) {
        const unauthorized = await request(
          `${prefix}/channels/${category}`,
          'DELETE',
          undefined,
          token
        )
        expect(unauthorized.status).toBe(401)
      }
      expect(getChannel(server.db, category)).not.toBeNull()
      await fence(client)
      expect(events(client)).toEqual([])
      const deleted = await request(`${prefix}/channels/${category}`, 'DELETE')
      expect(deleted.status).toBe(200)
      for (const id of [category, '999999999999999999']) {
        const response = await request(`${prefix}/channels/${id}`, 'DELETE')
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({
          code: 10_003,
          message: 'Unknown Channel',
        })
      }
      await fence(client)
      expect(events(client).map((frame) => [frame.t, frame.d?.id])).toEqual([
        ['CHANNEL_DELETE', category],
      ])
    }
  )

  it('rolls back all parent changes and publishes nothing if category deletion fails', async () => {
    const category = channel(4)
    const children = [channel(0, category), channel(2, category)]
    const client = await connect()
    server.db
      .exec(`CREATE TRIGGER reject_category_delete BEFORE DELETE ON channels
      WHEN OLD.type = 4 BEGIN SELECT RAISE(ABORT, 'Deletion failed'); END`)
    expect(() => deleteChannel(server.db, category)).toThrow('Deletion failed')
    expect(server.db.inTransaction).toBe(false)
    expect(getChannel(server.db, category)).not.toBeNull()
    for (const id of children)
      expect(getChannel(server.db, id)?.parent_id).toBe(category)
    await fence(client)
    expect(events(client)).toEqual([])
  })

  it('publishes only after every parent change and the category deletion commit', () => {
    const category = channel(4)
    const children = [channel(0, category), channel(2, category)]
    const observed: string[] = []
    /** Verifies synchronous bus listeners see the complete committed mutation. */
    const onUpdate: Parameters<typeof gatewayBus.on<'channel.update'>>[1] = ({
      channel: updated,
    }) => {
      observed.push(String(updated.id))
      expect(server.db.inTransaction).toBe(false)
      expect(getChannel(server.db, category)).toBeNull()
      for (const id of children)
        expect(getChannel(server.db, id)?.parent_id).toBeNull()
    }
    gatewayBus.on('channel.update', onUpdate)
    try {
      deleteChannel(server.db, category)
      expect(observed).toHaveLength(children.length)
      expect(observed).toEqual(expect.arrayContaining(children))
    } finally {
      gatewayBus.off('channel.update', onUpdate)
    }
  })

  it('keeps reset silent and preserves hierarchy until guild cleanup cascades it', async () => {
    const category = channel(4)
    const child = channel(2, category)
    setTestGuildVoiceState(server.db, guild, USER, {
      channel_id: child,
      emit: false,
    })
    const client = await connect()
    const reset = await request('/_test/reset', 'POST', { token: TOKEN })
    expect(reset.status).toBeLessThan(300)
    await fence(client)
    expect(events(client)).toEqual([])
    expect(getChannel(server.db, child)?.parent_id).toBe(category)
    expect(getGuildVoiceState(server.db, guild, USER)).toBeNull()
    setTestGuildVoiceState(server.db, guild, USER, {
      channel_id: child,
      emit: false,
    })
    const deleted = await request(`/guilds/${guild}`, 'DELETE')
    expect(deleted.status).toBeLessThan(300)
    await fence(client)
    expect(events(client).map((frame) => frame.t)).toEqual(['GUILD_DELETE'])
    expect(getChannel(server.db, category)).toBeNull()
    expect(getChannel(server.db, child)).toBeNull()
    expect(getGuildVoiceState(server.db, guild, USER)).toBeNull()
  })
})
