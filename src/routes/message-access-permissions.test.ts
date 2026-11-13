import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFullTestApp, seedMember, seedMessage } from '../test-helpers'
import { setupTestEnvironment } from '../services/test-control'
import { addMemberRole } from '../services/guild-members'
import { gatewayBus } from '../gateway/bus'

const VIEW = 1n << 10n
const SEND = 1n << 11n
const HISTORY = 1n << 16n
const ADMIN = 1n << 3n
const BOT = '111111111111111111'
const GUILD = '222222222222222222'
const CHANNEL = '333333333333333333'
const TOKEN = 'Bot access-test'
const MISSING_ACCESS = { code: 50_001, message: 'Missing Access' }
const MISSING_PERMISSIONS = { code: 50_013, message: 'Missing Permissions' }

/** Resolves a request and returns its status. */
async function statusOf(
  response: Response | Promise<Response>
): Promise<number> {
  const resolved = await response
  return resolved.status
}

/** Resolves a request and returns its JSON body. */
async function bodyOf(
  response: Response | Promise<Response>
): Promise<unknown> {
  const resolved = await response
  return resolved.json()
}

describe('single-message access checks', () => {
  let fixture: ReturnType<typeof createFullTestApp>
  let ownMessage: string
  let foreignMessage: string
  let dispatched: string[]
  const record = (name: string) => (): void => {
    dispatched.push(name)
  }
  const onUpdate = record('update')
  const onDelete = record('delete')

  /** Sends a request through the complete application and auth stack. */
  function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token = TOKEN
  ) {
    return fixture.app.request(path, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Changes the base `@everyone` permissions through Discord REST. */
  async function everyone(permissions: bigint) {
    const response = await request(
      `/api/v10/guilds/${GUILD}/roles/${GUILD}`,
      'PATCH',
      { permissions: String(permissions) }
    )
    expect(response.status).toBe(200)
  }

  /** Creates a role and optionally assigns it to the bot. */
  async function role(permissions: bigint, assigned = true) {
    const response = await request(`/api/v10/guilds/${GUILD}/roles`, 'POST', {
      name: 'reader',
      permissions: String(permissions),
    })
    const { id } = (await response.json()) as { id: string }
    if (assigned) expect(addMemberRole(fixture.db, GUILD, BOT, id)).toBe(true)
    return id
  }

  /** Adds or replaces a channel overwrite through Discord REST. */
  async function overwrite(id: string, type: number, allow = 0n, deny = 0n) {
    const response = await request(
      `/api/v10/channels/${CHANNEL}/permissions/${id}`,
      'PUT',
      { type, allow: String(allow), deny: String(deny) }
    )
    expect(response.status).toBe(204)
  }

  /** The three single-message calls, keyed by method. */
  const calls = {
    GET: (id: string, prefix = '/api/v10') =>
      request(`${prefix}/channels/${CHANNEL}/messages/${id}`),
    PATCH: (id: string, prefix = '/api/v10') =>
      request(`${prefix}/channels/${CHANNEL}/messages/${id}`, 'PATCH', {
        content: 'edited',
      }),
    DELETE: (id: string, prefix = '/api/v10') =>
      request(`${prefix}/channels/${CHANNEL}/messages/${id}`, 'DELETE'),
  }

  /** Reads the stored content of a message, or undefined when it is gone. */
  function storedContent(id: string): string | undefined {
    return (
      fixture.db
        .prepare('SELECT content FROM messages WHERE id = ?')
        .get(id) as { content: string } | undefined
    )?.content
  }

  /** Asserts a refusal changed nothing and dispatched nothing. */
  function expectUntouched() {
    expect(storedContent(ownMessage)).toBe('mine')
    expect(storedContent(foreignMessage)).toBe('theirs')
    expect(dispatched).toEqual([])
  }

  beforeEach(() => {
    fixture = createFullTestApp()
    dispatched = []
    gatewayBus.on('message.update', onUpdate)
    gatewayBus.on('message.delete', onDelete)
    const owner = seedMember(
      fixture.db,
      setupTestEnvironment(fixture.db, {
        token: 'Bot owner-fixture',
        guilds: [{ name: 'Owner fixture' }],
      }).guilds[0].id
    )
    setupTestEnvironment(fixture.db, {
      token: TOKEN,
      user: { id: BOT },
      guilds: [
        {
          id: GUILD,
          name: 'Access guild',
          owner_id: owner,
          channels: [{ id: CHANNEL, name: 'rules' }],
        },
      ],
    })
    ownMessage = seedMessage(fixture.db, CHANNEL, BOT, TOKEN, 'mine')
    foreignMessage = seedMessage(fixture.db, CHANNEL, owner, 'Bot x', 'theirs')
  })

  afterEach(() => {
    gatewayBus.off('message.update', onUpdate)
    gatewayBus.off('message.delete', onDelete)
    fixture.cleanup()
  })

  it('keeps the success paths working with the default permissions', async () => {
    expect(await statusOf(calls.GET(ownMessage))).toBe(200)
    const edited = await calls.PATCH(ownMessage)
    expect(edited.status).toBe(200)
    expect(storedContent(ownMessage)).toBe('edited')
    expect(await statusOf(calls.DELETE(ownMessage))).toBe(204)
    expect(storedContent(ownMessage)).toBeUndefined()
  })

  it.each(['/api/v10', '/api', ''])(
    'refuses all three calls without VIEW_CHANNEL through %s',
    async (prefix) => {
      await everyone(HISTORY | SEND)
      for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
        const response = await calls[method](ownMessage, prefix)
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual(MISSING_ACCESS)
      }
      expectUntouched()
    }
  )

  it('checks access before message lookup, ownership and body validation', async () => {
    await everyone(0n)
    const unknown = await calls.GET('999999999999999999')
    expect(await unknown.json()).toEqual(MISSING_ACCESS)
    // Not the author: would be 50005 without the access check.
    const foreign = await calls.PATCH(foreignMessage)
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toEqual(MISSING_ACCESS)
    // Invalid body: would be 400 without the access check.
    const invalid = await request(
      `/api/v10/channels/${CHANNEL}/messages/${ownMessage}`,
      'PATCH',
      { content: 'x'.repeat(2001) }
    )
    expect(invalid.status).toBe(403)
    expect(await invalid.json()).toEqual(MISSING_ACCESS)
    expectUntouched()
  })

  it('re-checks access after the PATCH body has been read', async () => {
    const encoder = new TextEncoder()
    const gate = Promise.withResolvers<undefined>()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('{"content":'))
        await gate.promise
        controller.enqueue(encoder.encode('"edited"}'))
        controller.close()
      },
    })
    const pending = fixture.app.request(
      `/api/v10/channels/${CHANNEL}/messages/${ownMessage}`,
      {
        method: 'PATCH',
        headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit
    )
    // Revoke access while the request body is still streaming.
    await new Promise((resolve) => setTimeout(resolve, 20))
    fixture.db
      .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
      .run(GUILD, BOT)
    gate.resolve(undefined)
    const response = await pending
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(MISSING_ACCESS)
    expectUntouched()
  })

  it('keeps the authorship rule after the access check', async () => {
    const response = await calls.PATCH(foreignMessage)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 50_005 })
  })

  it('refuses a role without VIEW_CHANNEL and allows one that has it', async () => {
    await everyone(0n)
    await role(SEND)
    expect(await statusOf(calls.GET(ownMessage))).toBe(403)
    await role(VIEW | HISTORY)
    expect(await statusOf(calls.GET(ownMessage))).toBe(200)
    expect(await statusOf(calls.PATCH(ownMessage))).toBe(200)
  })

  it.each([
    ['@everyone', GUILD, 0],
    ['an assigned role', undefined, 0],
    ['the member', BOT, 1],
  ] as const)(
    'honors an overwrite denying VIEW_CHANNEL to %s',
    async (_name, target, type) => {
      await everyone(VIEW | HISTORY)
      const id = target ?? (await role(0n))
      await overwrite(id, type, 0n, VIEW)
      for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
        const response = await calls[method](ownMessage)
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual(MISSING_ACCESS)
      }
      expectUntouched()
    }
  )

  it('lets a member overwrite re-allow what @everyone and a role deny', async () => {
    await everyone(VIEW | HISTORY)
    await overwrite(GUILD, 0, 0n, VIEW)
    const id = await role(0n)
    await overwrite(id, 0, 0n, VIEW)
    expect(await statusOf(calls.GET(ownMessage))).toBe(403)
    await overwrite(BOT, 1, VIEW, 0n)
    expect(await statusOf(calls.GET(ownMessage))).toBe(200)
    expect(await statusOf(calls.PATCH(ownMessage))).toBe(200)
    expect(await statusOf(calls.DELETE(ownMessage))).toBe(204)
  })

  it('requires READ_MESSAGE_HISTORY on GET only', async () => {
    await everyone(VIEW | SEND)
    const read = await calls.GET(ownMessage)
    expect(read.status).toBe(403)
    expect(await read.json()).toEqual(MISSING_PERMISSIONS)
    expect(await statusOf(calls.PATCH(ownMessage))).toBe(200)
    expect(await statusOf(calls.DELETE(ownMessage))).toBe(204)
  })

  it('lets a member overwrite grant READ_MESSAGE_HISTORY back', async () => {
    await everyone(VIEW)
    expect(await statusOf(calls.GET(ownMessage))).toBe(403)
    await overwrite(BOT, 1, HISTORY, 0n)
    expect(await statusOf(calls.GET(ownMessage))).toBe(200)
  })

  it('reports VIEW_CHANNEL before READ_MESSAGE_HISTORY on GET', async () => {
    await everyone(0n)
    expect(await bodyOf(calls.GET(ownMessage))).toEqual(MISSING_ACCESS)
  })

  it('exempts the guild owner from overwrites and permissions', async () => {
    // The default setup makes the bot the owner of its guild.
    const owned = setupTestEnvironment(fixture.db, {
      token: 'Bot owned',
      user: { id: '555555555555555555' },
      guilds: [{ name: 'Owned', channels: [{ name: 'rules' }] }],
    }).guilds[0]
    const channel = owned.channels[0].id
    const put = await request(
      `/api/v10/channels/${channel}/permissions/${owned.id}`,
      'PUT',
      { type: 0, allow: '0', deny: String(VIEW | HISTORY) },
      'Bot owned'
    )
    expect(put.status).toBe(204)
    const message = seedMessage(
      fixture.db,
      channel,
      '555555555555555555',
      'Bot owned'
    )
    const base = `/api/v10/channels/${channel}/messages/${message}`
    expect(await statusOf(request(base, 'GET', undefined, 'Bot owned'))).toBe(
      200
    )
    expect(
      await statusOf(request(base, 'PATCH', { content: 'e' }, 'Bot owned'))
    ).toBe(200)
    expect(
      await statusOf(request(base, 'DELETE', undefined, 'Bot owned'))
    ).toBe(204)
  })

  it('exempts a guild-level ADMINISTRATOR but not an overwrite ADMINISTRATOR', async () => {
    await everyone(0n)
    await overwrite(BOT, 1, ADMIN, VIEW)
    expect(await statusOf(calls.GET(ownMessage))).toBe(403)
    await role(ADMIN)
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      expect(await statusOf(calls[method](ownMessage))).toBeLessThan(300)
    }
  })

  it('refuses a caller that is not a member of the guild', async () => {
    fixture.db
      .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
      .run(GUILD, BOT)
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const response = await calls[method](ownMessage)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(MISSING_ACCESS)
    }
    expectUntouched()
  })

  it('restores access when the denying overwrite is removed', async () => {
    await overwrite(BOT, 1, 0n, VIEW)
    expect(await statusOf(calls.GET(ownMessage))).toBe(403)
    const removed = await request(
      `/api/v10/channels/${CHANNEL}/permissions/${BOT}`,
      'DELETE'
    )
    expect(removed.status).toBe(204)
    expect(await statusOf(calls.GET(ownMessage))).toBe(200)
  })

  it('answers an unknown channel before any access check', async () => {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await request(
        '/api/v10/channels/999999999999999999/messages/999999999999999999',
        method,
        method === 'PATCH' ? { content: 'x' } : undefined
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 10_003 })
    }
  })

  it('keeps the message list unchanged', async () => {
    await everyone(0n)
    const response = await request(`/api/v10/channels/${CHANNEL}/messages`)
    expect(response.status).toBe(200)
  })

  it('does not apply guild checks to DM channels', async () => {
    const other = '777777777777777777'
    fixture.db
      .prepare(
        'INSERT INTO channels (id, type, guild_id, name) VALUES (?, 1, NULL, NULL)'
      )
      .run(other)
    const message = seedMessage(fixture.db, other, BOT, TOKEN, 'dm')
    const response = await request(
      `/api/v10/channels/${other}/messages/${message}`
    )
    expect(response.status).toBe(200)
  })
})
