/**
 * Channel messages API routing
 *
 * Implements message CRUD and bulk-delete for /channels/:channelId/messages.
 */

import { Hono } from 'hono'
import type { Database } from '../db'
import { DiscordErrorCode, discordError, validationError } from '../errors'
import { generateSnowflake } from '../snowflake'
import {
  MAX_FILE_SIZE,
  withMessageAttachments,
  type AttachmentInput,
} from '../services/attachments'
import {
  isAttachmentFilename,
  isAttachmentContentType,
} from '../validators/attachment'
import { resolveMessageStickers } from '../services/message-stickers'
import {
  validateMessageStickers,
  unusableMessageStickersError,
} from '../validators/message-stickers'
import { getChannel } from '../services/channels'
import { getMessageSendError } from '../services/message-permissions'
import {
  getMessage,
  getMessages,
  createMessage,
  updateMessage,
  deleteMessage,
  bulkDeleteMessages,
  isTooOldForBulkDelete,
  MESSAGE_FLAGS,
} from '../services/messages'
import {
  validateMessageCreate,
  isEmptyMessage,
  validatePollCreate,
  type MessageCreatePayload,
  type PollCreatePayloadField,
} from '../validators/message'
import { parseBulkDeleteMessages } from '../validators/bulk-delete'
import { createPoll, getPollForMessage } from '../services/polls'
import type { AppEnv, BotRecord } from '../middleware/auth'
import {
  requireEntity,
  parseLimitQuery,
  parseJsonBody,
} from '../lib/route-helpers'

/**
 * Creates the channel messages API routes.
 * @param db - Database
 * @param baseUrl - Base URL
 * @param uploadPath - Directory attachments are saved to
 * @returns Hono router instance
 */
export function createChannelMessageRoutes(
  db: Database,
  baseUrl: string,
  uploadPath = '/data/uploads'
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // GET /channels/:channelId/messages — List messages
  app.get('/channels/:channelId/messages', (c) => {
    const { channelId } = c.req.param()
    const channel = requireEntity(
      c,
      getChannel(db, channelId),
      DiscordErrorCode.UNKNOWN_CHANNEL,
      'Unknown Channel'
    )
    if (channel instanceof Response) return channel

    const limit = parseLimitQuery(c, 50, 100)
    const before = c.req.query('before')
    const after = c.req.query('after')
    const around = c.req.query('around')

    const messages = getMessages(
      db,
      channelId,
      { limit, before, after, around },
      baseUrl
    )
    return c.json(messages)
  })

  // GET /channels/:channelId/messages/:messageId — Retrieve a specific message
  app.get('/channels/:channelId/messages/:messageId', (c) => {
    const { channelId, messageId } = c.req.param()
    const message = getMessage(db, messageId, baseUrl)
    if (
      message &&
      (message.channel_id !== channelId ||
        message.flags & MESSAGE_FLAGS.EPHEMERAL)
    ) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_MESSAGE,
        'Unknown Message',
        404
      )
      return c.json(err.body, 404)
    }
    const msg = requireEntity(
      c,
      message,
      DiscordErrorCode.UNKNOWN_MESSAGE,
      'Unknown Message'
    )
    return msg instanceof Response ? msg : c.json(msg)
  })

  // POST /channels/:channelId/messages — Send a message
  app.post('/channels/:channelId/messages', async (c) => {
    const { channelId } = c.req.param()

    const channel = requireEntity(
      c,
      getChannel(db, channelId),
      DiscordErrorCode.UNKNOWN_CHANNEL,
      'Unknown Channel'
    )
    if (channel instanceof Response) return channel

    let bot = c.get('bot')
    // If auth middleware wasn't applied (e.g. in unit tests), fall back to a
    // direct token lookup so the author can still be resolved.
    if (!bot) {
      const authHeader = c.req.header('Authorization')
      if (authHeader) {
        bot = db
          .prepare('SELECT * FROM bots WHERE token = ?')
          .get(authHeader) as BotRecord | undefined
      }
    }
    const authorId = bot?.user_id ?? '000000000000000000'
    const authorToken = bot?.token ?? ''

    const accessError = getMessageSendError(db, channelId, authorId)
    if (accessError) return c.json(accessError.body, accessError.status)

    const contentType = c.req.header('content-type') ?? ''
    let payload: Record<string, unknown>
    const attachmentFiles: AttachmentInput[] = []

    if (contentType.includes('multipart/form-data')) {
      try {
        const formData = await c.req.formData()
        const payloadJson = formData.get('payload_json')
        if (payloadJson !== null && typeof payloadJson !== 'string')
          return c.json({ message: '400: Bad Request', code: 0 }, 400)
        const parsed: unknown = payloadJson ? JSON.parse(payloadJson) : {}
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        )
          return c.json({ message: '400: Bad Request', code: 0 }, 400)
        payload = parsed as Record<string, unknown>
        const indices = new Set<number>()
        for (const [key, file] of formData) {
          if (key === 'payload_json') continue
          const match = /^files\[(\d+)\]$/.exec(key)
          const index = match ? Number(match[1]) : -1
          if (
            !match ||
            !(file instanceof File) ||
            index >= 10 ||
            indices.has(index) ||
            !isAttachmentFilename(file.name) ||
            !isAttachmentContentType(file.type || 'application/octet-stream')
          )
            return c.json({ message: '400: Bad Request', code: 0 }, 400)
          indices.add(index)
          if (file.size > MAX_FILE_SIZE) {
            return c.json(
              discordError(
                DiscordErrorCode.FILE_TOO_LARGE,
                'File uploaded exceeds the maximum size',
                400
              ).body,
              400
            )
          }
          attachmentFiles.push({
            filename: file.name,
            data: await file.arrayBuffer(),
            contentType: file.type || 'application/octet-stream',
          })
        }
      } catch {
        return c.json({ message: '400: Bad Request', code: 0 }, 400)
      }
    } else {
      payload = await parseJsonBody(c)
    }
    if (
      payload.content !== undefined &&
      payload.content !== null &&
      typeof payload.content !== 'string'
    )
      return c.json({ message: '400: Bad Request', code: 0 }, 400)

    const hasAttachments = attachmentFiles.length > 0
    const hasPoll = payload.poll !== undefined && payload.poll !== null

    const stickerErrors = validateMessageStickers(payload)
    if (Object.keys(stickerErrors).length > 0)
      return c.json(validationError(stickerErrors).body, 400)
    const stickerItems = resolveMessageStickers(
      db,
      channelId,
      (payload.sticker_ids ?? []) as string[]
    )
    if (!stickerItems)
      return c.json(validationError(unusableMessageStickersError()).body, 400)

    const errors = validateMessageCreate(payload, hasAttachments)
    if (hasPoll) {
      Object.assign(
        errors,
        validatePollCreate(payload.poll as PollCreatePayloadField)
      )
    }
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    if (
      !hasPoll &&
      isEmptyMessage(payload, hasAttachments, stickerItems.length > 0)
    ) {
      const err = discordError(
        DiscordErrorCode.EMPTY_MESSAGE,
        'Cannot send an empty message',
        400
      )
      return c.json(err.body, 400)
    }

    const permissionError = getMessageSendError(
      db,
      channelId,
      authorId,
      payload
    )
    if (permissionError)
      return c.json(permissionError.body, permissionError.status)

    const messageId = generateSnowflake()

    const responseMessage = await withMessageAttachments(
      db,
      uploadPath,
      channelId,
      messageId,
      authorToken,
      attachmentFiles,
      (persist) => {
        // Attachment preparation can await disk writes. Re-read membership,
        // roles and overwrites before the synchronous message transaction.
        const currentError = getMessageSendError(
          db,
          channelId,
          authorId,
          payload
        )
        return currentError
          ? c.json(currentError.body, currentError.status)
          : createMessage(
              db,
              {
                messageId,
                channelId,
                authorId,
                authorToken,
                content: payload.content as string | undefined,
                tts: payload.tts as boolean | undefined,
                embeds: payload.embeds as unknown[] | undefined,
                messageReference: payload.message_reference as
                  { message_id?: string } | undefined,
                flags: payload.flags as number | undefined,
                stickerItems,
              },
              baseUrl,
              () => {
                persist()
                if (!hasPoll) return
                const pollField = payload.poll as PollCreatePayloadField
                createPoll(db, messageId, {
                  question: pollField.question.text,
                  answers: pollField.answers.map((a) => ({
                    text: a.poll_media.text,
                    emoji: a.poll_media.emoji ?? undefined,
                  })),
                  allowMultiselect: pollField.allow_multiselect,
                  durationHours: pollField.duration,
                })
              }
            )
      }
    )
    if (responseMessage instanceof Response) return responseMessage
    return hasPoll
      ? c.json({
          ...responseMessage,
          poll: getPollForMessage(db, messageId),
        })
      : c.json(responseMessage)
  })

  // PATCH /channels/:channelId/messages/:messageId — Edit a message
  app.patch('/channels/:channelId/messages/:messageId', async (c) => {
    const { channelId, messageId } = c.req.param()
    const bot = c.get('bot')

    const existing = requireEntity(
      c,
      getMessage(db, messageId, baseUrl),
      DiscordErrorCode.UNKNOWN_MESSAGE,
      'Unknown Message'
    )
    if (existing instanceof Response) return existing
    if (
      existing.channel_id !== channelId ||
      existing.flags & MESSAGE_FLAGS.EPHEMERAL
    ) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_MESSAGE,
        'Unknown Message',
        404
      )
      return c.json(err.body, 404)
    }

    if (bot && existing.author.id !== bot.user_id) {
      const err = discordError(
        DiscordErrorCode.CANNOT_EDIT_OTHER,
        'Cannot edit a message authored by another user',
        403
      )
      return c.json(err.body, 403)
    }

    const payload = (await parseJsonBody(c)) as Pick<
      MessageCreatePayload,
      'content' | 'embeds'
    >

    const errors = validateMessageCreate(payload)
    if (Object.keys(errors).length > 0) {
      return c.json(validationError(errors).body, 400)
    }

    const updated = updateMessage(db, messageId, payload, baseUrl)
    return c.json(updated)
  })

  // DELETE /channels/:channelId/messages/:messageId — Delete a message
  // Unlike PATCH (which enforces authorship), deletion is intentionally not
  // ownership-guarded: the mock does not model MANAGE_MESSAGES, and real
  // Discord permits deleting other users' messages with that permission.
  app.delete('/channels/:channelId/messages/:messageId', (c) => {
    const { channelId, messageId } = c.req.param()
    const deleted = deleteMessage(db, messageId, channelId)
    if (!deleted) {
      const err = discordError(
        DiscordErrorCode.UNKNOWN_MESSAGE,
        'Unknown Message',
        404
      )
      return c.json(err.body, 404)
    }
    return c.body(null, 204)
  })

  // POST /channels/:channelId/messages/bulk-delete — Bulk delete messages
  app.post('/channels/:channelId/messages/bulk-delete', async (c) => {
    const { channelId } = c.req.param()
    const channel = requireEntity(
      c,
      getChannel(db, channelId),
      DiscordErrorCode.UNKNOWN_CHANNEL,
      'Unknown Channel'
    )
    if (channel instanceof Response) return channel
    if (!channel.guild_id) {
      return c.json(
        discordError(
          DiscordErrorCode.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE,
          'Cannot execute action on this channel type',
          400
        ).body,
        400
      )
    }
    const messages = parseBulkDeleteMessages(await c.req.text())
    const uniqueMessages = new Set(messages)
    if (uniqueMessages.size !== messages?.length) {
      return c.json(
        validationError({
          messages: {
            _errors: [
              {
                code: 'BASE_TYPE_BAD_TYPE',
                message: 'Must be an array of unique Snowflake IDs.',
              },
            ],
          },
        }).body,
        400
      )
    }

    if (messages.length < 2 || messages.length > 100) {
      const err = discordError(
        DiscordErrorCode.INVALID_BULK_DELETE,
        'Provided too many messages to delete',
        400
      )
      return c.json(err.body, 400)
    }

    for (const msgId of messages) {
      if (isTooOldForBulkDelete(db, msgId)) {
        const err = discordError(
          DiscordErrorCode.MESSAGE_TOO_OLD,
          'A message provided was too old to bulk delete',
          400
        )
        return c.json(err.body, 400)
      }
    }

    bulkDeleteMessages(db, channelId, messages)

    return c.body(null, 204)
  })

  // POST /channels/:channelId/messages/:messageId/crosspost — Crosspost an announcement channel message
  app.post('/channels/:channelId/messages/:messageId/crosspost', (c) => {
    const { channelId, messageId } = c.req.param()

    const channel = requireEntity(
      c,
      getChannel(db, channelId),
      DiscordErrorCode.UNKNOWN_CHANNEL,
      'Unknown Channel'
    )
    if (channel instanceof Response) return channel

    const existing = requireEntity(
      c,
      getMessage(db, messageId, baseUrl),
      DiscordErrorCode.UNKNOWN_MESSAGE,
      'Unknown Message'
    )
    if (existing instanceof Response) return existing
    if (existing.flags & MESSAGE_FLAGS.EPHEMERAL) {
      return c.json(
        discordError(DiscordErrorCode.UNKNOWN_MESSAGE, 'Unknown Message', 404)
          .body,
        404
      )
    }

    if (channel.type !== 5) {
      const err = discordError(
        DiscordErrorCode.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE,
        'Cannot execute action on this channel type',
        400
      )
      return c.json(err.body, 400)
    }

    const updated = updateMessage(
      db,
      messageId,
      { flags: existing.flags | MESSAGE_FLAGS.CROSSPOSTED },
      baseUrl
    )
    return c.json(updated)
  })

  return app
}
