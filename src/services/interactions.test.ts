import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initializeDatabase, closeDatabase } from '../db'
import type { Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import {
  createInteraction,
  getInteractionFollowupTarget,
  handleInteractionCallback,
} from './interactions'

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
