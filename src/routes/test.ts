/**
 * Test control API routing
 *
 * Implements the /_test/* test-only endpoints.
 */

import { Hono } from 'hono'
import { generateSnowflake } from '../snowflake'
import { decodeTestAttachments } from '../validators/attachment'
import {
  withMessageAttachments,
  cleanupAttachmentFiles,
} from '../services/attachments'
import { createAuditLogEntry } from '../services/audit-logs'
import {
  isAuditSnowflake,
  validateAuditLogFixture,
} from '../validators/audit-log'
import type { Database } from '../db'
import { validateInteractionLocale } from '../validators/interaction'
import {
  setupTestEnvironment,
  deleteTestSetup,
  resetTestData,
  getTestMessages,
  createTestUser,
  joinTestGuildMember,
  injectTestMessage,
  editTestMessage,
  createTestInteraction,
} from '../services/test-control'
import type {
  SetupRequest,
  TestInteractionRequest,
} from '../services/test-control'
import { getChannelWebhooks } from '../services/webhooks'
import { getInteractionCallbackObservation } from '../services/interactions'
import { injectPollVote } from '../services/polls'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import { validateGuildMemberUpdate } from '../validators/guild'
import { validateRestFault } from '../validators/rest-fault'
import { validateMessageCreate } from '../validators/message'
import {
  validateMessageStickers,
  unusableMessageStickersError,
} from '../validators/message-stickers'
import { requiredError, typeError } from '../validators/common'
import { parseJsonBody } from '../lib/route-helpers'
import {
  createRestFault,
  getRestFault,
  deleteRestFault,
} from '../services/rest-faults'

/**
 * Creates the test control API routes.
 * @param db - Database
 * @param baseUrl - Base URL (used for injected message attachment URL generation)
 * @param uploadPath - Directory used for fixture uploads and lifecycle cleanup
 * @returns Hono router instance
 */
export function createTestRoutes(
  db: Database,
  baseUrl: string,
  uploadPath = '/data/uploads'
): Hono {
  const app = new Hono()

  app.post('/_test/guilds/:guildId/audit-logs', async (c) => {
    const guildId = c.req.param('guildId')
    const payload = validateAuditLogFixture(
      await c.req.json<unknown>().catch(() => undefined)
    )
    if (!payload || guildId === '0' || !isAuditSnowflake(guildId)) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    const result = createAuditLogEntry(db, guildId, payload)
    if (result === 'INVALID_INPUT')
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    if (result === 'CONFLICT')
      return c.json({ message: '409: Conflict', code: 0 }, 409)
    if (result === 'UNKNOWN_GUILD')
      return c.json(
        discordError(DiscordErrorCode.UNKNOWN_GUILD, 'Unknown Guild', 404).body,
        404
      )
    if (result === 'UNKNOWN_USER')
      return c.json(
        discordError(DiscordErrorCode.UNKNOWN_USER, 'Unknown User', 404).body,
        404
      )
    return result === 'UNKNOWN_CHANNEL'
      ? c.json(
          discordError(DiscordErrorCode.UNKNOWN_CHANNEL, 'Unknown Channel', 404)
            .body,
          404
        )
      : c.json(result, 201)
  })

  app.post('/_test/rest-faults', async (c) => {
    const parsed: unknown = await c.req.json().catch(() => undefined)
    const payload = validateRestFault(parsed)
    if (!payload) return c.json({ message: '400: Bad Request', code: 0 }, 400)
    const result = createRestFault(db, payload)
    if (result === 'UNKNOWN_SCOPE')
      return c.json({ message: '404: Not Found', code: 0 }, 404)
    return result === 'CONFLICT'
      ? c.json({ message: '409: Conflict', code: 0 }, 409)
      : c.json(result, 201)
  })

  app.get('/_test/rest-faults/:id', (c) => {
    const fault = getRestFault(db, c.req.param('id'))
    return fault
      ? c.json(fault)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })

  app.delete('/_test/rest-faults/:id', (c) => {
    return deleteRestFault(db, c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })

  // POST /_test/setup — Set up Bot, Guild, and Channel
  app.post('/_test/setup', async (c) => {
    const payload = await c.req.json<SetupRequest>()

    if (
      payload.user?.global_name !== undefined &&
      payload.user.global_name !== null &&
      typeof payload.user.global_name !== 'string'
    ) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }

    try {
      const result = setupTestEnvironment(db, payload)
      return c.json(result, 201)
    } catch (err) {
      if (err instanceof Error && err.message === 'CONFLICT') {
        return c.json({ message: '409: Conflict', code: 0 }, 409)
      }
      if (err instanceof Error && err.message === 'INVALID_OWNER_ID') {
        return c.json(
          { message: 'owner_id must be a non-empty user ID', code: 0 },
          400
        )
      }
      if (err instanceof Error && err.message === 'UNKNOWN_USER') {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_USER, 'Unknown User', 404).body,
          404
        )
      }
      if (err instanceof Error && err.message === 'BOT_OWNER') {
        return c.json(
          { message: 'Guild owner must not be a bot', code: 0 },
          400
        )
      }
      throw err
    }
  })

  // DELETE /_test/setup/:token (:token is in "Bot xxx" format)
  app.delete('/_test/setup/*', (c) => {
    // Decode the path parameter manually (Bot tokens may contain spaces)
    const token = decodeURIComponent(c.req.path.replace('/_test/setup/', ''))
    cleanupAttachmentFiles(db, uploadPath, { setupToken: token })
    const deleted = deleteTestSetup(db, token)
    return deleted
      ? c.body(null, 204)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })

  // POST /_test/users — Register a non-bot user for testing
  app.post('/_test/users', async (c) => {
    const payload = await c.req.json<{
      id?: string
      username?: string
      discriminator?: string
      global_name?: string | null
    }>()

    if (
      !payload.username ||
      (payload.global_name !== undefined &&
        payload.global_name !== null &&
        typeof payload.global_name !== 'string')
    ) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }

    try {
      const result = createTestUser(db, {
        id: payload.id,
        username: payload.username,
        discriminator: payload.discriminator,
        global_name: payload.global_name,
      })
      return c.json(result, 201)
    } catch (err) {
      if (err instanceof Error && err.message === 'CONFLICT') {
        return c.json({ message: '409: Conflict', code: 0 }, 409)
      }
      throw err
    }
  })

  // POST /_test/guilds/:guildId/members/:userId — Join an existing non-bot user
  app.post('/_test/guilds/:guildId/members/:userId', async (c) => {
    const { guildId, userId } = c.req.param()
    const body = await c.req.text()
    let parsed: unknown
    try {
      parsed = body.trim() ? JSON.parse(body) : {}
    } catch {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    const payload = parsed as Record<string, unknown>
    const errors = validateGuildMemberUpdate(payload)
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    const result = joinTestGuildMember(
      db,
      guildId,
      userId,
      typeof payload.nick === 'string' ? payload.nick : null
    )
    switch (result) {
      case 'UNKNOWN_GUILD': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_GUILD, 'Unknown Guild', 404)
            .body,
          404
        )
      }
      case 'UNKNOWN_USER': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_USER, 'Unknown User', 404).body,
          404
        )
      }
      case 'BOT_USER': {
        return c.json({ message: 'User must not be a bot', code: 0 }, 400)
      }
      case 'CONFLICT': {
        return c.json({ message: '409: Conflict', code: 0 }, 409)
      }
      default: {
        return c.json(result, 201)
      }
    }
  })

  // POST /_test/reset — Reset test data (messages, etc.)
  app.post('/_test/reset', async (c) => {
    let token: string | undefined
    try {
      const body = await c.req.json<{ token?: string }>()
      token = body.token
    } catch {
      // Reset everything when no body is provided
    }

    cleanupAttachmentFiles(db, uploadPath, { token })
    resetTestData(db, token)
    return c.body(null, 204)
  })

  // GET /_test/messages/:channelId — List a channel's messages for testing
  app.get('/_test/messages/:channelId', (c) => {
    const { channelId } = c.req.param()
    const messages = getTestMessages(db, channelId)
    return c.json({ messages })
  })

  // GET /_test/webhooks/:channelId — List a channel's webhooks for testing
  app.get('/_test/webhooks/:channelId', (c) => {
    const { channelId } = c.req.param()
    const webhooks = getChannelWebhooks(db, channelId)
    return c.json({ webhooks })
  })

  // POST /_test/channels/:channelId/messages — Inject a message authored by
  // a pre-registered user (see POST /_test/users)
  app.post('/_test/channels/:channelId/messages', async (c) => {
    const { channelId } = c.req.param()
    const parsed: unknown = await c.req.json().catch(() => undefined)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    const payload = parsed as {
      id?: string
      content?: string
      sticker_ids?: string[] | null
      sticker_items?: unknown
      author?: { id?: string }
      remove_after_create?: boolean
      attachments?: unknown
    }

    const files = decodeTestAttachments(payload.attachments)
    if (
      files === null ||
      (payload.content !== undefined && typeof payload.content !== 'string') ||
      typeof payload.author?.id !== 'string' ||
      payload.author.id.length === 0 ||
      (payload.id !== undefined &&
        (typeof payload.id !== 'string' || !/^\d{1,20}$/.test(payload.id))) ||
      (payload.remove_after_create !== undefined &&
        typeof payload.remove_after_create !== 'boolean')
    ) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }

    const errors = {
      ...validateMessageCreate({ content: payload.content }),
      ...validateMessageStickers({
        sticker_ids: payload.sticker_ids,
        sticker_items: payload.sticker_items,
      }),
    }
    if (Object.keys(errors).length > 0)
      return c.json(validationError(errors).body, 400)
    if (!payload.content && files.length === 0 && !payload.sticker_ids?.length)
      return c.json({ message: '400: Bad Request', code: 0 }, 400)

    const authorId = payload.author.id
    const messageId = payload.id ?? generateSnowflake()
    const result = await withMessageAttachments(
      db,
      uploadPath,
      channelId,
      messageId,
      '',
      files,
      (persist) =>
        injectTestMessage(
          db,
          channelId,
          {
            id: messageId,
            content: payload.content,
            sticker_ids: payload.sticker_ids,
            author: { id: authorId },
            remove_after_create: payload.remove_after_create,
          },
          baseUrl,
          persist
        )
    )

    if (result === 'CONFLICT')
      return c.json({ message: '409: Conflict', code: 0 }, 409)
    if (result === 'INVALID_STICKERS')
      return c.json(validationError(unusableMessageStickersError()).body, 400)
    return result === 'UNKNOWN_CHANNEL' || result === 'UNKNOWN_USER'
      ? c.json({ message: '404: Not Found', code: 0 }, 404)
      : c.json(result, 201)
  })

  // PATCH /_test/channels/:channelId/messages/:messageId — Edit human content
  app.patch('/_test/channels/:channelId/messages/:messageId', async (c) => {
    const { channelId, messageId } = c.req.param()
    const payload = await parseJsonBody(c)
    if (typeof payload.content !== 'string') {
      return c.json(
        validationError({
          content: {
            _errors: [
              payload.content === undefined
                ? requiredError()
                : typeError('string'),
            ],
          },
        }).body,
        400
      )
    }
    const errors = validateMessageCreate({ content: payload.content })
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    const result = editTestMessage(
      db,
      channelId,
      messageId,
      payload.content,
      baseUrl
    )
    switch (result) {
      case 'UNKNOWN_CHANNEL': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_CHANNEL, 'Unknown Channel', 404)
            .body,
          404
        )
      }
      case 'UNKNOWN_MESSAGE': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_MESSAGE, 'Unknown Message', 404)
            .body,
          404
        )
      }
      case 'BOT_AUTHOR': {
        return c.json(
          { message: 'Message author must be a non-bot user', code: 0 },
          400
        )
      }
      default: {
        return c.json(result)
      }
    }
  })

  // GET /_test/interactions/:interactionId/callback — Read accepted callback state.
  app.get('/_test/interactions/:interactionId/callback', (c) => {
    const applicationId = c.req.query('application_id')
    const token = c.req.header('X-Interaction-Token')
    if (!applicationId || !token) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    const observation = getInteractionCallbackObservation(
      db,
      c.req.param('interactionId'),
      applicationId,
      token
    )
    c.header('Cache-Control', 'no-store')
    return observation
      ? c.json(observation)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })

  // POST /_test/interactions — Simulate an interaction against a registered
  // command, without a real Discord client.
  app.post('/_test/interactions', async (c) => {
    const body = await c.req.json<TestInteractionRequest>()
    const errors = validateInteractionLocale(body.locale)
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }
    const result = createTestInteraction(db, body)
    return result.ok
      ? c.json(result.interaction, 201)
      : c.json({ message: '404: Not Found', code: 0 }, 404)
  })

  // POST /_test/polls/:messageId/votes — Inject a poll vote for testing
  app.post('/_test/polls/:messageId/votes', async (c) => {
    const { messageId } = c.req.param()
    const payload = await c.req.json<{
      answer_id?: number
      user_id?: string
    }>()

    if (payload.answer_id === undefined || !payload.user_id) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }

    const result = injectPollVote(
      db,
      messageId,
      payload.answer_id,
      payload.user_id
    )
    return result === 'UNKNOWN_MESSAGE' || result === 'UNKNOWN_ANSWER'
      ? c.json({ message: '404: Not Found', code: 0 }, 404)
      : c.body(null, 204)
  })

  return app
}
