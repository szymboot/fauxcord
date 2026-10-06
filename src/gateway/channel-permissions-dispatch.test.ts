import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'
import { getChannel } from '../services/channels'
import { GatewayOp } from './opcodes'

/** Queues frames so back-to-back dispatches cannot be lost. */
function createMessageReader(
  ws: WebSocket
): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: ((message: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })
  return () =>
    new Promise((resolve) => {
      const queued = queue.shift()
      if (queued) resolve(queued)
      else waiters.push(resolve)
    })
}

/** Connected Gateway client and its ordered frame reader. */
interface GatewayClient {
  ws: WebSocket
  next: () => Promise<Record<string, unknown>>
  sequence: number
  sessionId: string
}

/** Identifies a client and consumes its initial guild availability frames. */
async function connectClient(
  url: string,
  token: string,
  intents: number,
  guildIds: string[],
  sockets: WebSocket[]
): Promise<GatewayClient> {
  const ws = new WebSocket(url)
  sockets.push(ws)
  const next = createMessageReader(ws)
  const hello = await next()
  expect(hello.op).toBe(GatewayOp.Hello)
  ws.send(JSON.stringify({ op: GatewayOp.Identify, d: { token, intents } }))
  const ready = await next()
  expect(ready.t).toBe('READY')
  let sequence = Number(ready.s)
  if (intents & GatewayIntentBits.Guilds) {
    for (const guildId of guildIds) {
      const initial = await next()
      expect(initial.t).toBe('GUILD_CREATE')
      expect(initial.d).toMatchObject({ id: guildId })
      sequence = Number(initial.s)
    }
  }
  const sessionId = (ready.d as { session_id: string }).session_id
  return { ws, next, sequence, sessionId }
}

/** Uses ordered heartbeat acknowledgement as a barrier for absent dispatches. */
async function expectNoDispatch(client: GatewayClient): Promise<void> {
  client.ws.send(
    JSON.stringify({ op: GatewayOp.Heartbeat, d: client.sequence })
  )
  expect(await client.next()).toMatchObject({ op: GatewayOp.HeartbeatAck })
}

describe('permission overwrite CHANNEL_UPDATE delivery', () => {
  const sockets: WebSocket[] = []
  const servers: Awaited<ReturnType<typeof createTestGatewayServer>>[] = []
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    for (const server of servers.splice(0)) await server.close()
  })

  it.each(['/api/v10', '/api', ''])(
    'delivers full channel state on create, replace and delete through %s',
    async (prefix) => {
      const server = await createTestGatewayServer()
      servers.push(server)
      const token = seedBot(server.db)
      const guildId = seedGuild(server.db, token)
      const channelId = seedChannel(server.db, guildId)
      const sibling = seedChannel(server.db, guildId, '333333333333333334')
      const client = await connectClient(
        server.url,
        token,
        GatewayIntentBits.Guilds,
        [guildId],
        sockets
      )
      const secondSession = await connectClient(
        server.url,
        token.slice(4),
        GatewayIntentBits.Guilds,
        [guildId],
        sockets
      )
      const httpUrl = server.url.replace('ws://', 'http://')
      const memberId = '444444444444444444'
      const cases = [
        {
          method: 'PUT',
          id: memberId,
          body: { type: 1, allow: '1024', deny: '0' },
          overwrites: [{ id: memberId, type: 1, allow: '1024', deny: '0' }],
        },
        {
          method: 'PUT',
          id: guildId,
          body: { type: 0, deny: 1024 },
          overwrites: [
            { id: guildId, type: 0, allow: '0', deny: '1024' },
            { id: memberId, type: 1, allow: '1024', deny: '0' },
          ],
        },
        {
          method: 'PUT',
          id: memberId,
          body: { type: 0, allow: '8', deny: '2048' },
          overwrites: [
            { id: guildId, type: 0, allow: '0', deny: '1024' },
            { id: memberId, type: 0, allow: '8', deny: '2048' },
          ],
        },
        {
          method: 'DELETE',
          id: memberId,
          overwrites: [{ id: guildId, type: 0, allow: '0', deny: '1024' }],
        },
        { method: 'DELETE', id: guildId, overwrites: [] },
      ]
      for (const mutation of cases) {
        const response = await fetch(
          `${httpUrl}${prefix}/channels/${channelId}/permissions/${mutation.id}`,
          {
            method: mutation.method,
            headers: {
              Authorization: token,
              'Content-Type': 'application/json',
            },
            ...(mutation.body && { body: JSON.stringify(mutation.body) }),
          }
        )
        expect(response.status).toBe(204)
        expect(await response.text()).toBe('')
        const current = getChannel(server.db, channelId)
        expect(current).toMatchObject({
          guild_id: guildId,
          permission_overwrites: mutation.overwrites,
        })
        const read = await fetch(`${httpUrl}${prefix}/channels/${channelId}`, {
          headers: { Authorization: token },
        })
        expect(read.status).toBe(200)
        expect(await read.json()).toEqual(current)
        for (const session of [client, secondSession]) {
          const envelope = {
            op: GatewayOp.Dispatch,
            t: 'CHANNEL_UPDATE',
            s: ++session.sequence,
            d: current,
          }
          expect(await session.next()).toEqual(envelope)
          expect(
            server.sessionManager.get(session.sessionId)?.replayBuffer.at(-1)
              ?.event
          ).toEqual(envelope)
        }
        expect(getChannel(server.db, sibling)?.permission_overwrites).toEqual(
          []
        )
      }
      for (const session of [client, secondSession])
        await expectNoDispatch(session)
    }
  )

  it('isolates guild owners, intents and app databases even when identifiers match', async () => {
    const server = await createTestGatewayServer()
    const otherServer = await createTestGatewayServer()
    servers.push(server, otherServer)
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const channelId = seedChannel(server.db, guildId)
    const otherToken = seedBot(server.db, 'Bot other', '111111111111111112')
    const otherGuild = seedGuild(server.db, otherToken, '222222222222222223')
    const aliasToken = seedBot(server.db, 'Bot alias', '111111111111111111')
    const aliasGuild = seedGuild(server.db, aliasToken, '222222222222222224')
    const otherChannel = seedChannel(
      server.db,
      otherGuild,
      '333333333333333334'
    )
    seedGuild(otherServer.db, seedBot(otherServer.db), guildId)
    const owner = await connectClient(
      server.url,
      token.slice(4),
      GatewayIntentBits.Guilds,
      [guildId],
      sockets
    )
    const foreign = await connectClient(
      server.url,
      otherToken.slice(4),
      GatewayIntentBits.Guilds,
      [otherGuild],
      sockets
    )
    const alias = await connectClient(
      server.url,
      aliasToken.slice(4),
      GatewayIntentBits.Guilds,
      [aliasGuild],
      sockets
    )
    const noIntent = await connectClient(
      server.url,
      token.slice(4),
      GatewayIntentBits.GuildMessages,
      [],
      sockets
    )
    const otherApp = await connectClient(
      otherServer.url,
      token.slice(4),
      GatewayIntentBits.Guilds,
      [guildId],
      sockets
    )
    for (const [id, recipient, excluded] of [
      [channelId, owner, foreign],
      [otherChannel, foreign, owner],
    ] as const) {
      // REST authentication is intentionally permissive across guilds; route
      // delivery by the guild's registered bot rather than the request token.
      const response = await fetch(
        `${server.url.replace('ws://', 'http://')}/api/v10/channels/${id}/permissions/${guildId}`,
        {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 0, deny: '1024' }),
        }
      )
      expect(response.status).toBe(204)
      expect(await recipient.next()).toMatchObject({
        t: 'CHANNEL_UPDATE',
        d: { id },
      })
      recipient.sequence++
      for (const client of [excluded, alias, noIntent, otherApp])
        await expectNoDispatch(client)
    }
  })

  it('emits no update on malformed, invalid, unknown or unauthenticated requests and no-op deletion', async () => {
    const server = await createTestGatewayServer()
    servers.push(server)
    const token = seedBot(server.db)
    const guildId = seedGuild(server.db, token)
    const channelId = seedChannel(server.db, guildId)
    const client = await connectClient(
      server.url,
      token.slice(4),
      GatewayIntentBits.Guilds,
      [guildId],
      sockets
    )
    const original = getChannel(server.db, channelId)
    for (const request of [
      { method: 'PUT', body: '{', status: 400 },
      {
        method: 'PUT',
        body: JSON.stringify({ type: 0, allow: 'nope' }),
        status: 400,
      },
      { method: 'PUT', body: JSON.stringify({ allow: '1024' }), status: 400 },
      {
        method: 'PUT',
        body: JSON.stringify({ type: 0 }),
        channel: '999999999999999999',
        status: 404,
      },
      { method: 'DELETE', channel: '999999999999999999', status: 404 },
      {
        method: 'PUT',
        body: JSON.stringify({ type: 0 }),
        authorization: '',
        status: 401,
      },
      { method: 'DELETE', authorization: 'Bot unregistered', status: 401 },
      { method: 'DELETE', status: 204 },
    ]) {
      const response = await fetch(
        `${server.url.replace('ws://', 'http://')}/api/v10/channels/${request.channel ?? channelId}/permissions/${guildId}`,
        {
          method: request.method,
          headers: {
            Authorization: request.authorization ?? token,
            'Content-Type': 'application/json',
          },
          ...(request.body && { body: request.body }),
        }
      )
      expect(response.status).toBe(request.status)
      expect(getChannel(server.db, channelId)).toEqual(original)
      await expectNoDispatch(client)
    }
  })
})
