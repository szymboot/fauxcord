import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createRealServer,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'
import { createTestUser } from '../services/test-control'
import { createGuildSticker } from '../services/guild-advanced'
import type { MessageObject } from '../services/messages'
import { GatewayOp } from './opcodes'

/** Buffers incoming frames and bounds reads without relying on fixed sleeps. */
function frameReader(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: ((frame: Record<string, unknown>) => void)[] = []
  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  return () => {
    const frame = queue.shift()
    if (frame) return Promise.resolve(frame)
    const { promise, resolve, reject } =
      Promise.withResolvers<Record<string, unknown>>()
    const timer = setTimeout(() => {
      reject(new Error('Gateway frame timed out'))
    }, 2000)
    waiters.push((next) => {
      clearTimeout(timer)
      resolve(next)
    })
    return promise
  }
}

describe('buildApp attachment and Gateway-control cleanup wiring', () => {
  let close: (() => Promise<void>) | undefined
  let uploadPath: string | undefined
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await close?.()
    close = undefined
    if (uploadPath) await rm(uploadPath, { recursive: true, force: true })
    uploadPath = undefined
  })

  it.each([
    'full',
    'empty-token',
    'token',
    'setup',
    'empty-setup',
    'unknown-setup',
  ])('cleans both features through real HTTP (%s)', async (action) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fauxcord-wiring-'))
    uploadPath = directory
    const server = await createRealServer({ uploadPath: directory })
    close = server.close
    const bytes = Buffer.from([0, 255, 128, 13, 10])
    const rejectedSetup = action === 'empty-setup' || action === 'unknown-setup'
    const humanId = createTestUser(server.db, { username: 'Human' }).id
    const scopes = [
      {
        token: 'Bot wiring-a',
        botId: '111111111111111111',
        guildId: '222222222222222222',
        channelId: '333333333333333333',
      },
      {
        token: 'Bot wiring-b',
        botId: '444444444444444444',
        guildId: '555555555555555555',
        channelId: '666666666666666666',
      },
    ]

    /** Issues a JSON request to this actual buildApp-created server. */
    async function request(
      route: string,
      method = 'GET',
      body?: unknown,
      token?: string
    ): Promise<Response> {
      return fetch(`${server.baseUrl}${route}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: token }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(2000),
      })
    }

    const clients = []
    for (const [index, scope] of scopes.entries()) {
      seedBot(server.db, scope.token, scope.botId)
      seedGuild(server.db, scope.token, scope.guildId)
      seedChannel(server.db, scope.guildId, scope.channelId)
      const sticker = createGuildSticker(server.db, scope.guildId, humanId, {
        name: 'Evidence',
        tags: 'wave',
      })
      const socket = new WebSocket(server.baseUrl.replace('http://', 'ws://'))
      sockets.push(socket)
      const next = frameReader(socket)
      expect(await next()).toMatchObject({ op: GatewayOp.Hello })
      socket.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: {
            token: scope.token,
            intents:
              GatewayIntentBits.GuildMessages |
              GatewayIntentBits.MessageContent,
          },
        })
      )
      const ready = await next()
      expect(ready.t).toBe('READY')
      const sessionId = (ready.d as { session_id: string }).session_id
      const session = server.sessionManager.get(sessionId)
      if (!session) throw new Error('Missing identified session')
      const closeListeners = session.ws.listenerCount('close')
      const control = await request('/_test/gateway-event-controls', 'POST', {
        guild_id: scope.guildId,
        bot_id: scope.botId,
        // Verify both unique-session selection and explicit-session selection.
        ...(index === 1 && { session_id: sessionId }),
        events: ['MESSAGE_DELETE'],
        hold: true,
        ttl_ms: 60_000,
      })
      expect(control.status).toBe(201)
      const armed = (await control.json()) as {
        id: string
        session_id: string
      }
      expect(armed.session_id).toBe(sessionId)
      expect(session.ws.listenerCount('close')).toBe(closeListeners + 1)
      const messages: MessageObject[] = []
      for (const human of [true, false]) {
        const payload = { sticker_ids: [sticker.id] }
        const form = new FormData()
        form.set('payload_json', JSON.stringify(payload))
        form.set(
          'files[0]',
          new File([bytes], 'proof.bin', { type: 'image/png' })
        )
        const created = human
          ? await request(
              `/_test/channels/${scope.channelId}/messages`,
              'POST',
              {
                ...payload,
                author: { id: humanId },
                attachments: [
                  {
                    filename: 'proof.bin',
                    content_type: 'image/png',
                    data: bytes.toString('base64'),
                  },
                ],
              }
            )
          : await fetch(
              `${server.baseUrl}/api/v10/channels/${scope.channelId}/messages`,
              {
                method: 'POST',
                headers: { Authorization: scope.token },
                body: form,
                signal: AbortSignal.timeout(2000),
              }
            )
        expect(created.status).toBe(human ? 201 : 200)
        const message = (await created.json()) as MessageObject
        expect(message.attachments).toHaveLength(1)
        expect(message.sticker_items).toEqual([
          { id: sticker.id, name: 'Evidence', format_type: 1 },
        ])
        expect(await next()).toMatchObject({
          t: 'MESSAGE_CREATE',
          d: message,
        })
        messages.push(message)
        const deleted = await request(
          `/api/v10/channels/${scope.channelId}/messages/${message.id}`,
          'DELETE',
          undefined,
          scope.token
        )
        expect(deleted.status).toBe(204)
        socket.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
        // The native delete is held by the same controls mounted by buildApp.
        expect(await next()).toMatchObject({ op: GatewayOp.HeartbeatAck })
      }
      const inspected = await request(
        `/_test/gateway-event-controls/${armed.id}`
      )
      expect(inspected.status).toBe(200)
      expect(await inspected.json()).toMatchObject({
        events_captured: messages.map((message) => ({
          state: 'held',
          deliveries: 0,
          envelope: {
            t: 'MESSAGE_DELETE',
            d: {
              id: message.id,
              channel_id: scope.channelId,
              guild_id: scope.guildId,
            },
          },
        })),
      })
      if (rejectedSetup) {
        // Keep a live combined message as well as the deleted-message files.
        const retained = await request(
          `/_test/channels/${scope.channelId}/messages`,
          'POST',
          {
            author: { id: humanId },
            sticker_ids: [sticker.id],
            attachments: [
              {
                filename: 'live.bin',
                content_type: 'image/png',
                data: bytes.toString('base64'),
              },
            ],
          }
        )
        expect(retained.status).toBe(201)
        const message = (await retained.json()) as MessageObject
        expect(await next()).toMatchObject({ t: 'MESSAGE_CREATE', d: message })
        messages.push(message)
      }
      clients.push({
        scope,
        messages,
        controlId: armed.id,
        session,
        closeListeners,
      })
    }

    /** Downloads through the configured upload path, including retained files. */
    async function download(
      message: MessageObject,
      status: number
    ): Promise<void> {
      const response = await fetch(message.attachments[0].url, {
        signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(status)
      if (status !== 200) return
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    }

    for (const client of clients)
      for (const message of client.messages) await download(message, 200)
    // Prove uploads are in the caller's configured directory, not the default.
    const directories = await readdir(directory)
    expect(directories.toSorted((a, b) => a.localeCompare(b))).toEqual(
      scopes
        .map((scope) => scope.channelId)
        .toSorted((a, b) => a.localeCompare(b))
    )
    if (rejectedSetup) {
      const tables = [
        'messages',
        'message_stickers',
        'attachments',
        'attachment_files',
      ]
      const snapshots = tables.map((table) =>
        server.db.prepare(`SELECT * FROM ${table}`).all()
      )
      expect(snapshots[0]).toHaveLength(2)
      const result = await request(
        action === 'empty-setup'
          ? '/_test/setup/'
          : '/_test/setup/Bot%20missing',
        'DELETE'
      )
      expect(result.status).toBe(404)
      for (const [index, table] of tables.entries()) {
        expect(server.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(
          snapshots[index]
        )
      }
      for (const client of clients) {
        expect(client.session.ws.listenerCount('close')).toBe(
          client.closeListeners + 1
        )
        const observed = await request(
          `/_test/gateway-event-controls/${client.controlId}`
        )
        expect(observed.status).toBe(200)
        expect(await observed.json()).toMatchObject({
          events_captured: client.messages.slice(0, 2).map((message) => ({
            state: 'held',
            deliveries: 0,
            envelope: { t: 'MESSAGE_DELETE', d: { id: message.id } },
          })),
        })
        for (const message of client.messages) await download(message, 200)
      }
      return
    }
    const result =
      action === 'setup'
        ? await request(
            `/_test/setup/${encodeURIComponent(scopes[0].token)}`,
            'DELETE'
          )
        : await request(
            '/_test/reset',
            'POST',
            action === 'token'
              ? { token: scopes[0].token }
              : action === 'empty-token'
                ? { token: '' }
                : {}
          )
    expect(result.status).toBe(204)
    const all = action === 'full' || action === 'empty-token'
    for (const [index, client] of clients.entries()) {
      const cleared = all || index === 0
      // Check eagerly before GET can lazily prune a deleted guild's control.
      expect(client.session.ws.listenerCount('close')).toBe(
        client.closeListeners + (cleared ? 0 : 1)
      )
      const observed = await request(
        `/_test/gateway-event-controls/${client.controlId}`
      )
      expect(observed.status).toBe(cleared ? 404 : 200)
      for (const [messageIndex, message] of client.messages.entries()) {
        const removed =
          all || (index === 0 && (action === 'setup' || messageIndex === 1))
        await download(message, removed ? 404 : 200)
      }
    }
    expect(server.db.prepare('SELECT * FROM message_stickers').all()).toEqual(
      []
    )
    expect(server.db.prepare('SELECT * FROM attachments').all()).toEqual([])
    expect(
      server.db.prepare('SELECT * FROM attachment_files').all()
    ).toHaveLength(all ? 0 : action === 'setup' ? 2 : 3)
    if (all) expect(await readdir(directory)).toEqual([])
  })
})
