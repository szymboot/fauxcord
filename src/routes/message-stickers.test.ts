import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase, type Database } from '../db'
import { createTestRoutes } from './test'
import { createChannelRoutes } from './channels'
import { createAuthMiddleware, type AppEnv } from '../middleware/auth'
import {
  seedBot,
  seedGuild,
  seedChannel,
  seedApplicationOwner,
  seedSkuSubscription,
} from '../test-helpers'
import {
  createGuildSticker,
  deleteGuildSticker,
} from '../services/guild-advanced'
import { createTestUser, resetTestData } from '../services/test-control'
import { getMessage, type MessageObject } from '../services/messages'
import { gatewayBus } from '../gateway/bus'

const BASE_URL = 'http://localhost:3000'
const TOKEN = 'Bot stickers'

describe('message stickers', () => {
  let db: Database
  let app: Hono<AppEnv>
  let guild: string
  let channel: string
  let human: string
  let stickers: string[]
  let events: unknown[]

  /** Records native bus events, including rejected-request side effects. */
  const collect = (event: unknown): void => {
    events.push(event)
  }

  /** Sends a message through either the human fixture or ordinary REST path. */
  const post = (fixture: boolean, payload: Record<string, unknown>) =>
    app.request(
      fixture
        ? `/_test/channels/${channel}/messages`
        : `/api/v10/channels/${channel}/messages`,
      {
        method: 'POST',
        headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(fixture && { author: { id: human } }),
          ...payload,
        }),
      }
    )

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono<AppEnv>()
    app.route('/', createTestRoutes(db, BASE_URL))
    app.use('*', createAuthMiddleware(db, false))
    app.route('/api/v10', createChannelRoutes(db, BASE_URL))
    const token = seedBot(db, TOKEN)
    guild = seedGuild(db, token)
    channel = seedChannel(db, guild)
    human = createTestUser(db, { username: 'Human' }).id
    stickers = [1, 2, 3].map(
      (index) =>
        createGuildSticker(db, guild, human, {
          name: `Sticker ${index}`,
          tags: 'wave',
        }).id
    )
    events = []
    gatewayBus.on('message.create', collect)
    gatewayBus.on('message.update', collect)
    gatewayBus.on('message.delete', collect)
  })

  afterEach(() => {
    gatewayBus.off('message.create', collect)
    gatewayBus.off('message.update', collect)
    gatewayBus.off('message.delete', collect)
    db.close()
  })

  describe.each([true, false])('fixture=%s', (fixture) => {
    it.each([undefined, null, []])(
      'keeps no-sticker messages compatible (%j)',
      async (ids) => {
        const response = await post(fixture, {
          content: 'plain',
          sticker_ids: ids,
        })
        expect(response.status).toBe(fixture ? 201 : 200)
        expect(await response.json()).not.toHaveProperty('sticker_items')
      }
    )

    it.each([1, 2, 3])(
      'stores and reads %i stickers with and without content',
      async (count) => {
        for (const content of [undefined, '', 'with stickers']) {
          const ids = stickers.slice(0, count)
          const items = ids.map((id, index) => ({
            id,
            name: `Sticker ${index + 1}`,
            format_type: 1,
          }))
          const response = await post(fixture, { content, sticker_ids: ids })
          expect(response.status).toBe(fixture ? 201 : 200)
          const message = (await response.json()) as MessageObject
          expect(message).toMatchObject({
            content: content ?? '',
            sticker_items: items,
          })
          expect(message).not.toHaveProperty('sticker_ids')
          expect(getMessage(db, message.id, BASE_URL)).toEqual(message)
          const headers = { Authorization: TOKEN }
          const single = await app.request(
            `/api/v10/channels/${channel}/messages/${message.id}`,
            { headers }
          )
          expect(await single.json()).toEqual(message)
          const history = await app.request(
            `/api/v10/channels/${channel}/messages`,
            { headers }
          )
          expect(await history.json()).toContainEqual(message)
          expect(events.at(-1)).toMatchObject({
            message: { sticker_items: items },
          })
          const path = fixture
            ? `/_test/channels/${channel}/messages/${message.id}`
            : `/api/v10/channels/${channel}/messages/${message.id}`
          const edit = await app.request(path, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'edited' }),
          })
          expect(edit.status).toBe(200)
          expect(await edit.json()).toMatchObject({
            content: 'edited',
            sticker_items: items,
          })
          expect(events.at(-1)).toMatchObject({
            message: { content: 'edited', sticker_items: items },
          })
        }
      }
    )

    it.each([
      1,
      '123',
      {},
      [null],
      [1],
      [''],
      ['abc'],
      ['0'],
      ['01'],
      ['18446744073709551616'],
      ['999999999999999999'],
      ['missing'],
    ])('rejects invalid IDs without writes or events (%j)', async (ids) => {
      const response = await post(fixture, {
        content: 'invalid',
        sticker_ids: ids,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 50_035,
        errors: { sticker_ids: {} },
      })
      expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0)
      expect(events).toEqual([])
    })

    it('rejects excessive, duplicate, unavailable and foreign stickers and forged items', async () => {
      const otherGuild = seedGuild(db, TOKEN, '222222222222222223')
      const foreign = createGuildSticker(db, otherGuild, human, {
        name: 'Foreign',
      }).id
      db.prepare('UPDATE stickers SET available = 0 WHERE id = ?').run(
        stickers[2]
      )
      for (const payload of [
        { sticker_ids: [...stickers, foreign] },
        { sticker_ids: [stickers[0], stickers[0]] },
        { sticker_ids: [stickers[2]] },
        { sticker_ids: [stickers[0], foreign] },
        {
          sticker_items: [{ id: stickers[0], name: 'Forged', format_type: 99 }],
        },
      ]) {
        const response1 = await post(fixture, { content: 'bad', ...payload })
        expect(response1.status).toBe(400)
      }
      expect(events).toEqual([])
      expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0)
    })

    it('keeps catalog snapshots and removes message associations on deletion', async () => {
      const response = await post(fixture, { sticker_ids: [stickers[0]] })
      const message = (await response.json()) as MessageObject
      expect(response.status).toBe(fixture ? 201 : 200)
      deleteGuildSticker(db, guild, stickers[0])
      expect(getMessage(db, message.id, BASE_URL)).toEqual(message)
      const response3 = await app.request(
        `/api/v10/channels/${channel}/messages/${message.id}`,
        { method: 'DELETE', headers: { Authorization: TOKEN } }
      )
      expect(response3.status).toBe(204)
      expect(getMessage(db, message.id, BASE_URL)).toBeNull()
      expect(
        db.prepare('SELECT COUNT(*) FROM message_stickers').pluck().get()
      ).toBe(0)
    })
  })

  it('rejects REST sticker creation for voice messages and components v2', async () => {
    for (const flags of [1 << 13, 1 << 15]) {
      const response = await post(false, { sticker_ids: stickers, flags })
      expect(response.status).toBe(400)
    }
    expect(events).toEqual([])
  })

  it('keeps unrelated human fixture fields ignored', async () => {
    const response = await post(true, {
      sticker_ids: stickers,
      embeds: [null],
      flags: 1 << 13,
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      sticker_items: expect.any(Array),
      embeds: [],
      flags: 0,
    })
  })

  it('uses standard catalog stickers for human fixtures and keeps format types', async () => {
    const { applicationId, ownerId } = seedApplicationOwner(db)
    const { skuId } = seedSkuSubscription(db, applicationId, ownerId)
    db.prepare(
      "INSERT INTO sticker_packs (id, sku_id, name) VALUES ('1234', ?, 'Pack')"
    ).run(skuId)
    for (const format of [1, 2, 3, 4]) {
      const id = `12345${format}`
      db.prepare(
        "INSERT INTO stickers (id, pack_id, name, tags, type, format_type, sort_value) VALUES (?, '1234', 'Standard', 'wave', 1, ?, 0)"
      ).run(id, format)
      const response = await post(true, { sticker_ids: [id] })
      expect(response.status).toBe(201)
      const message = (await response.json()) as MessageObject
      expect(message.sticker_items).toEqual([
        { id, name: 'Standard', format_type: format },
      ])
      const read = await app.request(`/_test/messages/${channel}`)
      expect(await read.json()).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: message.id,
            sticker_items: message.sticker_items,
          }),
        ]),
      })
      const response4 = await post(false, { sticker_ids: [id] })
      expect(response4.status).toBe(400)
    }
  })

  it('rejects unsupported catalog formats and empty/too-long human content', async () => {
    db.prepare('UPDATE stickers SET format_type = 99 WHERE id = ?').run(
      stickers[0]
    )
    const response5 = await post(true, { sticker_ids: [stickers[0]] })
    expect(response5.status).toBe(400)
    const response6 = await post(true, {
      sticker_ids: stickers.slice(1),
      content: 'x'.repeat(2001),
    })
    expect(response6.status).toBe(400)
    const response7 = await post(true, { sticker_ids: [], content: '' })
    expect(response7.status).toBe(400)
    expect(events).toEqual([])
  })

  it('cascades channel deletion without affecting another guild', async () => {
    const response8 = await post(true, { sticker_ids: stickers })
    const message = (await response8.json()) as MessageObject
    const otherGuild = seedGuild(db, TOKEN, '222222222222222223')
    const otherChannel = seedChannel(db, otherGuild, '333333333333333334')
    const otherSticker = createGuildSticker(db, otherGuild, human, {
      name: 'Other',
    }).id
    const response = await app.request(
      `/_test/channels/${otherChannel}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: { id: human },
          sticker_ids: [otherSticker],
        }),
      }
    )
    expect(response.status).toBe(201)
    const otherMessage = (await response.json()) as MessageObject
    db.prepare('DELETE FROM channels WHERE id = ?').run(channel)
    expect(getMessage(db, message.id, BASE_URL)).toBeNull()
    expect(getMessage(db, otherMessage.id, BASE_URL)).toEqual(otherMessage)
    expect(
      db.prepare('SELECT COUNT(*) FROM message_stickers').pluck().get()
    ).toBe(1)
  })

  it('cleans up sticker-only remove_after_create fixtures and reset', async () => {
    const response = await post(true, {
      sticker_ids: stickers,
      remove_after_create: true,
    })
    expect(response.status).toBe(201)
    const message = (await response.json()) as MessageObject
    expect(message.sticker_items).toHaveLength(3)
    expect(getMessage(db, message.id, BASE_URL)).toBeNull()
    expect(events).toHaveLength(2)
    expect(
      db.prepare('SELECT COUNT(*) FROM message_stickers').pluck().get()
    ).toBe(0)
    await post(true, { sticker_ids: stickers })
    resetTestData(db)
    expect(
      db.prepare('SELECT COUNT(*) FROM message_stickers').pluck().get()
    ).toBe(0)
  })

  it('requires ordinary REST authentication and rejects missing channels/users', async () => {
    const response9 = await app.request(
      `/api/v10/channels/${channel}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ sticker_ids: stickers }),
      }
    )
    expect(response9.status).toBe(401)
    const response10 = await app.request('/_test/channels/missing/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: { id: human },
        sticker_ids: stickers,
      }),
    })
    expect(response10.status).toBe(404)
    const response11 = await post(true, {
      author: { id: 'missing' },
      sticker_ids: stickers,
    })
    expect(response11.status).toBe(404)
  })
})
