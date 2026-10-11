import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../db'
import { seedBot, seedEmoji, seedGuild } from '../test-helpers'
import {
  parseReactionEmoji,
  reactionEmojiFromKey,
  reactionEmojiKey,
  resolveReactionEmoji,
} from './reaction-emoji'

describe('reaction emoji identity', () => {
  it.each([
    ['party:123', { id: '123', name: 'party', animated: false }],
    ['a:dance:456', { id: '456', name: 'dance', animated: true }],
    ['a:789', { id: '789', name: 'a', animated: false }],
    ['👍🏽', { id: null, name: '👍🏽', animated: false }],
    ['party:12a', { id: null, name: 'party:12a', animated: false }],
    [':123', { id: null, name: ':123', animated: false }],
  ])('parses %s', (raw, expected) => {
    expect(parseReactionEmoji(raw)).toEqual(expected)
  })

  it('keys custom emoji by ID only, so names and the animated prefix do not matter', () => {
    const keys = ['party:123', 'fiesta:123', 'a:party:123'].map((raw) =>
      reactionEmojiKey(parseReactionEmoji(raw))
    )
    expect(new Set(keys)).toEqual(new Set(['custom:123']))
    expect(reactionEmojiKey(parseReactionEmoji('🐝'))).toBe('🐝')
  })

  it('builds payload emoji from current data, then request fallback, then null', () => {
    const fallback = parseReactionEmoji('a:old:123')
    expect(
      reactionEmojiFromKey(
        'custom:123',
        { name: 'new', animated: false },
        fallback
      )
    ).toEqual({ id: '123', name: 'new', animated: false })
    expect(reactionEmojiFromKey('custom:123', undefined, fallback)).toEqual({
      id: '123',
      name: 'old',
      animated: true,
    })
    expect(reactionEmojiFromKey('custom:123')).toEqual({
      id: '123',
      name: null,
      animated: false,
    })
    expect(reactionEmojiFromKey('🐝')).toStrictEqual({ id: null, name: '🐝' })
  })

  it('resolves the current guild emoji name and animated flag', () => {
    const db = initializeDatabase(':memory:')
    const guild = seedGuild(db, seedBot(db, 'Bot emoji'))
    const id = seedEmoji(db, guild, null, 'current', true)
    expect(resolveReactionEmoji(db, parseReactionEmoji(`stale:${id}`))).toEqual(
      {
        id,
        name: 'current',
        animated: true,
      }
    )
  })
})
