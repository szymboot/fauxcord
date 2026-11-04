import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
  seedWebhook,
  type FullTestContext,
} from '../test-helpers'
import { createCommand } from '../services/application-commands'
import { createTestUser } from '../services/test-control'
import { INTERACTION_TOKEN_TTL_MS } from '../services/interactions'

const applicationId = '111111111111111111'
const botAuth = 'Bot expiry-bot'
const PREFIXES = ['/api/v10', '/api', '']

/** Reads a response status. */
async function status(response: Response | Promise<Response>): Promise<number> {
  const resolved = await response
  return resolved.status
}

/** Reads a response body as JSON. */
async function json(response: Response | Promise<Response>): Promise<unknown> {
  const resolved = await response
  return resolved.json()
}

/** A simulated interaction as returned by `POST /_test/interactions`. */
interface Started {
  id: string
  token: string
  application_id: string
}

/** The Discord error body for an expired interaction token. */
const INVALID_WEBHOOK_TOKEN = {
  message: 'Invalid Webhook Token',
  code: 50_027,
}

describe('interaction token expiry', () => {
  let context: FullTestContext
  let guildId: string
  let channelId: string
  let user: string
  let interaction: Started
  let originalId: string
  let followupId: string

  /** JSON request helper without bot authorization (token-authorized routes). */
  function send(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {}
  ): Response | Promise<Response> {
    return context.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Starts a slash-command interaction. */
  async function start(): Promise<Started> {
    const response = await send('/_test/interactions', 'POST', {
      application_id: applicationId,
      command_name: 'ranking',
      guild_id: guildId,
      channel_id: channelId,
      user_id: user,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as Started
  }

  /** Webhook path of an interaction token. */
  function hook(target: Started, suffix = '', prefix = ''): string {
    return `${prefix}/webhooks/${applicationId}/${target.token}${suffix}`
  }

  /** Expires a token through test control. */
  function expire(
    target: Started,
    body?: unknown,
    token: string | null = target.token
  ): Response | Promise<Response> {
    return send(
      `/_test/interactions/${target.id}/expire-token`,
      'POST',
      body === undefined ? { application_id: target.application_id } : body,
      token === null ? {} : { 'X-Interaction-Token': token }
    )
  }

  beforeEach(async () => {
    context = createFullTestApp()
    const { db } = context
    const botToken = seedBot(db, botAuth, applicationId)
    guildId = seedGuild(db, botToken)
    channelId = seedChannel(db, guildId)
    user = createTestUser(db, { username: 'Caller' }).id
    db.prepare(
      'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
    ).run(guildId, user)
    createCommand(db, applicationId, guildId, { name: 'ranking', type: 1 })

    interaction = await start()
    const callback = await send(
      `/api/v10/interactions/${interaction.id}/${interaction.token}/callback?with_response=true`,
      'POST',
      { type: 4, data: { content: 'original' } }
    )
    expect(callback.status).toBe(200)
    originalId = (
      (await callback.json()) as {
        interaction: { response_message_id: string }
      }
    ).interaction.response_message_id
    const followup = await send(hook(interaction, '?wait=true'), 'POST', {
      content: 'followup',
    })
    expect(followup.status).toBe(200)
    followupId = ((await followup.json()) as { id: string }).id
  })

  afterEach(() => {
    vi.useRealTimers()
    context.cleanup()
  })

  /** Every interaction-token webhook route with a request that is valid before expiry. */
  const routes: {
    name: string
    method: string
    path: (
      target: Started,
      ids: { original: string; followup: string }
    ) => string
    body?: unknown
    ok: number
  }[] = [
    {
      name: 'GET @original',
      method: 'GET',
      path: (target) => hook(target, '/messages/@original'),
      ok: 200,
    },
    {
      name: 'PATCH @original',
      method: 'PATCH',
      path: (target) => hook(target, '/messages/@original'),
      body: { content: 'edited original' },
      ok: 200,
    },
    {
      name: 'DELETE @original',
      method: 'DELETE',
      path: (target) => hook(target, '/messages/@original'),
      ok: 204,
    },
    {
      name: 'POST followup',
      method: 'POST',
      path: (target) => hook(target, '?wait=true'),
      body: { content: 'another followup' },
      ok: 200,
    },
    {
      name: 'POST followup without wait',
      method: 'POST',
      path: (target) => hook(target),
      body: { content: 'another followup' },
      ok: 204,
    },
    {
      name: 'GET message',
      method: 'GET',
      path: (target, ids) => hook(target, `/messages/${ids.followup}`),
      ok: 200,
    },
    {
      name: 'PATCH message',
      method: 'PATCH',
      path: (target, ids) => hook(target, `/messages/${ids.followup}`),
      body: { content: 'edited followup' },
      ok: 200,
    },
    {
      name: 'DELETE message',
      method: 'DELETE',
      path: (target, ids) => hook(target, `/messages/${ids.followup}`),
      ok: 204,
    },
  ]

  describe.each(PREFIXES)('under prefix "%s"', (prefix) => {
    it.each(routes)(
      '$name works before expiry and returns 401/50027 after it',
      async (route) => {
        const ids = { original: originalId, followup: followupId }
        const path = prefix + route.path(interaction, ids)
        const before = await send(path, route.method, route.body)
        expect(before.status).toBe(route.ok)

        // Recreate state consumed by the destructive routes, then expire.
        const fresh = await start()
        const cb = await send(
          `/api/v10/interactions/${fresh.id}/${fresh.token}/callback?with_response=true`,
          'POST',
          { type: 4, data: { content: 'o' } }
        )
        const freshOriginal = (
          (await cb.json()) as {
            interaction: { response_message_id: string }
          }
        ).interaction.response_message_id
        const followup = await send(hook(fresh, '?wait=true'), 'POST', {
          content: 'f',
        })
        const freshFollowup = ((await followup.json()) as { id: string }).id
        expect(await status(expire(fresh))).toBe(200)

        const after = await send(
          prefix +
            route.path(fresh, {
              original: freshOriginal,
              followup: freshFollowup,
            }),
          route.method,
          route.body
        )
        expect(after.status).toBe(401)
        expect(await after.json()).toEqual(INVALID_WEBHOOK_TOKEN)
      }
    )
  })

  it('rejects an expired token before validating the body', async () => {
    await expire(interaction)
    const response = await send(hook(interaction), 'POST', {})
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(INVALID_WEBHOOK_TOKEN)
    const malformed = await context.app.request(
      hook(interaction, '/messages/@original'),
      { method: 'PATCH', body: 'not json' }
    )
    expect(malformed.status).toBe(401)
  })

  describe('natural expiry (Fauxcord clock)', () => {
    it('stays valid until 15 minutes after creation, then expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const fresh = await start()
      const original = hook(fresh, '/messages/@original')
      await send(
        `/api/v10/interactions/${fresh.id}/${fresh.token}/callback`,
        'POST',
        { type: 5 }
      )

      vi.setSystemTime(Date.now() + INTERACTION_TOKEN_TTL_MS - 1)
      expect(await status(send(original))).toBe(200)

      vi.setSystemTime(Date.now() + 1)
      const expired = await send(original)
      expect(expired.status).toBe(401)
      expect(await expired.json()).toEqual(INVALID_WEBHOOK_TOKEN)
      expect(await status(send(hook(fresh), 'POST', { content: 'late' }))).toBe(
        401
      )
    })

    it('measures lifetime per interaction and from its own creation', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const first = await start()
      vi.setSystemTime(Date.now() + INTERACTION_TOKEN_TTL_MS - 1000)
      const second = await start()
      vi.setSystemTime(Date.now() + 1000)
      expect(await status(send(hook(first), 'POST', { content: 'x' }))).toBe(
        401
      )
      expect(await status(send(hook(second), 'POST', { content: 'x' }))).toBe(
        204
      )
    })

    it('expires rows without a recorded expiry 15 minutes after created_at', async () => {
      context.db
        .prepare('UPDATE interactions SET token_expires_at = NULL WHERE id = ?')
        .run(interaction.id)
      const path = hook(interaction, '/messages/@original')
      expect(await status(send(path))).toBe(200)
      context.db
        .prepare(
          "UPDATE interactions SET created_at = datetime('now', '-16 minutes') WHERE id = ?"
        )
        .run(interaction.id)
      expect(await status(send(path))).toBe(401)
    })
  })

  describe('POST /_test/interactions/:interactionId/expire-token', () => {
    it('expires only the addressed token and reports the instant', async () => {
      const other = await start()
      const response = await expire(interaction)
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      const body = (await response.json()) as Record<string, string>
      expect(body).toEqual({
        interaction_id: interaction.id,
        application_id: applicationId,
        token_expires_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      })
      expect(JSON.stringify(body)).not.toContain(interaction.token)
      expect(Date.parse(body.token_expires_at)).toBeLessThanOrEqual(Date.now())

      expect(await status(send(hook(interaction, '/messages/@original')))).toBe(
        401
      )
      expect(await status(send(hook(other), 'POST', { content: 'x' }))).toBe(
        204
      )
    })

    it('is idempotent and keeps the first expiry instant', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const first = (await json(expire(interaction))) as {
        token_expires_at: string
      }
      vi.setSystemTime(Date.now() + 60_000)
      const second = await expire(interaction)
      expect(second.status).toBe(200)
      expect(await second.json()).toMatchObject({
        token_expires_at: first.token_expires_at,
      })
    })

    it('does not extend a token that already expired naturally', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const fresh = await start()
      vi.setSystemTime(Date.now() + INTERACTION_TOKEN_TTL_MS + 60_000)
      const body = (await json(expire(fresh))) as {
        token_expires_at: string
      }
      expect(Date.parse(body.token_expires_at)).toBe(Date.now() - 60_000)
    })

    it('requires application_id and the interaction token', async () => {
      for (const response of [
        await expire(interaction, {}),
        await expire(interaction, null),
        await expire(interaction, { application_id: 5 }),
        await expire(interaction, { application_id: applicationId }, ''),
        await expire(interaction, { application_id: applicationId }, null),
      ]) {
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          message: '400: Bad Request',
          code: 0,
        })
      }
      expect(await status(send(hook(interaction, '/messages/@original')))).toBe(
        200
      )
    })

    it('returns 404 for unknown interactions and mismatched application or token', async () => {
      const notFound = { message: '404: Not Found', code: 0 }
      const unknown = await send(
        '/_test/interactions/999/expire-token',
        'POST',
        { application_id: applicationId },
        { 'X-Interaction-Token': interaction.token }
      )
      const otherApp = await expire(interaction, { application_id: '222' })
      const wrongToken = await expire(
        interaction,
        { application_id: applicationId },
        'nope'
      )
      for (const response of [unknown, otherApp, wrongToken]) {
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual(notFound)
      }
      expect(await status(send(hook(interaction, '/messages/@original')))).toBe(
        200
      )
    })

    it('does not affect other applications sharing nothing but the route', async () => {
      const otherBotToken = seedBot(
        context.db,
        'Bot other-bot',
        '222222222222222222'
      )
      const otherGuild = seedGuild(context.db, otherBotToken)
      const otherChannel = seedChannel(context.db, otherGuild)
      const other = createTestUser(context.db, { username: 'Other' }).id
      context.db
        .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
        .run(otherGuild, other)
      createCommand(context.db, '222222222222222222', otherGuild, {
        name: 'ranking',
        type: 1,
      })
      const response = await send('/_test/interactions', 'POST', {
        application_id: '222222222222222222',
        command_name: 'ranking',
        guild_id: otherGuild,
        channel_id: otherChannel,
        user_id: other,
      })
      const foreign = (await response.json()) as Started
      // Another application's interaction cannot be expired with these credentials.
      expect(
        await status(
          send(
            `/_test/interactions/${foreign.id}/expire-token`,
            'POST',
            { application_id: applicationId },
            { 'X-Interaction-Token': foreign.token }
          )
        )
      ).toBe(404)
    })

    it('is removed with the interaction by reset', async () => {
      await expire(interaction)
      const reset = await send('/_test/reset', 'POST', {})
      expect(reset.status).toBe(204)
      expect(await status(expire(interaction))).toBe(404)
    })
  })

  describe('what expiry does not touch', () => {
    it('keeps the original and followup readable through bot channel routes', async () => {
      await expire(interaction)
      for (const prefix of PREFIXES) {
        for (const id of [originalId, followupId]) {
          const response = await send(
            `${prefix}/channels/${channelId}/messages/${id}`,
            'GET',
            undefined,
            { Authorization: botAuth }
          )
          expect(response.status).toBe(200)
        }
      }
      const edit = await send(
        `/api/v10/channels/${channelId}/messages/${followupId}`,
        'PATCH',
        { content: 'bot edit' },
        { Authorization: botAuth }
      )
      expect(edit.status).toBe(200)
      const list = await send(
        `/api/v10/channels/${channelId}/messages`,
        'GET',
        undefined,
        { Authorization: botAuth }
      )
      expect(
        ((await list.json()) as { id: string }[])
          .map((m) => m.id)
          .toSorted((a, b) => a.localeCompare(b))
      ).toEqual([originalId, followupId].toSorted((a, b) => a.localeCompare(b)))
    })

    it('keeps an ephemeral original stored, though only its token could read it', async () => {
      const fresh = await start()
      const callback = await send(
        `/api/v10/interactions/${fresh.id}/${fresh.token}/callback?with_response=true`,
        'POST',
        { type: 4, data: { content: 'secret', flags: 64 } }
      )
      const id = (
        (await callback.json()) as {
          interaction: { response_message_id: string }
        }
      ).interaction.response_message_id
      expect(await status(expire(fresh))).toBe(200)
      expect(
        context.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)
      ).toBeDefined()
    })

    it('does not change the initial callback semantics', async () => {
      const fresh = await start()
      await expire(fresh)
      const response = await send(
        `/api/v10/interactions/${fresh.id}/${fresh.token}/callback`,
        'POST',
        { type: 4, data: { content: 'late' } }
      )
      expect(response.status).toBe(204)
      const observed = await send(
        `/_test/interactions/${fresh.id}/callback?application_id=${applicationId}`,
        'GET',
        undefined,
        { 'X-Interaction-Token': fresh.token }
      )
      expect(await observed.json()).toMatchObject({ responded: true })
    })

    it('still lets users click buttons on messages of an expired interaction', async () => {
      const botMessage = await send(
        `/api/v10/channels/${channelId}/messages`,
        'POST',
        {
          content: 'Appeal your ban',
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 1, label: 'Appeal', custom_id: 'appeal' },
              ],
            },
          ],
        },
        { Authorization: botAuth }
      )
      const messageId = ((await botMessage.json()) as { id: string }).id
      await expire(interaction)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 2 * INTERACTION_TOKEN_TTL_MS)

      const click = await send('/_test/interactions', 'POST', {
        application_id: applicationId,
        type: 3,
        channel_id: channelId,
        message_id: messageId,
        custom_id: 'appeal',
        user_id: user,
      })
      expect(click.status).toBe(201)
      const clicked = (await click.json()) as Started
      expect(clicked.id).not.toBe(interaction.id)
      const reply = await send(hook(clicked), 'POST', { content: 'hello' })
      expect(reply.status).toBe(204)
    })
  })

  describe('ordering with REST faults', () => {
    it('runs an armed fault before the native expiry response', async () => {
      const armed = await send('/_test/rest-faults', 'POST', {
        method: 'GET',
        path: `/interactions/${interaction.id}/messages/@original`,
        status: 503,
        code: 0,
        message: 'Injected failure',
      })
      expect(armed.status).toBe(201)
      await expire(interaction)
      const path = hook(interaction, '/messages/@original')
      const faulted = await send(path)
      expect(faulted.status).toBe(503)
      // Once the fault is exhausted the native expiry response applies.
      const native = await send(path)
      expect(native.status).toBe(401)
      expect(await native.json()).toEqual(INVALID_WEBHOOK_TOKEN)
    })
  })

  it('does not treat unknown tokens as expired', async () => {
    await expire(interaction)
    const unknown = await send(
      `/webhooks/${applicationId}/unknown-token/messages/@original`
    )
    expect(unknown.status).toBe(404)
    const unknownPost = await send(
      `/webhooks/${applicationId}/unknown-token`,
      'POST',
      { content: 'x' }
    )
    expect(unknownPost.status).toBe(404)
    expect(await json(unknownPost)).toMatchObject({ code: 10_015 })
  })

  it('leaves real webhook tokens working after an interaction expired', async () => {
    const { webhookId, webhookToken } = seedWebhook(
      context.db,
      channelId,
      guildId
    )
    await expire(interaction)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * INTERACTION_TOKEN_TTL_MS)

    const executed = await send(
      `/webhooks/${webhookId}/${webhookToken}?wait=true`,
      'POST',
      { content: 'from webhook' }
    )
    expect(executed.status).toBe(200)
    const messageId = ((await executed.json()) as { id: string }).id
    const messagePath = `/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`
    expect(await status(send(messagePath))).toBe(200)
    expect(
      await status(send(messagePath, 'PATCH', { content: 'edited' }))
    ).toBe(200)
    expect(await status(send(messagePath, 'DELETE'))).toBe(204)
  })

  it('treats an unparsable created_at without a recorded expiry as expired', async () => {
    context.db
      .prepare(
        "UPDATE interactions SET token_expires_at = NULL, created_at = 'garbage' WHERE id = ?"
      )
      .run(interaction.id)
    expect(await status(send(hook(interaction, '/messages/@original')))).toBe(
      401
    )
    const response = await expire(interaction)
    expect(response.status).toBe(200)
  })
})
