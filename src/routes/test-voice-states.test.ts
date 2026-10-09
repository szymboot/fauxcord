import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedMember,
  seedVoiceChannel,
  seedChannel,
} from '../test-helpers'
import {
  getGuildVoiceState,
  getGuildVoiceStates,
} from '../services/voice-states'
import type { GuildVoiceState } from '../services/voice-states'

const token = 'Bot voice-fixture'
const otherToken = 'Bot other-voice-fixture'

describe('Test voice-state fixtures', () => {
  let context: ReturnType<typeof createFullTestApp>
  let guild: string
  let otherGuild: string
  let user: string
  let channel: string
  let stage: string
  let foreignChannel: string

  beforeEach(() => {
    context = createFullTestApp()
    guild = seedGuild(context.db, seedBot(context.db, token))
    otherGuild = seedGuild(
      context.db,
      seedBot(context.db, otherToken),
      '222222222222222223'
    )
    user = seedMember(context.db, guild)
    seedMember(context.db, otherGuild, user)
    channel = seedVoiceChannel(context.db, guild)
    stage = seedVoiceChannel(context.db, guild, '555555555555555556')
    context.db.prepare('UPDATE channels SET type = 13 WHERE id = ?').run(stage)
    foreignChannel = seedVoiceChannel(
      context.db,
      otherGuild,
      '555555555555555557'
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  /** Sends an unauthenticated fixture patch, optionally to another scope. */
  function patch(body: string, guildId = guild, userId = user) {
    return context.app.request(
      `/_test/guilds/${guildId}/voice-states/${userId}`,
      { method: 'PATCH', body }
    )
  }

  /** Sends a patch and returns its HTTP status for validation assertions. */
  async function patchStatus(body: string, guildId = guild, userId = user) {
    const response = await patch(body, guildId, userId)
    return response.status
  }

  /** Snapshots every table a voice fixture might accidentally mutate. */
  function snapshot() {
    return [
      'guild_voice_states',
      'guild_members',
      'users',
      'guilds',
      'channels',
    ].map((table) => context.db.prepare(`SELECT * FROM ${table}`).all())
  }

  it('silently prepares joins, streams, stops, moves, disconnects and rejoins with stable session identity', async () => {
    const identities = snapshot().slice(1)
    const emit = vi.spyOn(gatewayBus, 'emit')
    const joined = await patch(
      JSON.stringify({ channel_id: channel, emit: false })
    )
    expect(joined.status).toBe(200)
    const initial = (await joined.json()) as GuildVoiceState
    expect(initial).toEqual({
      guild_id: guild,
      user_id: user,
      channel_id: channel,
      session_id: expect.any(String),
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: false,
      self_stream: false,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    })
    for (const update of [
      { self_stream: true, self_mute: true, mute: true, suppress: true },
      { self_stream: false },
      { channel_id: stage, self_stream: true, self_video: true },
    ]) {
      const response = await patch(JSON.stringify({ ...update, emit: false }))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        ...update,
        session_id: initial.session_id,
        user_id: user,
        guild_id: guild,
      })
    }
    const moved = getGuildVoiceState(context.db, guild, user)
    expect(moved).toMatchObject({ self_mute: true, mute: true, suppress: true })
    expect(getGuildVoiceStates(context.db, guild)).toEqual([moved])
    for (const prefix of ['', '/api', '/api/v10']) {
      const response = await context.app.request(
        `${prefix}/guilds/${guild}/voice-states/${user}`,
        { headers: { Authorization: token } }
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(moved)
    }
    const disconnected = await patch('{"channel_id":null,"emit":false}')
    expect(disconnected.status).toBe(200)
    expect(await disconnected.json()).toMatchObject({
      channel_id: null,
      self_stream: false,
      self_video: false,
      self_mute: true,
      mute: true,
      session_id: initial.session_id,
    })
    expect(getGuildVoiceStates(context.db, guild)).toEqual([])
    const rejoined = await patch(
      JSON.stringify({ channel_id: channel, emit: false })
    )
    const next = (await rejoined.json()) as GuildVoiceState
    expect(next.session_id).not.toBe(initial.session_id)
    expect(snapshot().slice(1)).toEqual(identities)
    expect(emit).not.toHaveBeenCalled()
  })

  it('preserves omitted flags, accepts explicit false and normalizes request timestamps', async () => {
    const timestamp = '2020-02-29T12:00:00Z'
    const response = await patch(
      JSON.stringify({
        channel_id: stage,
        deaf: true,
        self_deaf: true,
        self_video: true,
        request_to_speak_timestamp: timestamp,
        emit: false,
      })
    )
    expect(response.status).toBe(200)
    const before = getGuildVoiceState(context.db, guild, user)
    expect(before?.request_to_speak_timestamp).toBe(
      '2020-02-29T12:00:00.000000+00:00'
    )
    expect(await patchStatus('{}')).toBe(200)
    expect(getGuildVoiceState(context.db, guild, user)).toEqual(before)
    expect(
      await patchStatus('{"deaf":false,"request_to_speak_timestamp":null}')
    ).toBe(200)
    expect(getGuildVoiceState(context.db, guild, user)).toEqual({
      ...before,
      deaf: false,
      request_to_speak_timestamp: null,
    })
  })

  it.each([
    '',
    '{broken',
    'null',
    '[]',
    '42',
    'true',
    '{"channel_id":42}',
    '{"channel_id":""}',
    '{"self_stream":null}',
    '{"self_stream":"true"}',
    '{"self_mute":1}',
    '{"self_deaf":[]}',
    '{"self_video":{}}',
    '{"mute":null}',
    '{"deaf":0}',
    '{"suppress":"false"}',
    '{"emit":null}',
    '{"session_id":"override"}',
    '{"user_id":"override"}',
    '{"guild_id":"override"}',
    '{"__proto__":{}}',
    '{"request_to_speak_timestamp":"2020-02-30T00:00:00Z"}',
    '{"request_to_speak_timestamp":42}',
    '{"channel_id":null,"self_stream":true}',
    '{"channel_id":null,"self_video":true}',
  ])('rejects invalid input %s without mutation', async (body) => {
    await patch(JSON.stringify({ channel_id: channel, self_stream: true }))
    const before = snapshot()
    expect(await patchStatus(body)).toBe(400)
    expect(snapshot()).toEqual(before)
  })

  it('requires a channel to create a state and rejects stream while disconnected', async () => {
    for (const body of ['{}', '{"self_stream":true}']) {
      expect(await patchStatus(body)).toBe(400)
      expect(getGuildVoiceState(context.db, guild, user)).toBeNull()
    }
    expect(await patchStatus('{"channel_id":null}')).toBe(200)
    const before = snapshot()
    expect(await patchStatus('{"self_stream":true}')).toBe(400)
    expect(snapshot()).toEqual(before)
  })

  it('rejects missing entities, nonmembers and invalid channels without mutation', async () => {
    const nonmember = seedMember(context.db, otherGuild)
    const textChannel = seedChannel(context.db, guild)
    const before = snapshot()
    for (const [guildId, userId, channelId, status] of [
      ['missing', user, channel, 404],
      [guild, 'missing', channel, 404],
      [guild, nonmember, channel, 404],
      [guild, user, '999999999999999999', 404],
      [guild, user, foreignChannel, 404],
      [guild, user, textChannel, 400],
    ] as const) {
      expect(
        await patchStatus(
          JSON.stringify({ channel_id: channelId }),
          guildId,
          userId
        )
      ).toBe(status)
      expect(snapshot()).toEqual(before)
    }
  })

  it('isolates guilds and clears only the selected setup on reset/deletion', async () => {
    await patch(JSON.stringify({ channel_id: channel }))
    await patch(JSON.stringify({ channel_id: foreignChannel }), otherGuild)
    const other = getGuildVoiceState(context.db, otherGuild, user)
    const reset = await context.app.request('/_test/reset', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
    expect(reset.status).toBe(204)
    expect(getGuildVoiceState(context.db, guild, user)).toBeNull()
    expect(getGuildVoiceState(context.db, otherGuild, user)).toEqual(other)
    await patch(JSON.stringify({ channel_id: channel }))
    const deleted = await context.app.request(
      `/_test/setup/${encodeURIComponent(token)}`,
      { method: 'DELETE' }
    )
    expect(deleted.status).toBe(204)
    expect(getGuildVoiceState(context.db, guild, user)).toBeNull()
    expect(getGuildVoiceState(context.db, otherGuild, user)).toEqual(other)
    await context.app.request('/_test/reset', { method: 'POST', body: '{}' })
    expect(getGuildVoiceState(context.db, otherGuild, user)).toBeNull()
  })

  it('cleans up removed members and channels and filters legacy invalid states', async () => {
    await patch(JSON.stringify({ channel_id: channel }))
    context.db
      .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
      .run(guild, user)
    expect(getGuildVoiceState(context.db, guild, user)).toBeNull()
    seedMember(context.db, guild, user)
    await patch(JSON.stringify({ channel_id: channel }))
    context.db.prepare('DELETE FROM channels WHERE id = ?').run(channel)
    expect(getGuildVoiceState(context.db, guild, user)).toBeNull()
    context.db
      .prepare(
        `INSERT INTO guild_voice_states (guild_id, user_id, channel_id, session_id)
      VALUES (?, ?, ?, 'legacy')`
      )
      .run(guild, user, foreignChannel)
    expect(getGuildVoiceStates(context.db, guild)).toEqual([])
  })

  it('keeps REST reads authenticated and refuses cross-setup access', async () => {
    await patch(JSON.stringify({ channel_id: channel }))
    const path = `/api/v10/guilds/${guild}/voice-states/${user}`
    const unauthenticated = await context.app.request(path)
    expect(unauthenticated.status).toBe(401)
    const forbidden = await context.app.request(path, {
      headers: { Authorization: otherToken },
    })
    expect(forbidden.status).toBe(403)
  })
})
