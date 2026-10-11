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
    // Server mute is owned by the member: the fixture mirrors it into
    // guild_members, survives disconnect and is restored on rejoin.
    expect(next.mute).toBe(true)
    const [members, ...others] = identities
    expect(snapshot().slice(1)).toEqual([
      (members as Record<string, unknown>[]).map((row) =>
        row.guild_id === guild && row.user_id === user
          ? { ...row, mute: 1 }
          : row
      ),
      ...others,
    ])
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
    // A distinct human per guild: one human cannot be connected in both.
    const otherUser = seedMember(context.db, otherGuild)
    await patch(JSON.stringify({ channel_id: channel }))
    await patch(
      JSON.stringify({ channel_id: foreignChannel }),
      otherGuild,
      otherUser
    )
    const other = getGuildVoiceState(context.db, otherGuild, otherUser)
    const reset = await context.app.request('/_test/reset', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
    expect(reset.status).toBe(204)
    expect(getGuildVoiceState(context.db, guild, user)).toBeNull()
    expect(getGuildVoiceState(context.db, otherGuild, otherUser)).toEqual(other)
    await patch(JSON.stringify({ channel_id: channel }))
    const deleted = await context.app.request(
      `/_test/setup/${encodeURIComponent(token)}`,
      { method: 'DELETE' }
    )
    expect(deleted.status).toBe(204)
    expect(getGuildVoiceState(context.db, guild, user)).toBeNull()
    expect(getGuildVoiceState(context.db, otherGuild, otherUser)).toEqual(other)
    await context.app.request('/_test/reset', { method: 'POST', body: '{}' })
    expect(getGuildVoiceState(context.db, otherGuild, otherUser)).toBeNull()
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

  describe('REST reads without a stored voice state', () => {
    const botId = '111111111111111111'
    const unknownVoiceState = { message: 'Unknown Voice State', code: 10_065 }
    const unknownMember = { message: 'Unknown Member', code: 10_007 }

    /** Reads one native voice state as `token` (or another Authorization). */
    async function read(path: string, authorization: string | null = token) {
      const response = await context.app.request(
        path,
        authorization === null
          ? {}
          : { headers: { Authorization: authorization } }
      )
      return { status: response.status, body: await response.json() }
    }

    it('returns Unknown Voice State for a member who never joined voice, under every prefix', async () => {
      const before = snapshot()
      const member = await read(`/api/v10/guilds/${guild}/members/${user}`)
      expect(member.status).toBe(200)
      for (const prefix of ['', '/api', '/api/v10']) {
        expect(
          await read(`${prefix}/guilds/${guild}/voice-states/${user}`),
          prefix
        ).toEqual({ status: 404, body: unknownVoiceState })
      }
      expect(snapshot()).toEqual(before)
    })

    it('returns Unknown Voice State for the bot member through @me and %40me, under every prefix', async () => {
      seedMember(context.db, guild, botId)
      const before = snapshot()
      for (const prefix of ['', '/api', '/api/v10']) {
        for (const alias of ['@me', '%40me']) {
          expect(
            await read(`${prefix}/guilds/${guild}/voice-states/${alias}`),
            `${prefix} ${alias}`
          ).toEqual({ status: 404, body: unknownVoiceState })
        }
        expect(
          await read(`${prefix}/guilds/${guild}/voice-states/${botId}`),
          prefix
        ).toEqual({ status: 404, body: unknownVoiceState })
      }
      expect(snapshot()).toEqual(before)
    })

    it('keeps Unknown Member for users who are not members of the guild', async () => {
      const outsider = seedMember(context.db, otherGuild, '444444444444444445')
      for (const userId of [outsider, '999999999999999999']) {
        expect(
          await read(`/api/v10/guilds/${guild}/voice-states/${userId}`),
          userId
        ).toEqual({ status: 404, body: unknownMember })
      }
      // A bot whose membership row is absent is not a member either.
      for (const alias of ['@me', '%40me']) {
        expect(
          await read(`/api/v10/guilds/${guild}/voice-states/${alias}`),
          alias
        ).toEqual({ status: 404, body: unknownMember })
      }
    })

    it('returns Unknown Member once a member with a stored state leaves', async () => {
      await patch(JSON.stringify({ channel_id: channel, emit: false }))
      const path = `/api/v10/guilds/${guild}/voice-states/${user}`
      const connected = await read(path)
      expect(connected.status).toBe(200)
      context.db
        .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
        .run(guild, user)
      expect(await read(path)).toEqual({ status: 404, body: unknownMember })
    })

    it('keeps returning connected and stored disconnected states', async () => {
      seedMember(context.db, guild, botId)
      for (const [userId, aliases] of [
        [user, [user]],
        [botId, ['@me', '%40me', botId]],
      ] as const) {
        /** Reads every alias under every prefix, expecting the stored state. */
        async function expectStored() {
          const stored = getGuildVoiceState(context.db, guild, userId)
          for (const prefix of ['', '/api', '/api/v10']) {
            for (const alias of aliases) {
              expect(
                await read(`${prefix}/guilds/${guild}/voice-states/${alias}`),
                `${prefix} ${alias}`
              ).toEqual({ status: 200, body: stored })
            }
          }
          return stored
        }
        await patch(JSON.stringify({ channel_id: channel }), guild, userId)
        const connected = await expectStored()
        expect(connected).toMatchObject({
          user_id: userId,
          channel_id: channel,
        })
        await patch('{"channel_id":null}', guild, userId)
        expect(await expectStored()).toMatchObject({
          user_id: userId,
          channel_id: null,
          session_id: connected?.session_id,
        })
      }
    })

    it('checks authentication, the guild and access before the member', async () => {
      seedMember(context.db, guild, botId)
      for (const alias of [user, '@me', '%40me']) {
        const path = `/api/v10/guilds/${guild}/voice-states/${alias}`
        const unauthenticated = await read(path, null)
        expect(unauthenticated.status, alias).toBe(401)
        expect(await read(path, otherToken), alias).toEqual({
          status: 403,
          body: { message: 'Missing Access', code: 50_001 },
        })
        expect(
          await read(
            `/api/v10/guilds/999999999999999998/voice-states/${alias}`
          ),
          alias
        ).toEqual({
          status: 404,
          body: { message: 'Unknown Guild', code: 10_004 },
        })
      }
      const invalid = await read(
        `/api/v10/guilds/${guild}/voice-states/not-a-snowflake`
      )
      expect(invalid).toMatchObject({ status: 400, body: { code: 50_035 } })
    })
  })

  describe('single voice connection per human user', () => {
    /** Returns the voice states published on the bus, in emission order. */
    function published(spy: {
      mock: { calls: unknown[][] }
    }): GuildVoiceState[] {
      return spy.mock.calls
        .filter((call) => call[0] === 'voice.state.update')
        .map((call) => (call[1] as { state: GuildVoiceState }).state)
    }

    it('disconnects the other guild before publishing the join', async () => {
      await patch(
        JSON.stringify({ channel_id: channel, self_stream: true, emit: false })
      )
      const before = getGuildVoiceState(context.db, guild, user)
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await patch(
        JSON.stringify({ channel_id: foreignChannel, self_video: true }),
        otherGuild
      )
      expect(response.status).toBe(200)
      const joined = (await response.json()) as GuildVoiceState
      expect(published(emit)).toMatchObject([
        {
          guild_id: guild,
          channel_id: null,
          session_id: before?.session_id,
          self_stream: false,
          self_video: false,
        },
        {
          guild_id: otherGuild,
          channel_id: foreignChannel,
          session_id: joined.session_id,
          self_video: true,
        },
      ])
      expect(getGuildVoiceStates(context.db, guild)).toEqual([])
      expect(getGuildVoiceStates(context.db, otherGuild)).toEqual([joined])
    })

    it('rolls back the displacement and publishes nothing when the join fails', async () => {
      await patch(
        JSON.stringify({ channel_id: channel, self_stream: true, emit: false })
      )
      const before = snapshot()
      context.db.exec(`CREATE TRIGGER reject_join
        BEFORE INSERT ON guild_voice_states WHEN NEW.guild_id = '${otherGuild}'
        BEGIN SELECT RAISE(ABORT, 'Join failed'); END`)
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await patch(
        JSON.stringify({ channel_id: foreignChannel }),
        otherGuild
      )
      expect(response.status).toBe(500)
      expect(context.db.inTransaction).toBe(false)
      expect(snapshot()).toEqual(before)
      expect(getGuildVoiceState(context.db, guild, user)).toMatchObject({
        channel_id: channel,
        self_stream: true,
      })
      expect(published(emit)).toEqual([])
    })

    it('applies the rule silently with emit: false', async () => {
      await patch(JSON.stringify({ channel_id: channel, emit: false }))
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await patch(
        JSON.stringify({ channel_id: foreignChannel, emit: false }),
        otherGuild
      )
      expect(response.status).toBe(200)
      expect(published(emit)).toEqual([])
      expect(getGuildVoiceState(context.db, guild, user)).toMatchObject({
        channel_id: null,
      })
    })

    it('applies the rule to REST voice-state writes for a human member', async () => {
      await patch(JSON.stringify({ channel_id: channel, emit: false }))
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await context.app.request(
        `/api/v10/guilds/${otherGuild}/voice-states/${user}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: otherToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channel_id: foreignChannel }),
        }
      )
      expect(response.status).toBe(204)
      expect(
        published(emit).map((state) => [state.guild_id, state.channel_id])
      ).toEqual([
        [guild, null],
        [otherGuild, foreignChannel],
      ])
    })

    it('exempts bot users, which may hold one connection per guild', async () => {
      const botId = '111111111111111111'
      seedMember(context.db, guild, botId)
      seedMember(context.db, otherGuild, botId)
      await patch(JSON.stringify({ channel_id: channel }), guild, botId)
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await context.app.request(
        `/api/v10/guilds/${otherGuild}/voice-states/@me`,
        {
          method: 'PATCH',
          headers: {
            Authorization: otherToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channel_id: foreignChannel }),
        }
      )
      expect(response.status).toBe(204)
      expect(published(emit).map((state) => state.guild_id)).toEqual([
        otherGuild,
      ])
      expect(getGuildVoiceState(context.db, guild, botId)?.channel_id).toBe(
        channel
      )
      expect(
        getGuildVoiceState(context.db, otherGuild, botId)?.channel_id
      ).toBe(foreignChannel)
    })
  })
})
