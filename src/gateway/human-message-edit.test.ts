import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
} from '../test-helpers'
import type { MessageObject } from '../services/messages'
import { GatewayOp } from './opcodes'

/**
 * Buffers frames arriving in bursts and bounds every wait to two seconds.
 * @param ws - Client WebSocket
 * @returns Reader for the next Gateway frame
 */
function createMessageReader(
  ws: WebSocket
): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  return () =>
    new Promise((resolve, reject) => {
      const queued = queue.shift()
      if (queued) {
        resolve(queued)
        return
      }
      const timer = setTimeout(() => {
        reject(new Error('Gateway frame timed out'))
      }, 2000)
      waiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
}

describe('human message editing Gateway integration', () => {
  let close: (() => Promise<void>) | undefined
  let ws: WebSocket | undefined
  afterEach(async () => {
    ws?.terminate()
    ws = undefined
    await close?.()
    close = undefined
  })

  it('persists edits and delivers native updates on the existing application bot session', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db, 'Bot application')
    const guildId = seedGuild(server.db, token)
    const channelId = seedChannel(server.db, guildId)
    const httpUrl = server.url.replace('ws://', 'http://')
    ws = new WebSocket(server.url)
    const next = createMessageReader(ws)
    const hello = await next()
    expect(hello.op).toBe(GatewayOp.Hello)
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token, intents: GatewayIntentBits.GuildMessages },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    const botUserId = '111111111111111111'
    expect(ready.d).toMatchObject({ user: { id: botUserId, bot: true } })
    const sessions = server.sessionManager.getAll()
    expect(sessions).toHaveLength(1)
    const session = sessions[0]
    const headers = { 'Content-Type': 'application/json' }
    const registration = await fetch(`${httpUrl}/_test/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: 'LiveHuman',
        global_name: 'Live Human',
      }),
      signal: AbortSignal.timeout(2000),
    })
    expect(registration.status).toBe(201)
    const human = (await registration.json()) as { id: string }
    const injection = await fetch(
      `${httpUrl}/_test/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: 'retained human message',
          author: { id: human.id },
        }),
        signal: AbortSignal.timeout(2000),
      }
    )
    expect(injection.status).toBe(201)
    const original = (await injection.json()) as MessageObject
    const created = await next()
    expect(created).toMatchObject({
      op: GatewayOp.Dispatch,
      t: 'MESSAGE_CREATE',
      d: { ...original, guild_id: guildId, member: { user: original.author } },
    })
    let sequence = Number(created.s)
    for (const content of [
      'edited by human',
      'edited by human',
      '',
      'Zażółć 🐝 こんにちは',
    ]) {
      const response = await fetch(
        `${httpUrl}/_test/channels/${channelId}/messages/${original.id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ content }),
          signal: AbortSignal.timeout(2000),
        }
      )
      expect(response.status).toBe(200)
      const edited = (await response.json()) as MessageObject
      expect(edited).toEqual({
        ...original,
        content,
        edited_timestamp: expect.any(String),
      })
      const dispatch = await next()
      expect(dispatch).toEqual({
        op: GatewayOp.Dispatch,
        t: 'MESSAGE_UPDATE',
        s: ++sequence,
        d: {
          ...edited,
          guild_id: guildId,
          member: (created.d as { member: unknown }).member,
        },
      })
      const read = await fetch(
        `${httpUrl}/api/v10/channels/${channelId}/messages/${original.id}`,
        {
          headers: { Authorization: token },
          signal: AbortSignal.timeout(2000),
        }
      )
      expect(read.status).toBe(200)
      expect(await read.json()).toEqual(edited)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      expect(server.sessionManager.getAll()).toEqual([session])
      expect(session.botId).toBe(botUserId)
    }
    // A heartbeat also catches stray/duplicate dispatches before its ACK.
    ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: sequence }))
    const ack = await next()
    expect(ack.op).toBe(GatewayOp.HeartbeatAck)
    const identity = await fetch(`${httpUrl}/api/v10/users/@me`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(2000),
    })
    expect(await identity.json()).toMatchObject({ id: botUserId, bot: true })
  })
})
