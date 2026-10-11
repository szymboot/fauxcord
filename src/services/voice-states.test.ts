import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase, closeDatabase, type Database } from '../db'
import {
  seedBot,
  seedGuild,
  seedMember,
  seedVoiceChannel,
  seedChannel,
} from '../test-helpers'
import { getGuildMember } from './guild-members'
import {
  compareUserIds,
  disconnectGuildVoiceChannelMembers,
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
      displaced: [],
    })
    expect(
      setTestGuildVoiceState(db, guild, user, { self_stream: true })
    ).toEqual({
      previous: state,
      state: { ...state, self_stream: true },
      changed: true,
      emit: true,
      displaced: [],
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

  describe('single voice connection per human user', () => {
    let otherGuild: string
    let otherChannel: string

    beforeEach(() => {
      otherGuild = seedGuild(db, 'Bot testtoken', '222222222222222223')
      otherChannel = seedVoiceChannel(db, otherGuild, '555555555555555558')
      seedMember(db, otherGuild, user)
    })

    it('disconnects the other guild first, keeping its session and clearing live-only fields', () => {
      setTestGuildVoiceState(db, guild, user, {
        channel_id: channel,
        self_stream: true,
        self_video: true,
        self_mute: true,
        request_to_speak_timestamp: '2026-01-01T00:00:00.000Z',
      })
      const before = getGuildVoiceState(db, guild, user)
      const result = setTestGuildVoiceState(db, otherGuild, user, {
        channel_id: otherChannel,
        self_stream: true,
      })
      assert.ok(typeof result !== 'string')
      const disconnected = {
        ...before,
        channel_id: null,
        self_stream: false,
        self_video: false,
        request_to_speak_timestamp: null,
      }
      expect(result.displaced).toEqual([
        {
          previous: before,
          state: disconnected,
          changed: true,
          emit: true,
          displaced: [],
        },
      ])
      expect(result.state).toMatchObject({
        guild_id: otherGuild,
        channel_id: otherChannel,
        self_stream: true,
      })
      expect(getGuildVoiceState(db, guild, user)).toEqual(disconnected)
      expect(getGuildVoiceStates(db, guild)).toEqual([])
      expect(getGuildVoiceStates(db, otherGuild)).toEqual([result.state])
    })

    it('applies the rule silently for emit: false and reports a silent displacement', () => {
      setTestGuildVoiceState(db, guild, user, {
        channel_id: channel,
        emit: false,
      })
      const result = setTestGuildVoiceState(db, otherGuild, user, {
        channel_id: otherChannel,
        emit: false,
      })
      assert.ok(typeof result !== 'string')
      expect(result.emit).toBe(false)
      expect(result.displaced.map((entry) => entry.emit)).toEqual([false])
      expect(getGuildVoiceState(db, guild, user)?.channel_id).toBeNull()
    })

    it('keeps same-guild moves, disconnects and other users untouched', () => {
      const moved = seedVoiceChannel(db, guild, '555555555555555559')
      const other = seedMember(db, otherGuild)
      setTestGuildVoiceState(db, otherGuild, other, {
        channel_id: otherChannel,
      })
      setTestGuildVoiceState(db, guild, user, { channel_id: channel })
      const result = setTestGuildVoiceState(db, guild, user, {
        channel_id: moved,
      })
      assert.ok(typeof result !== 'string')
      expect(result.displaced).toEqual([])
      const left = setTestGuildVoiceState(db, guild, user, {
        channel_id: null,
      })
      assert.ok(typeof left !== 'string')
      expect(left.displaced).toEqual([])
      expect(getGuildVoiceState(db, otherGuild, other)?.channel_id).toBe(
        otherChannel
      )
    })

    it('does not displace a retained disconnected state or a failed write', () => {
      setTestGuildVoiceState(db, guild, user, { channel_id: channel })
      setTestGuildVoiceState(db, guild, user, { channel_id: null })
      const result = setTestGuildVoiceState(db, otherGuild, user, {
        channel_id: otherChannel,
      })
      assert.ok(typeof result !== 'string')
      expect(result.displaced).toEqual([])
      setTestGuildVoiceState(db, guild, user, { channel_id: channel })
      expect(
        setTestGuildVoiceState(db, otherGuild, user, {
          channel_id: seedChannel(db, otherGuild),
        })
      ).toBe('INVALID_INPUT')
      expect(getGuildVoiceState(db, guild, user)?.channel_id).toBe(channel)
    })

    it('heals legacy rows connected in several guilds on the next connected write', () => {
      const third = seedGuild(db, 'Bot testtoken', '222222222222222224')
      const thirdChannel = seedVoiceChannel(db, third, '555555555555555560')
      seedMember(db, third, user)
      const insert = db.prepare(`INSERT INTO guild_voice_states
        (guild_id, user_id, channel_id, session_id) VALUES (?, ?, ?, 'legacy')`)
      insert.run(third, user, thirdChannel)
      insert.run(guild, user, channel)
      const result = setTestGuildVoiceState(db, otherGuild, user, {
        channel_id: otherChannel,
      })
      assert.ok(typeof result !== 'string')
      expect(result.displaced.map((entry) => entry.state.guild_id)).toEqual([
        guild,
        third,
      ])
      expect(getGuildVoiceStates(db, guild)).toEqual([])
      expect(getGuildVoiceStates(db, third)).toEqual([])
    })

    it('resolves the displaced mute/deaf from the member, not a divergent stored row', () => {
      setTestGuildVoiceState(db, guild, user, {
        channel_id: channel,
        mute: true,
        self_deaf: true,
        suppress: true,
      })
      // Legacy/direct-SQL divergence: the row contradicts the member's flags.
      db.prepare(
        'UPDATE guild_voice_states SET mute = 0, deaf = 1 WHERE guild_id = ? AND user_id = ?'
      ).run(guild, user)
      const before = getGuildVoiceState(db, guild, user)
      const result = setTestGuildVoiceState(db, otherGuild, user, {
        channel_id: otherChannel,
      })
      assert.ok(typeof result !== 'string')
      const disconnected = {
        ...before,
        channel_id: null,
        mute: true,
        deaf: false,
        self_stream: false,
        self_video: false,
        request_to_speak_timestamp: null,
      }
      expect(result.displaced).toEqual([
        {
          previous: before,
          state: disconnected,
          changed: true,
          emit: true,
          displaced: [],
        },
      ])
      expect(getGuildVoiceState(db, guild, user)).toEqual(disconnected)
      expect(getGuildMember(db, guild, user)).toMatchObject({
        mute: true,
        deaf: false,
      })
    })

    it('leaves a legacy connected row without a membership untouched', () => {
      const third = seedGuild(db, 'Bot testtoken', '222222222222222224')
      const thirdChannel = seedVoiceChannel(db, third, '555555555555555560')
      db.prepare(
        `INSERT INTO guild_voice_states
        (guild_id, user_id, channel_id, session_id) VALUES (?, ?, ?, 'orphan')`
      ).run(third, user, thirdChannel)
      const orphan = getGuildVoiceState(db, third, user)
      const result = setTestGuildVoiceState(db, otherGuild, user, {
        channel_id: otherChannel,
      })
      assert.ok(typeof result !== 'string')
      expect(result.displaced).toEqual([])
      expect(getGuildVoiceState(db, third, user)).toEqual(orphan)
    })

    it('lets bot users stay connected in one channel per guild', () => {
      const botId = '111111111111111111'
      seedMember(db, guild, botId)
      seedMember(db, otherGuild, botId)
      setTestGuildVoiceState(db, guild, botId, { channel_id: channel })
      const result = setTestGuildVoiceState(db, otherGuild, botId, {
        channel_id: otherChannel,
      })
      assert.ok(typeof result !== 'string')
      expect(result.displaced).toEqual([])
      expect(getGuildVoiceState(db, guild, botId)?.channel_id).toBe(channel)
      expect(getGuildVoiceState(db, otherGuild, botId)?.channel_id).toBe(
        otherChannel
      )
    })
  })
})

describe('compareUserIds', () => {
  it('orders decimal IDs numerically, then by raw text, then non-decimal IDs', () => {
    const ids = [
      'abc',
      '10',
      '002',
      '2',
      '100000000000000000',
      '99999999999999999',
    ]
    expect(ids.toSorted(compareUserIds)).toEqual([
      '002',
      '2',
      '10',
      '99999999999999999',
      '100000000000000000',
      'abc',
    ])
  })
})

describe('disconnectGuildVoiceChannelMembers', () => {
  it('returns disconnects in numeric order for noncanonical stored IDs', () => {
    const db = initializeDatabase(':memory:')
    const guild = seedGuild(db, seedBot(db))
    const channel = seedVoiceChannel(db, guild)
    for (const id of ['10', '002', 'abc']) {
      seedMember(db, guild, id)
      expect(
        setTestGuildVoiceState(db, guild, id, { channel_id: channel })
      ).toMatchObject({ state: { channel_id: channel } })
    }

    const mutations = disconnectGuildVoiceChannelMembers(db, channel)

    expect(mutations.map((mutation) => mutation.state.user_id)).toEqual([
      '002',
      '10',
      'abc',
    ])
    expect(
      mutations.every((mutation) => mutation.state.channel_id === null)
    ).toBe(true)
    closeDatabase(db)
  })
})
