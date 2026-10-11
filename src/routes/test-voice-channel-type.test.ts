import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase } from '../db'
import { gatewayBus } from '../gateway/bus'
import { createFullTestApp } from '../test-helpers'
import { getGuildVoiceStates } from '../services/voice-states'

const guildId = '222222222222222222'
const otherGuildId = '222222222222222223'
const voiceId = '555555555555555555'
const stageId = '555555555555555556'
const textId = '333333333333333333'
const humanId = '444444444444444444'

describe('Voice channel type stability', () => {
  let context: ReturnType<typeof createFullTestApp>

  /** Re-runs setup with a fresh token and the given channel definitions. */
  function setup(
    token: string,
    channels: Record<string, unknown>[],
    id = guildId
  ) {
    return context.app.request('/_test/setup', {
      method: 'POST',
      body: JSON.stringify({
        token,
        guilds: [{ id, name: 'Guild', channels }],
      }),
    })
  }

  /** Captures setup-owned state to check atomic failures. */
  function snapshot() {
    return Object.fromEntries(
      ['bots', 'guilds', 'channels', 'guild_voice_states'].map((table) => [
        table,
        context.db.prepare(`SELECT * FROM ${table}`).all(),
      ])
    )
  }

  beforeEach(async () => {
    context = createFullTestApp()
    const human = await context.app.request('/_test/users', {
      method: 'POST',
      body: JSON.stringify({ id: humanId, username: 'listener' }),
    })
    expect(human.status).toBe(201)
    const first = await setup('Bot first', [
      { id: textId, name: 'general', type: 0 },
      { id: voiceId, name: 'voice', type: 2 },
      { id: stageId, name: 'stage', type: 13 },
    ])
    expect(first.status).toBe(201)
    const member = await context.app.request(
      `/_test/guilds/${guildId}/members/${humanId}`,
      { method: 'POST', body: '{}' }
    )
    expect(member.status).toBeLessThan(300)
    const join = await context.app.request(
      `/_test/guilds/${guildId}/voice-states/${humanId}`,
      { method: 'PATCH', body: JSON.stringify({ channel_id: voiceId }) }
    )
    expect(join.status).toBe(200)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(context.db)
  })

  it.each([
    [voiceId, 0],
    [voiceId, 4],
    [stageId, 5],
    [textId, 2],
    [textId, 13],
  ])(
    'rejects converting channel %s to type %s without partial state or events',
    async (channelId, type) => {
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await setup('Bot second', [
        { id: channelId, name: 'renamed', type },
      ])
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        message:
          'Channel type cannot change between voice-capable (2, 13) and other types',
        code: 0,
      })
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it.each([
    [textId, '2'],
    [textId, '13'],
    [voiceId, '0'],
    [textId, 1.5],
    [textId, -1],
  ])(
    'rejects channel %s with non-integer type %o atomically',
    async (channelId, type) => {
      const before = snapshot()
      const emit = vi.spyOn(gatewayBus, 'emit')
      const response = await setup('Bot second', [
        { id: channelId, name: 'renamed', type },
      ])
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        message: 'Channel type must be a non-negative integer',
        code: 0,
      })
      expect(snapshot()).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
    }
  )

  it('keeps voice states consistent when a voice channel stays voice-capable', async () => {
    const response = await setup('Bot second', [
      { id: voiceId, name: 'renamed-voice', type: 13 },
    ])
    expect(response.status).toBe(201)
    expect(getGuildVoiceStates(context.db, guildId)).toEqual([
      expect.objectContaining({ user_id: humanId, channel_id: voiceId }),
    ])
    const fixture = await context.app.request(
      `/_test/guilds/${guildId}/voice-states/${humanId}`,
      { method: 'PATCH', body: '{}' }
    )
    expect(fixture.status).toBe(200)
  })

  it('preserves the stored type when a reused channel omits type', async () => {
    const response = await setup('Bot second', [
      { id: voiceId, name: 'still-voice' },
    ])
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      guilds: [{ channels: [{ id: voiceId, name: 'still-voice', type: 2 }] }],
    })
    const channel = await context.app.request(`/channels/${voiceId}`, {
      headers: { Authorization: 'Bot second' },
    })
    await expect(channel.json()).resolves.toMatchObject({
      type: 2,
      name: 'still-voice',
    })
    expect(getGuildVoiceStates(context.db, guildId)).toHaveLength(1)
  })

  it('treats type null like omission for reused and new channels', async () => {
    const response = await setup('Bot second', [
      { id: voiceId, name: 'null-voice', type: null },
      { id: '667', name: 'null-new', type: null },
    ])
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      guilds: [
        {
          channels: [
            { id: voiceId, type: 2 },
            { id: '667', type: 0 },
          ],
        },
      ],
    })
    expect(getGuildVoiceStates(context.db, guildId)).toHaveLength(1)
  })

  it('still defaults new channels without type to text', async () => {
    const response = await setup('Bot second', [{ id: '666', name: 'fresh' }])
    await expect(response.json()).resolves.toMatchObject({
      guilds: [{ channels: [{ id: '666', type: 0 }] }],
    })
  })

  it('rejects moving a voice-capable channel to another guild', async () => {
    const before = snapshot()
    const response = await setup(
      'Bot second',
      [{ id: voiceId, name: 'voice', type: 2 }],
      otherGuildId
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      message: 'Voice-capable channels cannot move to another guild',
      code: 0,
    })
    expect(snapshot()).toEqual(before)
  })

  it('still allows reusing a text channel ID in another guild', async () => {
    const response = await setup(
      'Bot second',
      [{ id: textId, name: 'moved' }],
      otherGuildId
    )
    expect(response.status).toBe(201)
  })

  describe('PATCH /channels/:id type', () => {
    /** Patches a channel as the setup bot. */
    function patch(channelId: string, body: Record<string, unknown>) {
      return context.app.request(`/api/v10/channels/${channelId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bot first',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    }

    it.each([
      [voiceId, 0, '(2)'],
      [stageId, 2, '(13)'],
      [textId, 2, '(0, 5)'],
      [textId, 13, '(0, 5)'],
    ])(
      'rejects changing channel %s to type %s',
      async (channelId, type, choices) => {
        const before = snapshot()
        const emit = vi.spyOn(gatewayBus, 'emit')
        const response = await patch(channelId, { type, name: 'renamed' })
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({
          code: 50_035,
          errors: {
            type: {
              _errors: [
                {
                  code: 'BASE_TYPE_CHOICES',
                  message: `Value must be one of ${choices}.`,
                },
              ],
            },
          },
        })
        expect(snapshot()).toEqual(before)
        expect(emit).not.toHaveBeenCalled()
      }
    )

    it('accepts the current type unchanged', async () => {
      const response = await patch(voiceId, { type: 2, name: 'same-type' })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        type: 2,
        name: 'same-type',
      })
    })

    it('returns 404 for an unknown channel and 401 without auth', async () => {
      const missing = await patch('999999999999999999', { type: 0 })
      expect(missing.status).toBe(404)
      const unauthenticated = await context.app.request(
        `/api/v10/channels/${voiceId}`,
        { method: 'PATCH', body: JSON.stringify({ type: 0 }) }
      )
      expect(unauthenticated.status).toBe(401)
    })
  })
})
