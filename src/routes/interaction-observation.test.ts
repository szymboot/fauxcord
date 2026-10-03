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

const applicationId = '111111111111111111'

describe('initial interaction callback observation', () => {
  let context: FullTestContext
  let interactionId: string
  let interactionToken: string
  let botToken: string

  beforeEach(() => {
    context = createFullTestApp()
    botToken = seedBot(context.db, 'Bot observation-bot', applicationId)
    const guildId = seedGuild(context.db, botToken)
    const channelId = seedChannel(context.db, guildId)
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

  /** Reads callback state without putting the interaction token in the URL. */
  function observe(
    id = interactionId,
    appId = applicationId,
    token = interactionToken
  ): Response | Promise<Response> {
    return context.app.request(
      `/_test/interactions/${id}/callback?application_id=${appId}`,
      { headers: { 'X-Interaction-Token': token } }
    )
  }

  /** Submits a bot callback through the native REST endpoint. */
  function submitCallback(
    body: string,
    token = interactionToken
  ): Response | Promise<Response> {
    return context.app.request(
      `/api/v10/interactions/${interactionId}/${token}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }
    )
  }

  /** Reads and verifies a successful, uncacheable observation response. */
  async function readObservation(): Promise<unknown> {
    const response = await observe()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return response.json()
  }

  /** Submits a callback and returns its status for acceptance assertions. */
  async function callbackStatus(
    body: string,
    token = interactionToken
  ): Promise<number> {
    const response = await submitCallback(body, token)
    return response.status
  }

  it('allows browser observation with the interaction token header', async () => {
    const response = await context.app.request(
      `/_test/interactions/${interactionId}/callback?application_id=${applicationId}`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:4000',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'X-Interaction-Token',
        },
      }
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'X-Interaction-Token'
    )
  })

  it('returns pending state without acknowledging the interaction', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await observe()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        interaction_id: interactionId,
        application_id: applicationId,
        responded: false,
        initial_callback_type: null,
      })
    }
    expect(await callbackStatus('{"type":4}')).toBe(204)
  })

  it.each([4, 5])(
    'preserves accepted type %i after original completion, deletion, and a retry',
    async (type) => {
      expect(await callbackStatus(JSON.stringify({ type }))).toBe(204)
      const originalPath = `/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`
      const edited = await context.app.request(originalPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Completed before observation' }),
      })
      expect(edited.status).toBe(200)
      expect(await edited.json()).toMatchObject({ flags: 0 })
      const expected = {
        interaction_id: interactionId,
        application_id: applicationId,
        responded: true,
        initial_callback_type: type,
      }
      const first = await observe()
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual(expected)
      const retry = await submitCallback(
        JSON.stringify({ type: type === 4 ? 5 : 4 })
      )
      expect(retry.status).toBe(400)
      expect(await retry.json()).toMatchObject({ code: 40_060 })
      const deleted = await context.app.request(originalPath, {
        method: 'DELETE',
      })
      expect(deleted.status).toBe(204)
      expect(await readObservation()).toEqual(expected)
    }
  )

  it('preserves nullable message fields accepted by the Discord spec', async () => {
    expect(
      await callbackStatus(
        JSON.stringify({
          type: 4,
          data: { content: null, embeds: null, tts: null, flags: null },
        })
      )
    ).toBe(204)
    expect(await readObservation()).toMatchObject({
      responded: true,
      initial_callback_type: 4,
    })
  })

  it.each([1, 6, 7, 8, 9, 10, 12, 13])(
    'records accepted acknowledgement-only callback type %i',
    async (type) => {
      expect(await callbackStatus(JSON.stringify({ type }))).toBe(204)
      expect(await readObservation()).toMatchObject({
        responded: true,
        initial_callback_type: type,
      })
    }
  )

  it.each(['interaction', 'application', 'token', 'other-interaction-token'])(
    'returns the same token-free 404 for a mismatched %s',
    async (mismatch) => {
      expect(await callbackStatus('{"type":5}')).toBe(204)
      // A valid token from another interaction must not match this ID.
      const other = seedInteraction(
        context.db,
        applicationId,
        'other-channel',
        'user'
      )
      const response = await observe(
        mismatch === 'interaction' ? 'unknown' : interactionId,
        mismatch === 'application' ? 'unknown' : applicationId,
        mismatch === 'token'
          ? 'unknown'
          : mismatch === 'other-interaction-token'
            ? other.interactionToken
            : interactionToken
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        message: '404: Not Found',
        code: 0,
      })
    }
  )

  it.each(['application', 'token', 'both'])(
    'requires the %s lookup credentials',
    async (missing) => {
      const response = await context.app.request(
        `/_test/interactions/${interactionId}/callback${missing === 'token' ? `?application_id=${applicationId}` : ''}`,
        {
          headers:
            missing === 'application'
              ? { 'X-Interaction-Token': interactionToken }
              : {},
        }
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: '400: Bad Request',
        code: 0,
      })
    }
  )

  it.each([
    '{',
    'null',
    '[]',
    '{"type":99}',
    '{"type":4,"data":null}',
    '{"type":4,"data":{"embeds":{}}}',
    '{"type":4,"data":{"embeds":[null]}}',
    '{"type":4,"data":{"embeds":["invalid"]}}',
    '{"type":4,"data":{"tts":"false"}}',
    '{"type":4,"data":{"content":123}}',
    '{"type":4,"data":{"flags":"0"}}',
    '{"type":4,"data":{"flags":0.5}}',
    '{"type":4,"data":{"flags":9007199254740992}}',
    '{"type":5,"data":{"flags":128}}',
  ])(
    'does not invent acceptance for malformed or rejected callback %s',
    async (body) => {
      const rejected = await submitCallback(body)
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ code: 50_035 })
      expect(await readObservation()).toMatchObject({
        responded: false,
        initial_callback_type: null,
      })
      expect(await callbackStatus('{"type":5}')).toBe(204)
      expect(await callbackStatus(body)).toBe(400)
      expect(await readObservation()).toMatchObject({
        responded: true,
        initial_callback_type: 5,
      })
    }
  )

  it('does not acknowledge a callback with an unknown token', async () => {
    expect(await callbackStatus('{"type":4}', 'unknown')).toBe(404)
    expect(await readObservation()).toMatchObject({
      responded: false,
      initial_callback_type: null,
    })
  })

  it('reports unknown historical mode for a legacy acknowledged row', async () => {
    context.db
      .prepare('UPDATE interactions SET responded = 1 WHERE id = ?')
      .run(interactionId)
    expect(await readObservation()).toMatchObject({
      responded: true,
      initial_callback_type: null,
    })
    expect(await callbackStatus('{"type":4}')).toBe(400)
    expect(await readObservation()).toMatchObject({
      responded: true,
      initial_callback_type: null,
    })
  })

  it('clears observation on setup deletion', async () => {
    expect(await callbackStatus('{"type":4}')).toBe(204)
    const removed = await context.app.request(
      `/_test/setup/${encodeURIComponent(botToken)}`,
      {
        method: 'DELETE',
      }
    )
    expect(removed.status).toBe(204)
    const observation = await observe()
    expect(observation.status).toBe(404)
  })

  it.each([undefined, 'Bot observation-bot'])(
    'clears observations on reset with scope %s',
    async (token) => {
      expect(await callbackStatus('{"type":5}')).toBe(204)
      const reset = await context.app.request('/_test/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      expect(reset.status).toBe(204)
      const observation = await observe()
      expect(observation.status).toBe(404)
    }
  )
})
