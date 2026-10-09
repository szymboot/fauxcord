import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import * as fs from 'node:fs/promises'
import { createRealServer } from '../test-helpers'
import { GatewayOp } from './opcodes'

const BOT = '111111111111111111'
const OWNER = '444444444444444444'
const GUILD = '222222222222222222'
const CHANNEL = '333333333333333333'
const TOKEN = 'Bot network-permissions'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

/** Buffers real Gateway frames and bounds every read. */
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
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Gateway frame timed out'))
          }, 2000)
          waiters.push((next) => {
            clearTimeout(timer)
            resolve(next)
          })
        })
  }
}

/** Resolves an HTTP request and returns its status for concise assertions. */
async function responseStatus(response: Promise<Response>): Promise<number> {
  const resolved = await response
  return resolved.status
}

describe('message-send permissions over real HTTP and WebSocket', () => {
  const servers: Awaited<ReturnType<typeof createRealServer>>[] = []
  const sockets: WebSocket[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const socket of sockets.splice(0)) socket.terminate()
    for (const server of servers.splice(0)) await server.close()
  })

  /** Starts a production server with a registered human owner and non-owner bot. */
  async function start() {
    const server = await createRealServer()
    servers.push(server)
    /** Performs bounded real HTTP requests. */
    const request = (path: string, body?: unknown, method = 'POST') =>
      fetch(`${server.baseUrl}${path}`, {
        method,
        headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(2000),
      })
    expect(
      await responseStatus(
        request('/_test/users', { id: OWNER, username: 'HumanOwner' })
      )
    ).toBe(201)
    expect(
      await responseStatus(
        request('/_test/setup', {
          token: TOKEN,
          user: { id: BOT },
          guilds: [
            {
              id: GUILD,
              name: 'Log guild',
              owner_id: OWNER,
              channels: [{ id: CHANNEL, name: 'log' }],
            },
          ],
        })
      )
    ).toBe(201)
    const ws = new WebSocket(server.baseUrl.replace('http://', 'ws://'))
    sockets.push(ws)
    const next = frameReader(ws)
    expect(await next()).toMatchObject({ op: GatewayOp.Hello })
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: {
          token: TOKEN,
          intents:
            GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
        },
      })
    )
    const ready = await next()
    expect(ready.t).toBe('READY')
    const sessionId = (ready.d as { session_id: string }).session_id
    /** A heartbeat acknowledgement is an ordered barrier for absent events. */
    async function noCreate() {
      const sequence = server.sessionManager.get(sessionId)?.seq
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: sequence }))
      expect(await next()).toMatchObject({ op: GatewayOp.HeartbeatAck })
      expect(
        server.sessionManager
          .get(sessionId)
          ?.replayBuffer.filter((entry) => entry.event.t === 'MESSAGE_CREATE')
      ).toEqual([])
      expect(
        server.db.prepare('SELECT COUNT(*) AS count FROM messages').get()
      ).toEqual({ count: 0 })
      const channel = server.db
        .prepare('SELECT last_message_id FROM channels WHERE id = ?')
        .get(CHANNEL) as { last_message_id: string | null } | undefined
      expect(channel?.last_message_id ?? null).toBeNull()
    }
    return { server, request, next, noCreate }
  }

  it.each(['/api/v10', '/api', ''])(
    'denies access, sending and embeds without MESSAGE_CREATE, then recovers through %s',
    async (prefix) => {
      const { request, next, noCreate } = await start()
      for (const [deny, code] of [
        ['1024', 50_001],
        ['2048', 50_013],
        ['16384', 50_013],
      ] as const) {
        expect(
          await responseStatus(
            request(
              `/channels/${CHANNEL}/permissions/${BOT}`,
              { type: 1, deny },
              'PUT'
            )
          )
        ).toBe(204)
        const responses = await Promise.all(
          Array.from({ length: 3 }, () =>
            request(`${prefix}/channels/${CHANNEL}/messages`, {
              content: 'nickname changed',
              embeds: [{ description: 'old → new' }],
            })
          )
        )
        for (const response of responses) {
          expect(response.status).toBe(403)
          expect(await response.json()).toEqual({
            code,
            message: code === 50_001 ? 'Missing Access' : 'Missing Permissions',
          })
        }
        await noCreate()
      }
      expect(
        await responseStatus(
          request(
            `/channels/${CHANNEL}/permissions/${BOT}`,
            undefined,
            'DELETE'
          )
        )
      ).toBe(204)
      const response = await request(`${prefix}/channels/${CHANNEL}/messages`, {
        embeds: [{ description: 'old → new' }],
      })
      expect(response.status).toBe(200)
      const message = (await response.json()) as { id: string }
      expect(await next()).toMatchObject({
        t: 'MESSAGE_CREATE',
        d: {
          id: message.id,
          author: { id: BOT },
          embeds: [{ description: 'old → new' }],
        },
      })
    }
  )

  it.each(['/api/v10', '/api', ''])(
    'combines embed validation and permission recovery through %s',
    async (prefix) => {
      const { request, next, noCreate } = await start()
      const path = `${prefix}/channels/${CHANNEL}/messages`
      await request(
        `/channels/${CHANNEL}/permissions/${BOT}`,
        { type: 1, deny: '16384' },
        'PUT'
      )
      for (const embeds of [
        'not-an-array',
        [null],
        [{ description: 'x'.repeat(3001) }, { description: 'y'.repeat(3000) }],
      ]) {
        const invalid = await request(path, { embeds })
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toMatchObject({ code: 50_035 })
        await noCreate()
      }
      const embeds = [
        { description: 'x'.repeat(3000) },
        { description: 'y'.repeat(3000) },
      ]
      const denied = await request(path, { embeds })
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({
        code: 50_013,
        message: 'Missing Permissions',
      })
      await noCreate()
      await request(
        `/channels/${CHANNEL}/permissions/${BOT}`,
        undefined,
        'DELETE'
      )
      const accepted = await request(path, { embeds })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toMatchObject({ embeds })
      expect(await next()).toMatchObject({
        t: 'MESSAGE_CREATE',
        d: { embeds },
      })
    }
  )

  it('isolates identically named fixtures across server databases', async () => {
    const blocked = await start()
    const allowed = await start()
    await blocked.request(
      `/channels/${CHANNEL}/permissions/${BOT}`,
      { type: 1, deny: '2048' },
      'PUT'
    )
    const [denied, accepted] = await Promise.all([
      blocked.request(`/channels/${CHANNEL}/messages`, { content: 'blocked' }),
      allowed.request(`/channels/${CHANNEL}/messages`, { content: 'allowed' }),
    ])
    expect(denied.status).toBe(403)
    expect(accepted.status).toBe(200)
    await blocked.noCreate()
    expect(await allowed.next()).toMatchObject({
      t: 'MESSAGE_CREATE',
      d: { content: 'allowed' },
    })
  })

  it('retains real permissions across reset and clears them when a setup is recreated', async () => {
    const { request, next, noCreate } = await start()
    await request(
      `/channels/${CHANNEL}/permissions/${BOT}`,
      { type: 1, deny: '2048' },
      'PUT'
    )
    expect(
      await responseStatus(request('/_test/reset', { token: TOKEN }))
    ).toBe(204)
    expect(
      await responseStatus(
        request(`/channels/${CHANNEL}/messages`, {
          content: 'still denied',
        })
      )
    ).toBe(403)
    await noCreate()
    expect(
      await responseStatus(
        request(
          `/_test/setup/${encodeURIComponent(TOKEN)}`,
          undefined,
          'DELETE'
        )
      )
    ).toBe(204)
    expect(
      await responseStatus(
        request('/_test/setup', {
          token: TOKEN,
          user: { id: BOT },
          guilds: [
            {
              id: GUILD,
              name: 'Recreated',
              owner_id: OWNER,
              channels: [{ id: CHANNEL, name: 'log' }],
            },
          ],
        })
      )
    ).toBe(201)
    expect(
      await responseStatus(
        request(`/channels/${CHANNEL}/messages`, { content: 'recovered' })
      )
    ).toBe(200)
    expect(await next()).toMatchObject({
      t: 'MESSAGE_CREATE',
      d: { content: 'recovered' },
    })
  })

  it.each(['overwrite', 'membership', 'channel'])(
    'rechecks %s after disk preparation and removes unpublished uploads',
    async (change) => {
      const { server, request, next, noCreate } = await start()
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const { writeFile: original } =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises'
        )
      let writtenPath = ''
      // Only gate the filesystem await; HTTP, authorization, DB and WS stay real.
      vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
        await original(...args)
        if (typeof args[0] !== 'string') throw new Error('Expected upload path')
        writtenPath = args[0]
        entered.resolve(undefined)
        await release.promise
      })
      const form = new FormData()
      form.set(
        'payload_json',
        JSON.stringify({ embeds: [{ title: 'upload' }] })
      )
      form.set('files[0]', new File(['proof'], 'proof.txt'))
      const pending = fetch(`${server.baseUrl}/channels/${CHANNEL}/messages`, {
        method: 'POST',
        headers: { Authorization: TOKEN },
        body: form,
        signal: AbortSignal.timeout(4000),
      })
      try {
        await entered.promise
        switch (change) {
          case 'overwrite': {
            await request(
              `/channels/${CHANNEL}/permissions/${BOT}`,
              { type: 1, deny: '16384' },
              'PUT'
            )
            break
          }
          case 'membership': {
            await request(
              `/guilds/${GUILD}/members/${BOT}`,
              undefined,
              'DELETE'
            )
            break
          }
          case 'channel': {
            await request(`/channels/${CHANNEL}`, undefined, 'DELETE')
            break
          }
        }
      } finally {
        release.resolve(undefined)
      }
      const response = await pending
      expect(response.status).toBe(change === 'channel' ? 404 : 403)
      expect(await response.json()).toMatchObject({
        code:
          change === 'channel'
            ? 10_003
            : change === 'membership'
              ? 50_001
              : 50_013,
      })
      expect(
        server.db
          .prepare('SELECT COUNT(*) AS count FROM attachment_files')
          .get()
      ).toEqual({ count: 0 })
      await expect(fs.stat(writtenPath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await noCreate()
      if (change !== 'overwrite') return
      await request(
        `/channels/${CHANNEL}/permissions/${BOT}`,
        undefined,
        'DELETE'
      )
      const retried = await fetch(
        `${server.baseUrl}/channels/${CHANNEL}/messages`,
        {
          method: 'POST',
          headers: { Authorization: TOKEN },
          body: form,
          signal: AbortSignal.timeout(2000),
        }
      )
      expect(retried.status).toBe(200)
      expect(await next()).toMatchObject({
        t: 'MESSAGE_CREATE',
        d: { attachments: [{ filename: 'proof.txt' }] },
      })
    }
  )
})
