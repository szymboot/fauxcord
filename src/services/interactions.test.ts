import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initializeDatabase, closeDatabase } from '../db'
import type { Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import {
  createInteraction,
  getInteractionFollowupTarget,
  getInteractionCallbackObservation,
  handleInteractionCallback,
} from './interactions'
import { getMessage, getMessages, updateMessage } from './messages'

const BASE_URL = 'http://localhost:3000'

describe('interactions service', () => {
  let db: Database
  const applicationId = '111111111111111111'
  const channelId = '222222222222222222'
  const userId = '333333333333333333'

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    db.prepare(
      "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'AppUser', '0', 1)"
    ).run(applicationId)
    db.prepare(
      "INSERT INTO channels (id, guild_id, type, name) VALUES (?, NULL, 0, 'general')"
    ).run(channelId)
    db.prepare(
      "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'Caller', '0', 0)"
    ).run(userId)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('creates an interaction and emits interaction.create', () => {
    const spy = vi.fn()
    gatewayBus.on('interaction.create', spy)

    const interaction = createInteraction(db, {
      interactionId: 'int1',
      applicationId,
      token: 'token1',
      type: 2,
      channelId,
      userId,
      data: { name: 'ping' },
    })

    expect(interaction.id).toBe('int1')
    expect(interaction.application_id).toBe(applicationId)
    expect(interaction.channel_id).toBe(channelId)
    expect(interaction.user).toMatchObject({ id: userId })
    expect(interaction.locale).toBe('en-US')
    expect(spy).toHaveBeenCalledWith({
      applicationId,
      interaction: expect.objectContaining({ id: 'int1', locale: 'en-US' }),
    })

    gatewayBus.off('interaction.create', spy)
  })

  it.each([2, 3, 4, 5])('includes the requested locale for type %i', (type) => {
    const interaction = createInteraction(db, {
      interactionId: 'localized',
      applicationId,
      token: 'localized-token',
      type,
      channelId,
      userId,
      locale: 'pl',
    })
    expect(interaction.locale).toBe('pl')
    expect(interaction.data).toBeUndefined()
    expect(
      db
        .prepare('SELECT locale FROM interactions WHERE id = ?')
        .pluck()
        .get(interaction.id)
    ).toBe('pl')
  })

  it('omits locale for PING interactions', () => {
    const interaction = createInteraction(db, {
      interactionId: 'ping',
      applicationId,
      token: 'ping-token',
      type: 1,
      userId,
      locale: 'pl',
    })
    expect(interaction).not.toHaveProperty('locale')
  })

  it('resolves a followup target for a known interaction token', () => {
    createInteraction(db, {
      interactionId: 'int2',
      applicationId,
      token: 'token2',
      type: 2,
      channelId,
      userId,
    })
    const target = getInteractionFollowupTarget(db, applicationId, 'token2')
    expect(target).toEqual({ channelId, initialResponseMessageId: null })
  })

  it('returns null for an unknown followup token', () => {
    expect(
      getInteractionFollowupTarget(db, applicationId, 'unknown')
    ).toBeNull()
  })

  it('handles a type-4 callback by creating a message and recording responded', () => {
    createInteraction(db, {
      interactionId: 'int3',
      applicationId,
      token: 'token3',
      type: 2,
      channelId,
      userId,
    })

    const result = handleInteractionCallback(
      db,
      'int3',
      'token3',
      { type: 4, data: { content: 'pong' } },
      BASE_URL
    )
    expect(result).toMatchObject({
      ok: true,
      response: {
        interaction: { id: 'int3', type: 2 },
        resource: { type: 4, message: { content: 'pong' } },
      },
    })

    const target = getInteractionFollowupTarget(db, applicationId, 'token3')
    expect(target?.initialResponseMessageId).not.toBeNull()
  })

  it('returns not_found for an unknown interaction', () => {
    const result = handleInteractionCallback(
      db,
      'missing',
      'missing',
      { type: 5 },
      BASE_URL
    )
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('returns already_responded on a second callback', () => {
    createInteraction(db, {
      interactionId: 'int4',
      applicationId,
      token: 'token4',
      type: 2,
      channelId,
      userId,
    })
    handleInteractionCallback(db, 'int4', 'token4', { type: 5 }, BASE_URL)
    const second = handleInteractionCallback(
      db,
      'int4',
      'token4',
      { type: 5 },
      BASE_URL
    )
    expect(second).toEqual({ ok: false, reason: 'already_responded' })
  })
})

describe('deferred interaction responses', () => {
  let db: Database
  const applicationId = '111111111111111111'
  const channelId = '222222222222222222'
  const userId = '333333333333333333'

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    db.prepare(
      "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'RankingBot', '0', 1), (?, 'Caller', '0', 0)"
    ).run(applicationId, userId)
    db.prepare(
      "INSERT INTO channels (id, type, name) VALUES (?, 0, 'ranking')"
    ).run(channelId)
    createInteraction(db, {
      interactionId: 'deferred',
      applicationId,
      token: 'deferred-token',
      type: 2,
      channelId,
      userId,
      data: { name: 'me', type: 1 },
    })
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it.each([0, 64])('records a loading original with flags %i', (flags) => {
    const result = handleInteractionCallback(
      db,
      'deferred',
      'deferred-token',
      { type: 5, data: { flags } },
      BASE_URL
    )
    const target = getInteractionFollowupTarget(
      db,
      applicationId,
      'deferred-token'
    )
    expect(target?.initialResponseMessageId).toEqual(expect.any(String))
    const original = getMessage(
      db,
      target?.initialResponseMessageId ?? '',
      BASE_URL
    )
    expect(original).toMatchObject({
      channel_id: channelId,
      application_id: applicationId,
      webhook_id: applicationId,
      author: { id: applicationId, bot: true, username: 'RankingBot' },
      content: '',
      embeds: [],
      flags: 128 | flags,
      type: 20,
      interaction: {
        id: 'deferred',
        type: 2,
        name: 'me',
        user: { id: userId },
      },
    })
    expect(result).toMatchObject({
      ok: true,
      response: {
        interaction: {
          response_message_id: original?.id,
          response_message_loading: true,
          response_message_ephemeral: flags === 64,
        },
      },
    })
    if (result.ok) expect(result.response.resource).toBeUndefined()
    expect(
      handleInteractionCallback(
        db,
        'deferred',
        'deferred-token',
        {
          type: 4,
          data: { content: 'second acknowledgement' },
        },
        BASE_URL
      )
    ).toEqual({ ok: false, reason: 'already_responded' })
    expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(1)
  })

  it.each([0, 64])(
    'completes the same original and preserves visibility %i',
    (flags) => {
      const created = vi.fn()
      const updated = vi.fn()
      gatewayBus.on('message.create', created)
      gatewayBus.on('message.update', updated)
      try {
        handleInteractionCallback(
          db,
          'deferred',
          'deferred-token',
          {
            type: 5,
            data: { flags },
          },
          BASE_URL
        )
        const target = getInteractionFollowupTarget(
          db,
          applicationId,
          'deferred-token'
        )
        const originalId = target?.initialResponseMessageId ?? ''
        const embeds = [
          { title: 'Ranking', fields: [{ name: 'Position', value: '1' }] },
        ]
        const final = updateMessage(
          db,
          originalId,
          { embeds, flags: flags === 64 ? 0 : 64 },
          BASE_URL
        )
        expect(final).toMatchObject({
          id: originalId,
          content: '',
          embeds,
          flags,
        })
        expect(getMessage(db, originalId, BASE_URL)).toEqual(final)
        expect(getMessages(db, channelId, {}, BASE_URL)).toEqual(
          flags === 64 ? [] : [final]
        )
        expect(created).toHaveBeenCalledTimes(flags === 64 ? 0 : 1)
        expect(updated).toHaveBeenCalledTimes(flags === 64 ? 0 : 1)
        expect(
          db
            .prepare('SELECT last_message_id FROM channels WHERE id = ?')
            .pluck()
            .get(channelId)
        ).toBe(flags === 64 ? null : originalId)
        if (flags === 0)
          expect(updated).toHaveBeenCalledWith(
            expect.objectContaining({
              message: expect.objectContaining({
                id: originalId,
                embeds,
                flags: 0,
                application_id: applicationId,
              }),
            })
          )
      } finally {
        gatewayBus.off('message.create', created)
        gatewayBus.off('message.update', updated)
      }
    }
  )

  it('rolls back callback observation when original creation fails', () => {
    db.exec("DELETE FROM channels WHERE id = '222222222222222222'")
    expect(() =>
      handleInteractionCallback(
        db,
        'deferred',
        'deferred-token',
        { type: 4 },
        BASE_URL
      )
    ).toThrow()
    expect(
      getInteractionCallbackObservation(
        db,
        'deferred',
        applicationId,
        'deferred-token'
      )
    ).toEqual({
      interaction_id: 'deferred',
      application_id: applicationId,
      responded: false,
      initial_callback_type: null,
    })
    expect(
      getInteractionFollowupTarget(db, applicationId, 'deferred-token')
        ?.initialResponseMessageId
    ).toBeNull()
  })

  it.each([4, 5])(
    'records type %i with response state before dispatch',
    (type) => {
      const observations: unknown[] = []
      /** Observes the acceptance state available during message dispatch. */
      const observe = (): void => {
        observations.push(
          getInteractionCallbackObservation(
            db,
            'deferred',
            applicationId,
            'deferred-token'
          )
        )
      }
      gatewayBus.on('message.create', observe)
      try {
        handleInteractionCallback(
          db,
          'deferred',
          'deferred-token',
          { type },
          BASE_URL
        )
        expect(observations).toEqual([
          {
            interaction_id: 'deferred',
            application_id: applicationId,
            responded: true,
            initial_callback_type: type,
          },
        ])
      } finally {
        gatewayBus.off('message.create', observe)
      }
    }
  )

  it.each([6, 7, 9, 13])(
    'keeps acknowledgement-only callback type %i without an original',
    (type) => {
      expect(
        handleInteractionCallback(
          db,
          'deferred',
          'deferred-token',
          { type },
          BASE_URL
        )
      ).toMatchObject({ ok: true })
      expect(
        getInteractionFollowupTarget(db, applicationId, 'deferred-token')
          ?.initialResponseMessageId
      ).toBeNull()
    }
  )

  it('rejects a wrong token without acknowledging or creating a message', () => {
    expect(
      handleInteractionCallback(
        db,
        'deferred',
        'wrong-token',
        { type: 5 },
        BASE_URL
      )
    ).toEqual({ ok: false, reason: 'not_found' })
    expect(db.prepare('SELECT responded FROM interactions').pluck().get()).toBe(
      0
    )
    expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0)
  })
})
