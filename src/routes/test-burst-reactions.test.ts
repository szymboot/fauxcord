import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
  seedEmoji,
} from '../test-helpers'
import { closeDatabase, type Database } from '../db'
import { gatewayBus, type GatewayBusEvents } from '../gateway/bus'
import type { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth'

const TOKEN = 'Bot burst-reactions'
const BOT_ID = '111111111111111111'
const HUMAN_ID = '888888888888888888'
const SECOND_ID = '999999999999999999'
const COLORS = ['#ffcc4d', '#f4900c']

/**
 * Awaits a response and returns its status code.
 * @param response - Pending HTTP response
 * @returns HTTP status code
 */
async function statusOf(
  response: Response | Promise<Response>
): Promise<number> {
  const result = await response
  return result.status
}

describe('burst (super) reactions over the test control and REST routes', () => {
  let db: Database
  let app: Hono<AppEnv>
  let guild: string
  let channel: string
  let message: string
  let added: GatewayBusEvents['message.reaction.add'][]
  let removed: GatewayBusEvents['message.reaction.remove'][]

  /** Records native additions emitted by the shared reaction service. */
  const onAdd = (payload: GatewayBusEvents['message.reaction.add']): void => {
    added.push(payload)
  }
  /** Records native removals emitted by the shared reaction service. */
  const onRemove = (
    payload: GatewayBusEvents['message.reaction.remove']
  ): void => {
    removed.push(payload)
  }

  /** Calls the human reaction control (add with POST, removal with DELETE). */
  async function control(
    method: 'POST' | 'DELETE',
    body: unknown,
    cid = channel,
    mid = message
  ): Promise<Response> {
    return app.request(`/_test/channels/${cid}/messages/${mid}/reactions`, {
      method,
      body: JSON.stringify(body),
    })
  }

  /** Calls an authenticated native REST route as the setup bot. */
  async function rest(path: string, method = 'GET'): Promise<Response> {
    return app.request(`/api/v10${path}`, {
      method,
      headers: { Authorization: TOKEN },
    })
  }

  /** Lists reaction users of one type through the native REST route. */
  async function users(
    type?: string,
    emoji = '🐝',
    query = ''
  ): Promise<unknown> {
    const search = new URLSearchParams(query)
    if (type !== undefined) search.set('type', type)
    const result = await rest(
      `/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(emoji)}?${search.toString()}`
    )
    expect(result.status).toBe(200)
    return ((await result.json()) as { id: string }[]).map((user) => user.id)
  }

  /** Reads the message reaction summaries through the native REST route. */
  async function summaries(): Promise<unknown> {
    const result = await rest(`/channels/${channel}/messages/${message}`)
    expect(result.status).toBe(200)
    return ((await result.json()) as { reactions?: unknown }).reactions
  }

  /** Reads persisted rows, including membership type and colors. */
  function rows(): unknown[] {
    return db
      .prepare(
        'SELECT user_id, emoji, type, burst_colors FROM reactions ORDER BY id'
      )
      .all()
  }

  beforeEach(async () => {
    const fixture = createFullTestApp()
    db = fixture.db
    app = fixture.app
    seedBot(db, TOKEN, BOT_ID)
    guild = seedGuild(db, TOKEN)
    channel = seedChannel(db, guild)
    message = seedMessage(db, channel, BOT_ID, TOKEN)
    for (const id of [HUMAN_ID, SECOND_ID]) {
      const registered = await app.request('/_test/users', {
        method: 'POST',
        body: JSON.stringify({ id, username: `Human ${id}` }),
      })
      expect(registered.status).toBe(201)
      const joined = await app.request(`/_test/guilds/${guild}/members/${id}`, {
        method: 'POST',
      })
      expect(joined.status).toBe(201)
    }
    added = []
    removed = []
    gatewayBus.on('message.reaction.add', onAdd)
    gatewayBus.on('message.reaction.remove', onRemove)
  })

  afterEach(() => {
    gatewayBus.off('message.reaction.add', onAdd)
    gatewayBus.off('message.reaction.remove', onRemove)
    closeDatabase(db)
  })

  it('persists a burst membership beside a normal one for the same user and emoji', async () => {
    const normal = await control('POST', { user_id: HUMAN_ID, emoji: '🐝' })
    expect(normal.status).toBe(204)
    const burst = await control('POST', {
      user_id: HUMAN_ID,
      emoji: '🐝',
      burst: true,
      burst_colors: COLORS,
    })
    expect(burst.status).toBe(204)
    expect(rows()).toEqual([
      { user_id: HUMAN_ID, emoji: '🐝', type: 0, burst_colors: '[]' },
      {
        user_id: HUMAN_ID,
        emoji: '🐝',
        type: 1,
        burst_colors: JSON.stringify(COLORS),
      },
    ])
    expect(added).toHaveLength(2)
    expect(added[0]).not.toHaveProperty('burst')
    expect(added[1]).toMatchObject({
      userId: HUMAN_ID,
      emoji: { id: null, name: '🐝' },
      burst: true,
      burstColors: COLORS,
      messageAuthorId: BOT_ID,
      member: expect.objectContaining({
        user: expect.objectContaining({ id: HUMAN_ID }),
      }),
    })

    expect(await users()).toEqual([HUMAN_ID])
    expect(await users('0')).toEqual([HUMAN_ID])
    expect(await users('1')).toEqual([HUMAN_ID])
    expect(await summaries()).toEqual([
      {
        count: 2,
        count_details: { normal: 1, burst: 1 },
        me: false,
        me_burst: false,
        emoji: { id: null, name: '🐝' },
        burst_colors: COLORS,
      },
    ])
  })

  it('keeps types separate in reads, pagination and summaries across users and emoji', async () => {
    for (const body of [
      { user_id: SECOND_ID, emoji: '🐝', burst: true },
      { user_id: HUMAN_ID, emoji: '🐝', burst: true, burst_colors: COLORS },
      { user_id: SECOND_ID, emoji: '👍' },
    ]) {
      const result = await control('POST', body)
      expect(result.status).toBe(204)
    }
    expect(await users('0')).toEqual([])
    expect(await users('1')).toEqual([HUMAN_ID, SECOND_ID])
    expect(await users('1', '🐝', 'limit=1')).toEqual([HUMAN_ID])
    expect(await users('1', '🐝', `after=${HUMAN_ID}`)).toEqual([SECOND_ID])
    expect(await users('1', '👍')).toEqual([])
    expect(await users('0', '👍')).toEqual([SECOND_ID])
    // Colors come from the earliest burst membership of the emoji.
    expect(await summaries()).toEqual([
      {
        count: 2,
        count_details: { normal: 0, burst: 2 },
        me: false,
        me_burst: false,
        emoji: { id: null, name: '🐝' },
        burst_colors: [],
      },
      {
        count: 1,
        count_details: { normal: 1, burst: 0 },
        me: false,
        me_burst: false,
        emoji: { id: null, name: '👍' },
        burst_colors: [],
      },
    ])
  })

  it('orders and pages reaction users numerically across snowflake lengths', async () => {
    // 17-digit (older) and 19-digit IDs: lexicographic TEXT order would put
    // the larger 19-digit ID first and make the cursor skip the shorter one.
    const older = '20000000000000000'
    const newer = '1000000000000000000'
    for (const id of [newer, older]) {
      expect(
        await statusOf(
          app.request('/_test/users', {
            method: 'POST',
            body: JSON.stringify({ id, username: `Human ${id}` }),
          })
        )
      ).toBe(201)
      expect(
        await statusOf(
          app.request(`/_test/guilds/${guild}/members/${id}`, {
            method: 'POST',
          })
        )
      ).toBe(201)
    }
    for (const type of ['0', '1']) {
      for (const id of [newer, older, HUMAN_ID]) {
        expect(
          await statusOf(
            control('POST', {
              user_id: id,
              emoji: '🐝',
              ...(type === '1' && { burst: true }),
            })
          )
        ).toBe(204)
      }
      expect(await users(type)).toEqual([older, HUMAN_ID, newer])
      expect(await users(type, '🐝', 'limit=1')).toEqual([older])
      expect(await users(type, '🐝', `after=${older}&limit=1`)).toEqual([
        HUMAN_ID,
      ])
      expect(await users(type, '🐝', `after=${HUMAN_ID}`)).toEqual([newer])
      expect(await users(type, '🐝', `after=${newer}`)).toEqual([])
    }
  })

  it('pages with one comparator for IDs whose JavaScript and SQLite lengths differ', async () => {
    // '😀' is one SQLite character but two UTF-16 code units in JavaScript, so
    // a JavaScript-computed cursor length would skip the two-character 'ab'.
    for (const id of ['ab', '😀']) {
      db.prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, ?, '0', 0)"
      ).run(id, `User ${id}`)
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guild, id)
      expect(
        await statusOf(
          control('POST', { user_id: id, emoji: '🐝', burst: true })
        )
      ).toBe(204)
    }
    expect(await users('1')).toEqual(['😀', 'ab'])
    expect(await users('1', '🐝', `after=${encodeURIComponent('😀')}`)).toEqual(
      ['ab']
    )
  })

  it('supports burst reactions with custom guild emoji, including removal after deletion', async () => {
    const party = seedEmoji(db, guild, null, 'party', true)
    const custom = `party:${party}`
    expect(
      await statusOf(control('POST', { user_id: HUMAN_ID, emoji: custom }))
    ).toBe(204)
    expect(
      await statusOf(
        control('POST', {
          user_id: HUMAN_ID,
          // A stale name still identifies the emoji by ID.
          emoji: `a:old_name:${party}`,
          burst: true,
          burst_colors: COLORS,
        })
      )
    ).toBe(204)
    expect(added[1]).toMatchObject({
      emoji: { id: party, name: 'party', animated: true },
      burst: true,
      burstColors: COLORS,
    })
    expect(rows()).toEqual([
      {
        user_id: HUMAN_ID,
        emoji: `custom:${party}`,
        type: 0,
        burst_colors: '[]',
      },
      {
        user_id: HUMAN_ID,
        emoji: `custom:${party}`,
        type: 1,
        burst_colors: JSON.stringify(COLORS),
      },
    ])
    expect(await users('1', custom)).toEqual([HUMAN_ID])
    expect(await users('0', custom)).toEqual([HUMAN_ID])
    expect(await summaries()).toEqual([
      {
        count: 2,
        count_details: { normal: 1, burst: 1 },
        me: false,
        me_burst: false,
        emoji: { id: party, name: 'party', animated: true },
        burst_colors: COLORS,
      },
    ])

    // An unknown custom emoji is rejected before any write, burst or not.
    const unknown = await control('POST', {
      user_id: HUMAN_ID,
      emoji: 'ghost:123456789012345678',
      burst: true,
    })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ code: 10_014 })
    expect(rows()).toHaveLength(2)

    // After the guild emoji is deleted, the burst can still be removed.
    db.prepare('DELETE FROM emojis WHERE id = ?').run(party)
    expect(
      await statusOf(
        control('DELETE', { user_id: HUMAN_ID, emoji: custom, burst: true })
      )
    ).toBe(204)
    expect(removed).toEqual([
      expect.objectContaining({
        emoji: expect.objectContaining({ id: party }),
        burst: true,
      }),
    ])
    expect(await users('1', custom)).toEqual([])
    expect(await users('0', custom)).toEqual([HUMAN_ID])
  })

  it('treats a repeated burst add as a no-op without an event, even with new colors', async () => {
    const body = { user_id: HUMAN_ID, emoji: '🐝', burst: true }
    expect(await statusOf(control('POST', body))).toBe(204)
    expect(
      await statusOf(control('POST', { ...body, burst_colors: COLORS }))
    ).toBe(204)
    expect(added).toHaveLength(1)
    expect(rows()).toEqual([
      { user_id: HUMAN_ID, emoji: '🐝', type: 1, burst_colors: '[]' },
    ])
  })

  it('keeps the normal add when burst is false or omitted', async () => {
    expect(
      await statusOf(
        control('POST', { user_id: HUMAN_ID, emoji: '🐝', burst: false })
      )
    ).toBe(204)
    expect(rows()).toEqual([
      { user_id: HUMAN_ID, emoji: '🐝', type: 0, burst_colors: '[]' },
    ])
    expect(added[0]).not.toHaveProperty('burst')
  })

  it.each([
    { burst: 'true' },
    { burst: 1 },
    { burst: null },
    { burst_colors: COLORS },
    { burst: false, burst_colors: COLORS },
    { burst: true, burst_colors: '#ffcc4d' },
    { burst: true, burst_colors: ['ffcc4d'] },
    { burst: true, burst_colors: ['#fff'] },
    { burst: true, burst_colors: ['#ffcc4dff'] },
    { burst: true, burst_colors: [1] },
  ])(
    'rejects invalid burst input %j without state or events',
    async (extra) => {
      const result = await control('POST', {
        user_id: HUMAN_ID,
        emoji: '🐝',
        ...extra,
      })
      expect(result.status).toBe(400)
      const body = (await result.json()) as {
        code: number
        errors: Record<string, unknown>
      }
      expect(body.code).toBe(50_035)
      expect(Object.keys(body.errors)).toEqual([
        'burst' in extra && typeof extra.burst !== 'boolean'
          ? 'burst'
          : 'burst_colors',
      ])
      expect(rows()).toEqual([])
      expect(added).toEqual([])
    }
  )

  it('removes only the normal membership through the documented REST delete routes', async () => {
    await control('POST', { user_id: HUMAN_ID, emoji: '🐝' })
    await control('POST', { user_id: HUMAN_ID, emoji: '🐝', burst: true })
    const route = `/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('🐝')}`
    expect(await statusOf(rest(`${route}/${HUMAN_ID}`, 'DELETE'))).toBe(204)
    expect(removed).toEqual([
      expect.objectContaining({ userId: HUMAN_ID, burst: false }),
    ])
    expect(removed[0]).not.toHaveProperty('scope')
    // No normal membership remains, so a second delete is a silent no-op.
    expect(await statusOf(rest(`${route}/${HUMAN_ID}`, 'DELETE'))).toBe(204)
    expect(removed).toHaveLength(1)
    expect(await users('0')).toEqual([])
    expect(await users('1')).toEqual([HUMAN_ID])

    // The bot's own reaction is always normal; deleting it leaves human bursts.
    expect(await statusOf(rest(`${route}/@me`, 'PUT'))).toBe(204)
    expect(await statusOf(rest(`${route}/@me`, 'DELETE'))).toBe(204)
    expect(removed).toHaveLength(2)
    expect(rows()).toEqual([
      { user_id: HUMAN_ID, emoji: '🐝', type: 1, burst_colors: '[]' },
    ])
  })

  it('clears both membership types with the emoji and message clear routes', async () => {
    for (const body of [
      { user_id: HUMAN_ID, emoji: '🐝' },
      { user_id: HUMAN_ID, emoji: '🐝', burst: true },
      { user_id: HUMAN_ID, emoji: '👍', burst: true },
      { user_id: SECOND_ID, emoji: '👍' },
    ]) {
      await control('POST', body)
    }
    const base = `/channels/${channel}/messages/${message}/reactions`
    expect(
      await statusOf(rest(`${base}/${encodeURIComponent('🐝')}`, 'DELETE'))
    ).toBe(204)
    expect(rows()).toEqual([
      { user_id: HUMAN_ID, emoji: '👍', type: 1, burst_colors: '[]' },
      { user_id: SECOND_ID, emoji: '👍', type: 0, burst_colors: '[]' },
    ])
    expect(await statusOf(rest(base, 'DELETE'))).toBe(204)
    expect(rows()).toEqual([])
    expect(await summaries()).toBeUndefined()
    // Clears emit their own clear events, never per-user removals.
    expect(removed).toEqual([])
  })

  it('removes a burst membership through the test control with a scoped burst removal', async () => {
    await control('POST', { user_id: HUMAN_ID, emoji: '🐝' })
    await control('POST', { user_id: HUMAN_ID, emoji: '🐝', burst: true })
    const result = await control('DELETE', {
      user_id: HUMAN_ID,
      emoji: '🐝',
      burst: true,
    })
    expect(result.status).toBe(204)
    expect(removed).toEqual([
      {
        db,
        guildId: guild,
        channelId: channel,
        messageId: message,
        userId: HUMAN_ID,
        emoji: { id: null, name: '🐝' },
        burst: true,
        scope: { db, botId: BOT_ID, token: TOKEN },
      },
    ])
    expect(await users('1')).toEqual([])
    expect(await users('0')).toEqual([HUMAN_ID])

    // Removing an absent membership succeeds without an event.
    expect(
      await statusOf(
        control('DELETE', { user_id: HUMAN_ID, emoji: '🐝', burst: true })
      )
    ).toBe(204)
    expect(removed).toHaveLength(1)

    // Omitting burst removes the normal membership.
    expect(
      await statusOf(control('DELETE', { user_id: HUMAN_ID, emoji: '🐝' }))
    ).toBe(204)
    expect(removed[1]).toMatchObject({ burst: false, scope: { botId: BOT_ID } })
    expect(rows()).toEqual([])

    // Re-adding after removal is a new membership with a new add event.
    await control('POST', { user_id: HUMAN_ID, emoji: '🐝', burst: true })
    expect(added).toHaveLength(3)
  })

  it.each([
    [{ emoji: '🐝', burst: true }, 400, 50_035],
    [{ user_id: HUMAN_ID, emoji: 'bee', burst: true }, 400, 50_035],
    [{ user_id: HUMAN_ID, emoji: '🐝', burst: 'yes' }, 400, 50_035],
    [{ user_id: '999', emoji: '🐝', burst: true }, 404, 10_013],
    [{ user_id: BOT_ID, emoji: '🐝', burst: true }, 400, 0],
  ])(
    'rejects removal %j without removing anything',
    async (body, status, code) => {
      await control('POST', { user_id: HUMAN_ID, emoji: '🐝', burst: true })
      const result = await control('DELETE', body)
      expect(result.status).toBe(status)
      expect(await result.json()).toMatchObject({ code })
      expect(rows()).toHaveLength(1)
      expect(removed).toEqual([])
    }
  )

  it.each([
    ['unknown channel', 404, 10_003],
    ['unknown message', 404, 10_008],
    ['nonmember', 404, 10_007],
  ])(
    'rejects removal for %s without removing anything',
    async (target, status, code) => {
      await control('POST', { user_id: HUMAN_ID, emoji: '🐝', burst: true })
      let cid = channel
      let mid = message
      if (target === 'unknown channel') cid = '999'
      else if (target === 'unknown message') mid = '999'
      else {
        db.prepare('DELETE FROM guild_members WHERE user_id = ?').run(HUMAN_ID)
      }
      const result = await control(
        'DELETE',
        { user_id: HUMAN_ID, emoji: '🐝', burst: true },
        cid,
        mid
      )
      expect(result.status).toBe(status)
      expect(await result.json()).toMatchObject({ code })
      expect(rows()).toHaveLength(1)
      expect(removed).toEqual([])
    }
  )
})
