import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initializeDatabase, closeDatabase } from '../db'
import type { Database } from '../db'
import {
  addReaction,
  removeReaction,
  getReactionUsers,
  removeAllReactions,
  removeEmojiReactions,
} from './reactions'
import { gatewayBus } from '../gateway/bus'
import { seedBot, seedGuild, seedChannel, seedMessage } from '../test-helpers'

describe('reactions service', () => {
  let db: Database
  let channelId: string
  let messageId: string
  const userId = '555555555555555555'

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    const bot = seedBot(db)
    const guild = seedGuild(db, bot)
    channelId = seedChannel(db, guild)
    messageId = seedMessage(db, channelId, '111111111111111111', bot)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('addReaction', () => {
    it('emits message.reaction.add and returns true on a genuine new reaction', () => {
      const listener = vi.fn()
      gatewayBus.on('message.reaction.add', listener)
      try {
        const result = addReaction(db, messageId, userId, '👍')
        expect(result).toBe(true)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ channelId, messageId, userId })
        )
      } finally {
        gatewayBus.off('message.reaction.add', listener)
      }
    })

    it('does not emit message.reaction.add when the reaction already exists (INSERT OR IGNORE no-op)', () => {
      addReaction(db, messageId, userId, '👍')

      const listener = vi.fn()
      gatewayBus.on('message.reaction.add', listener)
      try {
        const result = addReaction(db, messageId, userId, '👍')
        // Return value semantics are unchanged: still reports success even
        // though no new row was inserted.
        expect(result).toBe(true)
        expect(listener).not.toHaveBeenCalled()
      } finally {
        gatewayBus.off('message.reaction.add', listener)
      }
    })
  })

  describe('getReactionUsers', () => {
    it('defaults to normal users and returns no normal membership for burst reads', () => {
      db.prepare("INSERT INTO users (id, username) VALUES (?, 'Human')").run(
        userId
      )
      addReaction(db, messageId, userId, '👍')
      expect(getReactionUsers(db, messageId, '👍')).toEqual([
        expect.objectContaining({ id: userId, bot: 0 }),
      ])
      expect(getReactionUsers(db, messageId, '👍', 25, undefined, 0)).toEqual(
        getReactionUsers(db, messageId, '👍')
      )
      expect(getReactionUsers(db, messageId, '👍', 25, undefined, 1)).toEqual(
        []
      )
    })
  })

  describe('removeReaction', () => {
    it('emits message.reaction.remove when a reaction was actually deleted', () => {
      addReaction(db, messageId, userId, '👍')

      const listener = vi.fn()
      gatewayBus.on('message.reaction.remove', listener)
      try {
        removeReaction(db, messageId, userId, '👍')
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ channelId, messageId, userId })
        )
      } finally {
        gatewayBus.off('message.reaction.remove', listener)
      }
    })

    it('does not emit message.reaction.remove when there was nothing to delete', () => {
      const listener = vi.fn()
      gatewayBus.on('message.reaction.remove', listener)
      try {
        // No reaction was ever added, so the DELETE removes zero rows.
        removeReaction(db, messageId, userId, '👍')
        expect(listener).not.toHaveBeenCalled()
      } finally {
        gatewayBus.off('message.reaction.remove', listener)
      }
    })
  })

  it.each(['all', 'emoji'] as const)(
    'does not emit a clear %s event when SQLite rejects deletion',
    (kind) => {
      addReaction(db, messageId, userId, '👍')
      db.exec(`CREATE TRIGGER reject_reaction_delete BEFORE DELETE ON reactions
        BEGIN SELECT RAISE(ABORT, 'Cannot delete reaction'); END`)
      const event =
        kind === 'all'
          ? 'message.reaction.remove.all'
          : 'message.reaction.remove.emoji'
      const listener = vi.fn()
      gatewayBus.on(event, listener)
      try {
        expect(() => {
          if (kind === 'all') removeAllReactions(db, messageId)
          else removeEmojiReactions(db, messageId, '👍')
        }).toThrow('Cannot delete reaction')
        expect(listener).not.toHaveBeenCalled()
        expect(db.prepare('SELECT emoji FROM reactions').all()).toEqual([
          { emoji: '👍' },
        ])
      } finally {
        gatewayBus.off(event, listener)
      }
    }
  )
})
