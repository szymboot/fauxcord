import { afterEach, describe, expect, it } from 'vitest'
import { createContractFixture, createFullTestApp } from './test-helpers'

/** Embedded Discord user returned by REST views. */
interface DisplayNameUser {
  id: string
  global_name: string | null
}

describe('global name serialization across REST user views', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  it.each(['Display Name', null])(
    'returns the stored global_name=%s consistently',
    async (globalName) => {
      const context = createFullTestApp()
      cleanup = context.cleanup
      const fixture = createContractFixture(context.db)
      context.db
        .prepare('UPDATE users SET global_name = ? WHERE id = ?')
        .run(globalName, fixture.userId)
      context.db
        .prepare(
          'INSERT OR IGNORE INTO channel_recipients (channel_id, user_id) VALUES (?, ?)'
        )
        .run(fixture.groupDmChannelId, fixture.userId)
      context.db
        .prepare(
          'INSERT OR IGNORE INTO poll_votes (message_id, answer_id, user_id) VALUES (?, 1, ?)'
        )
        .run(fixture.pollMessageId, fixture.userId)
      const botHeaders = { Authorization: fixture.token }
      const bearerHeaders = { Authorization: `Bearer ${fixture.bearerToken}` }
      const requests = [
        { path: '/api/v10/users/@me', headers: botHeaders, field: undefined },
        {
          path: `/api/v10/users/${fixture.userId}`,
          headers: botHeaders,
          field: undefined,
        },
        {
          path: `/api/v10/channels/${fixture.channelId}/messages/${fixture.messageId}`,
          headers: botHeaders,
          field: 'author',
        },
        {
          path: `/api/v10/applications/${fixture.applicationId}`,
          headers: botHeaders,
          field: 'owner',
        },
        {
          path: `/api/v10/applications/${fixture.applicationId}/emojis/${fixture.applicationEmojiId}`,
          headers: botHeaders,
          field: 'user',
        },
        { path: '/api/v10/oauth2/@me', headers: bearerHeaders, field: 'user' },
        {
          path: `/api/v10/users/@me/guilds/${fixture.guildId}/member`,
          headers: bearerHeaders,
          field: 'user',
        },
        {
          path: `/api/v10/guilds/templates/${fixture.guildTemplateCode}`,
          headers: botHeaders,
          field: 'creator',
        },
      ]
      for (const { path, headers, field } of requests) {
        const response = await context.app.request(path, { headers })
        expect(response.status, path).toBe(200)
        const body = (await response.json()) as DisplayNameUser &
          Record<string, DisplayNameUser>
        const user = field ? body[field] : body
        expect(user, path).toMatchObject({
          id: fixture.userId,
          global_name: globalName,
        })
      }
      const lists = [
        {
          path: `/api/v10/channels/${fixture.groupDmChannelId}`,
          field: 'recipients',
        },
        {
          path: `/api/v10/channels/${fixture.channelId}/messages/${fixture.reactedMessageId}/reactions/${encodeURIComponent('👍')}`,
          field: undefined,
        },
        {
          path: `/api/v10/channels/${fixture.channelId}/polls/${fixture.pollMessageId}/answers/1`,
          field: 'users',
        },
      ]
      for (const { path, field } of lists) {
        const response = await context.app.request(path, {
          headers: botHeaders,
        })
        expect(response.status, path).toBe(200)
        const body = (await response.json()) as DisplayNameUser[] &
          Record<string, DisplayNameUser[]>
        const users = field ? body[field] : body
        expect(
          users.find((user) => user.id === fixture.userId),
          path
        ).toMatchObject({ global_name: globalName })
      }
    }
  )
})
