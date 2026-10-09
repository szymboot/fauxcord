import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import { getUser } from '../services/users'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedMember,
} from '../test-helpers'

const HUMAN = '888888888888888888'
const BOT = '111111111111111111'
const TOKEN = 'Bot global-name'
const PATH = `/_test/users/${HUMAN}`

describe('human global-name fixture', () => {
  let context: ReturnType<typeof createFullTestApp>

  beforeEach(async () => {
    context = createFullTestApp()
    seedBot(context.db, TOKEN, BOT)
    const registered = await context.app.request('/_test/users', {
      method: 'POST',
      body: JSON.stringify({
        id: HUMAN,
        username: 'Retained human',
        discriminator: '1234',
        avatar: 'a_retained',
        global_name: 'Before',
      }),
    })
    expect(registered.status).toBe(201)
    for (const guild of ['222222222222222222', '333333333333333333']) {
      seedGuild(context.db, TOKEN, guild)
      seedMember(context.db, guild, HUMAN)
      seedMember(context.db, guild, '777777777777777777')
      context.db
        .prepare(
          'UPDATE guild_members SET nick = ?, mute = 1, deaf = 1, flags = 4 WHERE guild_id = ? AND user_id = ?'
        )
        .run('Retained nick', guild, HUMAN)
      context.db
        .prepare('INSERT INTO roles (id, guild_id, name) VALUES (?, ?, ?)')
        .run(guild + '1', guild, 'Retained role')
      context.db
        .prepare(
          'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
        )
        .run(guild, HUMAN, guild + '1')
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Snapshots all persisted data to detect unintended writes. */
  function snapshot() {
    const tables = context.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        context.db.prepare(`SELECT * FROM "${name}"`).all(),
      ])
    )
  }

  it.each(['After', '', '  Exact name  ', null])(
    'silently sets %j and preserves all other state',
    async (globalName) => {
      const before = snapshot()
      const user = getUser(context.db, HUMAN)
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await context.app.request(PATH, {
        method: 'PATCH',
        body: JSON.stringify({ global_name: globalName }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        ...user,
        global_name: globalName,
      })
      const after = snapshot()
      expect({ ...after, users: before.users }).toEqual(before)
      expect(after.users).toEqual(
        (before.users as Record<string, unknown>[]).map((row) =>
          row.id === HUMAN ? { ...row, global_name: globalName } : row
        )
      )
      expect(emit).not.toHaveBeenCalled()
      for (const prefix of ['', '/api', '/api/v10']) {
        const read = await context.app.request(`${prefix}/users/${HUMAN}`, {
          headers: { Authorization: TOKEN },
        })
        expect(read.status).toBe(200)
        await expect(read.json()).resolves.toEqual({
          ...user,
          global_name: globalName,
        })
      }
      const unauthenticated = await context.app.request(
        `/api/v10/users/${HUMAN}`
      )
      expect(unauthenticated.status).toBe(401)
    }
  )

  it('preserves the name on omission and keeps registration conflicts and bot @me behavior', async () => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const omitted = await context.app.request(PATH, {
      method: 'PATCH',
      body: '{}',
    })
    expect(omitted.status).toBe(200)
    await expect(omitted.json()).resolves.toEqual(getUser(context.db, HUMAN))
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
    const conflict = await context.app.request('/_test/users', {
      method: 'POST',
      body: JSON.stringify({
        id: HUMAN,
        username: 'Replacement',
        global_name: 'Replacement',
      }),
    })
    expect(conflict.status).toBe(409)
    expect(snapshot()).toEqual(before)
    const bot = await context.app.request('/api/v10/users/@me', {
      method: 'PATCH',
      headers: { Authorization: TOKEN },
      body: '{"username":"Renamed bot"}',
    })
    expect(bot.status).toBe(200)
    await expect(bot.json()).resolves.toMatchObject({
      id: BOT,
      username: 'Renamed bot',
      bot: true,
    })
    expect(getUser(context.db, HUMAN)?.global_name).toBe('Before')
  })

  it.each([
    undefined,
    '',
    'null',
    '[]',
    '42',
    'true',
    '"name"',
    '{invalid',
    '{"global_name":42}',
    '{"global_name":false}',
    '{"global_name":[]}',
    '{"global_name":{}}',
    '{"username":"Unsupported"}',
    '{"global_name":"Valid","avatar":null}',
    '{"global_name":null,"bot":true}',
    '{"global_name":"Valid","__proto__":{}}',
  ])('rejects invalid body %s without partial mutation', async (body) => {
    const before = snapshot()
    const emit = vi.spyOn(gatewayBus, 'emit')
    const response = await context.app.request(PATH, { method: 'PATCH', body })
    expect(response.status).toBe(400)
    expect(snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([
    { user: 'missing', status: 404, code: 10_013 },
    { user: BOT, status: 400, code: 0 },
  ])(
    'rejects $user without creating or converting identities',
    async ({ user, status, code }) => {
      for (const body of [
        '{}',
        '{"global_name":"After"}',
        '{"global_name":null}',
      ]) {
        const before = snapshot()
        const emit = vi.spyOn(gatewayBus, 'emit')
        const response = await context.app.request(`/_test/users/${user}`, {
          method: 'PATCH',
          body,
        })
        expect(response.status).toBe(status)
        await expect(response.json()).resolves.toMatchObject({ code })
        expect(snapshot()).toEqual(before)
        expect(emit).not.toHaveBeenCalled()
      }
    }
  )
})
