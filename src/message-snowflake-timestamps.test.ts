import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { closeDatabase, initializeDatabase } from './db'
import { GatewayOp } from './gateway/opcodes'
import {
  createMessage,
  getMessage,
  isTooOldForBulkDelete,
  type MessageObject,
} from './services/messages'
import { createTestUser } from './services/test-control'
import { snowflakeToTimestamp } from './snowflake'
import {
  createFullTestApp,
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedInteraction,
  seedMember,
  seedMessage,
  seedWebhook,
  type FullTestContext,
} from './test-helpers'
import { toDiscordTimestamp } from './timestamp'

const APPLICATION_ID = '111111111111111111'
const DAY_MS = 24 * 60 * 60 * 1000
const TWO_WEEKS_MS = 14 * DAY_MS
/** A fixed instant whose milliseconds would be lost at whole-second precision. */
const NOW = new Date('2026-06-15T12:30:45.678Z')

/**
 * Builds a Snowflake ID for an exact instant.
 * @param ms - Unix epoch milliseconds
 * @param sequence - Distinguishes IDs sharing one millisecond
 * @returns Snowflake ID string
 */
function snowflakeAt(ms: number, sequence = 0): string {
  return ((BigInt(ms - 1_420_070_400_000) << 22n) | BigInt(sequence)).toString()
}

/**
 * Computes the timestamp Discord would serve for a message ID.
 * @param id - Message Snowflake
 * @returns Discord ISO 8601 timestamp
 */
function timestampOf(id: string): string {
  return toDiscordTimestamp(snowflakeToTimestamp(id))
}

/**
 * Runs an ES module script from the repository root in its own process.
 * @param timezone - IANA timezone of that process
 * @param script - Module source that prints one JSON value
 * @returns Parsed output
 */
function runInTimezone(timezone: string, script: string): unknown {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8',
      timeout: 10_000,
    }
  )
  return JSON.parse(output) as unknown
}

describe('message timestamps derived from Snowflake IDs', () => {
  let context: FullTestContext
  let token: string
  let guildId: string
  let channelId: string
  let humanId: string

  beforeEach(() => {
    // Only Date is faked, so request handling and timers behave normally.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    context = createFullTestApp()
    token = seedBot(context.db, 'Bot timestamps', APPLICATION_ID)
    guildId = seedGuild(context.db, token)
    channelId = seedChannel(context.db, guildId)
    humanId = createTestUser(context.db, { username: 'Human' }).id
  })

  afterEach(() => {
    context.cleanup()
    vi.useRealTimers()
  })

  /**
   * Sends a JSON request with the bot's credentials.
   * @param url - Request path
   * @param method - HTTP method
   * @param body - Optional JSON body
   * @returns Response
   */
  async function send(
    url: string,
    method = 'GET',
    body?: unknown
  ): Promise<Response> {
    return await context.app.request(url, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /**
   * Reads a successful JSON response.
   * @param url - Request path
   * @param method - HTTP method
   * @param body - Optional JSON body
   * @returns Parsed body
   */
  async function json<T = MessageObject>(
    url: string,
    method = 'GET',
    body?: unknown
  ): Promise<T> {
    const res = await send(url, method, body)
    expect(res.ok).toBe(true)
    return (await res.json()) as T
  }

  /**
   * Injects a human message with an explicit ID.
   * @param id - Message ID
   * @returns Injection response
   */
  async function inject(id: string): Promise<MessageObject> {
    return await json(`/_test/channels/${channelId}/messages`, 'POST', {
      id,
      content: `message ${id}`,
      author: { id: humanId },
    })
  }

  it('backdates an injected message with an old explicit ID', async () => {
    const id = snowflakeAt(NOW.getTime() - 15 * DAY_MS - 111)

    const created = await inject(id)

    expect(created.timestamp).toBe('2026-05-31T12:30:45.567000+00:00')
    expect(created.edited_timestamp).toBeNull()
    const read = await json(`/channels/${channelId}/messages/${id}`)
    expect(read.timestamp).toBe(created.timestamp)
  })

  it('uses the millisecond of a generated ID', async () => {
    const created = await json(`/channels/${channelId}/messages`, 'POST', {
      content: 'generated',
    })

    expect(created.timestamp).toBe(timestampOf(created.id))
    expect(created.timestamp).toBe('2026-06-15T12:30:45.678000+00:00')
  })

  it.each(['/api/v10', '/api', ''])(
    'serves the same timestamp on every channel message surface under "%s"',
    async (prefix) => {
      const ids = [20, 15, 10].map((days, index) =>
        snowflakeAt(NOW.getTime() - days * DAY_MS - index * 7 - 1)
      )
      for (const id of ids) await inject(id)
      const base = `${prefix}/channels/${channelId}`
      const expected = ids.map((id) => [id, timestampOf(id)])
      /** Reduces a message list to its ID and timestamp pairs, oldest first. */
      const pairs = (messages: MessageObject[]): string[][] =>
        messages
          .map((message) => [message.id, message.timestamp])
          .toSorted(([a], [b]) => a.localeCompare(b))

      for (const [query, from, to] of [
        ['', 0, 3],
        ['?limit=2', 1, 3],
        [`?before=${ids[2]}`, 0, 2],
        [`?after=${ids[0]}`, 1, 3],
        [`?around=${ids[1]}&limit=3`, 0, 3],
      ] as const) {
        const page = await json<MessageObject[]>(`${base}/messages${query}`)
        expect(pairs(page)).toEqual(expected.slice(from, to))
      }

      for (const id of ids) {
        const single = await json(`${base}/messages/${id}`)
        expect(single.timestamp).toBe(timestampOf(id))
        const pin = await send(`${base}/messages/pins/${id}`, 'PUT')
        expect(pin.status).toBe(204)
      }
      const pins = await json<{ items: { message: MessageObject }[] }>(
        `${base}/messages/pins`
      )
      expect(pairs(pins.items.map((item) => item.message))).toEqual(expected)
      expect(pairs(await json<MessageObject[]>(`${base}/pins`))).toEqual(
        expected
      )

      const inspected = await json<{
        messages: { id: string; timestamp: string; created_at: string }[]
      }>(`/_test/messages/${channelId}`)
      expect(
        inspected.messages.map((m) => [m.id, m.timestamp, m.created_at])
      ).toEqual([
        [ids[0], timestampOf(ids[0]), '2026-05-26 12:30:45.677'],
        [ids[1], timestampOf(ids[1]), '2026-05-31 12:30:45.670'],
        [ids[2], timestampOf(ids[2]), '2026-06-05 12:30:45.663'],
      ])
    }
  )

  it('keeps the creation timestamp through edits and never edits before it', async () => {
    const created = await json(`/channels/${channelId}/messages`, 'POST', {
      content: 'before',
    })

    const edited = await json(
      `/channels/${channelId}/messages/${created.id}`,
      'PATCH',
      { content: 'after' }
    )

    expect(edited.timestamp).toBe(created.timestamp)
    // An edit within the same second must not predate the millisecond creation.
    expect(edited.edited_timestamp).toBe(created.timestamp)

    const human = await inject(snowflakeAt(NOW.getTime() - DAY_MS))
    vi.setSystemTime(NOW.getTime() + 123)
    const humanEdit = await json(
      `/_test/channels/${channelId}/messages/${human.id}`,
      'PATCH',
      { content: 'human edit', author: { id: humanId } }
    )
    expect(humanEdit.timestamp).toBe('2026-06-14T12:30:45.678000+00:00')
    expect(humanEdit.edited_timestamp).toBe('2026-06-15T12:30:45.801000+00:00')
  })

  it('derives webhook message timestamps on execute, read and edit', async () => {
    const { webhookId, webhookToken } = seedWebhook(
      context.db,
      channelId,
      guildId
    )
    const base = `/webhooks/${webhookId}/${webhookToken}`

    const created = await json(`${base}?wait=true`, 'POST', {
      content: 'hook',
    })
    vi.setSystemTime(NOW.getTime() + 2000)
    const read = await json(`${base}/messages/${created.id}`)
    const edited = await json(`${base}/messages/${created.id}`, 'PATCH', {
      content: 'edited',
    })

    for (const message of [created, read, edited]) {
      expect(message.timestamp).toBe(timestampOf(created.id))
    }
    expect(created.timestamp).toBe('2026-06-15T12:30:45.678000+00:00')
  })

  it('derives interaction original response and followup timestamps', async () => {
    const interaction = seedInteraction(
      context.db,
      APPLICATION_ID,
      channelId,
      humanId
    )
    const base = `/webhooks/${APPLICATION_ID}/${interaction.interactionToken}`
    const callback = await json<{
      resource: { message: MessageObject }
    }>(
      `/interactions/${interaction.interactionId}/${interaction.interactionToken}/callback?with_response=true`,
      'POST',
      { type: 4, data: { content: 'original' } }
    )
    const original = callback.resource.message
    vi.setSystemTime(NOW.getTime() + 1234)
    const followup = await json(`${base}?wait=true`, 'POST', {
      content: 'followup',
    })

    expect(original.timestamp).toBe(timestampOf(original.id))
    expect(followup.timestamp).toBe('2026-06-15T12:30:46.912000+00:00')
    expect(followup.timestamp).toBe(timestampOf(followup.id))
    for (const [url, message] of [
      [`${base}/messages/@original`, original],
      [`${base}/messages/${followup.id}`, followup],
    ] as const) {
      const read = await json(url)
      const edited = await json(url, 'PATCH', { content: 'edited' })
      expect(read.timestamp).toBe(message.timestamp)
      expect(edited.timestamp).toBe(message.timestamp)
    }
  })

  it.each([
    { name: 'just inside', offset: 1, tooOld: false },
    { name: 'exactly at', offset: 0, tooOld: false },
    { name: 'just outside', offset: -1, tooOld: true },
  ])(
    'agrees with bulk delete $name the two-week limit',
    async ({ offset, tooOld }) => {
      const limit = NOW.getTime() - TWO_WEEKS_MS
      const ids = [snowflakeAt(limit + offset), snowflakeAt(limit + offset, 1)]
      for (const id of ids) await inject(id)
      const page = await json<MessageObject[]>(
        `/channels/${channelId}/messages`
      )
      expect(
        page.map((m) => Date.now() - Date.parse(m.timestamp) > TWO_WEEKS_MS)
      ).toEqual([tooOld, tooOld])

      const res = await send(
        `/channels/${channelId}/messages/bulk-delete`,
        'POST',
        { messages: ids }
      )

      expect(res.status).toBe(tooOld ? 400 : 204)
      if (tooOld) expect(await res.json()).toMatchObject({ code: 50_034 })
    }
  )

  it('lets a client filter by timestamp before bulk deleting', async () => {
    const old = snowflakeAt(NOW.getTime() - 15 * DAY_MS)
    const recent = [1, 2].map((days) =>
      snowflakeAt(NOW.getTime() - days * DAY_MS)
    )
    for (const id of [old, ...recent]) await inject(id)
    const page = await json<MessageObject[]>(`/channels/${channelId}/messages`)
    const fresh = page
      .filter((m) => Date.now() - Date.parse(m.timestamp) < TWO_WEEKS_MS)
      .map((m) => m.id)

    const res = await send(
      `/channels/${channelId}/messages/bulk-delete`,
      'POST',
      { messages: fresh }
    )

    expect(res.status).toBe(204)
    expect(fresh).toHaveLength(recent.length)
    expect(new Set(fresh)).toEqual(new Set(recent))
  })

  it('applies a ban message deletion window to the millisecond', async () => {
    seedMember(context.db, guildId, '444444444444444444')
    humanId = '444444444444444444'
    const ids = [2 * DAY_MS, 1001, 1000, 0].map((age) =>
      snowflakeAt(NOW.getTime() - age)
    )
    for (const id of ids) await inject(id)
    // Rows without a Snowflake time keep their whole-second stored value.
    for (const [messageId, second] of [
      ['m-before', '44'],
      ['m-inside', '45'],
    ]) {
      createMessage(
        context.db,
        { channelId, authorId: humanId, authorToken: '', messageId },
        'http://localhost'
      )
      context.db
        .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
        .run(`2026-06-15 12:30:${second}`, messageId)
    }

    const res = await send(`/guilds/${guildId}/bans/${humanId}`, 'PUT', {
      delete_message_seconds: 1,
    })

    expect(res.status).toBe(204)
    expect(
      context.db.prepare('SELECT id FROM messages ORDER BY id').all()
    ).toEqual([{ id: ids[0] }, { id: ids[1] }, { id: 'm-before' }])
  })

  it('derives the creation time of seeded messages', () => {
    const id = seedMessage(context.db, channelId, APPLICATION_ID, token)

    expect(getMessage(context.db, id, 'http://localhost')?.timestamp).toBe(
      '2026-06-15T12:30:45.678000+00:00'
    )
  })

  it.each(['01', '00000000000000000000', '18446744073709551616'])(
    'does not backdate an injected message with the non-Snowflake ID %s',
    async (id) => {
      const created = await inject(id)

      // The fallback is SQLite's clock, which Vitest does not fake.
      const stored = context.db
        .prepare('SELECT created_at FROM messages WHERE id = ?')
        .get(id) as { created_at: string }
      expect(stored.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(created.timestamp).toBe(
        `${stored.created_at.replace(' ', 'T')}.000000+00:00`
      )
    }
  )

  it.each(['m1', '01', '18446744073709551616', '99999999999999999999'])(
    'keeps the stored creation time for the non-Snowflake ID %s',
    (id) => {
      const created = createMessage(
        context.db,
        {
          channelId,
          authorId: APPLICATION_ID,
          authorToken: token,
          messageId: id,
        },
        'http://localhost'
      )
      const stored = context.db
        .prepare('SELECT created_at FROM messages WHERE id = ?')
        .get(id) as { created_at: string }

      expect(stored.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(created.timestamp).toBe(
        `${stored.created_at.replace(' ', 'T')}.000000+00:00`
      )
      context.db
        .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
        .run('2026-06-01 12:30:45', id)
      expect(isTooOldForBulkDelete(context.db, id)).toBe(true)
      context.db
        .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
        .run('2026-06-01 12:30:46', id)
      expect(isTooOldForBulkDelete(context.db, id)).toBe(false)
    }
  )
})

describe('message timestamps over the Gateway', () => {
  let close: (() => Promise<void>) | undefined
  let ws: WebSocket | undefined

  afterEach(async () => {
    ws?.terminate()
    ws = undefined
    await close?.()
    close = undefined
  })

  it('dispatches MESSAGE_CREATE and MESSAGE_UPDATE with the Snowflake time', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const token = seedBot(server.db, 'Bot gateway-timestamps')
    const guildId = seedGuild(server.db, token)
    const channelId = seedChannel(server.db, guildId)
    const human = createTestUser(server.db, { username: 'Human' }).id
    const httpUrl = server.url.replace('ws://', 'http://')
    const frames: { op: number; t?: string; d: MessageObject }[] = []
    ws = new WebSocket(server.url)
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as (typeof frames)[number])
    })
    /** Waits for the next dispatch or opcode frame matching the predicate. */
    const frame = (match: string | number): Promise<MessageObject> =>
      vi.waitFor(() => {
        const found = frames.find((f) => f.t === match || f.op === match)
        if (!found) throw new Error(`No ${match} frame yet`)
        return found.d
      })
    await frame(GatewayOp.Hello)
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token, intents: GatewayIntentBits.GuildMessages },
      })
    )
    await frame('READY')
    const id = snowflakeAt(Date.now() - 15 * DAY_MS)
    const headers = { 'Content-Type': 'application/json' }

    await fetch(`${httpUrl}/_test/channels/${channelId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, content: 'old', author: { id: human } }),
    })
    const created = await frame('MESSAGE_CREATE')
    await fetch(`${httpUrl}/_test/channels/${channelId}/messages/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ content: 'edited', author: { id: human } }),
    })
    const updated = await frame('MESSAGE_UPDATE')

    expect(created).toMatchObject({ id, timestamp: timestampOf(id) })
    expect(updated).toMatchObject({ id, timestamp: timestampOf(id) })
  })
})

describe('stored message creation times', () => {
  it('re-derives existing Snowflake rows when a database is reopened', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fauxcord-db-'))
    const dbPath = path.join(dir, 'legacy.db')
    try {
      let db = initializeDatabase(dbPath)
      const channelId = seedChannel(db, seedGuild(db, seedBot(db)))
      const id = snowflakeAt(Date.parse('2026-01-02T03:04:05.006Z'))
      const sameSecond = snowflakeAt(Date.parse('2026-01-02T03:04:05.007Z'))
      const insert = db.prepare(
        "INSERT INTO messages (id, channel_id, author_id, created_at, edited_at) VALUES (?, ?, '1', '2026-06-07 10:00:00', ?)"
      )
      insert.run(id, channelId, '2026-06-07 10:00:00')
      insert.run(sameSecond, channelId, '2026-01-02 03:04:05')
      insert.run('m1', channelId, '2026-06-07 10:00:00')
      closeDatabase(db)

      for (let reopen = 0; reopen < 2; reopen++) {
        db = initializeDatabase(dbPath)
        expect(
          db
            .prepare(
              'SELECT id, created_at, edited_at FROM messages ORDER BY id'
            )
            .all()
        ).toEqual([
          {
            id,
            created_at: '2026-01-02 03:04:05.006',
            edited_at: '2026-06-07 10:00:00',
          },
          // A legacy edit within the creation second must not precede it.
          {
            id: sameSecond,
            created_at: '2026-01-02 03:04:05.007',
            edited_at: '2026-01-02 03:04:05.007',
          },
          {
            id: 'm1',
            created_at: '2026-06-07 10:00:00',
            edited_at: '2026-06-07 10:00:00',
          },
        ])
        closeDatabase(db)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an edit committed while the database is being re-derived', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fauxcord-db-'))
    const dbPath = path.join(dir, 'concurrent.db')
    try {
      let db = initializeDatabase(dbPath)
      const channelId = seedChannel(db, seedGuild(db, seedBot(db)))
      const first = snowflakeAt(Date.parse('2026-01-02T03:04:05.006Z'))
      const second = snowflakeAt(Date.parse('2026-01-02T03:04:06.007Z'))
      const insert = db.prepare(
        "INSERT INTO messages (id, channel_id, author_id, created_at) VALUES (?, ?, '1', '2026-06-07 10:00:00')"
      )
      insert.run(first, channelId)
      insert.run(second, channelId)
      // Edits the second row after the rows were read, before its own update.
      db.exec(`
        CREATE TRIGGER concurrent_edit AFTER UPDATE OF created_at ON messages
        WHEN new.id = '${first}'
        BEGIN
          UPDATE messages SET edited_at = '2026-06-08 09:00:00'
          WHERE id = '${second}';
        END
      `)
      closeDatabase(db)

      db = initializeDatabase(dbPath)

      expect(
        db.prepare('SELECT edited_at FROM messages WHERE id = ?').get(second)
      ).toEqual({ edited_at: '2026-06-08 09:00:00' })
      closeDatabase(db)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('are read as UTC on non-UTC hosts', () => {
    // A separate process owns TZ; parallel tests keep their own timezone.
    const script = `
      import { createFullTestApp, seedBot, seedGuild, seedChannel } from './src/test-helpers.ts'
      import { createMessage, updateMessage, isTooOldForBulkDelete } from './src/services/messages.ts'
      const context = createFullTestApp()
      try {
        const channelId = seedChannel(context.db, seedGuild(context.db, seedBot(context.db)))
        const results = []
        for (const messageId of ['1456400000000000000', 'm1']) {
          createMessage(context.db, { channelId, authorId: '111111111111111111', authorToken: '', messageId }, 'http://localhost')
          context.db.prepare("UPDATE messages SET created_at = '2026-01-02 03:04:05.006' WHERE id = 'm1'").run()
          const message = updateMessage(context.db, messageId, { content: 'edited' }, 'http://localhost')
          results.push({ timestamp: message.timestamp, editedAge: Math.abs(Date.now() - Date.parse(message.edited_timestamp)) < 60000 })
        }
        // One hour inside the limit: a local-time reading would shift it out.
        const edge = new Date(Date.now() - 14 * 86400000 + 3600000).toISOString().replace('T', ' ').slice(0, 23)
        context.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(edge, 'm1')
        results.push(isTooOldForBulkDelete(context.db, 'm1'))
        console.log(JSON.stringify(results))
      } finally {
        context.cleanup()
      }
    `
    expect(runInTimezone('Pacific/Kiritimati', script)).toEqual([
      {
        timestamp: timestampOf('1456400000000000000'),
        editedAge: true,
      },
      { timestamp: '2026-01-02T03:04:05.006000+00:00', editedAge: true },
      false,
    ])
  })
})
