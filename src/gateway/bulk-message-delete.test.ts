import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  GatewayIntentBits,
  type GatewayMessageDeleteBulkDispatchData,
} from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
} from '../test-helpers'
import { generateSnowflake } from '../snowflake'
import { GatewayOp } from './opcodes'

/** Buffers frames and bounds each wait, including unexpected dispatches. */
function reader(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const frames: Record<string, unknown>[] = []
  const waiting: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    const resolve = waiting.shift()
    if (resolve) resolve(frame)
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
      waiting.push((next) => {
        clearTimeout(timer)
        resolve(next)
      })
    })
}

/** Sends an HTTP request and reads its status for rejection/no-op checks. */
async function fetchStatus(url: string, options: RequestInit): Promise<number> {
  const response = await fetch(url, options)
  return response.status
}

describe('native bulk deletion Gateway contract', () => {
  const sockets: WebSocket[] = []
  const closers: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    for (const close of closers.splice(0)) await close()
  })

  /** Opens and identifies a real socket, returning its buffered reader. */
  async function connect(url: string, token: string, intents: number) {
    const ws = new WebSocket(url)
    sockets.push(ws)
    const next = reader(ws)
    const hello = await next()
    expect(hello.op).toBe(GatewayOp.Hello)
    ws.send(JSON.stringify({ op: GatewayOp.Identify, d: { token, intents } }))
    const ready = await next()
    expect(ready.t).toBe('READY')
    return { ws, next }
  }

  /** Acknowledgement forms an ordered barrier that exposes stray events. */
  async function barrier(client: Awaited<ReturnType<typeof connect>>) {
    client.ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
    const ack = await client.next()
    expect(ack.op).toBe(GatewayOp.HeartbeatAck)
  }

  it('sends exactly one typed bulk dispatch to eligible subscribers and preserves single DELETE', async () => {
    const server = await createTestGatewayServer()
    closers.push(server.close)
    const token = seedBot(server.db)
    const guild = seedGuild(server.db, token)
    const channel = seedChannel(server.db, guild)
    const ids = [
      seedMessage(server.db, channel, '111111111111111111', token),
      seedMessage(server.db, channel, '111111111111111111', token),
    ]
    const otherToken = seedBot(server.db, 'Bot unrelated', '222222222222222222')
    const otherGuild = seedGuild(server.db, otherToken, generateSnowflake())
    const otherChannel = seedChannel(server.db, otherGuild, generateSnowflake())
    const foreign = seedMessage(
      server.db,
      otherChannel,
      '222222222222222222',
      otherToken
    )
    const eligible = await connect(
      server.url,
      token,
      GatewayIntentBits.GuildMessages
    )
    const noIntent = await connect(server.url, token, 0)
    const dmIntent = await connect(
      server.url,
      token,
      GatewayIntentBits.DirectMessages
    )
    const unrelated = await connect(
      server.url,
      otherToken,
      GatewayIntentBits.GuildMessages
    )
    const second = await createTestGatewayServer()
    closers.push(second.close)
    seedBot(second.db, token)
    const separateApp = await connect(
      second.url,
      token,
      GatewayIntentBits.GuildMessages
    )
    const httpUrl = server.url.replace('ws://', 'http://')
    const headers = { Authorization: token, 'Content-Type': 'application/json' }
    const response = await fetch(
      `${httpUrl}/api/v10/channels/${channel}/messages/bulk-delete`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: [...ids, foreign, generateSnowflake()],
        }),
        signal: AbortSignal.timeout(2000),
      }
    )
    expect(response.status).toBe(204)
    const data: GatewayMessageDeleteBulkDispatchData = {
      ids,
      channel_id: channel,
      guild_id: guild,
    }
    expect(await eligible.next()).toEqual({
      op: GatewayOp.Dispatch,
      t: 'MESSAGE_DELETE_BULK',
      s: 2,
      d: data,
    })
    for (const client of [eligible, noIntent, dmIntent, unrelated, separateApp])
      await barrier(client)
    for (const id of ids) {
      const read = await fetch(
        `${httpUrl}/api/v10/channels/${channel}/messages/${id}`,
        { headers, signal: AbortSignal.timeout(2000) }
      )
      expect(read.status).toBe(404)
    }
    expect(server.db.prepare('SELECT id FROM messages').all()).toEqual([
      { id: foreign },
    ])
    const survivor = seedMessage(
      server.db,
      channel,
      '111111111111111111',
      token
    )
    const deleted = await fetch(
      `${httpUrl}/api/v10/channels/${channel}/messages/${survivor}`,
      { method: 'DELETE', headers, signal: AbortSignal.timeout(2000) }
    )
    expect(deleted.status).toBe(204)
    expect(await eligible.next()).toEqual({
      op: GatewayOp.Dispatch,
      t: 'MESSAGE_DELETE',
      s: 3,
      d: { id: survivor, channel_id: channel, guild_id: guild },
    })
    await barrier(eligible)
  })

  it('emits nothing for invalid requests or all-missing valid requests, then emits a partial bulk', async () => {
    const server = await createTestGatewayServer()
    closers.push(server.close)
    const token = seedBot(server.db)
    const guild = seedGuild(server.db, token)
    const channel = seedChannel(server.db, guild)
    const id = seedMessage(server.db, channel, '111111111111111111', token)
    const client = await connect(
      server.url,
      token,
      GatewayIntentBits.GuildMessages
    )
    const endpoint = `${server.url.replace('ws://', 'http://')}/api/v10/channels/${channel}/messages/bulk-delete`
    const headers = { Authorization: token, 'Content-Type': 'application/json' }
    for (const body of [
      `{"messages":["${id}","${id}"]}`,
      `{"messages":["${id}","1"]}`,
      `{"messages":["${id}",true]}`,
      'malformed',
    ]) {
      expect(
        await fetchStatus(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(2000),
        })
      ).toBe(400)
      await barrier(client)
      expect(server.db.prepare('SELECT id FROM messages').all()).toEqual([
        { id },
      ])
    }
    const missing = [generateSnowflake(), generateSnowflake()]
    expect(
      await fetchStatus(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: missing }),
        signal: AbortSignal.timeout(2000),
      })
    ).toBe(204)
    await barrier(client)
    expect(
      await fetchStatus(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [id, missing[0]] }),
        signal: AbortSignal.timeout(2000),
      })
    ).toBe(204)
    expect(await client.next()).toEqual({
      op: GatewayOp.Dispatch,
      t: 'MESSAGE_DELETE_BULK',
      s: 2,
      d: { ids: [id], channel_id: channel, guild_id: guild },
    })
    await barrier(client)
  })
})
