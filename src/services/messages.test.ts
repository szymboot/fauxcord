import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  toMessageObject,
  createMessage,
  getMessage,
  getMessages,
  updateMessage,
  type MessageRow,
  type UserRow,
} from './messages'
import { initializeDatabase, closeDatabase, type Database } from '../db'
import { seedBot, seedGuild, seedChannel } from '../test-helpers'
import type { MessageComponents } from '../validators/message-components'

describe('toMessageObject', () => {
  const row: MessageRow = {
    id: '1',
    channel_id: '2',
    author_id: '3',
    author_token: 'Bot test',
    content: 'hello',
    components: '[]',
    tts: 0,
    mention_everyone: 0,
    pinned: 0,
    type: 0,
    flags: 0,
    referenced_message_id: null,
    created_at: '2026-01-01 00:00:00',
    edited_at: null,
  }
  const author: UserRow = {
    id: '3',
    username: 'bot',
    discriminator: '0',
    avatar: null,
    bot: 1,
  }

  it.each(['Display Name', null, undefined])(
    'preserves author global_name=%s',
    (globalName) => {
      const message = toMessageObject(
        row,
        { ...author, global_name: globalName },
        [],
        [],
        [],
        'http://localhost:3000'
      )
      expect(message.author.global_name).toBe(globalName ?? null)
    }
  )

  it('includes the full Reaction shape (count_details, me_burst, burst_colors)', () => {
    // Real Discord's Reaction object (discord-api-types APIReaction) requires
    // count_details/me_burst/burst_colors — omitting them causes a real
    // NullReferenceException in Discord.Net.Rest's RestReaction.Create,
    // confirmed via the compat/dotnet-discordnet verifier.
    const obj = toMessageObject(
      row,
      author,
      [],
      [],
      [{ emoji: '👍', count: 2, burst_count: 0, burst_colors: null }],
      'http://localhost:3000'
    )
    expect(obj.reactions).toHaveLength(1)
    const reaction = obj.reactions?.[0]
    expect(reaction?.count).toBe(2)
    expect(reaction?.me).toBe(false)
    expect(reaction?.me_burst).toBe(false)
    expect(reaction?.burst_colors).toEqual([])
    expect(reaction?.count_details).toEqual({ burst: 0, normal: 2 })
    expect(reaction?.emoji).toEqual({ id: null, name: '👍' })
  })

  it('splits burst memberships into count_details and exposes burst colors', () => {
    const obj = toMessageObject(
      row,
      author,
      [],
      [],
      [
        {
          emoji: '🔥',
          count: 3,
          burst_count: 2,
          burst_colors: '["#ff0000","#00ff00"]',
        },
      ],
      'http://localhost:3000'
    )
    expect(obj.reactions).toEqual([
      {
        count: 3,
        count_details: { burst: 2, normal: 1 },
        me: false,
        me_burst: false,
        emoji: { id: null, name: '🔥' },
        burst_colors: ['#ff0000', '#00ff00'],
      },
    ])
  })

  it('omits the reactions field entirely when there are no reactions', () => {
    const obj = toMessageObject(
      row,
      author,
      [],
      [],
      [],
      'http://localhost:3000'
    )
    expect(obj.reactions).toBeUndefined()
  })
  it.each([
    {
      name: 'POSIX indexed',
      filePath: path.posix.join('2', '1', '123', 'proof #?.txt'),
      suffix: '2/1/123/proof%20%23%3F.txt',
    },
    {
      name: 'Windows indexed',
      filePath: path.win32.join('2', '1', '123', 'proof #?.txt'),
      suffix: '2/1/123/proof%20%23%3F.txt',
    },
    {
      name: 'POSIX legacy',
      filePath: path.posix.join('2', '1', 'proof #?.txt'),
      suffix: '2/1/proof%20%23%3F.txt',
    },
    {
      name: 'Windows legacy',
      filePath: path.win32.join('2', '1', 'proof #?.txt'),
      suffix: '2/1/proof%20%23%3F.txt',
    },
  ])('serializes usable $name attachment URLs', ({ filePath, suffix }) => {
    const message = toMessageObject(
      row,
      author,
      [],
      [
        {
          id: '123',
          message_id: '1',
          filename: 'proof #?.txt',
          size: 3,
          content_type: 'image/png',
          file_path: filePath,
        },
      ],
      [],
      'http://localhost:3000'
    )
    expect(message.attachments[0].url).toBe(
      `http://localhost:3000/_mock/attachments/${suffix}`
    )
    expect(message.attachments[0].proxy_url).toBe(message.attachments[0].url)
  })
})

describe('persisted message components', () => {
  let db: Database
  let channelId: string
  let authorId: string
  const baseUrl = 'http://localhost:3000'
  const components: MessageComponents = [
    {
      type: 1,
      id: 0,
      components: [
        {
          type: 2,
          id: 0,
          style: 1,
          label: 'Buy',
          custom_id: 'shop_item_buy_1',
        },
        {
          type: 2,
          id: 0,
          style: 4,
          label: 'Return',
          custom_id: 'shop_item_return_1',
          disabled: true,
          emoji: { name: '🐝', animated: false },
        },
      ],
    },
  ]
  beforeEach(() => {
    db = initializeDatabase(':memory:')
    const token = seedBot(db)
    authorId = (
      db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
        user_id: string
      }
    ).user_id
    channelId = seedChannel(db, seedGuild(db, token))
  })
  afterEach(() => {
    closeDatabase(db)
  })

  it('stores independent snapshots and replaces, preserves, and clears them on edits', () => {
    const created = createMessage(
      db,
      {
        messageId: '1',
        channelId,
        authorId,
        authorToken: 'Bot test',
        components,
      },
      baseUrl
    )
    expect(created.components).toEqual(components)
    expect(getMessage(db, '1', baseUrl)?.components).toEqual(components)
    expect(getMessages(db, channelId, {}, baseUrl)[0].components).toEqual(
      components
    )
    created.components[0].components.pop()
    expect(getMessage(db, '1', baseUrl)?.components).toEqual(components)
    expect(
      updateMessage(db, '1', { content: 'edited' }, baseUrl)?.components
    ).toEqual(components)
    const buyOnly: MessageComponents = [
      { ...components[0], components: [components[0].components[0]] },
    ]
    const edited = updateMessage(db, '1', { components: buyOnly }, baseUrl)
    expect(edited?.components).toEqual(buyOnly)
    expect(edited?.edited_timestamp).not.toBeNull()
    expect(
      updateMessage(db, '1', { components: [] }, baseUrl)?.components
    ).toEqual([])
    expect(updateMessage(db, '1', { components }, baseUrl)?.components).toEqual(
      components
    )
    expect(
      updateMessage(db, '1', { components: null }, baseUrl)?.components
    ).toEqual([])
  })

  it('defaults ordinary fixtures and messages without components to an empty array', () => {
    expect(
      createMessage(
        db,
        { messageId: '1', channelId, authorId, authorToken: 'Bot test' },
        baseUrl
      ).components
    ).toEqual([])
  })
})

describe('message component migration', () => {
  it('upgrades legacy rows, persists components across reopening, and tolerates reinitialization', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fauxcord-components-'))
    const databasePath = path.join(directory, 'fixtures.db')
    let db = initializeDatabase(databasePath)
    try {
      db.exec('ALTER TABLE messages DROP COLUMN components')
      const token = seedBot(db)
      const channel = seedChannel(db, seedGuild(db, token))
      const author = (
        db.prepare('SELECT user_id FROM bots WHERE token = ?').get(token) as {
          user_id: string
        }
      ).user_id
      db.prepare(
        'INSERT INTO messages (id, channel_id, author_id, content) VALUES (?, ?, ?, ?)'
      ).run('1', channel, author, 'legacy')
      closeDatabase(db)
      db = initializeDatabase(databasePath)
      expect(getMessage(db, '1', 'http://localhost')?.components).toEqual([])
      const updated = updateMessage(
        db,
        '1',
        {
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 5,
                  label: 'Link',
                  url: 'https://example.com',
                },
              ],
            },
          ],
        },
        'http://localhost'
      )
      closeDatabase(db)
      db = initializeDatabase(databasePath)
      expect(getMessage(db, '1', 'http://localhost')).toEqual(updated)
    } finally {
      closeDatabase(db)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
