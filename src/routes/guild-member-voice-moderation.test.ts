import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatewayBus } from '../gateway/bus'
import {
  getGuildMember,
  updateGuildMember,
  type GuildMemberObject,
} from '../services/guild-members'
import {
  getGuildVoiceState,
  getGuildVoiceStates,
} from '../services/voice-states'
import {
  createFullTestApp,
  seedBearerCredential,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedRole,
  seedVoiceChannel,
  seedVoiceState,
} from '../test-helpers'

const TOKEN = 'Bot voice-moderation'
const BOT_ID = '111111111111111111'
const HUMAN_OWNER = '999999999999999999'
const VIEW_CHANNEL = 1n << 10n
const CONNECT = 1n << 20n
const MUTE_MEMBERS = 1n << 22n
const DEAFEN_MEMBERS = 1n << 23n
const MOVE_MEMBERS = 1n << 24n
const ADMINISTRATOR = 1n << 3n

describe('Modify Guild Member voice moderation', () => {
  let context: ReturnType<typeof createFullTestApp>
  let guild: string
  let user: string
  let channel: string
  let other: string
  let stage: string
  let session: string
  let events: { name: string; payload: Record<string, unknown> }[]

  beforeEach(() => {
    context = createFullTestApp()
    guild = seedGuild(context.db, seedBot(context.db, TOKEN))
    user = seedMember(context.db, guild)
    channel = seedVoiceChannel(context.db, guild)
    other = seedVoiceChannel(context.db, guild, '555555555555555556')
    stage = seedVoiceChannel(context.db, guild, '555555555555555557')
    context.db.prepare('UPDATE channels SET type = 13 WHERE id = ?').run(stage)
    seedChannel(context.db, guild)
    const otherGuild = seedGuild(
      context.db,
      seedBot(context.db, 'Bot other-guild', '121212121212121212'),
      '222222222222222299'
    )
    seedVoiceChannel(context.db, otherGuild, '555555555555555599')
    session = seedVoiceState(context.db, guild, user, channel)
    events = []
    const original = gatewayBus.emit.bind(gatewayBus)
    vi.spyOn(gatewayBus, 'emit').mockImplementation((name, payload) => {
      events.push({ name, payload })
      return original(name, payload)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    context.cleanup()
  })

  /** Sends Modify Guild Member through the assembled app. */
  function patch(
    body: unknown,
    target = user,
    prefix = '/api/v10'
  ): Promise<Response> {
    return Promise.resolve(
      context.app.request(`${prefix}/guilds/${guild}/members/${target}`, {
        method: 'PATCH',
        headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    )
  }

  /** Sends Modify Guild Member and returns only the HTTP status. */
  async function status(
    body: unknown,
    target = user,
    prefix = '/api/v10'
  ): Promise<number> {
    const response = await patch(body, target, prefix)
    return response.status
  }

  /** Returns the emitted voice-state dispatch data. */
  function voiceEvents(): Record<string, unknown>[] {
    return events
      .filter((event) => event.name === 'voice.state.update')
      .map((event) => event.payload.state as Record<string, unknown>)
  }

  /** Makes a human the owner so the bot needs real permissions. */
  function useHumanOwner(guildPermissions = 0n): string {
    seedMember(context.db, guild, HUMAN_OWNER)
    seedMember(context.db, guild, BOT_ID)
    context.db
      .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
      .run(HUMAN_OWNER, guild)
    context.db
      .prepare(
        `INSERT INTO roles (id, guild_id, name, position, permissions)
         VALUES (?, ?, '@everyone', 0, ?)`
      )
      .run(guild, guild, String(VIEW_CHANNEL | CONNECT))
    const role = seedRole(context.db, guild, 'voice-moderator')
    context.db
      .prepare('UPDATE roles SET permissions = ? WHERE id = ?')
      .run(String(guildPermissions), role)
    context.db
      .prepare(
        'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
      )
      .run(guild, BOT_ID, role)
    return role
  }

  /** Adds a channel permission overwrite. */
  function overwrite(
    channelId: string,
    id: string,
    type: 0 | 1,
    allow: bigint,
    deny: bigint
  ): void {
    context.db
      .prepare(
        `INSERT OR REPLACE INTO channel_overwrites
         (channel_id, id, type, allow, deny) VALUES (?, ?, ?, ?, ?)`
      )
      .run(channelId, id, type, String(allow), String(deny))
  }

  /** Snapshots persisted member and voice rows for no-mutation assertions. */
  function snapshot(): unknown[] {
    return ['guild_members', 'guild_voice_states', 'member_roles'].map(
      (table) => context.db.prepare(`SELECT * FROM ${table}`).all()
    )
  }

  it.each(['/api/v10', '/api', ''])(
    'server-mutes and unmutes a connected member under %s',
    async (prefix) => {
      for (const mute of [true, false]) {
        events = []
        const response = await patch({ mute }, user, prefix)
        expect(response.status).toBe(200)
        const member = (await response.json()) as GuildMemberObject
        expect(member).toMatchObject({ mute, deaf: false, user: { id: user } })
        expect(getGuildMember(context.db, guild, user)).toEqual(member)
        const state = getGuildVoiceState(context.db, guild, user)
        expect(state).toMatchObject({
          channel_id: channel,
          session_id: session,
          mute,
          deaf: false,
        })
        expect(events.map((event) => event.name)).toEqual([
          'guild.member.update',
          'voice.state.update',
        ])
        expect(events[0].payload).toMatchObject({ guildId: guild, member })
        expect(voiceEvents()).toEqual([
          {
            ...state,
            member: {
              ...member,
              user: { ...member.user, primary_guild: null },
            },
          },
        ])
      }
    }
  )

  it('server-deafens, combines mute/deaf in one VOICE_STATE_UPDATE and keeps self flags', async () => {
    context.db
      .prepare(
        'UPDATE guild_voice_states SET self_mute = 1, self_deaf = 1, self_video = 1 WHERE user_id = ?'
      )
      .run(user)
    expect(await status({ deaf: true })).toBe(200)
    expect(voiceEvents()).toHaveLength(1)
    expect(voiceEvents()[0]).toMatchObject({
      deaf: true,
      mute: false,
      self_mute: true,
      self_deaf: true,
      self_video: true,
      member: { deaf: true, mute: false },
    })
    events = []
    const response = await patch({ mute: true, deaf: false, nick: 'Quiet' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      mute: true,
      deaf: false,
      nick: 'Quiet',
    })
    expect(voiceEvents()).toEqual([
      expect.objectContaining({
        mute: true,
        deaf: false,
        session_id: session,
        member: expect.objectContaining({
          mute: true,
          deaf: false,
          nick: 'Quiet',
        }),
      }),
    ])
  })

  it('emits GUILD_MEMBER_UPDATE but no VOICE_STATE_UPDATE for an unchanged flag', async () => {
    await patch({ mute: true })
    events = []
    expect(await status({ mute: true })).toBe(200)
    expect(events.map((event) => event.name)).toEqual(['guild.member.update'])
  })

  it('moves a connected member to another voice or stage channel in the same session', async () => {
    context.db
      .prepare(
        `UPDATE guild_voice_states SET self_mute = 1, self_stream = 1,
         request_to_speak_timestamp = '2026-10-01T12:00:00.000000+00:00'
         WHERE user_id = ?`
      )
      .run(user)
    const moved = await patch({ channel_id: other })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ user: { id: user } })
    const expected = {
      guild_id: guild,
      user_id: user,
      channel_id: other,
      session_id: session,
      self_mute: true,
      self_stream: false,
      suppress: false,
      request_to_speak_timestamp: null,
    }
    expect(getGuildVoiceState(context.db, guild, user)).toMatchObject(expected)
    expect(voiceEvents()).toEqual([expect.objectContaining(expected)])

    events = []
    expect(await status({ channel_id: stage })).toBe(200)
    expect(voiceEvents()).toEqual([
      expect.objectContaining({
        channel_id: stage,
        session_id: session,
        suppress: true,
      }),
    ])

    events = []
    expect(await status({ channel_id: stage })).toBe(200)
    expect(voiceEvents()).toEqual([])
    expect(events.map((event) => event.name)).toEqual(['guild.member.update'])
  })

  it('disconnects with channel_id null using fixture disconnect semantics', async () => {
    await patch({ mute: true })
    context.db
      .prepare(
        'UPDATE guild_voice_states SET self_stream = 1, self_video = 1 WHERE user_id = ?'
      )
      .run(user)
    events = []
    const response = await patch({ channel_id: null })
    expect(response.status).toBe(200)
    const state = getGuildVoiceState(context.db, guild, user)
    expect(state).toMatchObject({
      channel_id: null,
      session_id: session,
      self_stream: false,
      self_video: false,
      mute: true,
    })
    expect(getGuildVoiceStates(context.db, guild)).toEqual([])
    expect(voiceEvents()).toEqual([
      expect.objectContaining({ channel_id: null, session_id: session }),
    ])
    // Server mute belongs to the member and is restored on the next join.
    expect(getGuildMember(context.db, guild, user)?.mute).toBe(true)
    seedVoiceState(context.db, guild, user, channel)
    expect(getGuildVoiceState(context.db, guild, user)?.mute).toBe(true)
  })

  it.each([
    { mute: true },
    { mute: false },
    { deaf: true },
    { deaf: false },
    { channel_id: '555555555555555556' },
    { channel_id: null },
    { mute: true, nick: 'Not applied' },
  ])(
    'returns 400/40032 for %j when the target is not connected',
    async (body) => {
      for (const prepare of ['never', 'disconnected'] as const) {
        if (prepare === 'never')
          context.db.prepare('DELETE FROM guild_voice_states').run()
        else seedVoiceState(context.db, guild, user, channel)
        if (prepare === 'disconnected')
          context.db
            .prepare('UPDATE guild_voice_states SET channel_id = NULL')
            .run()
        const before = snapshot()
        events = []
        const response = await patch(body)
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          code: 40_032,
          message: 'Target user is not connected to voice.',
        })
        expect(snapshot()).toEqual(before)
        expect(events).toEqual([])
      }
    }
  )

  it('treats null mute/deaf as a no-op that does not require voice', async () => {
    context.db.prepare('DELETE FROM guild_voice_states').run()
    const response = await patch({ mute: null, deaf: null, nick: 'Null' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      nick: 'Null',
      mute: false,
      deaf: false,
    })
    expect(voiceEvents()).toEqual([])
  })

  it('checks the guild before validation, then validation before the member', async () => {
    const unknownGuild = await context.app.request(
      `/api/v10/guilds/222222222222222200/members/${user}`,
      {
        method: 'PATCH',
        headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mute: 'wrong' }),
      }
    )
    expect(unknownGuild.status).toBe(404)
    expect(await unknownGuild.json()).toMatchObject({ code: 10_004 })
    const invalid = await patch({ mute: 'wrong' }, '999999999999999990')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 50_035 })
  })

  it('prefers Unknown Member over voice errors', async () => {
    const response = await patch({ mute: true }, '999999999999999990')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 10_007 })
  })

  it.each([
    ['unknown', '555555555555555500', 404, 10_003],
    ['foreign', '555555555555555599', 404, 10_003],
    ['text', '333333333333333333', 400, 50_024],
  ] as const)(
    'rejects a %s destination channel without mutation',
    async (_kind, destination, httpStatus, code) => {
      const before = snapshot()
      const response = await patch({ channel_id: destination, mute: true })
      expect(response.status).toBe(httpStatus)
      expect(await response.json()).toMatchObject({ code })
      expect(snapshot()).toEqual(before)
      expect(events).toEqual([])
    }
  )

  it.each([
    ['mute', 'yes', 'BASE_TYPE_BOOLEAN'],
    ['mute', 1, 'BASE_TYPE_BOOLEAN'],
    ['deaf', 'true', 'BASE_TYPE_BOOLEAN'],
    ['channel_id', 'abc', 'NUMBER_TYPE_COERCE'],
    ['channel_id', 555_555_555_555, 'NUMBER_TYPE_COERCE'],
    ['channel_id', '0', 'NUMBER_TYPE_COERCE'],
    ['channel_id', true, 'NUMBER_TYPE_COERCE'],
  ] as const)(
    'rejects %s=%j with 50035 before mutation',
    async (field, value, errorCode) => {
      const before = snapshot()
      const response = await patch({ [field]: value })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 50_035,
        errors: { [field]: { _errors: [{ code: errorCode }] } },
      })
      expect(snapshot()).toEqual(before)
      expect(events).toEqual([])
    }
  )

  it('ignores voice fields on Modify Current Member', async () => {
    seedMember(context.db, guild, BOT_ID)
    seedVoiceState(context.db, guild, BOT_ID, channel)
    const response = await context.app.request(
      `/api/v10/guilds/${guild}/members/@me`,
      {
        method: 'PATCH',
        headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nick: 'Self',
          mute: true,
          deaf: true,
          channel_id: null,
        }),
      }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      nick: 'Self',
      mute: false,
      deaf: false,
    })
    expect(getGuildVoiceState(context.db, guild, BOT_ID)).toMatchObject({
      channel_id: channel,
      mute: false,
      deaf: false,
    })
    expect(voiceEvents()).toEqual([])
  })

  describe('permissions of a non-owner bot', () => {
    it.each([
      [{ mute: true }, MUTE_MEMBERS],
      [{ deaf: true }, DEAFEN_MEMBERS],
      [{ channel_id: null }, MOVE_MEMBERS],
      [{ channel_id: '555555555555555556' }, MOVE_MEMBERS],
    ] as const)(
      'requires the matching bit for %j',
      async (body, permission) => {
        const role = useHumanOwner()
        const before = snapshot()
        const denied = await patch({ ...body, nick: 'Not applied' })
        expect(denied.status).toBe(403)
        expect(await denied.json()).toEqual({
          code: 50_013,
          message: 'Missing Permissions',
        })
        expect(snapshot()).toEqual(before)
        expect(events).toEqual([])
        context.db
          .prepare('UPDATE roles SET permissions = ? WHERE id = ?')
          .run(String(permission), role)
        expect(await status(body)).toBe(200)
        expect(voiceEvents()).toHaveLength(1)
      }
    )

    it('requires each bit separately and honors overwrites on the current channel', async () => {
      const role = useHumanOwner(MUTE_MEMBERS)
      expect(await status({ mute: true, deaf: true })).toBe(403)
      expect(await status({ mute: true })).toBe(200)
      overwrite(channel, role, 0, 0n, MUTE_MEMBERS)
      expect(await status({ mute: false })).toBe(403)
      overwrite(channel, BOT_ID, 1, MUTE_MEMBERS, 0n)
      expect(await status({ mute: false })).toBe(200)
      overwrite(channel, guild, 0, 0n, VIEW_CHANNEL)
      expect(await status({ mute: true })).toBe(403)
    })

    it('requires CONNECT and MOVE_MEMBERS on a different destination', async () => {
      const role = useHumanOwner(MOVE_MEMBERS)
      overwrite(other, guild, 0, 0n, CONNECT)
      expect(await status({ channel_id: other })).toBe(403)
      expect(getGuildVoiceState(context.db, guild, user)?.channel_id).toBe(
        channel
      )
      overwrite(other, role, 0, CONNECT, 0n)
      overwrite(stage, role, 0, 0n, MOVE_MEMBERS)
      expect(await status({ channel_id: stage })).toBe(403)
      expect(await status({ channel_id: other })).toBe(200)
      expect(getGuildVoiceState(context.db, guild, user)?.channel_id).toBe(
        other
      )
      // Moving out only needs MOVE_MEMBERS where the member is now.
      expect(await status({ channel_id: null })).toBe(200)
    })

    it('implicitly denies voice moderation without CONNECT in the current channel', async () => {
      const role = useHumanOwner(MUTE_MEMBERS | DEAFEN_MEMBERS | MOVE_MEMBERS)
      overwrite(channel, role, 0, 0n, CONNECT)
      const before = snapshot()
      for (const body of [
        { mute: true },
        { deaf: true },
        { channel_id: null },
        { channel_id: other },
      ])
        expect(await status(body)).toBe(403)
      expect(snapshot()).toEqual(before)
      expect(events).toEqual([])
      overwrite(channel, BOT_ID, 1, CONNECT, 0n)
      expect(await status({ mute: true })).toBe(200)
    })

    it('rejects voice moderation through an OAuth2 Bearer token without mutation', async () => {
      const { bearerToken } = seedBearerCredential(context.db, HUMAN_OWNER)
      context.db
        .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
        .run(HUMAN_OWNER, guild)
      const before = snapshot()
      for (const body of [{ mute: true }, { channel_id: null }]) {
        const response = await context.app.request(
          `/api/v10/guilds/${guild}/members/${user}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${bearerToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          }
        )
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: 50_013 })
      }
      expect(snapshot()).toEqual(before)
      expect(events).toEqual([])
    })

    it('lets guild administrators and owners bypass channel denials', async () => {
      const role = useHumanOwner(ADMINISTRATOR)
      overwrite(channel, role, 0, 0n, MUTE_MEMBERS | VIEW_CHANNEL)
      expect(await status({ mute: true })).toBe(200)
      context.db
        .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
        .run(BOT_ID, guild)
      context.db
        .prepare('UPDATE roles SET permissions = ? WHERE id = ?')
        .run('0', role)
      expect(await status({ deaf: true, channel_id: other })).toBe(200)
    })

    it('does not add permission checks to non-voice fields', async () => {
      useHumanOwner()
      expect(await status({ nick: 'Allowed' })).toBe(200)
    })
  })

  it('keeps fixture and REST mute/deaf consistent on member and voice reads', async () => {
    const fixture = await context.app.request(
      `/_test/guilds/${guild}/voice-states/${user}`,
      { method: 'PATCH', body: JSON.stringify({ mute: true, deaf: true }) }
    )
    expect(fixture.status).toBe(200)
    expect(getGuildMember(context.db, guild, user)).toMatchObject({
      mute: true,
      deaf: true,
    })
    expect(voiceEvents()).toEqual([
      expect.objectContaining({
        mute: true,
        deaf: true,
        member: expect.objectContaining({ mute: true, deaf: true }),
      }),
    ])
    expect(await status({ deaf: false })).toBe(200)
    const read = await context.app.request(
      `/api/v10/guilds/${guild}/voice-states/${user}`,
      { headers: { Authorization: TOKEN } }
    )
    expect(await read.json()).toMatchObject({ mute: true, deaf: false })
  })

  it('mirrors direct service mute/deaf writes onto the stored voice state', () => {
    const updated = updateGuildMember(context.db, guild, user, { deaf: true })
    expect(updated).toMatchObject({ deaf: true, mute: false })
    const state = getGuildVoiceState(context.db, guild, user)
    expect(state).toMatchObject({ deaf: true, session_id: session })
    expect(events.map((event) => event.name)).toEqual([
      'guild.member.update',
      'voice.state.update',
    ])
    expect(voiceEvents()).toEqual([
      expect.objectContaining({
        deaf: true,
        member: expect.objectContaining({ deaf: true }),
      }),
    ])

    // A retained disconnected state is synced silently.
    context.db.prepare('UPDATE guild_voice_states SET channel_id = NULL').run()
    events = []
    updateGuildMember(context.db, guild, user, { mute: true, deaf: false })
    expect(getGuildVoiceState(context.db, guild, user)).toMatchObject({
      channel_id: null,
      mute: true,
      deaf: false,
    })
    expect(events.map((event) => event.name)).toEqual(['guild.member.update'])

    // Without any voice state only the member row changes.
    context.db.prepare('DELETE FROM guild_voice_states').run()
    events = []
    expect(
      updateGuildMember(context.db, guild, user, { mute: false })
    ).toMatchObject({ mute: false })
    expect(getGuildVoiceState(context.db, guild, user)).toBeNull()
    expect(events.map((event) => event.name)).toEqual(['guild.member.update'])
  })

  it('keeps REST fault injection ahead of voice moderation', async () => {
    const path = `/guilds/${guild}/members/${user}`
    const armed = await context.app.request('/_test/rest-faults', {
      method: 'POST',
      body: JSON.stringify({
        path,
        method: 'PATCH',
        status: 403,
        code: 50_013,
        message: 'Missing Permissions',
      }),
    })
    expect(armed.status).toBe(201)
    const before = snapshot()
    expect(await status({ mute: true })).toBe(403)
    expect(snapshot()).toEqual(before)
    expect(voiceEvents()).toEqual([])
    expect(await status({ mute: true })).toBe(200)
    expect(voiceEvents()).toHaveLength(1)
  })
})
