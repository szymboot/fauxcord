import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import {
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
  type FullTestContext,
} from '../test-helpers'
import { createTestUser } from '../services/test-control'
import { gatewayBus } from '../gateway/bus'

describe('audit-log fixtures and REST reads', () => {
  let context: FullTestContext
  let guildId: string
  let channelId: string
  let authorId: string
  const actorId = '111111111111111111'
  const token = 'Bot audit-routes'

  beforeEach(() => {
    context = createFullTestApp()
    guildId = seedGuild(context.db, seedBot(context.db, token, actorId))
    channelId = seedChannel(context.db, guildId)
    authorId = createTestUser(context.db, { username: 'Author' }).id
  })
  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Builds a valid controllable deletion entry. */
  function payload(id?: string) {
    return {
      id,
      action_type: 72,
      user_id: actorId,
      target_id: authorId,
      options: { channel_id: channelId, count: '1' },
    }
  }

  /** Posts an unauthenticated test control request. */
  function post(body: unknown, guild = guildId) {
    return context.app.request(`/_test/guilds/${guild}/audit-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** Reads the authenticated Discord endpoint. */
  function read(
    query = '',
    guild = guildId,
    auth = token,
    prefix = '/api/v10'
  ) {
    return context.app.request(`${prefix}/guilds/${guild}/audit-logs${query}`, {
      headers: { Authorization: auth },
    })
  }

  /** Checks an HTTP response status without nested await member access. */
  async function expectStatus(
    request: Response | Promise<Response>,
    status: number
  ) {
    const response = await request
    expect(response.status).toBe(status)
  }

  /** Reads an HTTP JSON body as untrusted data. */
  async function bodyOf(
    request: Response | Promise<Response>
  ): Promise<unknown> {
    const response = await request
    const body: unknown = await response.json()
    return body
  }

  it('supports empty history, current generated entries, old entries and mismatched targets without dispatch or message deletion', async () => {
    const emit = vi.spyOn(gatewayBus, 'emit')
    expect(await bodyOf(read())).toMatchObject({
      audit_log_entries: [],
      users: [],
    })
    const other = createTestUser(context.db, { username: 'OtherAuthor' })
    const recent = await post(payload())
    expect(recent.status).toBe(201)
    const entry = (await recent.json()) as { id: string }
    expect(
      await bodyOf(post({ ...payload('100'), target_id: other.id }))
    ).toMatchObject({ id: '100' })
    const old = await post({
      ...payload(),
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(old.status).toBe(201)
    const oldEntry = (await old.json()) as { id: string }
    for (const prefix of ['/api/v10', '/api', '']) {
      const response = await read('', guildId, token, prefix)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        audit_log_entries: [
          { id: entry.id },
          { id: oldEntry.id },
          { id: '100', target_id: other.id },
        ],
      })
    }
    const filtered = await read(
      `?target_id=${authorId}&user_id=${actorId}&action_type=72&limit=1`
    )
    expect(await filtered.json()).toMatchObject({
      audit_log_entries: [{ id: entry.id }],
      users: [{ id: actorId }, { id: authorId }],
    })
    expect(context.db.prepare('SELECT * FROM messages').all()).toEqual([])
    expect(emit).not.toHaveBeenCalled()
  })

  it('preserves existing auth and guild access checks', async () => {
    const otherToken = seedBot(
      context.db,
      'Bot other-routes',
      '444444444444444444'
    )
    const otherGuild = seedGuild(context.db, otherToken, '555555555555555555')
    await post(payload('100'))
    await expectStatus(
      context.app.request(`/api/v10/guilds/${guildId}/audit-logs`),
      401
    )
    await expectStatus(read('', guildId, 'Bot invalid'), 401)
    await expectStatus(read('', guildId, otherToken), 403)
    await expectStatus(read('', '987'), 404)
    expect(await bodyOf(read('', otherGuild, otherToken))).toMatchObject({
      audit_log_entries: [],
      users: [],
    })
  })

  it('applies before/after cursor order, action/user filters and strict limits', async () => {
    for (const id of ['9', '100', '99'])
      await expectStatus(post(payload(id)), 201)
    const before = await read('?before=100&limit=1')
    expect(await before.json()).toMatchObject({
      audit_log_entries: [{ id: '99' }],
    })
    const after = await read('?after=0&limit=2')
    expect(await after.json()).toMatchObject({
      audit_log_entries: [{ id: '9' }, { id: '99' }],
    })
    for (const query of [`?user_id=${authorId}`, '?action_type=73']) {
      expect(await bodyOf(read(query))).toMatchObject({
        audit_log_entries: [],
        users: [],
      })
    }
  })

  it.each([
    'limit=0',
    'limit=101',
    'limit=2.5',
    'limit=1x',
    'limit=',
    'action_type=-1',
    'action_type=72x',
    'action_type=0',
    'action_type=999',
    'action_type=2147483648',
    'user_id=01',
    'target_id=no',
    'before=-1',
    'after=18446744073709551616',
  ])('rejects malformed query %s', async (query) => {
    const response = await read(`?${query}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 50_035 })
  })

  it.each([
    null,
    [],
    {},
    { action_type: 73 },
    { user_id: '01' },
    { target_id: 123 },
    { id: '18446744073709551616' },
    { id: '0' },
    { timestamp: 'invalid' },
    { timestamp: '2026-02-30T00:00:00.000Z' },
    { id: '100', timestamp: '2026-01-01T00:00:00.000Z' },
    { options: null },
    { options: { channel_id: '01', count: '1' } },
    { options: { channel_id: '333333333333333333', count: 1 } },
    { options: { channel_id: '333333333333333333', count: '0' } },
    {
      options: {
        channel_id: '333333333333333333',
        count: '1',
        message_id: '123',
      },
    },
    { reason: 'unsupported' },
  ])(
    'rejects malformed fixture overrides %j without mutation',
    async (override) => {
      const body =
        override === null ||
        Array.isArray(override) ||
        Object.keys(override).length === 0
          ? override
          : { ...payload(), ...override }
      await expectStatus(post(body), 400)
      expect(
        context.db.prepare('SELECT * FROM guild_audit_log_entries').all()
      ).toEqual([])
    }
  )

  it('rejects malformed JSON, guild IDs, unknown users and wrong-guild channels without mutation', async () => {
    const malformed = await context.app.request(
      `/_test/guilds/${guildId}/audit-logs`,
      { method: 'POST', body: '{' }
    )
    expect(malformed.status).toBe(400)
    await expectStatus(post(payload(), 'invalid'), 400)
    await expectStatus(post(payload(), '987'), 404)
    for (const field of ['user_id', 'target_id']) {
      const response = await post({ ...payload(), [field]: '987' })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 10_013 })
    }
    const otherGuild = seedGuild(
      context.db,
      seedBot(context.db, 'Bot other', '444444444444444444'),
      '555555555555555555'
    )
    const otherChannel = seedChannel(
      context.db,
      otherGuild,
      '666666666666666666'
    )
    const response = await post({
      ...payload(),
      options: { channel_id: otherChannel, count: '1' },
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 10_003 })
    expect(
      context.db.prepare('SELECT * FROM guild_audit_log_entries').all()
    ).toEqual([])
    await expectStatus(post(payload('100')), 201)
    await expectStatus(post(payload('100')), 409)
    await expectStatus(
      post(
        {
          ...payload('100'),
          options: { channel_id: otherChannel, count: '1' },
        },
        otherGuild
      ),
      409
    )
  })
})
