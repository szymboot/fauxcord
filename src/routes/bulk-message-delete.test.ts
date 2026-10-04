import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
  seedGroupDmChannel,
} from '../test-helpers'
import { generateSnowflake } from '../snowflake'
import { gatewayBus } from '../gateway/bus'
import { createPoll } from '../services/polls'
import { bulkDeleteMessages } from '../services/messages'

describe('bulk message deletion', () => {
  let context: ReturnType<typeof createFullTestApp>
  let token: string
  let guild: string
  let channel: string
  let ids: string[]
  const single = vi.fn()
  const bulk = vi.fn()

  /** Sends a bulk request through the full middleware stack. */
  function request(
    body: string,
    target = channel,
    authorization: string | undefined = token
  ) {
    return context.app.request(
      `/api/v10/channels/${target}/messages/bulk-delete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorization && { Authorization: authorization }),
        },
        body,
      }
    )
  }

  /** Sends a bulk request and reads its status for rejection/no-op checks. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  beforeEach(() => {
    context = createFullTestApp()
    token = seedBot(context.db)
    guild = seedGuild(context.db, token)
    channel = seedChannel(context.db, guild)
    ids = [
      seedMessage(context.db, channel, '111111111111111111', token),
      seedMessage(context.db, channel, '111111111111111111', token),
    ]
    single.mockClear()
    bulk.mockClear()
    gatewayBus.on('message.delete', single)
    gatewayBus.on('message.delete.bulk', bulk)
  })
  afterEach(() => {
    gatewayBus.off('message.delete', single)
    gatewayBus.off('message.delete.bulk', bulk)
    context.cleanup()
  })

  it('commits cascade cleanup before one bulk event and emits no single events', async () => {
    const db = context.db
    for (const id of ids) {
      db.prepare('INSERT INTO embeds (message_id, data) VALUES (?, ?)').run(
        id,
        '{}'
      )
      db.prepare(
        'INSERT INTO attachments (id, message_id, filename, size, content_type, file_path) VALUES (?, ?, ?, 1, ?, ?)'
      ).run(generateSnowflake(), id, 'a.txt', 'text/plain', '/tmp/a.txt')
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(id, '111111111111111111', '👍')
      db.prepare('INSERT INTO pins (channel_id, message_id) VALUES (?, ?)').run(
        channel,
        id
      )
      createPoll(db, id, { question: '?', answers: [{ text: 'yes' }] })
      db.prepare(
        'INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?, 1, ?)'
      ).run(id, '111111111111111111')
    }
    const survivor = seedMessage(db, channel, '111111111111111111', token)
    bulk.mockImplementationOnce(() => {
      expect(db.inTransaction).toBe(false)
      for (const table of [
        'embeds',
        'attachments',
        'reactions',
        'pins',
        'polls',
        'poll_answers',
        'poll_votes',
      ]) {
        expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
      }
    })
    expect(await status(JSON.stringify({ messages: ids }))).toBe(204)
    expect(bulk).toHaveBeenCalledTimes(1)
    expect(bulk).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: guild,
        channelId: channel,
        messageIds: ids,
      })
    )
    expect(single).not.toHaveBeenCalled()
    expect(db.prepare('SELECT id FROM messages').all()).toEqual([
      { id: survivor },
    ])
  })

  it('preserves raw integer precision, including mixed quoted and numeric IDs', async () => {
    expect(await status(`{"messages":[${ids[0]},"${ids[1]}"]}`)).toBe(204)
    expect(bulk).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: ids })
    )
  })

  it.each([
    'null',
    '[]',
    '{}',
    '{"messages":null}',
    '{"messages":{}}',
    '{"messages":[true, false]}',
    '{"messages":[{}, []]}',
    '{"messages":["abc1", "abc2"]}',
    '{"messages":[-1, 1.5]}',
    '{"messages":[1e20, "18446744073709551616"]}',
    '{"messages":["1", "2"]} trailing',
  ])('rejects malformed input without deletion or events: %s', async (body) => {
    expect(await status(body)).toBe(400)
    expect(context.db.prepare('SELECT id FROM messages').all()).toHaveLength(2)
    expect(bulk).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
  })

  it.each(['duplicate', 'old', 'empty', 'one', 'over-limit', 'invalid-id'])(
    'rejects the entire %s request',
    async (kind) => {
      const messages =
        kind === 'duplicate'
          ? [ids[0], ids[0]]
          : kind === 'old'
            ? [ids[0], '1']
            : kind === 'empty'
              ? []
              : kind === 'one'
                ? [ids[0]]
                : kind === 'over-limit'
                  ? [
                      ids[0],
                      ...Array.from({ length: 100 }, () => generateSnowflake()),
                    ]
                  : [ids[0], 'bad']
      const response = await request(JSON.stringify({ messages }))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code:
          kind === 'old'
            ? 50_034
            : kind === 'invalid-id' || kind === 'duplicate'
              ? 50_035
              : 50_016,
      })
      expect(context.db.prepare('SELECT id FROM messages').all()).toHaveLength(
        2
      )
      expect(bulk).not.toHaveBeenCalled()
      expect(single).not.toHaveBeenCalled()
    }
  )

  it('accepts 100 unique missing targets, without emitting phantom deletions', async () => {
    const messages = Array.from({ length: 100 }, () => generateSnowflake())
    expect(await status(JSON.stringify({ messages }))).toBe(204)
    expect(bulk).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
  })

  it('ignores missing, foreign-channel and ephemeral targets while deleting local targets', async () => {
    const other = seedChannel(
      context.db,
      seedGuild(context.db, token, generateSnowflake()),
      generateSnowflake()
    )
    const foreign = seedMessage(context.db, other, '111111111111111111', token)
    context.db
      .prepare('UPDATE messages SET flags = 64 WHERE id = ?')
      .run(ids[1])
    const messages = [ids[0], foreign, generateSnowflake(), ids[1]]
    expect(await status(JSON.stringify({ messages }))).toBe(204)
    expect(
      context.db.prepare('SELECT id FROM messages ORDER BY id').all()
    ).toEqual([{ id: ids[1] }, { id: foreign }])
    expect(bulk).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: [ids[0]] })
    )
    expect(single).not.toHaveBeenCalled()
  })

  it('rolls back all deletion and cleanup when the database fails', async () => {
    context.db.exec(
      `CREATE TRIGGER fail_bulk BEFORE DELETE ON messages WHEN OLD.id = '${ids[1]}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
    )
    expect(await status(JSON.stringify({ messages: ids }))).toBe(500)
    expect(context.db.prepare('SELECT id FROM messages').all()).toHaveLength(2)
    expect(bulk).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
  })

  it('accepts exactly 100 existing targets and emits one ordered event', async () => {
    const messages = [
      ...ids,
      ...Array.from({ length: 98 }, () =>
        seedMessage(context.db, channel, '111111111111111111', token)
      ),
    ].toReversed()
    expect(await status(JSON.stringify({ messages }))).toBe(204)
    expect(context.db.prepare('SELECT id FROM messages').all()).toEqual([])
    expect(bulk).toHaveBeenCalledTimes(1)
    expect(bulk).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: messages })
    )
    expect(single).not.toHaveBeenCalled()
  })

  it('rejects mixed numeric/string duplicates before mutation', async () => {
    expect(await status(`{"messages":[${ids[0]},"${ids[0]}"]}`)).toBe(400)
    expect(context.db.prepare('SELECT id FROM messages').all()).toHaveLength(2)
    expect(bulk).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
  })

  it('rejects a stored old Snowflake even when its database timestamp is recent', async () => {
    const oldId = (
      (BigInt(Date.now() - 15 * 24 * 60 * 60 * 1000) - 1_420_070_400_000n) <<
      22n
    ).toString()
    context.db
      .prepare('UPDATE messages SET id = ? WHERE id = ?')
      .run(oldId, ids[1])
    expect(await status(JSON.stringify({ messages: [ids[0], oldId] }))).toBe(
      400
    )
    expect(context.db.prepare('SELECT id FROM messages').all()).toHaveLength(2)
    expect(bulk).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
  })

  it('rejects an enclosing transaction before mutation or dispatch', () => {
    expect(() => {
      context.db.transaction(() => {
        bulkDeleteMessages(context.db, channel, ids)
      })()
    }).toThrow('Bulk deletion requires its own transaction')
    expect(context.db.prepare('SELECT id FROM messages').all()).toHaveLength(2)
    expect(bulk).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
  })

  it('returns 404 for unknown channels, 400 for DMs and 401 without auth', async () => {
    const body = JSON.stringify({ messages: ids })
    expect(await status(body, generateSnowflake())).toBe(404)
    expect(await status(body, seedGroupDmChannel(context.db))).toBe(400)
    expect(await status(body, channel, '')).toBe(401)
    expect(context.db.prepare('SELECT id FROM messages').all()).toHaveLength(2)
    expect(bulk).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
  })
})
