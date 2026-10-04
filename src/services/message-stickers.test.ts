import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../db'
import { seedBot, seedGuild, seedChannel } from '../test-helpers'
import { createGuildSticker } from './guild-advanced'
import { getMessage, getMessages } from './messages'
import { injectTestMessage, createTestUser } from './test-control'

describe('message sticker persistence', () => {
  it('upgrades an existing database and retains sticker snapshots after reopening', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fauxcord-stickers-'))
    const databasePath = path.join(directory, 'fixtures.db')
    let db = initializeDatabase(databasePath)
    try {
      // Simulate the schema before message sticker support.
      db.exec('DROP TABLE message_stickers')
      const token = seedBot(db)
      const guild = seedGuild(db, token)
      const channel = seedChannel(db, guild)
      const human = createTestUser(db, { username: 'Human' }).id
      db.prepare(
        'INSERT INTO messages (id, channel_id, author_id, content) VALUES (?, ?, ?, ?)'
      ).run('1', channel, human, 'legacy')
      db.close()
      db = initializeDatabase(databasePath)
      expect(getMessage(db, '1', 'http://localhost')).not.toHaveProperty(
        'sticker_items'
      )
      const id = createGuildSticker(db, guild, human, { name: 'Persistent' }).id
      const message = injectTestMessage(
        db,
        channel,
        { author: { id: human }, sticker_ids: [id] },
        'http://localhost'
      )
      expect(typeof message).toBe('object')
      if (typeof message === 'string') throw new Error(message)
      db.close()
      db = initializeDatabase(databasePath)
      expect(getMessage(db, message.id, 'http://localhost')).toEqual(message)
      expect(getMessages(db, channel, {}, 'http://localhost')).toContainEqual(
        message
      )
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
