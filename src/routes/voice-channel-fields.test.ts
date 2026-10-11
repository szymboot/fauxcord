import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import { createFullTestApp } from '../test-helpers'
import { buildGuildCreatePayload } from '../services/guilds'

const token = 'Bot voice-fields'
const guildId = '222222222222222222'
const otherGuildId = '222222222222222223'
const textId = '333333333333333333'
const voiceId = '555555555555555555'
const stageId = '555555555555555556'
const otherVoiceId = '555555555555555557'
const humanId = '444444444444444444'
const listenerId = '444444444444444445'

const MOVE_MEMBERS = String(1n << 24n)

describe('Voice channel and guild AFK fields', () => {
  let context: ReturnType<typeof createFullTestApp>

  /** Runs `/_test/setup` with the given body. */
  function setup(body: Record<string, unknown>) {
    return context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  /** Sends an authenticated JSON request as the setup bot. */
  function api(path: string, method = 'GET', body?: unknown) {
    return context.app.request(`/api/v10${path}`, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Awaits a response and parses its JSON body. */
  async function readJson(
    pending: Response | Promise<Response>
  ): Promise<unknown> {
    const response = await pending
    return response.json()
  }

  /** Awaits a response and returns its HTTP status. */
  async function readStatus(
    pending: Response | Promise<Response>
  ): Promise<number> {
    const response = await pending
    return response.status
  }

  /** Captures guild/channel state to check atomic failures. */
  function snapshot() {
    return Object.fromEntries(
      ['bots', 'guilds', 'channels'].map((table) => [
        table,
        context.db.prepare(`SELECT * FROM ${table}`).all(),
      ])
    )
  }

  /** Registers a human user and adds it to the main guild. */
  async function addHuman(id: string) {
    const user = await context.app.request('/_test/users', {
      method: 'POST',
      body: JSON.stringify({ id, username: `human-${id.slice(-1)}` }),
    })
    expect(user.status).toBe(201)
    const member = await context.app.request(
      `/_test/guilds/${guildId}/members/${id}`,
      { method: 'POST', body: '{}' }
    )
    expect(member.status).toBeLessThan(300)
  }

  beforeEach(async () => {
    context = createFullTestApp()
    const response = await setup({
      token,
      guilds: [
        {
          id: guildId,
          name: 'Voice Guild',
          channels: [
            { id: textId, name: 'general', type: 0 },
            { id: voiceId, name: 'voice', type: 2 },
            { id: stageId, name: 'stage', type: 13 },
          ],
        },
        {
          id: otherGuildId,
          name: 'Other Guild',
          channels: [{ id: otherVoiceId, name: 'other-voice', type: 2 }],
        },
      ],
    })
    expect(response.status).toBe(201)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  describe('defaults', () => {
    it('returns Discord defaults on voice and stage channels only', async () => {
      for (const id of [voiceId, stageId]) {
        const body = (await readJson(api(`/channels/${id}`))) as Record<
          string,
          unknown
        >
        expect(body).toMatchObject({
          bitrate: 64_000,
          user_limit: 0,
          rtc_region: null,
        })
        expect(body).not.toHaveProperty('video_quality_mode')
      }
      const text = (await readJson(api(`/channels/${textId}`))) as Record<
        string,
        unknown
      >
      for (const field of [
        'bitrate',
        'user_limit',
        'rtc_region',
        'video_quality_mode',
      ])
        expect(text).not.toHaveProperty(field)
    })

    it('returns the guild AFK defaults', async () => {
      await expect(readJson(api(`/guilds/${guildId}`))).resolves.toMatchObject({
        afk_channel_id: null,
        afk_timeout: 300,
      })
    })
  })

  describe('POST /guilds/:id/channels', () => {
    it('creates a voice channel with explicit settings', async () => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await api(`/guilds/${guildId}/channels`, 'POST', {
        name: 'tuned',
        type: 2,
        bitrate: 96_000,
        user_limit: 5,
        rtc_region: 'us-west',
        video_quality_mode: 2,
      })
      expect(response.status).toBe(201)
      const channel = (await response.json()) as { id: string }
      expect(channel).toMatchObject({
        type: 2,
        bitrate: 96_000,
        user_limit: 5,
        rtc_region: 'us-west',
        video_quality_mode: 2,
      })
      expect(emit).toHaveBeenCalledWith('channel.create', {
        channel: expect.objectContaining({ id: channel.id, user_limit: 5 }),
      })
      await expect(
        readJson(api(`/channels/${channel.id}`))
      ).resolves.toMatchObject({ bitrate: 96_000, video_quality_mode: 2 })
    })

    it('ignores voice settings on non-voice channels like Discord', async () => {
      const response = await api(`/guilds/${guildId}/channels`, 'POST', {
        name: 'text',
        type: 0,
        bitrate: 1,
        user_limit: 'x',
      })
      expect(response.status).toBe(201)
      expect(await response.json()).not.toHaveProperty('bitrate')
    })

    it.each([
      [
        2,
        { bitrate: 7999 },
        'bitrate',
        'Must be an integer between 8000 and 96000.',
      ],
      [
        2,
        { bitrate: 96_001 },
        'bitrate',
        'Must be an integer between 8000 and 96000.',
      ],
      [
        13,
        { bitrate: 64_001 },
        'bitrate',
        'Must be an integer between 8000 and 64000.',
      ],
      [
        2,
        { user_limit: 100 },
        'user_limit',
        'Must be an integer between 0 and 99.',
      ],
      [
        13,
        { user_limit: 10_001 },
        'user_limit',
        'Must be an integer between 0 and 10000.',
      ],
      [
        2,
        { user_limit: 1.5 },
        'user_limit',
        'Must be an integer between 0 and 99.',
      ],
      [2, { rtc_region: 'mars' }, 'rtc_region', undefined],
      [
        2,
        { video_quality_mode: 3 },
        'video_quality_mode',
        'Value must be one of (1, 2).',
      ],
    ])('rejects type %s with %o', async (type, settings, field, message) => {
      const before = snapshot()
      const response = await api(`/guilds/${guildId}/channels`, 'POST', {
        name: 'bad',
        type,
        ...settings,
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as {
        code: number
        errors: Record<string, { _errors: { message: string }[] }>
      }
      expect(body.code).toBe(50_035)
      expect(body.errors[field]._errors[0].message).toEqual(
        message ?? expect.stringContaining('us-west')
      )
      expect(snapshot()).toEqual(before)
    })

    it('accepts stage limits above the voice limits', async () => {
      const response = await api(`/guilds/${guildId}/channels`, 'POST', {
        name: 'big-stage',
        type: 13,
        user_limit: 10_000,
        bitrate: 64_000,
      })
      expect(response.status).toBe(201)
    })

    it('raises the voice bitrate ceiling with the guild boost tier', async () => {
      context.db
        .prepare('UPDATE guilds SET premium_tier = 3 WHERE id = ?')
        .run(guildId)
      const ok = await api(`/guilds/${guildId}/channels`, 'POST', {
        name: 'hifi',
        type: 2,
        bitrate: 384_000,
      })
      expect(ok.status).toBe(201)
      const tooHigh = await api(`/guilds/${guildId}/channels`, 'POST', {
        name: 'hifi',
        type: 2,
        bitrate: 384_001,
      })
      expect(tooHigh.status).toBe(400)
    })

    it('returns 404 for an unknown guild and 401 without auth', async () => {
      const missing = await api('/guilds/999999999999999999/channels', 'POST', {
        name: 'x',
        type: 2,
      })
      expect(missing.status).toBe(404)
      const unauthenticated = await context.app.request(
        `/api/v10/guilds/${guildId}/channels`,
        { method: 'POST', body: JSON.stringify({ name: 'x', type: 2 }) }
      )
      expect(unauthenticated.status).toBe(401)
    })
  })

  describe('PATCH /channels/:id', () => {
    it('updates voice settings and dispatches CHANNEL_UPDATE', async () => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await api(`/channels/${voiceId}`, 'PATCH', {
        bitrate: 32_000,
        user_limit: 2,
        rtc_region: 'eu-central',
        video_quality_mode: 1,
      })
      expect(response.status).toBe(200)
      const expected = {
        id: voiceId,
        bitrate: 32_000,
        user_limit: 2,
        rtc_region: 'eu-central',
        video_quality_mode: 1,
      }
      await expect(response.json()).resolves.toMatchObject(expected)
      expect(emit).toHaveBeenCalledWith('channel.update', {
        channel: expect.objectContaining(expected),
      })
    })

    it('restores defaults with null and preserves omitted settings', async () => {
      await api(`/channels/${voiceId}`, 'PATCH', {
        bitrate: 32_000,
        user_limit: 2,
        rtc_region: 'eu-central',
        video_quality_mode: 2,
      })
      const response = await api(`/channels/${voiceId}`, 'PATCH', {
        bitrate: null,
        rtc_region: null,
        video_quality_mode: null,
      })
      const body = (await response.json()) as Record<string, unknown>
      expect(body).toMatchObject({
        bitrate: 64_000,
        user_limit: 2,
        rtc_region: null,
      })
      expect(body).not.toHaveProperty('video_quality_mode')
    })

    it('rejects out-of-range settings without changes or events', async () => {
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await api(`/channels/${stageId}`, 'PATCH', {
        user_limit: 10_001,
        bitrate: 96_000,
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 50_035,
        errors: { user_limit: {}, bitrate: {} },
      })
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    })

    it('ignores voice settings on a text channel', async () => {
      const response = await api(`/channels/${textId}`, 'PATCH', {
        name: 'still-text',
        bitrate: 1,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).not.toHaveProperty('bitrate')
    })
  })

  describe('PATCH /guilds/:id AFK settings', () => {
    it('sets the AFK channel and timeout and dispatches GUILD_UPDATE', async () => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await api(`/guilds/${guildId}`, 'PATCH', {
        afk_channel_id: voiceId,
        afk_timeout: 900,
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        afk_channel_id: voiceId,
        afk_timeout: 900,
      })
      expect(emit).toHaveBeenCalledWith('guild.update', {
        guild: expect.objectContaining({
          id: guildId,
          afk_channel_id: voiceId,
          afk_timeout: 900,
        }),
        scope: expect.objectContaining({ db: context.db, token }),
      })
      expect(buildGuildCreatePayload(context.db, guildId)).toMatchObject({
        afk_channel_id: voiceId,
        afk_timeout: 900,
      })
    })

    it('does not dispatch GUILD_UPDATE for a no-op patch', async () => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await api(`/guilds/${guildId}`, 'PATCH', {
        afk_timeout: 300,
      })
      expect(response.status).toBe(200)
      expect(emit).not.toHaveBeenCalled()
    })

    it('clears the AFK channel with null', async () => {
      await api(`/guilds/${guildId}`, 'PATCH', { afk_channel_id: voiceId })
      const response = await api(`/guilds/${guildId}`, 'PATCH', {
        afk_channel_id: null,
      })
      await expect(response.json()).resolves.toMatchObject({
        afk_channel_id: null,
      })
    })

    it.each([
      [{ afk_timeout: 120 }, 'afk_timeout'],
      [{ afk_timeout: '300' }, 'afk_timeout'],
      [{ afk_timeout: null }, 'afk_timeout'],
      [{ afk_channel_id: textId }, 'afk_channel_id'],
      [{ afk_channel_id: stageId }, 'afk_channel_id'],
      [{ afk_channel_id: otherVoiceId }, 'afk_channel_id'],
      [{ afk_channel_id: '999999999999999999' }, 'afk_channel_id'],
      [{ afk_channel_id: 5 }, 'afk_channel_id'],
    ])('rejects %o', async (payload, field) => {
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await api(`/guilds/${guildId}`, 'PATCH', {
        name: 'Renamed',
        ...payload,
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 50_035,
        errors: { [field]: { _errors: [expect.any(Object)] } },
      })
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    })

    it('returns 404 for an unknown guild and 401 without auth', async () => {
      const missing = await api('/guilds/999999999999999999', 'PATCH', {
        afk_timeout: 60,
      })
      expect(missing.status).toBe(404)
      const unauthenticated = await context.app.request(
        `/api/v10/guilds/${guildId}`,
        { method: 'PATCH', body: JSON.stringify({ afk_timeout: 60 }) }
      )
      expect(unauthenticated.status).toBe(401)
    })

    it('clears the AFK channel when that channel is deleted', async () => {
      await api(`/guilds/${guildId}`, 'PATCH', { afk_channel_id: voiceId })
      expect(await readStatus(api(`/channels/${voiceId}`, 'DELETE'))).toBe(200)
      await expect(readJson(api(`/guilds/${guildId}`))).resolves.toMatchObject({
        afk_channel_id: null,
      })
    })
  })

  describe('/_test/setup', () => {
    it('seeds voice settings and AFK fields into REST and GUILD_CREATE', async () => {
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await setup({
        token: 'Bot second',
        guilds: [
          {
            id: guildId,
            name: 'Voice Guild',
            premium_tier: 2,
            afk_channel_id: '666666666666666666',
            afk_timeout: 3600,
            channels: [
              {
                id: '666666666666666666',
                name: 'afk',
                type: 2,
                bitrate: 256_000,
                user_limit: 99,
                rtc_region: 'us-east',
                video_quality_mode: 2,
              },
              { id: stageId, name: 'stage', user_limit: 10_000 },
            ],
          },
        ],
      })
      expect(response.status).toBe(201)
      const guildCreate = emit.mock.calls.find(
        ([event]) => event === 'guild.create'
      )?.[1] as {
        guild: {
          afk_channel_id: string
          afk_timeout: number
          channels: unknown[]
        }
      }
      expect(guildCreate.guild).toMatchObject({
        afk_channel_id: '666666666666666666',
        afk_timeout: 3600,
      })
      expect(guildCreate.guild.channels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: '666666666666666666',
            bitrate: 256_000,
            user_limit: 99,
            rtc_region: 'us-east',
            video_quality_mode: 2,
          }),
          expect.objectContaining({ id: stageId, user_limit: 10_000 }),
        ])
      )
    })

    it('preserves omitted settings when setup reuses IDs', async () => {
      await api(`/guilds/${guildId}`, 'PATCH', {
        afk_channel_id: voiceId,
        afk_timeout: 60,
      })
      await api(`/channels/${voiceId}`, 'PATCH', { user_limit: 3 })
      const response = await setup({
        token: 'Bot second',
        guilds: [
          {
            id: guildId,
            name: 'Voice Guild',
            channels: [{ id: voiceId, name: 'voice' }],
          },
        ],
      })
      expect(response.status).toBe(201)
      const guild = await context.app.request(`/guilds/${guildId}`, {
        headers: { Authorization: 'Bot second' },
      })
      await expect(guild.json()).resolves.toMatchObject({
        afk_channel_id: voiceId,
        afk_timeout: 60,
      })
      const channel = await context.app.request(`/channels/${voiceId}`, {
        headers: { Authorization: 'Bot second' },
      })
      await expect(channel.json()).resolves.toMatchObject({ user_limit: 3 })
    })

    it.each([
      [{ afk_timeout: 61 }, [], 'Invalid guild AFK settings', 'afk_timeout'],
      [
        { afk_channel_id: textId },
        [],
        'Invalid guild AFK settings',
        'afk_channel_id',
      ],
      [
        {},
        [{ id: textId, name: 'general', bitrate: 64_000 }],
        'Invalid voice channel settings',
        'bitrate',
      ],
      [
        {},
        [{ id: voiceId, name: 'voice', user_limit: 100 }],
        'Invalid voice channel settings',
        'user_limit',
      ],
      [
        {},
        [{ name: 'new-voice', type: 2, bitrate: 128_000 }],
        'Invalid voice channel settings',
        'bitrate',
      ],
    ])(
      'rejects guild %o with channels %o atomically',
      async (guildFields, channels, message, field) => {
        const before = snapshot()
        const emit = vi.spyOn(gatewayBus, 'emit')
        const response = await setup({
          token: 'Bot second',
          guilds: [
            { id: guildId, name: 'Voice Guild', ...guildFields, channels },
          ],
        })
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({
          message,
          code: 0,
          errors: { [field]: { _errors: [expect.any(Object)] } },
        })
        expect(snapshot()).toEqual(before)
        expect(emit).not.toHaveBeenCalled()
      }
    )
  })

  describe('REST voice-state joins and user_limit', () => {
    /** Re-seeds the guild with a human owner so the bot has no bypass. */
    async function humanOwnedGuild() {
      const owner = await context.app.request('/_test/users', {
        method: 'POST',
        body: JSON.stringify({ id: '777777777777777777', username: 'owner' }),
      })
      expect(owner.status).toBe(201)
      const response = await setup({
        token: 'Bot limited',
        user: { id: '888888888888888888' },
        guilds: [
          {
            id: guildId,
            name: 'Voice Guild',
            owner_id: '777777777777777777',
            channels: [{ id: voiceId, name: 'voice', user_limit: 1 }],
          },
        ],
      })
      expect(response.status).toBe(201)
      await addHuman(humanId)
      await addHuman(listenerId)
    }

    /** Patches a voice state through the ordinary REST route. */
    function restJoin(userId: string, channelId = voiceId) {
      return context.app.request(
        `/api/v10/guilds/${guildId}/voice-states/${userId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: 'Bot limited',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channel_id: channelId }),
        }
      )
    }

    /** Joins through the privileged fixture API. */
    function fixtureJoin(userId: string, channelId = voiceId) {
      return context.app.request(
        `/_test/guilds/${guildId}/voice-states/${userId}`,
        { method: 'PATCH', body: JSON.stringify({ channel_id: channelId }) }
      )
    }

    it('blocks joins into a full channel for users without MOVE_MEMBERS', async () => {
      await humanOwnedGuild()
      expect(await readStatus(restJoin(humanId))).toBe(204)
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const full = await restJoin(listenerId)
      expect(full.status).toBe(403)
      await expect(full.json()).resolves.toMatchObject({ code: 50_013 })
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
      // Updating the already-connected member is not a join.
      expect(
        await readStatus(
          context.app.request(
            `/api/v10/guilds/${guildId}/voice-states/${humanId}`,
            {
              method: 'PATCH',
              headers: {
                Authorization: 'Bot limited',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ channel_id: voiceId, suppress: true }),
            }
          )
        )
      ).toBe(204)
    })

    it('admits users when the joining user or the caller has MOVE_MEMBERS', async () => {
      await humanOwnedGuild()
      expect(await readStatus(restJoin(humanId))).toBe(204)
      const overwrite = await context.app.request(
        `/api/v10/channels/${voiceId}/permissions/888888888888888888`,
        {
          method: 'PUT',
          headers: {
            Authorization: 'Bot limited',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ type: 1, allow: MOVE_MEMBERS, deny: '0' }),
        }
      )
      expect(overwrite.status).toBe(204)
      expect(await readStatus(restJoin(listenerId))).toBe(204)
    })

    it('lets the fixture API bypass the user limit', async () => {
      await humanOwnedGuild()
      expect(await readStatus(fixtureJoin(humanId))).toBe(200)
      expect(await readStatus(fixtureJoin(listenerId))).toBe(200)
    })

    it('treats user_limit 0 as unlimited', async () => {
      await humanOwnedGuild()
      await context.app.request(`/api/v10/channels/${voiceId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bot limited',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_limit: 0 }),
      })
      expect(await readStatus(restJoin(humanId))).toBe(204)
      expect(await readStatus(restJoin(listenerId))).toBe(204)
    })
  })
})
