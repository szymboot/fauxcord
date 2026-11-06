/**
 * Test control route for human-created invites.
 *
 * Implements POST /_test/channels/:channelId/invites and
 * POST /_test/invites/:code/delete.
 */

import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import { createTestInvite } from '../services/test-control'
import type { TestInviteRequest } from '../services/test-control'
import { deleteInviteAsMember } from '../services/invite-deletion'
import {
  validateTestInvite,
  validateTestInviteDelete,
} from '../validators/test-invite'

/**
 * Creates the human-created invite fixture and member deletion routes.
 * @param db - Database
 * @returns Hono router instance
 */
export function createTestInviteRoutes(db: Database): Hono {
  const app = new Hono()

  // POST /_test/channels/:channelId/invites — Create an invite as a human
  app.post('/_test/channels/:channelId/invites', async (c) => {
    const parsed: unknown = await c.req.json().catch(() => undefined)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    const payload = parsed as Record<string, unknown>
    const errors = validateTestInvite(payload)
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    const result = createTestInvite(
      db,
      c.req.param('channelId'),
      payload as unknown as TestInviteRequest
    )
    switch (result) {
      case 'UNKNOWN_CHANNEL': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_CHANNEL, 'Unknown Channel', 404)
            .body,
          404
        )
      }
      case 'NOT_GUILD_CHANNEL': {
        return c.json(
          discordError(
            DiscordErrorCode.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE,
            'Cannot execute action on this channel type',
            400
          ).body,
          400
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
      case 'NOT_MEMBER': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_MEMBER, 'Unknown Member', 404)
            .body,
          404
        )
      }
      default: {
        return c.json(result, 201)
      }
    }
  })

  // POST /_test/invites/:code/delete — Delete an invite as a guild member
  app.post('/_test/invites/:code/delete', async (c) => {
    const parsed: unknown = await c.req.json().catch(() => undefined)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }
    const payload = parsed as Record<string, unknown>
    const errors = validateTestInviteDelete(payload)
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    const result = deleteInviteAsMember(
      db,
      c.req.param('code'),
      payload.actor_id as string,
      payload.reason as string | null | undefined
    )
    switch (result) {
      case 'UNKNOWN_INVITE': {
        return c.json(
          discordError(DiscordErrorCode.UNKNOWN_INVITE, 'Unknown Invite', 404)
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
      case 'MISSING_PERMISSIONS': {
        return c.json(
          discordError(
            DiscordErrorCode.MISSING_PERMISSIONS,
            'Missing Permissions',
            403
          ).body,
          403
        )
      }
      default: {
        return c.json(result)
      }
    }
  })

  return app
}
