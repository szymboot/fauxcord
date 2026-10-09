import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase, closeDatabase, type Database } from '../db'
import {
  seedBot,
  seedGuild,
  seedMember,
  seedVoiceChannel,
  seedChannel,
} from '../test-helpers'
import {
  getGuildVoiceState,
  getGuildVoiceStates,
  setTestGuildVoiceState,
} from './voice-states'

describe('Shared voice-state foundation', () => {
  let db: Database
  let guild: string
  let user: string
  let channel: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    guild = seedGuild(db, seedBot(db))
    user = seedMember(db, guild)
    channel = seedVoiceChannel(db, guild)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('returns prior state, change detection and default/silent publication policy', () => {
    const joined = setTestGuildVoiceState(db, guild, user, {
      channel_id: channel,
    })
    expect(joined).toMatchObject({ previous: null, changed: true, emit: true })
    const state = getGuildVoiceState(db, guild, user)
    expect(setTestGuildVoiceState(db, guild, user, { emit: false })).toEqual({
      previous: state,
      state,
      changed: false,
      emit: false,
    })
    expect(
      setTestGuildVoiceState(db, guild, user, { self_stream: true })
    ).toEqual({
      previous: state,
      state: { ...state, self_stream: true },
      changed: true,
      emit: true,
    })
  })

  it('validates direct calls before writes and rolls back failed persistence', () => {
    expect(
      setTestGuildVoiceState(db, guild, user, {
        channel_id: channel,
        mute: 'true',
      })
    ).toBe('INVALID_INPUT')
    expect(getGuildVoiceState(db, guild, user)).toBeNull()
    setTestGuildVoiceState(db, guild, user, { channel_id: channel })
    const before = getGuildVoiceState(db, guild, user)
    db.exec(`CREATE TRIGGER reject_voice AFTER UPDATE ON guild_voice_states
      BEGIN SELECT RAISE(ABORT, 'Fixture failed'); END`)
    expect(() =>
      setTestGuildVoiceState(db, guild, user, { self_stream: true })
    ).toThrow('Fixture failed')
    expect(db.inTransaction).toBe(false)
    expect(getGuildVoiceState(db, guild, user)).toEqual(before)
  })

  it('lists all valid voice/stage members without a limit and filters legacy invalid rows', () => {
    const stage = seedVoiceChannel(db, guild, '555555555555555556')
    db.prepare('UPDATE channels SET type = 13 WHERE id = ?').run(stage)
    const text = seedChannel(db, guild)
    const otherGuild = seedGuild(db, 'Bot testtoken', '222222222222222223')
    const foreign = seedVoiceChannel(db, otherGuild, '555555555555555557')
    const insert = db.prepare(`INSERT INTO guild_voice_states
      (guild_id, user_id, channel_id, session_id) VALUES (?, ?, ?, 'legacy')`)
    for (const channelId of [stage, text, foreign, null]) {
      insert.run(guild, seedMember(db, guild), channelId)
    }
    const orphan = seedMember(db, otherGuild)
    insert.run(guild, orphan, channel)
    setTestGuildVoiceState(db, guild, user, { channel_id: channel })
    const states = getGuildVoiceStates(db, guild)
    expect(states).toHaveLength(2)
    expect(states.map((state) => state.channel_id)).toEqual(
      expect.arrayContaining([channel, stage])
    )
    expect(
      states.every((state) => state.guild_id === guild && !state.self_stream)
    ).toBe(true)
    expect(getGuildVoiceStates(db, otherGuild)).toEqual([])
  })

  it('cascades guild deletion and reads legacy nullable streaming as false', () => {
    setTestGuildVoiceState(db, guild, user, { channel_id: channel })
    db.prepare('UPDATE guild_voice_states SET self_stream = NULL').run()
    expect(getGuildVoiceState(db, guild, user)?.self_stream).toBe(false)
    db.prepare('DELETE FROM guilds WHERE id = ?').run(guild)
    expect(getGuildVoiceState(db, guild, user)).toBeNull()
  })
})
