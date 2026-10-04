import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initializeDatabase, closeDatabase } from '../db'
import type { Database } from '../db'
import {
  createTestInteraction,
  createTestUser,
  deleteTestSetup,
  resetTestData,
} from './test-control'
import { createCommand } from './application-commands'

describe('createTestInteraction', () => {
  let db: Database
  const applicationId = '111111111111111111'
  const guildId = '222222222222222222'
  const channelId = '333333333333333333'

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    db.prepare(
      "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'App', '0', 1)"
    ).run(applicationId)
    db.prepare(
      "INSERT INTO bots (token, user_id, username, discriminator) VALUES ('Bot t', ?, 'App', '0')"
    ).run(applicationId)
    db.prepare(
      "INSERT INTO guilds (id, name, owner_id, bot_token) VALUES (?, 'g', ?, 'Bot t')"
    ).run(guildId, applicationId)
    db.prepare(
      "INSERT INTO channels (id, guild_id, type, name) VALUES (?, ?, 0, 'general')"
    ).run(channelId, guildId)
    createCommand(db, applicationId, guildId, {
      name: 'ping',
      description: 'x',
    })
  })

  it('creates an interaction against a registered guild command', () => {
    const result = createTestInteraction(db, {
      application_id: applicationId,
      command_name: 'ping',
      guild_id: guildId,
      channel_id: channelId,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.interaction.data?.name).toBe('ping')
    expect(result.interaction.locale).toBe('en-US')
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('passes the requested user locale to the interaction service', () => {
    const result = createTestInteraction(db, {
      application_id: applicationId,
      command_name: 'ping',
      guild_id: guildId,
      channel_id: channelId,
      locale: 'pl',
    })
    expect(result).toMatchObject({ ok: true, interaction: { locale: 'pl' } })
  })

  it('returns unknown_command for an unregistered command name', () => {
    const result = createTestInteraction(db, {
      application_id: applicationId,
      command_name: 'does-not-exist',
      guild_id: guildId,
      channel_id: channelId,
    })
    expect(result).toEqual({ ok: false, reason: 'unknown_command' })
  })

  it('falls back to a global command when no guild-scoped match exists', () => {
    createCommand(db, applicationId, null, {
      name: 'globalonly',
      description: 'x',
    })
    const result = createTestInteraction(db, {
      application_id: applicationId,
      command_name: 'globalonly',
      guild_id: guildId,
      channel_id: channelId,
    })
    expect(result.ok).toBe(true)
  })
})

describe('deleteTestSetup / resetTestData — application command & interaction cleanup', () => {
  let db: Database
  const token = 'Bot cleanuptoken'
  const applicationId = '444444444444444444'

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    db.prepare(
      "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'App', '0', 1)"
    ).run(applicationId)
    db.prepare(
      'INSERT INTO bots (token, user_id, username, discriminator) VALUES (?, ?, ?, ?)'
    ).run(token, applicationId, 'App', '0')
    createCommand(db, applicationId, null, { name: 'ping', description: 'x' })
    createTestInteraction(db, {
      application_id: applicationId,
      command_name: 'ping',
    })
  })

  it('deleteTestSetup removes global commands and interactions for the bot', () => {
    deleteTestSetup(db, token)
    const commands = db
      .prepare('SELECT * FROM application_commands WHERE application_id = ?')
      .all(applicationId)
    const interactions = db
      .prepare('SELECT * FROM interactions WHERE application_id = ?')
      .all(applicationId)
    expect(commands).toHaveLength(0)
    expect(interactions).toHaveLength(0)
  })

  it('resetTestData removes interactions but keeps application_commands', () => {
    resetTestData(db, token)
    const commands = db
      .prepare('SELECT * FROM application_commands WHERE application_id = ?')
      .all(applicationId)
    const interactions = db
      .prepare('SELECT * FROM interactions WHERE application_id = ?')
      .all(applicationId)
    expect(commands).toHaveLength(1)
    expect(interactions).toHaveLength(0)
  })
})

describe('createTestUser avatar', () => {
  let db: Database

  beforeEach(() => {
    db = initializeDatabase(':memory:')
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it.each(['0123456789abcdef0123456789abcdef', null, undefined])(
    'persists avatar=%s with the existing human defaults',
    (avatar) => {
      const user = createTestUser(db, { username: 'Human', avatar })
      expect(user.id).toMatch(/^\d+$/)
      expect(user).toEqual({
        id: user.id,
        username: 'Human',
        discriminator: '0',
      })
      expect(
        db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
      ).toMatchObject({
        avatar: avatar ?? null,
        bot: 0,
        global_name: null,
      })
    }
  )

  it('rejects an ID collision without overwriting the profile', () => {
    const user = createTestUser(db, {
      id: '555555555555555555',
      username: 'Human',
      discriminator: '1234',
      global_name: 'Display Name',
      avatar: '0123456789abcdef0123456789abcdef',
    })
    const before = db.prepare('SELECT * FROM users').all()
    expect(() =>
      createTestUser(db, { id: user.id, username: 'Other', avatar: null })
    ).toThrow('CONFLICT')
    expect(db.prepare('SELECT * FROM users').all()).toEqual(before)
  })
})
