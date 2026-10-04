import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedGuild,
  seedChannel,
  seedInteraction,
  type FullTestContext,
} from '../test-helpers'
import { createTestUser } from '../services/test-control'
import type { MessageObject } from '../services/messages'
import { generateSnowflake } from '../snowflake'

const applicationId = '111111111111111111'

describe('original interaction response REST flow', () => {
  let context: FullTestContext
  let channelId: string
  let interactionId: string
  let interactionToken: string
  let botToken: string

  beforeEach(() => {
    context = createFullTestApp()
    botToken = seedBot(context.db, 'Bot deferred-token', applicationId)
    const guildId = seedGuild(context.db, botToken)
    channelId = seedChannel(context.db, guildId)
    const user = createTestUser(context.db, { username: 'Caller' })
    const interaction = seedInteraction(
      context.db,
      applicationId,
      channelId,
      user.id
    )
    interactionId = interaction.interactionId
    interactionToken = interaction.interactionToken
  })

  afterEach(() => {
    context.cleanup()
  })

  it.each(['/api/v10', '/api', ''])(
    'defers, rejects a second acknowledgement, and edits the original under %s',
    async (prefix) => {
      const callbackPath = `${prefix}/interactions/${interactionId}/${interactionToken}/callback`
      const originalPath = `${prefix}/webhooks/${applicationId}/${interactionToken}/messages/@original`
      const deferred = await context.app.request(
        `${callbackPath}?with_response=true`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 5 }),
        }
      )
      expect(deferred.status).toBe(200)
      const acknowledgement = (await deferred.json()) as {
        interaction: { response_message_id: string }
        resource?: unknown
      }
      expect(acknowledgement).toMatchObject({
        interaction: {
          response_message_loading: true,
          response_message_ephemeral: false,
        },
      })
      expect(acknowledgement.resource).toBeUndefined()
      const pending = await context.app.request(originalPath)
      expect(pending.status).toBe(200)
      expect(await pending.json()).toMatchObject({
        id: acknowledgement.interaction.response_message_id,
        content: '',
        embeds: [],
        flags: 128,
      })

      const duplicate = await context.app.request(callbackPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 4, data: { content: 'Ranking' } }),
      })
      expect(duplicate.status).toBe(400)
      expect(await duplicate.json()).toMatchObject({ code: 40_060 })

      const embeds = [
        {
          title: 'Your ranking',
          description: 'Position: 1',
          fields: [{ name: 'Points', value: '42' }],
        },
      ]
      const edited = await context.app.request(originalPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Ranking result', embeds }),
      })
      expect(edited.status).toBe(200)
      const final = (await edited.json()) as MessageObject
      expect(final).toMatchObject({
        id: acknowledgement.interaction.response_message_id,
        channel_id: channelId,
        application_id: applicationId,
        webhook_id: applicationId,
        author: { id: applicationId, bot: true },
        content: 'Ranking result',
        embeds,
        flags: 0,
        type: 20,
        interaction: { id: interactionId, type: 2 },
      })
      const retrieved = await context.app.request(originalPath)
      expect(await retrieved.json()).toEqual(final)
      const observed = await context.app.request(
        `${prefix}/channels/${channelId}/messages`,
        {
          headers: { Authorization: botToken },
        }
      )
      expect(observed.status).toBe(200)
      expect(await observed.json()).toEqual([final])
      const unauthorized = await context.app.request(
        `${prefix}/channels/${channelId}/messages`
      )
      expect(unauthorized.status).toBe(401)

      const secondEdit = await context.app.request(originalPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: null }),
      })
      expect(await secondEdit.json()).toMatchObject({
        id: final.id,
        content: 'Ranking result',
        embeds: [],
        flags: 0,
      })
      const deleted = await context.app.request(originalPath, {
        method: 'DELETE',
      })
      expect(deleted.status).toBe(204)
      const missing = await context.app.request(originalPath)
      expect(missing.status).toBe(404)
      const editDeleted = await context.app.request(originalPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'deleted' }),
      })
      expect(editDeleted.status).toBe(404)
    }
  )

  it.each([4, 5])(
    'keeps type-%i ephemeral originals out of channel observation after editing',
    async (type) => {
      await context.app.request(
        `/interactions/${interactionId}/${interactionToken}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            data: { flags: 64, ...(type === 4 && { content: 'Private' }) },
          }),
        }
      )
      const originalPath = `/webhooks/${applicationId}/${interactionToken}/messages/@original`
      const edited = await context.app.request(originalPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{ description: 'Private ranking' }],
          flags: 0,
        }),
      })
      expect(edited.status).toBe(200)
      const original = (await edited.json()) as MessageObject
      expect(original).toMatchObject({
        flags: 64,
        embeds: [{ description: 'Private ranking' }],
      })
      const list = await context.app.request(
        `/channels/${channelId}/messages`,
        { headers: { Authorization: botToken } }
      )
      expect(await list.json()).toEqual([])
      const single = await context.app.request(
        `/channels/${channelId}/messages/${original.id}`,
        { headers: { Authorization: botToken } }
      )
      expect(single.status).toBe(404)
    }
  )

  it.each(['wrong-token', 'wrong-application'])(
    'rejects %s original access without modifying the pending response',
    async (invalid) => {
      await context.app.request(
        `/interactions/${interactionId}/${interactionToken}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 5 }),
        }
      )
      const path = `/webhooks/${invalid === 'wrong-application' ? 'unknown' : applicationId}/${invalid === 'wrong-token' ? 'unknown' : interactionToken}/messages/@original`
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        const response = await context.app.request(path, {
          method,
          ...(method === 'PATCH' && {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'wrong' }),
          }),
        })
        expect(response.status).toBe(404)
      }
      const original = await context.app.request(
        `/webhooks/${applicationId}/${interactionToken}/messages/@original`
      )
      expect(await original.json()).toMatchObject({ flags: 128, content: '' })
    }
  )

  it('rejects an invalid deferred flag without acknowledging the interaction', async () => {
    const callback = `/interactions/${interactionId}/${interactionToken}/callback`
    const invalid = await context.app.request(callback, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 5, data: { flags: 128 } }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      code: 50_035,
      errors: { 'data.flags': expect.anything() },
    })
    const valid = await context.app.request(callback, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 5 }),
    })
    expect(valid.status).toBe(204)
  })

  it.each([
    { content: 'x'.repeat(2001) },
    { content: 42 },
    { embeds: 'invalid' },
    { flags: 'invalid' },
  ])(
    'rejects invalid original edits without clearing loading: %j',
    async (payload) => {
      await context.app.request(
        `/interactions/${interactionId}/${interactionToken}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 5 }),
        }
      )
      const path = `/webhooks/${applicationId}/${interactionToken}/messages/@original`
      const edited = await context.app.request(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(edited.status).toBe(400)
      expect(await edited.json()).toMatchObject({ code: 50_035 })
      const original = await context.app.request(path)
      expect(await original.json()).toMatchObject({
        flags: 128,
        content: '',
        embeds: [],
      })
    }
  )

  it('preserves acknowledgement-only support for spec callback type 13', async () => {
    const callback = await context.app.request(
      `/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 13, data: {} }),
      }
    )
    expect(callback.status).toBe(204)
    const original = await context.app.request(
      `/webhooks/${applicationId}/${interactionToken}/messages/@original`
    )
    expect(original.status).toBe(404)
  })

  it.each([false, true])(
    'blocks channel mutations of ephemeral originals (completed: %s)',
    async (completed) => {
      await context.app.request(
        `/interactions/${interactionId}/${interactionToken}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 5, data: { flags: 64 } }),
        }
      )
      const originalPath = `/webhooks/${applicationId}/${interactionToken}/messages/@original`
      if (completed) {
        await context.app.request(originalPath, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Private ranking' }),
        })
      }
      const retrieved = await context.app.request(originalPath)
      const original = (await retrieved.json()) as MessageObject
      const messagePath = `/channels/${channelId}/messages/${original.id}`
      const attempts = [
        { method: 'PATCH', path: messagePath, payload: { content: 'Exposed' } },
        { method: 'PUT', path: `/channels/${channelId}/pins/${original.id}` },
        {
          method: 'PUT',
          path: `/channels/${channelId}/messages/pins/${original.id}`,
        },
        { method: 'POST', path: `${messagePath}/crosspost` },
        {
          method: 'POST',
          path: `${messagePath}/threads`,
          payload: { name: 'Private thread' },
        },
        { method: 'PUT', path: `${messagePath}/reactions/thumbsup/@me` },
        { method: 'DELETE', path: messagePath },
      ]
      for (const attempt of attempts) {
        const response = await context.app.request(attempt.path, {
          method: attempt.method,
          headers: {
            Authorization: botToken,
            'Content-Type': 'application/json',
          },
          ...(attempt.payload && { body: JSON.stringify(attempt.payload) }),
        })
        expect(response.status, `${attempt.method} ${attempt.path}`).toBe(404)
        expect(await response.json()).toMatchObject({ code: 10_008 })
      }
      // Existing persisted pin rows must not expose private responses either.
      context.db
        .prepare('INSERT INTO pins (channel_id, message_id) VALUES (?, ?)')
        .run(channelId, original.id)
      const pins = await context.app.request(`/channels/${channelId}/pins`, {
        headers: { Authorization: botToken },
      })
      expect(await pins.json()).toEqual([])
      const newPins = await context.app.request(
        `/channels/${channelId}/messages/pins`,
        { headers: { Authorization: botToken } }
      )
      expect(await newPins.json()).toMatchObject({ items: [] })
      const after = await context.app.request(originalPath)
      expect(await after.json()).toEqual(original)
      const bulkDeleted = await context.app.request(
        `/channels/${channelId}/messages/bulk-delete`,
        {
          method: 'POST',
          headers: {
            Authorization: botToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: [original.id, generateSnowflake()],
          }),
        }
      )
      expect(bulkDeleted.status).toBe(204)
      const afterBulk = await context.app.request(originalPath)
      expect(await afterBulk.json()).toEqual(original)
    }
  )
})
