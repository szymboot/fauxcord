/**
 * Interaction operations service
 *
 * Persists interactions, converts them into Discord-shaped response
 * objects, dispatches INTERACTION_CREATE, resolves followup-message
 * targets, and handles the callback (initial response) endpoint.
 */

import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import { gatewayBus } from '../gateway/bus'
import { getGuildMember } from './guild-members'
import { getUser } from './users'
import { createMessage, MESSAGE_FLAGS, type MessageObject } from './messages'

/** Interaction object for API responses and Gateway dispatch */
export interface InteractionObject {
  id: string
  application_id: string
  type: number
  locale?: string
  data?: Record<string, unknown>
  guild_id?: string
  channel_id?: string
  member?: Record<string, unknown>
  user?: Record<string, unknown>
  token: string
  version: number
}

/** Interaction record type retrieved from the DB */
interface InteractionRow {
  id: string
  application_id: string
  token: string
  type: number
  locale: string
  guild_id: string | null
  channel_id: string | null
  command_id: string | null
  data: string
  user_id: string
  member_json: string | null
  responded: number
  initial_response_message_id: string | null
  created_at: string
}

/**
 * Converts a DB interaction record into the API response / Gateway payload
 * format. Re-fetches the command's name/type from `application_commands`
 * (when `command_id` is set) so `data` always reflects the current command
 * registration rather than a stale snapshot.
 * @param db - Database
 * @param row - DB record
 * @returns Interaction object
 */
function toInteractionObject(
  db: Database,
  row: InteractionRow
): InteractionObject {
  const storedData = JSON.parse(row.data) as Record<string, unknown>
  let data: Record<string, unknown> | undefined

  if (row.command_id) {
    const cmd = db
      .prepare('SELECT name, type FROM application_commands WHERE id = ?')
      .get(row.command_id) as { name: string; type: number } | undefined
    data = {
      id: row.command_id,
      name: cmd?.name ?? '',
      type: cmd?.type ?? 1,
      ...storedData,
    }
  } else if (Object.keys(storedData).length > 0) {
    data = storedData
  }

  const member = row.guild_id
    ? getGuildMember(db, row.guild_id, row.user_id)
    : null
  const user = row.guild_id ? null : getUser(db, row.user_id)

  const result: InteractionObject = {
    id: row.id,
    application_id: row.application_id,
    type: row.type,
    token: row.token,
    version: 1,
    ...(row.type !== 1 && { locale: row.locale }),
    ...(data && { data }),
    ...(row.channel_id && { channel_id: row.channel_id }),
    ...(row.guild_id && { guild_id: row.guild_id }),
    ...(member && { member: member as unknown as Record<string, unknown> }),
    ...(user && { user: user as unknown as Record<string, unknown> }),
  }

  return result
}

/** Parameters used to create a new interaction */
export interface CreateInteractionParams {
  interactionId: string
  applicationId: string
  token: string
  type: number
  /** Invoking user's Discord locale; defaults to en-US. */
  locale?: string
  guildId?: string
  channelId?: string
  commandId?: string
  data?: Record<string, unknown>
  userId: string
}

/**
 * Inserts a new interaction row and emits `interaction.create` for Gateway
 * dispatch.
 * @param db - Database
 * @param params - Interaction creation parameters
 * @returns The created interaction object
 */
export function createInteraction(
  db: Database,
  params: CreateInteractionParams
): InteractionObject {
  db.prepare(
    `INSERT INTO interactions
       (id, application_id, token, type, locale, guild_id, channel_id, command_id, data, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.interactionId,
    params.applicationId,
    params.token,
    params.type,
    params.locale ?? 'en-US',
    params.guildId ?? null,
    params.channelId ?? null,
    params.commandId ?? null,
    JSON.stringify(params.data ?? {}),
    params.userId
  )

  const row = db
    .prepare('SELECT * FROM interactions WHERE id = ?')
    .get(params.interactionId) as InteractionRow
  const interaction = toInteractionObject(db, row)

  gatewayBus.emit('interaction.create', {
    applicationId: params.applicationId,
    interaction: interaction as unknown as Record<string, unknown>,
  })

  return interaction
}

/**
 * Resolves the channel an interaction's followup messages should target,
 * treating `(application_id, token)` as `(webhook_id, webhook_token)` per
 * Discord's own followup-message convention.
 * @param db - Database
 * @param applicationId - Application ID (used as the pseudo-webhook ID)
 * @param token - Interaction token (used as the pseudo-webhook token)
 * @returns The target channel and the initial response's message ID, or
 * null when no interaction matches
 */
export function getInteractionFollowupTarget(
  db: Database,
  applicationId: string,
  token: string
): { channelId: string; initialResponseMessageId: string | null } | null {
  const row = db
    .prepare(
      'SELECT channel_id, initial_response_message_id FROM interactions WHERE application_id = ? AND token = ?'
    )
    .get(applicationId, token) as
    | { channel_id: string | null; initial_response_message_id: string | null }
    | undefined
  return row?.channel_id
    ? {
        channelId: row.channel_id,
        initialResponseMessageId: row.initial_response_message_id,
      }
    : null
}

/** Callback (initial response) payload for POST .../callback */
export interface InteractionCallbackPayload {
  type: number
  data?: {
    content?: string
    embeds?: unknown[]
    tts?: boolean
    flags?: number
  }
}

/** Result of an interaction callback attempt */
export interface InteractionCallbackResponse {
  interaction: {
    id: string
    type: number
    response_message_id?: string
    response_message_loading?: boolean
    response_message_ephemeral?: boolean
    channel_id?: string
    guild_id?: string
  }
  resource?: {
    type: number
    message: MessageObject
  }
}

/** Result of an interaction callback attempt. */
export type InteractionCallbackResult =
  | { ok: true; response: InteractionCallbackResponse }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_responded' }

/**
 * Handles POST /interactions/:id/:token/callback. Type 4 (CHANNEL_MESSAGE_
 * WITH_SOURCE) creates the original response. Type 5 creates a loading
 * original that can be completed through the webhook edit endpoint.
 * Types 6/7/9 retain this mock's acknowledgement-only behavior.
 * @param db - Database
 * @param interactionId - `:interactionId` route param
 * @param token - `:interactionToken` route param
 * @param payload - Callback request body
 * @param baseUrl - Base URL (for message attachment URLs)
 * @returns Result of the callback attempt
 */
export function handleInteractionCallback(
  db: Database,
  interactionId: string,
  token: string,
  payload: InteractionCallbackPayload,
  baseUrl: string
): InteractionCallbackResult {
  const row = db
    .prepare('SELECT * FROM interactions WHERE id = ? AND token = ?')
    .get(interactionId, token) as InteractionRow | undefined
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.responded === 1) return { ok: false, reason: 'already_responded' }

  const interaction: InteractionCallbackResponse['interaction'] = {
    id: row.id,
    type: row.type,
    ...(row.channel_id && { channel_id: row.channel_id }),
    ...(row.guild_id && { guild_id: row.guild_id }),
  }

  let resource: InteractionCallbackResponse['resource']
  if ((payload.type === 4 || payload.type === 5) && row.channel_id) {
    const channelId = row.channel_id
    const deferred = payload.type === 5
    const messageId = generateSnowflake()
    const flags = deferred
      ? MESSAGE_FLAGS.LOADING |
        ((payload.data?.flags ?? 0) & MESSAGE_FLAGS.EPHEMERAL)
      : (payload.data?.flags ?? 0)
    const command = row.command_id
      ? (db
          .prepare('SELECT type FROM application_commands WHERE id = ?')
          .get(row.command_id) as { type: number } | undefined)
      : undefined
    const data = JSON.parse(row.data) as { type?: number }
    const message = db.transaction(() => {
      // Link before creation so REST hydration and Gateway dispatch both carry
      // the original interaction correlation. Roll back if creation fails.
      db.prepare(
        'UPDATE interactions SET responded = 1, initial_response_message_id = ? WHERE id = ?'
      ).run(messageId, row.id)
      return createMessage(
        db,
        {
          messageId,
          channelId,
          authorId: row.application_id,
          authorToken: 'interaction',
          type:
            row.type === 2
              ? (command?.type ?? data.type ?? 1) === 1
                ? 20
                : 23
              : 0,
          content: deferred ? undefined : payload.data?.content,
          tts: deferred ? undefined : payload.data?.tts,
          embeds: deferred ? undefined : payload.data?.embeds,
          flags,
        },
        baseUrl
      )
    })()
    interaction.response_message_id = messageId
    interaction.response_message_loading = deferred
    interaction.response_message_ephemeral = Boolean(
      flags & MESSAGE_FLAGS.EPHEMERAL
    )
    if (!deferred) resource = { type: 4, message }
  } else {
    db.prepare('UPDATE interactions SET responded = 1 WHERE id = ?').run(row.id)
  }

  return {
    ok: true,
    response: resource ? { interaction, resource } : { interaction },
  }
}
