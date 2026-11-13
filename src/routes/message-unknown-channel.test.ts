import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
  seedMessage,
} from '../test-helpers'
import { gatewayBus } from '../gateway/bus'

type Method = 'GET' | 'PATCH' | 'DELETE'

const NEVER_EXISTED = '999999999999999999'

describe('single-message routes resolve the channel first', () => {
  let context: ReturnType<typeof createFullTestApp>
  let token: string
  let authorId: string
  let channel: string
  let message: string
  const update = vi.fn()
  const remove = vi.fn()
  const create = vi.fn()

  /** Sends a single-message request through the full middleware stack. */
  function request(
    method: Method,
    channelId: string,
    messageId: string,
    body?: unknown,
    authorization = token
  ) {
    return context.app.request(
      `/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }
    )
  }

  /** Counts stored messages across every channel. */
  function messageCount(): number {
    return (
      context.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as {
        n: number
      }
    ).n
  }

  beforeEach(() => {
    context = createFullTestApp()
    token = seedBot(context.db)
    authorId = (
      context.db
        .prepare('SELECT user_id FROM bots WHERE token = ?')
        .get(token) as { user_id: string }
    ).user_id
    channel = seedChannel(context.db, seedGuild(context.db, token))
    message = seedMessage(context.db, channel, authorId, token, 'rules')
    for (const mock of [update, remove, create]) mock.mockClear()
    gatewayBus.on('message.update', update)
    gatewayBus.on('message.delete', remove)
    gatewayBus.on('message.create', create)
  })
  afterEach(() => {
    gatewayBus.off('message.update', update)
    gatewayBus.off('message.delete', remove)
    gatewayBus.off('message.create', create)
    context.cleanup()
  })

  /** Asserts a 404 with the given Discord error code and message. */
  async function expectError(
    response: Response,
    code: number,
    text: string
  ): Promise<void> {
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ message: text, code })
  }

  const cases: [Method, unknown][] = [
    ['GET', undefined],
    ['PATCH', { content: 'edited' }],
    ['DELETE', undefined],
  ]

  describe.each(cases)('%s', (method, body) => {
    it('returns 10003 for a channel that never existed', async () => {
      const response = await request(method, NEVER_EXISTED, message, body)
      await expectError(response, 10_003, 'Unknown Channel')
      expect(messageCount()).toBe(1)
      expect(update).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    })

    it('returns 10003 for a channel deleted after a message was posted', async () => {
      const posted = await context.app.request(
        `/api/v10/channels/${channel}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: 'posted' }),
        }
      )
      const { id } = (await posted.json()) as { id: string }
      const deleted = await context.app.request(
        `/api/v10/channels/${channel}`,
        {
          method: 'DELETE',
          headers: { Authorization: token },
        }
      )
      expect(deleted.status).toBe(200)
      expect(messageCount()).toBe(0)
      create.mockClear()
      update.mockClear()
      remove.mockClear()

      const response = await request(method, channel, id, body)
      await expectError(response, 10_003, 'Unknown Channel')
      expect(messageCount()).toBe(0)
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    })

    it('returns 10003 before body validation and ownership checks', async () => {
      const invalid = method === 'PATCH' ? { content: 'a'.repeat(2001) } : body
      const response = await request(method, NEVER_EXISTED, message, invalid)
      await expectError(response, 10_003, 'Unknown Channel')
    })

    it('keeps 10008 for an unknown message in an existing channel', async () => {
      const response = await request(method, channel, NEVER_EXISTED, body)
      await expectError(response, 10_008, 'Unknown Message')
      expect(messageCount()).toBe(1)
      expect(update).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    })

    it('keeps 10008 for a message that belongs to another channel', async () => {
      const other = seedChannel(
        context.db,
        seedGuild(context.db, token),
        '888888888888888888'
      )
      const response = await request(method, other, message, body)
      await expectError(response, 10_008, 'Unknown Message')
      expect(messageCount()).toBe(1)
      expect(update).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    })

    it('keeps 10008 for an ephemeral message', async () => {
      context.db
        .prepare('UPDATE messages SET flags = flags | 64 WHERE id = ?')
        .run(message)
      const response = await request(method, channel, message, body)
      await expectError(response, 10_008, 'Unknown Message')
      expect(messageCount()).toBe(1)
      expect(update).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    })
  })

  it('still serves, edits and deletes a message in an existing channel', async () => {
    const fetched = await request('GET', channel, message)
    expect(fetched.status).toBe(200)
    const edited = await request('PATCH', channel, message, { content: 'new' })
    expect(edited.status).toBe(200)
    expect(update).toHaveBeenCalledTimes(1)
    const removed = await request('DELETE', channel, message)
    expect(removed.status).toBe(204)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('still rejects unauthenticated requests with 401', async () => {
    const response = await context.app.request(
      `/api/v10/channels/${NEVER_EXISTED}/messages/${message}`
    )
    expect(response.status).toBe(401)
  })
})
