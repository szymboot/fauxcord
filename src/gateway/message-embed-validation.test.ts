import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedInteraction,
  seedWebhook,
} from '../test-helpers'
import { GatewayOp } from './opcodes'

/** Buffers socket frames and gives each pending read a bounded lifetime. */
function createReader(ws: WebSocket): () => Promise<Record<string, unknown>> {
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
      const frame = queue.shift()
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

const invalidEmbeds = [
  false,
  {},
  'bad',
  [null],
  [false],
  [[]],
  [{ title: 1 }],
  [{ description: {} }],
  [{ fields: {} }],
  [{ fields: [null] }],
  [{ fields: [{}] }],
  [{ fields: [{ name: null, value: 'x' }] }],
  [{ fields: [{ name: 'x', value: false }] }],
  [{ fields: [{ name: 'x'.repeat(257), value: 'x' }] }],
  [{ fields: [{ name: 'x', value: 'x'.repeat(1025) }] }],
  [{ fields: [{ name: '', value: '', inline: 'true' }] }],
  [{ fields: Array.from({ length: 26 }, () => ({ name: '', value: '' })) }],
  [{ footer: {}, author: { name: false } }],
  [{ footer: { text: {} } }],
  [{ author: [] }],
  [{ footer: 1 }],
  [{ title: 'x'.repeat(257) }],
  [{ description: 'x'.repeat(4097) }],
  [{ footer: { text: 'x'.repeat(2049) } }],
  [{ author: { name: 'x'.repeat(257) } }],
  [{ description: 'x'.repeat(3000) }, { description: 'x'.repeat(3001) }],
  Array.from({ length: 11 }, () => ({})),
]

const maximumEmbeds = [
  { description: '🐝'.repeat(3000) },
  { description: '🐝'.repeat(3000) },
]

describe('embed validation over real HTTP and Gateway sockets', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>> | undefined
  let ws: WebSocket | undefined
  afterEach(async () => {
    ws?.terminate()
    ws = undefined
    await server?.close()
    server = undefined
  })

  it.each(['/api/v10', '/api', ''])(
    'rejects creates/edits atomically and recovers through %s',
    async (prefix) => {
      server = await createTestGatewayServer()
      const token = seedBot(server.db)
      const guild = seedGuild(server.db, token)
      const channel = seedChannel(server.db, guild)
      const otherChannel = seedChannel(server.db, guild, 'other')
      const http = server.url.replace('ws://', 'http://')
      const path = `${prefix}/channels/${channel}/messages`
      /** Sends a JSON request through the live HTTP server. */
      const request = (
        route: string,
        method: string,
        body?: unknown,
        authorization = token
      ) =>
        fetch(http + route, {
          method,
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(2000),
        })
      ws = new WebSocket(server.url)
      const next = createReader(ws)
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
      const unauthorized = await request(
        path,
        'POST',
        { embeds: maximumEmbeds },
        'Bot unknown'
      )
      expect(unauthorized.status).toBe(401)
      const unknownChannel = await request(
        `${prefix}/channels/0/messages`,
        'POST',
        {
          embeds: maximumEmbeds,
        }
      )
      expect(unknownChannel.status).toBe(404)
      const created = await request(path, 'POST', {
        content: 'original',
        embeds: maximumEmbeds,
      })
      expect(created.status).toBe(200)
      const original = (await created.json()) as {
        id: string
        embeds: unknown[]
      }
      expect(original.embeds).toEqual(maximumEmbeds)
      const createFrame = await next()
      expect(createFrame.t).toBe('MESSAGE_CREATE')
      const originalRows = server.db.prepare('SELECT * FROM messages').all()
      const embedRows = server.db.prepare('SELECT * FROM embeds').all()
      for (const embeds of invalidEmbeds) {
        for (const [route, method] of [
          [path, 'POST'],
          [`${path}/${original.id}`, 'PATCH'],
        ]) {
          const response = await request(route, method, {
            content: 'must not persist',
            embeds,
          })
          expect(response.status, JSON.stringify(embeds)).toBe(400)
          expect(await response.json()).toMatchObject({
            code: 50_035,
            message: 'Invalid Form Body',
            errors: expect.any(Object),
          })
        }
        expect(server.db.prepare('SELECT * FROM messages').all()).toEqual(
          originalRows
        )
        expect(server.db.prepare('SELECT * FROM embeds').all()).toEqual(
          embedRows
        )
      }
      // A heartbeat orders the socket stream and catches any rejected-write dispatch.
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: createFrame.s }))
      const rejectionAck = await next()
      expect(rejectionAck.op).toBe(GatewayOp.HeartbeatAck)
      const readOriginal = await request(`${path}/${original.id}`, 'GET')
      expect(await readOriginal.json()).toEqual(original)
      const rejectedWithoutContent = await request(path, 'POST', { embeds: {} })
      expect(rejectedWithoutContent.status).toBe(400)
      expect(await rejectedWithoutContent.json()).toMatchObject({
        code: 50_035,
      })
      const unknownMessage = await request(`${path}/0`, 'PATCH', {
        embeds: [null],
      })
      expect(unknownMessage.status).toBe(404)

      // Parallel invalid/valid requests must not share a budget or affect another channel.
      const results = await Promise.all([
        request(path, 'POST', {
          embeds: invalidEmbeds[0],
          content: 'rejected',
        }),
        request(`${prefix}/channels/${otherChannel}/messages`, 'POST', {
          embeds: maximumEmbeds,
        }),
      ])
      expect(results.map((result) => result.status)).toEqual([400, 200])
      const otherChannelCreate = await next()
      expect(otherChannelCreate.t).toBe('MESSAGE_CREATE')
      const channelHistory = await request(path, 'GET')
      expect(await channelHistory.json()).toEqual([original])
      const recoveryEdit = await request(`${path}/${original.id}`, 'PATCH', {
        content: 'recovered',
        embeds: maximumEmbeds,
      })
      expect(recoveryEdit.status).toBe(200)
      const recoveryUpdate = await next()
      expect(recoveryUpdate.t).toBe('MESSAGE_UPDATE')
      const omitted = await request(`${path}/${original.id}`, 'PATCH', {
        content: 'keeps embeds',
      })
      expect(((await omitted.json()) as { embeds: unknown[] }).embeds).toEqual(
        maximumEmbeds
      )
      const omittedUpdate = await next()
      expect(omittedUpdate.t).toBe('MESSAGE_UPDATE')
      for (const embeds of [null, []]) {
        const cleared = await request(`${path}/${original.id}`, 'PATCH', {
          embeds,
        })
        expect(cleared.status).toBe(200)
        expect(
          ((await cleared.json()) as { embeds: unknown[] }).embeds
        ).toEqual([])
        const clearUpdate = await next()
        expect(clearUpdate.t).toBe('MESSAGE_UPDATE')
        const compatible = await request(path, 'POST', {
          content: 'discordgo',
          embeds,
        })
        expect(compatible.status).toBe(200)
        expect(
          ((await compatible.json()) as { embeds: unknown[] }).embeds
        ).toEqual([])
        const compatibleCreate = await next()
        expect(compatibleCreate.t).toBe('MESSAGE_CREATE')
      }
      const reset = await request('/_test/reset', 'POST', { token })
      expect(reset.status).toBe(204)
      expect(server.db.prepare('SELECT * FROM embeds').all()).toEqual([])
      const afterReset = await request(path, 'POST', { embeds: maximumEmbeds })
      expect(afterReset.status).toBe(200)
      const resetCreate = await next()
      expect(resetCreate.t).toBe('MESSAGE_CREATE')
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      const resetAck = await next()
      expect(resetAck.op).toBe(GatewayOp.HeartbeatAck)
    }
  )

  it('uses the same validation for webhooks, followups, callbacks and original edits', async () => {
    server = await createTestGatewayServer()
    const token = seedBot(server.db)
    const guild = seedGuild(server.db, token)
    const channel = seedChannel(server.db, guild)
    const { webhookId, webhookToken } = seedWebhook(server.db, channel, guild)
    const applicationId = '111111111111111111'
    const { interactionId, interactionToken } = seedInteraction(
      server.db,
      applicationId,
      channel,
      applicationId
    )
    const http = server.url.replace('ws://', 'http://')
    /** Sends a JSON request to a credentialed webhook or callback URL. */
    const request = (path: string, method: string, body: unknown) =>
      fetch(http + '/api/v10' + path, {
        method,
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      })
    ws = new WebSocket(server.url)
    const next = createReader(ws)
    await next()
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token, intents: GatewayIntentBits.GuildMessages },
      })
    )
    await next()
    const webhookPath = `/webhooks/${webhookId}/${webhookToken}`
    const followupPath = `/webhooks/${applicationId}/${interactionToken}`
    const callbackPath = `/interactions/${interactionId}/${interactionToken}/callback`
    for (const embeds of invalidEmbeds) {
      const callback = await request(callbackPath, 'POST', {
        type: 4,
        data: { embeds },
      })
      expect(callback.status).toBe(400)
      expect(await callback.json()).toMatchObject({ code: 50_035 })
      const webhook = await request(webhookPath + '?wait=true', 'POST', {
        content: 'rejected',
        embeds,
      })
      expect(webhook.status).toBe(400)
    }
    expect(server.db.prepare('SELECT * FROM messages').all()).toEqual([])
    const callback = await request(callbackPath, 'POST', {
      type: 4,
      data: { embeds: maximumEmbeds },
    })
    expect(callback.status).toBe(204)
    const callbackCreate = await next()
    expect(callbackCreate.t).toBe('MESSAGE_CREATE')
    for (const path of [webhookPath, followupPath]) {
      for (const wait of ['true', 'false']) {
        const invalid = await request(path + '?wait=' + wait, 'POST', {
          content: 'rejected',
          embeds: [null],
        })
        expect(invalid.status).toBe(400)
      }
      const response = await request(path + '?wait=1', 'POST', {
        embeds: maximumEmbeds,
      })
      expect(response.status).toBe(200)
      const message = (await response.json()) as { id: string }
      const webhookCreate = await next()
      expect(webhookCreate.t).toBe('MESSAGE_CREATE')
      const rows = server.db.prepare('SELECT * FROM messages').all()
      const embedRows = server.db.prepare('SELECT * FROM embeds').all()
      for (const embeds of invalidEmbeds) {
        const edit = await request(`${path}/messages/${message.id}`, 'PATCH', {
          content: 'rejected',
          embeds,
        })
        expect(edit.status).toBe(400)
        expect(await edit.json()).toMatchObject({ code: 50_035 })
        const originalEdit = await request(
          `${followupPath}/messages/@original`,
          'PATCH',
          { content: 'rejected', embeds }
        )
        expect(originalEdit.status).toBe(400)
      }
      expect(server.db.prepare('SELECT * FROM messages').all()).toEqual(rows)
      expect(server.db.prepare('SELECT * FROM embeds').all()).toEqual(embedRows)
      const webhookRecovery = await request(
        `${path}/messages/${message.id}`,
        'PATCH',
        {
          embeds: maximumEmbeds,
        }
      )
      expect(webhookRecovery.status).toBe(200)
      const webhookUpdate = await next()
      expect(webhookUpdate.t).toBe('MESSAGE_UPDATE')
    }
    const originalRecovery = await request(
      `${followupPath}/messages/@original`,
      'PATCH',
      {
        embeds: maximumEmbeds,
      }
    )
    expect(originalRecovery.status).toBe(200)
    const originalUpdate = await next()
    expect(originalUpdate.t).toBe('MESSAGE_UPDATE')
    ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
    const finalAck = await next()
    expect(finalAck.op).toBe(GatewayOp.HeartbeatAck)
  })
})
