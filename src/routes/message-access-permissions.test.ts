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

describe('message access checks', () => {
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

  it('resolves thread messages against the parent channel overwrites', async () => {
    const thread = '888888888888888801'
    fixture.db
      .prepare(
        `INSERT INTO channels (id, guild_id, type, name, parent_id)
         VALUES (?, ?, 11, 'thread', ?)`
      )
      .run(thread, GUILD, CHANNEL)
    const message = seedMessage(fixture.db, thread, BOT, TOKEN, 'in thread')
    const url = `/api/v10/channels/${thread}/messages/${message}`
    await everyone(VIEW)
    // Parent lacks READ_MESSAGE_HISTORY: GET refused, PATCH allowed.
    expect(await statusOf(request(url))).toBe(403)
    await overwrite(BOT, 1, HISTORY, 0n)
    expect(await statusOf(request(url))).toBe(200)
    // Parent denies VIEW_CHANNEL: everything refused.
    await overwrite(BOT, 1, 0n, VIEW)
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await request(
        url,
        method,
        method === 'PATCH' ? { content: 'x' } : undefined
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(MISSING_ACCESS)
    }
    // Parent overwrite re-allows access.
    await overwrite(BOT, 1, VIEW | HISTORY, 0n)
    expect(await statusOf(request(url, 'DELETE'))).toBe(204)
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

  describe('message history list', () => {
    let newest: string

    beforeEach(() => {
      newest = seedMessage(fixture.db, CHANNEL, BOT, TOKEN, 'newest')
    })

    /** Every page shape of the list route with the IDs a reader receives. */
    const shapes: [string, () => { query: string; ids: string[] }][] = [
      [
        'no cursor',
        () => ({ query: '', ids: [newest, foreignMessage, ownMessage] }),
      ],
      ['limit', () => ({ query: '?limit=1', ids: [newest] })],
      [
        'maximum limit',
        () => ({
          query: '?limit=100',
          ids: [newest, foreignMessage, ownMessage],
        }),
      ],
      [
        'before',
        () => ({
          query: `?before=${newest}`,
          ids: [foreignMessage, ownMessage],
        }),
      ],
      [
        'after',
        () => ({
          query: `?after=${ownMessage}`,
          ids: [newest, foreignMessage],
        }),
      ],
      [
        'around',
        () => ({
          query: `?around=${foreignMessage}&limit=3`,
          ids: [newest, foreignMessage, ownMessage],
        }),
      ],
    ]

    /** Requests one history page of a channel. */
    function history(
      query = '',
      channel = CHANNEL,
      prefix = '/api/v10',
      token = TOKEN
    ) {
      return request(
        `${prefix}/channels/${channel}/messages${query}`,
        'GET',
        undefined,
        token
      )
    }

    /** Asserts a successful page and returns its message IDs. */
    async function idsOf(response: Response | Promise<Response>) {
      const resolved = await response
      expect(resolved.status).toBe(200)
      const messages = (await resolved.json()) as { id: string }[]
      return messages.map(({ id }) => id)
    }

    /** Asserts a `403` / `50001` refusal. */
    async function expectMissingAccess(response: Response | Promise<Response>) {
      const resolved = await response
      expect(resolved.status).toBe(403)
      expect(await resolved.json()).toEqual(MISSING_ACCESS)
    }

    /** Removes the bot from the guild. */
    function removeBot() {
      fixture.db
        .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
        .run(GUILD, BOT)
    }

    describe.each(shapes)('page shape: %s', (_name, shape) => {
      it('returns the page with VIEW_CHANNEL and READ_MESSAGE_HISTORY', async () => {
        await everyone(VIEW | HISTORY)
        const { query, ids } = shape()
        expect(await idsOf(history(query))).toEqual(ids)
      })

      it('refuses a caller that is not a member of the guild', async () => {
        removeBot()
        await expectMissingAccess(history(shape().query))
      })

      it('refuses a caller without VIEW_CHANNEL', async () => {
        await everyone(HISTORY | SEND)
        await expectMissingAccess(history(shape().query))
      })

      it('returns no messages without READ_MESSAGE_HISTORY', async () => {
        await everyone(VIEW | SEND)
        expect(await idsOf(history(shape().query))).toEqual([])
      })
    })

    it.each(['/api/v10', '/api', ''])(
      'applies each check through the %s prefix',
      async (prefix) => {
        expect(await idsOf(history('', CHANNEL, prefix))).toHaveLength(3)
        await everyone(VIEW)
        expect(await idsOf(history('', CHANNEL, prefix))).toEqual([])
        await everyone(HISTORY)
        await expectMissingAccess(history('', CHANNEL, prefix))
      }
    )

    it('reports a missing VIEW_CHANNEL even without READ_MESSAGE_HISTORY', async () => {
      await everyone(0n)
      await expectMissingAccess(history())
    })

    it('answers an unknown channel before any access check', async () => {
      removeBot()
      const response = await history('', '999999999999999999')
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 10_003 })
    })

    it('checks access before reading the query parameters', async () => {
      const query = '?limit=abc&before=abc&after=abc'
      await everyone(VIEW)
      expect(await idsOf(history(query))).toEqual([])
      await everyone(0n)
      await expectMissingAccess(history(query))
    })

    it('exempts the guild owner from overwrites and permissions', async () => {
      const owner = '555555555555555555'
      const owned = setupTestEnvironment(fixture.db, {
        token: 'Bot owned',
        user: { id: owner },
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
      const message = seedMessage(fixture.db, channel, owner, 'Bot owned')
      expect(
        await idsOf(history('', channel, '/api/v10', 'Bot owned'))
      ).toEqual([message])
    })

    it('exempts a guild-level ADMINISTRATOR but not an overwrite ADMINISTRATOR', async () => {
      await everyone(0n)
      await overwrite(BOT, 1, ADMIN, VIEW | HISTORY)
      await expectMissingAccess(history())
      await role(ADMIN)
      expect(await idsOf(history())).toHaveLength(3)
    })

    it('combines @everyone and role permissions', async () => {
      await everyone(VIEW)
      expect(await idsOf(history())).toEqual([])
      await role(HISTORY, false)
      expect(await idsOf(history())).toEqual([])
      await role(HISTORY)
      expect(await idsOf(history())).toHaveLength(3)
    })

    it.each([
      ['@everyone', GUILD, 0],
      ['an assigned role', undefined, 0],
      ['the member', BOT, 1],
    ] as const)(
      'lets an overwrite for %s deny a role-granted READ_MESSAGE_HISTORY',
      async (_name, target, type) => {
        await everyone(0n)
        const reader = await role(VIEW | HISTORY)
        expect(await idsOf(history())).toHaveLength(3)
        await overwrite(target ?? reader, type, 0n, HISTORY)
        expect(await idsOf(history())).toEqual([])
      }
    )

    it.each([
      ['@everyone', GUILD, 0],
      ['an assigned role', undefined, 0],
      ['the member', BOT, 1],
    ] as const)(
      'lets an overwrite for %s grant a READ_MESSAGE_HISTORY the role lacks',
      async (_name, target, type) => {
        await everyone(0n)
        const viewer = await role(VIEW)
        expect(await idsOf(history())).toEqual([])
        await overwrite(target ?? viewer, type, HISTORY, 0n)
        expect(await idsOf(history())).toHaveLength(3)
      }
    )

    it.each([
      ['@everyone', GUILD, 0],
      ['an assigned role', undefined, 0],
      ['the member', BOT, 1],
    ] as const)(
      'lets an overwrite for %s deny a role-granted VIEW_CHANNEL',
      async (_name, target, type) => {
        await everyone(0n)
        const reader = await role(VIEW | HISTORY)
        await overwrite(target ?? reader, type, 0n, VIEW)
        await expectMissingAccess(history())
      }
    )

    it('applies everyone, role and member overwrites in order', async () => {
      const reader = await role(0n)
      await everyone(VIEW | HISTORY)
      await overwrite(GUILD, 0, 0n, HISTORY)
      expect(await idsOf(history())).toEqual([])
      await overwrite(reader, 0, HISTORY, 0n)
      expect(await idsOf(history())).toHaveLength(3)
      await overwrite(BOT, 1, 0n, HISTORY)
      expect(await idsOf(history())).toEqual([])
      await overwrite(reader, 0, 0n, HISTORY)
      await overwrite(BOT, 1, HISTORY, 0n)
      expect(await idsOf(history())).toHaveLength(3)
    })

    it('resolves thread history against the parent channel overwrites', async () => {
      const thread = '888888888888888801'
      fixture.db
        .prepare(
          `INSERT INTO channels (id, guild_id, type, name, parent_id)
           VALUES (?, ?, 11, 'thread', ?)`
        )
        .run(thread, GUILD, CHANNEL)
      const message = seedMessage(fixture.db, thread, BOT, TOKEN, 'in thread')
      await everyone(VIEW | HISTORY)
      await overwrite(BOT, 1, 0n, HISTORY)
      expect(await idsOf(history('', thread))).toEqual([])
      await overwrite(BOT, 1, 0n, VIEW)
      await expectMissingAccess(history('', thread))
      await everyone(0n)
      await overwrite(BOT, 1, VIEW | HISTORY, 0n)
      expect(await idsOf(history('', thread))).toEqual([message])
    })

    it('runs a history page fault before the permission check', async () => {
      await everyone(0n)
      const armed = await request('/_test/rest-faults', 'POST', {
        method: 'GET',
        path: `/channels/${CHANNEL}/messages`,
        status: 500,
        code: 0,
        message: 'Page failed',
        times: 2,
      })
      expect(armed.status).toBe(201)
      for (let attempt = 0; attempt < 2; attempt++) {
        const faulted = await history()
        expect(faulted.status).toBe(500)
        expect(await faulted.json()).toEqual({
          code: 0,
          message: 'Page failed',
        })
      }
      await expectMissingAccess(history())
    })

    it('leaves the control endpoint unchecked', async () => {
      removeBot()
      const response = await request(`/_test/messages/${CHANNEL}`)
      expect(response.status).toBe(200)
      const { messages } = (await response.json()) as { messages: unknown[] }
      expect(messages).toHaveLength(3)
    })

    it('does not apply guild checks to Bearer callers', async () => {
      removeBot()
      const issued = await request('/_test/oauth2/tokens', 'POST', {
        client_id: BOT,
        user_id: BOT,
        scope: 'identify',
      })
      expect(issued.status).toBe(201)
      const { access_token: token } = (await issued.json()) as {
        access_token: string
      }
      expect(
        await idsOf(history('', CHANNEL, '/api/v10', `Bearer ${token}`))
      ).toHaveLength(3)
    })

    it('does not apply guild checks to DM channels', async () => {
      const dm = '777777777777777777'
      fixture.db
        .prepare(
          'INSERT INTO channels (id, type, guild_id, name) VALUES (?, 1, NULL, NULL)'
        )
        .run(dm)
      const message = seedMessage(fixture.db, dm, BOT, TOKEN, 'dm')
      expect(await idsOf(history('', dm))).toEqual([message])
    })
  })
})
