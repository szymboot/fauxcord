import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
} from '../test-helpers'
import { closeDatabase, type Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import type { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth'

const TOKEN = 'Bot reactions'
const BOT_ID = '111111111111111111'
const HUMAN_ID = '888888888888888888'
const DEFAULT_REACTION = { user_id: HUMAN_ID, emoji: '🐝' }

describe('POST /_test/channels/:channelId/messages/:messageId/reactions', () => {
  let db: Database
  let app: Hono<AppEnv>
  let guild: string
  let channel: string
  let message: string
  let events: unknown[]

  /** Records native additions to detect dispatches on rejected or duplicate requests. */
  const collect = (payload: unknown): void => {
    events.push(payload)
  }

  /** Adds an explicit human reaction without authentication. */
  async function react(
    body: unknown = DEFAULT_REACTION,
    cid = channel,
    mid = message
  ): Promise<Response> {
    return app.request(`/_test/channels/${cid}/messages/${mid}/reactions`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  /** Reads persisted rows to verify failures leave no partial reactions. */
  function rows(): unknown[] {
    return db
      .prepare('SELECT message_id, user_id, emoji FROM reactions ORDER BY id')
      .all()
  }

  beforeEach(async () => {
    const fixture = createFullTestApp()
    db = fixture.db
    app = fixture.app
    seedBot(db, TOKEN)
    guild = seedGuild(db, TOKEN)
    channel = seedChannel(db, guild)
    message = seedMessage(db, channel, BOT_ID, TOKEN)
    const registered = await app.request('/_test/users', {
      method: 'POST',
      body: JSON.stringify({
        id: HUMAN_ID,
        username: 'Human',
        global_name: 'Human Name',
        avatar: 'a_human',
      }),
    })
    expect(registered.status).toBe(201)
    const joined = await app.request(
      `/_test/guilds/${guild}/members/${HUMAN_ID}`,
      { method: 'POST', body: JSON.stringify({ nick: 'Busy Bee' }) }
    )
    expect(joined.status).toBe(201)
    events = []
    gatewayBus.on('message.reaction.add', collect)
  })

  afterEach(() => {
    gatewayBus.off('message.reaction.add', collect)
    closeDatabase(db)
  })

  it('persists the same human through every REST alias and preserves profile and membership', async () => {
    const users = db.prepare('SELECT * FROM users').all()
    const members = db.prepare('SELECT * FROM guild_members').all()
    const result1 = await react()
    expect(result1.status).toBe(204)
    expect(rows()).toEqual([
      { message_id: message, user_id: HUMAN_ID, emoji: '🐝' },
    ])
    for (const prefix of ['', '/api', '/api/v10']) {
      const read = await app.request(
        `${prefix}/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('🐝')}`,
        { headers: { Authorization: TOKEN } }
      )
      expect(read.status).toBe(200)
      expect(await read.json()).toEqual([
        {
          id: HUMAN_ID,
          username: 'Human',
          discriminator: '0',
          avatar: 'a_human',
          global_name: 'Human Name',
          bot: false,
        },
      ])
      const result = await app.request(
        `${prefix}/channels/${channel}/messages/${message}`,
        { headers: { Authorization: TOKEN } }
      )
      expect(await result.json()).toMatchObject({
        reactions: [{ count: 1, emoji: { id: null, name: '🐝' } }],
      })
    }
    expect(db.prepare('SELECT * FROM users').all()).toEqual(users)
    expect(db.prepare('SELECT * FROM guild_members').all()).toEqual(members)
    expect(events).toHaveLength(1)
  })

  it('supports announcement messages without changing the source author', async () => {
    db.prepare('UPDATE channels SET type = 5 WHERE id = ?').run(channel)
    const source = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(message)
    const result = await react()
    expect(result.status).toBe(204)
    expect(
      db.prepare('SELECT * FROM messages WHERE id = ?').get(message)
    ).toEqual(source)
    expect(rows()).toHaveLength(1)
  })

  it('reports a persistence failure without a reaction or add event', async () => {
    db.exec(
      "CREATE TRIGGER reject_reaction BEFORE INSERT ON reactions BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END"
    )
    const result = await react()
    expect(result.status).toBe(500)
    expect(await result.json()).toEqual({
      message: 'Internal Server Error',
      code: 0,
    })
    expect(rows()).toEqual([])
    expect(events).toEqual([])
  })

  it.each(['👍🏽', '👩‍💻', '🇵🇱', '1️⃣', '❤️'])(
    'accepts one Unicode emoji sequence %s',
    async (emoji) => {
      const result2 = await react({ user_id: HUMAN_ID, emoji })
      expect(result2.status).toBe(204)
      expect(rows()).toEqual([
        { message_id: message, user_id: HUMAN_ID, emoji },
      ])
    }
  )

  it.each([
    null,
    [],
    'text',
    {},
    { user_id: 1, emoji: '🐝' },
    { user_id: '', emoji: '🐝' },
    { user_id: HUMAN_ID },
    ...[
      null,
      1,
      {},
      [],
      '',
      'hello',
      '🐝🐝',
      ' bee ',
      'bee:123',
      '<:bee:123>',
      '\uD800',
    ].map((emoji) => ({ user_id: HUMAN_ID, emoji })),
  ])('rejects invalid input %j without state or events', async (body) => {
    const response = await react(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 50_035 })
    expect(rows()).toEqual([])
    expect(events).toEqual([])
  })

  it.each(['', '{'])('rejects malformed JSON %j', async (body) => {
    const result = await app.request(
      `/_test/channels/${channel}/messages/${message}/reactions`,
      { method: 'POST', body }
    )
    expect(result.status).toBe(400)
    expect(rows()).toEqual([])
    expect(events).toEqual([])
  })

  it.each([
    ['unknown user', 404, 10_013],
    ['bot actor', 400, 0],
    ['nonmember', 404, 10_007],
    ['other guild member', 404, 10_007],
    ['unknown channel', 404, 10_003],
    ['wrong channel', 404, 10_008],
    ['unknown message', 404, 10_008],
    ['ephemeral message', 404, 10_008],
    ['DM', 400, 0],
    ['unsupported guild channel', 400, 0],
  ])(
    'rejects %s without partial writes or events',
    async (target, status, code) => {
      let cid = channel
      let mid = message
      let user = HUMAN_ID
      switch (target) {
        case 'unknown user': {
          user = '999'
          break
        }
        case 'bot actor': {
          user = BOT_ID
          break
        }
        case 'nonmember': {
          db.prepare('DELETE FROM guild_members WHERE user_id = ?').run(user)
          break
        }
        case 'other guild member': {
          db.prepare('DELETE FROM guild_members WHERE user_id = ?').run(user)
          const otherGuild = seedGuild(db, TOKEN, '777777777777777777')
          db.prepare(
            'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
          ).run(otherGuild, user)
          break
        }
        case 'unknown channel': {
          cid = '999'
          break
        }
        case 'wrong channel': {
          cid = seedChannel(db, guild, '444444444444444444')
          break
        }
        case 'unknown message': {
          mid = '999'
          break
        }
        case 'ephemeral message': {
          db.prepare('UPDATE messages SET flags = 64 WHERE id = ?').run(message)
          break
        }
        case 'DM': {
          db.prepare(
            'UPDATE channels SET guild_id = NULL, type = 1 WHERE id = ?'
          ).run(channel)
          break
        }
        case 'unsupported guild channel': {
          db.prepare('UPDATE channels SET type = 4 WHERE id = ?').run(channel)
          break
        }
      }
      const members = db.prepare('SELECT * FROM guild_members').all()
      const result = await react({ user_id: user, emoji: '🐝' }, cid, mid)
      expect(result.status).toBe(status)
      expect(await result.json()).toMatchObject({ code })
      expect(rows()).toEqual([])
      expect(events).toEqual([])
      expect(db.prepare('SELECT * FROM guild_members').all()).toEqual(members)
    }
  )

  it('preserves duplicate policy, multiple humans and emoji, normal bot authentication and removals', async () => {
    const result3 = await react()
    expect(result3.status).toBe(204)
    const result4 = await react()
    expect(result4.status).toBe(204)
    expect(events).toHaveLength(1)
    const normal = `/api/v10/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('🐝')}`
    const result5 = await app.request(`${normal}/@me`, { method: 'PUT' })
    expect(result5.status).toBe(401)
    const result6 = await app.request(`${normal}/@me`, {
      method: 'PUT',
      headers: { Authorization: TOKEN },
    })
    expect(result6.status).toBe(204)
    expect(rows()).toContainEqual({
      message_id: message,
      user_id: BOT_ID,
      emoji: '🐝',
    })
    const result7 = await app.request(`${normal}/${HUMAN_ID}`, {
      method: 'DELETE',
      headers: { Authorization: TOKEN },
    })
    expect(result7.status).toBe(204)
    const result8 = await react()
    expect(result8.status).toBe(204)
    const result9 = await react({ user_id: HUMAN_ID, emoji: '👍' })
    expect(result9.status).toBe(204)
    const second = '999999999999999999'
    await app.request('/_test/users', {
      method: 'POST',
      body: JSON.stringify({ id: second, username: 'Second' }),
    })
    await app.request(`/_test/guilds/${guild}/members/${second}`, {
      method: 'POST',
    })
    const result10 = await react({ user_id: second, emoji: '🐝' })
    expect(result10.status).toBe(204)
    expect(rows()).toHaveLength(4)
    const clear = await app.request(
      `/api/v10/channels/${channel}/messages/${message}/reactions`,
      { method: 'DELETE', headers: { Authorization: TOKEN } }
    )
    expect(clear.status).toBe(204)
    expect(rows()).toEqual([])
  })
})
