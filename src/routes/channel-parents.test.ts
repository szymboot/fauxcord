import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, initializeDatabase, type Database } from '../db'
import { buildApp } from '../app'
import { gatewayBus } from '../gateway/bus'

const token = 'Bot channel-parents'
const guildId = '222222222222222222'
const otherGuildId = '222222222222222223'
const categoryId = '1300000000000000002'
const nextCategoryId = '1300000000000000003'
const otherCategoryId = '1300000000000000004'
const textId = '444444444444444444'
const missingId = '999999999999999999'

describe.each(['/api/v10', '/api', ''])('Channel parents at %s', (prefix) => {
  let context: ReturnType<typeof buildApp> & { db: Database }

  /** Sends an authenticated native request through all app middleware. */
  function api(path: string, method = 'GET', body?: unknown) {
    return context.app.request(`${prefix}${path}`, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Sends raw JSON without rounding unquoted 19-digit integer Snowflakes. */
  function rawApi(path: string, method: string, body: string) {
    return context.app.request(`${prefix}${path}`, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body,
    })
  }

  /** Captures fixture state to verify rejected requests are atomic. */
  function snapshot() {
    return Object.fromEntries(
      ['bots', 'users', 'guilds', 'channels', 'guild_members', 'roles'].map(
        (table) => [table, context.db.prepare(`SELECT * FROM ${table}`).all()]
      )
    )
  }

  /** Creates a channel with the requested category parent. */
  function create(body: Record<string, unknown>) {
    return api(`/guilds/${guildId}/channels`, 'POST', { name: 'item', ...body })
  }

  /** Awaits a response and parses its JSON body. */
  async function readJson(
    pending: Response | Promise<Response>
  ): Promise<unknown> {
    const response = await pending
    return response.json()
  }

  /** Awaits a response and returns its HTTP status. */
  async function readStatus(
    pending: Response | Promise<Response>
  ): Promise<number> {
    const response = await pending
    return response.status
  }

  beforeEach(async () => {
    const db = initializeDatabase(':memory:')
    context = {
      ...buildApp(db, { baseUrl: 'http://localhost:3000', disableAuth: false }),
      db,
    }
    const response = await context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({
        token,
        guilds: [
          {
            id: guildId,
            name: 'Shop',
            channels: [
              { id: categoryId, name: 'shop', type: 4 },
              { id: nextCategoryId, name: 'archive', type: 4 },
              { id: textId, name: 'general', type: 0 },
            ],
          },
          {
            id: otherGuildId,
            name: 'Other',
            channels: [{ id: otherCategoryId, name: 'other', type: 4 }],
          },
        ],
      }),
    })
    expect(response.status).toBe(201)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    context.unsubscribeGateway()
    context.shutdownRestPageHolds()
    context.shutdownRestFaults()
    context.wss.close()
    closeDatabase(context.db)
  })

  it.each(['legacy', 'rate_limit', 'delay'])(
    'preserves parent state before native validation for %s POST/PATCH faults',
    async (mode) => {
      const createPath = `/guilds/${guildId}/channels`
      const updatePath = `/channels/${textId}`
      expect(
        await readStatus(api(updatePath, 'PATCH', { parent_id: categoryId }))
      ).toBe(200)
      const failureStatus = mode === 'rate_limit' ? 429 : 403

      /** Arms one exact owner-bound selector through the test control API. */
      async function arm(method: string, path: string, times: number) {
        const response = await context.app.request('/_test/rest-faults', {
          method: 'POST',
          body: JSON.stringify({
            method,
            path,
            times,
            status: failureStatus,
            code: 50_013,
            message: 'Selected parent failure',
            ...(mode !== 'legacy' && { mode }),
            ...(mode === 'rate_limit' && { retry_after: 0.01 }),
            ...(mode === 'delay' && { delay_ms: 1 }),
          }),
        })
        expect(response.status).toBe(201)
        return response.json() as Promise<{ id: string }>
      }

      /** Reads retained control counters without making a native request. */
      async function inspect(id: string) {
        return readJson(context.app.request(`/_test/rest-faults/${id}`))
      }

      /** Checks the selected failure contract rather than a native field error. */
      async function expectSelected(response: Response) {
        expect(response.status).toBe(failureStatus)
        expect(await response.json()).toEqual(
          mode === 'rate_limit'
            ? {
                message: 'Selected parent failure',
                retry_after: 0.01,
                global: false,
              }
            : { message: 'Selected parent failure', code: 50_013 }
        )
      }

      const postFault = await arm('POST', createPath, 2)
      const patchFault = await arm('PATCH', updatePath, 3)
      const initial = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const validCreate = `{"name":"fault-parent","parent_id":${categoryId}}`
      const invalidCreate = `{"name":"fault-parent","parent_id":${missingId}}`
      for (const body of [invalidCreate, validCreate]) {
        await expectSelected(await rawApi(createPath, 'POST', body))
        expect(snapshot()).toEqual(initial)
        expect(emit).not.toHaveBeenCalled()
      }
      expect(await inspect(postFault.id)).toMatchObject({
        remaining: 0,
        consumed: 2,
      })
      expect(await inspect(patchFault.id)).toMatchObject({
        remaining: 3,
        consumed: 0,
      })
      const invalidPostRetry = await rawApi(createPath, 'POST', invalidCreate)
      expect(invalidPostRetry.status).toBe(400)
      expect(await invalidPostRetry.json()).toMatchObject({
        code: 50_035,
        errors: { parent_id: expect.any(Object) },
      })
      expect(snapshot()).toEqual(initial)
      expect(emit).not.toHaveBeenCalled()
      const postRetry = await rawApi(createPath, 'POST', validCreate)
      expect(postRetry.status).toBe(201)
      const created = (await postRetry.json()) as {
        id: string
        parent_id: string
      }
      expect(created.parent_id).toBe(categoryId)
      expect(await readJson(api(`/channels/${created.id}`))).toMatchObject({
        parent_id: categoryId,
      })
      expect(emit).toHaveBeenCalledExactlyOnceWith('channel.create', {
        channel: expect.objectContaining({
          id: created.id,
          parent_id: categoryId,
        }),
      })

      emit.mockClear()
      const beforeEdits = snapshot()
      const move = `{"name":"moved","parent_id":${nextCategoryId}}`
      const clear = '{"parent_id":null}'
      const invalidMove = `{"name":"must-not-change","parent_id":${otherCategoryId}}`
      for (const body of [move, clear, invalidMove]) {
        await expectSelected(await rawApi(updatePath, 'PATCH', body))
        expect(snapshot()).toEqual(beforeEdits)
        expect(emit).not.toHaveBeenCalled()
      }
      expect(await inspect(patchFault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
      const invalidPatchRetry = await rawApi(updatePath, 'PATCH', invalidMove)
      expect(invalidPatchRetry.status).toBe(400)
      expect(await invalidPatchRetry.json()).toMatchObject({
        code: 50_035,
        errors: { parent_id: expect.any(Object) },
      })
      expect(snapshot()).toEqual(beforeEdits)
      expect(emit).not.toHaveBeenCalled()
      for (const [body, parent] of [
        [move, nextCategoryId],
        [clear, null],
        ['{"topic":"omitted parent"}', null],
      ] as const) {
        const response = await rawApi(updatePath, 'PATCH', body)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ parent_id: parent })
        expect(
          context.db
            .prepare('SELECT parent_id FROM channels WHERE id = ?')
            .get(textId)
        ).toEqual({ parent_id: parent })
        expect(emit).toHaveBeenLastCalledWith('channel.update', {
          channel: expect.objectContaining({ id: textId, parent_id: parent }),
        })
      }
      expect(emit).toHaveBeenCalledTimes(3)
      expect(await inspect(postFault.id)).toMatchObject({
        remaining: 0,
        consumed: 2,
      })
      expect(await inspect(patchFault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
    }
  )

  it.each([0, 2, 5, 13, 15, 16])(
    'creates and moves type %i with persisted parents and Gateway events',
    async (type) => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await create({ type, parent_id: categoryId })
      expect(response.status).toBe(201)
      const channel = (await response.json()) as { id: string }
      expect(emit).toHaveBeenCalledWith('channel.create', {
        channel: expect.objectContaining({
          id: channel.id,
          parent_id: categoryId,
        }),
      })

      for (const body of [
        { name: 'renamed' },
        { parent_id: nextCategoryId },
        { parent_id: null },
      ]) {
        const updated = await api(`/channels/${channel.id}`, 'PATCH', body)
        expect(updated.status).toBe(200)
        const parent = 'parent_id' in body ? body.parent_id : categoryId
        expect(await updated.json()).toMatchObject({ parent_id: parent })
        expect(await readJson(api(`/channels/${channel.id}`))).toMatchObject({
          parent_id: parent,
        })
        const listed = (await readJson(api(`/guilds/${guildId}/channels`))) as {
          id: string
          parent_id: string | null
        }[]
        expect(listed.find((entry) => entry.id === channel.id)?.parent_id).toBe(
          parent
        )
        expect(emit).toHaveBeenLastCalledWith('channel.update', {
          channel: expect.objectContaining({
            id: channel.id,
            parent_id: parent,
          }),
        })
      }
    }
  )

  it('preserves exact integer parent IDs from Python clients in REST and Gateway events', async () => {
    const emit = vi.spyOn(gatewayBus, 'emit')
    const created = await rawApi(
      `/guilds/${guildId}/channels`,
      'POST',
      `{"name":"numeric-parent","parent_id":${categoryId},"position":2}`
    )
    expect(created.status).toBe(201)
    const channel = (await created.json()) as {
      id: string
      parent_id: string
      position: number
    }
    expect(channel.parent_id).toBe(categoryId)
    expect(channel.position).toBe(2)
    expect(emit).toHaveBeenLastCalledWith('channel.create', {
      channel: expect.objectContaining({
        id: channel.id,
        parent_id: categoryId,
      }),
    })
    const updated = await rawApi(
      `/channels/${channel.id}`,
      'PATCH',
      `{"parent_id":${nextCategoryId}}`
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ parent_id: nextCategoryId })
    expect(await readJson(api(`/channels/${channel.id}`))).toMatchObject({
      parent_id: nextCategoryId,
    })
    const listed = (await readJson(api(`/guilds/${guildId}/channels`))) as {
      id: string
      parent_id: string | null
    }[]
    expect(listed.find((entry) => entry.id === channel.id)?.parent_id).toBe(
      nextCategoryId
    )
    expect(emit).toHaveBeenLastCalledWith('channel.update', {
      channel: expect.objectContaining({
        id: channel.id,
        parent_id: nextCategoryId,
      }),
    })
  })

  it.each([
    {
      fields: `"nested":{"parent_id":${missingId}},"parent_id":${categoryId}`,
      parent: categoryId,
    },
    {
      fields: `"parent_id":${missingId},"parent_id":${categoryId}`,
      parent: categoryId,
    },
    { fields: String.raw`"parent_\u0069d":${categoryId}`, parent: categoryId },
    { fields: `"parent_id":${categoryId},"parent_id":null`, parent: null },
  ])(
    'uses JSON property semantics for integer parents: $fields',
    async ({ fields, parent }) => {
      const created = await rawApi(
        `/guilds/${guildId}/channels`,
        'POST',
        `{"name":"raw",${fields}}`
      )
      expect(created.status).toBe(201)
      expect(await created.json()).toMatchObject({ parent_id: parent })
      const updated = await rawApi(
        `/channels/${textId}`,
        'PATCH',
        `{${fields}}`
      )
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({ parent_id: parent })
    }
  )

  it.each([
    `"parent_id":${missingId}`,
    `"parent_id":${textId}`,
    `"parent_id":${otherCategoryId}`,
    '"parent_id":-1',
    '"parent_id":-0',
    '"parent_id":1.5',
    `"parent_id":${categoryId}.0`,
    `"parent_id":${categoryId}e0`,
    '"parent_id":1e400',
    `"nested":{"parent_id":${categoryId}},"parent_id":${missingId}`,
    `"parent_id":${categoryId},"parent_id":${missingId}`,
  ])('rejects invalid raw integer parents atomically: %s', async (fields) => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    for (const response of [
      await rawApi(
        `/guilds/${guildId}/channels`,
        'POST',
        `{"name":"raw",${fields}}`
      ),
      await rawApi(
        `/channels/${textId}`,
        'PATCH',
        `{"name":"must-not-change",${fields}}`
      ),
    ]) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 50_035,
        errors: { parent_id: expect.any(Object) },
      })
    }
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([{}, { parent_id: null }])(
    'creates without a parent: %j',
    async (body) => {
      const response = await create(body)
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ parent_id: null })
    }
  )

  it.each([guildId, otherGuildId])(
    'allows consistent setup reuse in guild %s',
    async (destination) => {
      expect(
        await readStatus(
          api(`/channels/${textId}`, 'PATCH', { parent_id: categoryId })
        )
      ).toBe(200)
      const response = await context.app.request('/_test/setup', {
        method: 'POST',
        body: JSON.stringify({
          token: 'Bot valid-reuse',
          guilds: [
            {
              id: destination,
              name: 'consistent',
              channels: [
                { id: textId, name: 'renamed-child' },
                { id: categoryId, name: 'renamed-category' },
              ],
            },
          ],
        }),
      })
      expect(response.status).toBe(201)
      expect(await readJson(api(`/channels/${textId}`))).toMatchObject({
        guild_id: destination,
        name: 'renamed-child',
        parent_id: categoryId,
      })
    }
  )

  it.each([
    { source: 'deleted-category', type: 0 },
    { source: 'bulk-position-parent', type: 0 },
    { source: 'deleted-category', type: 5 },
    { source: 'bulk-position-parent', type: 5 },
  ])(
    'preserves the stored parent after $source when reusing as type $type',
    async ({ source, type }) => {
      expect(
        await readStatus(
          api(`/channels/${textId}`, 'PATCH', { parent_id: categoryId })
        )
      ).toBe(200)
      if (source === 'deleted-category') {
        expect(await readStatus(api(`/channels/${categoryId}`, 'DELETE'))).toBe(
          200
        )
      } else {
        expect(
          await readStatus(
            api(`/guilds/${guildId}/channels`, 'PATCH', [
              { id: textId, parent_id: missingId },
            ])
          )
        ).toBe(204)
      }
      const before = (await readJson(api(`/channels/${textId}`))) as {
        parent_id: string | null
      }
      expect(before.parent_id).toBe(
        source === 'deleted-category' ? null : missingId
      )
      const response = await context.app.request('/_test/setup', {
        method: 'POST',
        body: JSON.stringify({
          token: 'Bot unchanged-parent-reuse',
          guilds: [
            {
              id: guildId,
              name: 'reused',
              channels: [{ id: textId, name: 'renamed', type }],
            },
          ],
        }),
      })
      expect(response.status).toBe(201)
      expect(await readJson(api(`/channels/${textId}`))).toMatchObject({
        name: 'renamed',
        type,
        parent_id: before.parent_id,
      })
    }
  )

  it.each([1, 3, 10, 11, 12, 14, 99])(
    'ignores category parents on guild creation for unsupported type %i',
    async (type) => {
      for (const parent of [
        categoryId,
        missingId,
        { a: 1 },
        [categoryId],
        123,
        false,
      ]) {
        const response = await create({ type, parent_id: parent })
        expect(response.status).toBe(201)
        const channel = (await response.json()) as { id: string }
        expect(await readJson(api(`/channels/${channel.id}`))).toMatchObject({
          parent_id: null,
        })
      }
    }
  )

  it('allows a category move when its nested-category child was already invalid', async () => {
    expect(
      await readStatus(
        api(`/guilds/${guildId}/channels`, 'PATCH', [
          { id: nextCategoryId, parent_id: categoryId },
        ])
      )
    ).toBe(204)
    const response = await context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({
        token: 'Bot existing-nesting',
        guilds: [
          {
            id: otherGuildId,
            name: 'destination',
            channels: [{ id: categoryId, name: 'moved' }],
          },
        ],
      }),
    })
    expect(response.status).toBe(201)
    expect(await readJson(api(`/channels/${categoryId}`))).toMatchObject({
      guild_id: otherGuildId,
    })
    expect(await readJson(api(`/channels/${nextCategoryId}`))).toMatchObject({
      guild_id: guildId,
      parent_id: categoryId,
    })
  })

  it.each(['category', 'move-parent', 'move-thread'])(
    'rejects setup that newly invalidates a thread parent: %s',
    async (change) => {
      const response = await api(`/channels/${textId}/threads`, 'POST', {
        name: 'thread',
        type: 11,
      })
      expect(response.status).toBe(201)
      const thread = (await response.json()) as { id: string }
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const setup = await context.app.request('/_test/setup', {
        method: 'POST',
        body: JSON.stringify({
          token: 'Bot invalid-thread-parent',
          guilds: [
            {
              id: change === 'category' ? guildId : otherGuildId,
              name: 'reused',
              channels: [
                {
                  id: change === 'move-thread' ? thread.id : textId,
                  name: 'changed',
                  ...(change === 'category' && { type: 4 }),
                },
              ],
            },
          ],
        }),
      })
      expect(setup.status).toBe(400)
      expect(await setup.json()).toMatchObject({
        code: 0,
        message: 'Invalid channel parent',
        errors: { parent_id: expect.any(Object) },
      })
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it.each([guildId, otherGuildId])(
    'allows consistent thread setup reuse in guild %s',
    async (destination) => {
      const response = await api(`/channels/${textId}/threads`, 'POST', {
        name: 'thread',
        type: 11,
      })
      expect(response.status).toBe(201)
      const thread = (await response.json()) as { id: string }
      const setup = await context.app.request('/_test/setup', {
        method: 'POST',
        body: JSON.stringify({
          token: 'Bot consistent-thread-parent',
          guilds: [
            {
              id: destination,
              name: 'consistent',
              channels: [
                { id: textId, name: 'parent' },
                { id: thread.id, name: 'renamed-thread' },
              ],
            },
          ],
        }),
      })
      expect(setup.status).toBe(201)
      expect(await readJson(api(`/channels/${thread.id}`))).toMatchObject({
        guild_id: destination,
        parent_id: textId,
      })
    }
  )

  it.each([
    missingId,
    textId,
    otherCategoryId,
    '',
    'invalid',
    123,
    false,
    {},
    [],
  ])(
    'rejects invalid parent %j before mutation or dispatch',
    async (parent) => {
      expect(
        await readStatus(
          api(`/channels/${textId}`, 'PATCH', { parent_id: categoryId })
        )
      ).toBe(200)
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      for (const response of [
        await create({ parent_id: parent }),
        await api(`/channels/${textId}`, 'PATCH', {
          name: 'must-not-change',
          parent_id: parent,
        }),
      ]) {
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          code: 50_035,
          message: 'Invalid Form Body',
          errors: {
            parent_id: {
              _errors: [
                { code: 'CHANNEL_TYPE_INVALID', message: expect.any(String) },
              ],
            },
          },
        })
      }
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it('rejects nested categories, self-parenting, and category-to-child cycles', async () => {
    expect(
      await readStatus(
        api(`/channels/${textId}`, 'PATCH', { parent_id: categoryId })
      )
    ).toBe(200)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    for (const response of [
      await create({ type: 4, parent_id: categoryId }),
      await api(`/channels/${categoryId}`, 'PATCH', { parent_id: categoryId }),
      await api(`/channels/${categoryId}`, 'PATCH', {
        parent_id: nextCategoryId,
      }),
      await api(`/channels/${categoryId}`, 'PATCH', { parent_id: textId }),
    ]) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 50_035,
        errors: { parent_id: expect.any(Object) },
      })
    }
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('keeps native thread creation and immutable text-channel parents intact', async () => {
    const response = await api(`/channels/${textId}/threads`, 'POST', {
      name: 'thread',
      type: 11,
    })
    expect(response.status).toBe(201)
    const thread = (await response.json()) as { id: string; parent_id: string }
    expect(thread.parent_id).toBe(textId)
    for (const body of [
      { name: 'renamed' },
      { parent_id: categoryId },
      { parent_id: null },
    ]) {
      expect(
        await readStatus(api(`/channels/${thread.id}`, 'PATCH', body))
      ).toBe(200)
      expect(await readJson(api(`/channels/${thread.id}`))).toMatchObject({
        parent_id: textId,
      })
    }
  })

  it('preserves unknown-resource and authentication errors', async () => {
    expect(
      await readStatus(
        api(`/channels/${missingId}`, 'PATCH', { parent_id: categoryId })
      )
    ).toBe(404)
    expect(
      await readStatus(
        api(`/guilds/${missingId}/channels`, 'POST', {
          name: 'item',
          parent_id: categoryId,
        })
      )
    ).toBe(404)
    for (const [path, method] of [
      [`/channels/${textId}`, 'PATCH'],
      [`/guilds/${guildId}/channels`, 'POST'],
    ]) {
      expect(
        await readStatus(
          context.app.request(`${prefix}${path}`, {
            method,
            body: JSON.stringify({ name: 'item', parent_id: categoryId }),
          })
        )
      ).toBe(401)
    }
  })

  it.each([
    {
      guild: guildId,
      channel: { id: categoryId, name: 'not-a-category', type: 0 },
    },
    {
      guild: otherGuildId,
      channel: { id: categoryId, name: 'moved-category' },
    },
    { guild: otherGuildId, channel: { id: textId, name: 'moved-child' } },
    {
      guild: guildId,
      channel: { id: textId, name: 'nested-category', type: 4 },
    },
    {
      guild: guildId,
      channel: { id: textId, name: 'invalid-thread', type: 11 },
    },
  ])('rolls back contradictory setup reuse: %j', async ({ guild, channel }) => {
    expect(
      await readStatus(
        api(`/channels/${textId}`, 'PATCH', { parent_id: categoryId })
      )
    ).toBe(200)
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({
        token: 'Bot invalid-reuse',
        guilds: [{ id: guild, name: 'reused', channels: [channel] }],
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 0,
      message: 'Invalid channel parent',
      errors: { parent_id: expect.any(Object) },
    })
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })
})
