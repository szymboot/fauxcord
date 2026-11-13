/**
 * Interaction operations service
 *
 * Persists interactions, converts them into Discord-shaped response
 * objects, dispatches INTERACTION_CREATE, resolves followup-message
 * targets, and handles the callback (initial response) endpoint.
 */

import type { MessageComponents } from '../validators/message-components'
import {
  parseAutocompleteChoices,
  type AutocompleteChoice,
} from '../validators/autocomplete'
import { parseModal, type ModalObject } from '../validators/modal'

import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import { gatewayBus } from '../gateway/bus'
import { getGuildMember } from './guild-members'
import { getUser } from './users'
import { createMessage, MESSAGE_FLAGS, type MessageObject } from './messages'
import {
  findArmedCallbackDeadlineId,
  findInteractionCallbackDeadlineAt,
} from './interaction-callback-deadlines'

/** How long an interaction token stays valid, as documented by Discord. */
export const INTERACTION_TOKEN_TTL_MS = 15 * 60 * 1000

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
  /**
   * The message a component click happened on, as REST returned it when the
   * click was made; also carried by a modal submitted from that click.
   */
  message?: Record<string, unknown>
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
  initial_callback_type: number | null
  initial_response_message_id: string | null
  modal_json: string | null
  choices_json: string | null
  rejected_callback_type: number | null
  message_json: string | null
  token_expires_at: number | null
  created_at_ms: number | null
  deadline_control_id: string | null
  rejected_reason: string | null
  rejected_at: number | null
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
    ...(row.message_json && {
      message: JSON.parse(row.message_json) as Record<string, unknown>,
    }),
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
  /** Message snapshot of a component click, kept for its modal submissions. */
  message?: Record<string, unknown>
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
  const createdAt = Date.now()
  db.prepare(
    `INSERT INTO interactions
       (id, application_id, token, type, locale, guild_id, channel_id, command_id, data, user_id, message_json, token_expires_at, created_at_ms, deadline_control_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    params.userId,
    params.message ? JSON.stringify(params.message) : null,
    createdAt + INTERACTION_TOKEN_TTL_MS,
    createdAt,
    findArmedCallbackDeadlineId(db, {
      application_id: params.applicationId,
      guild_id: params.guildId ?? null,
      channel_id: params.channelId ?? null,
    })
  )

  const row = db
    .prepare('SELECT * FROM interactions WHERE id = ?')
    .get(params.interactionId) as InteractionRow
  const interaction = toInteractionObject(db, row)

  // Only the setup owning the interaction's guild receives it, like other
  // scoped events, so apps sharing a process and bot ID stay isolated.
  const guild = db
    .prepare(
      'SELECT bot_token FROM guilds WHERE id = COALESCE(?, (SELECT guild_id FROM channels WHERE id = ?))'
    )
    .get(params.guildId ?? null, params.channelId ?? null) as
    { bot_token: string } | undefined
  gatewayBus.emit('interaction.create', {
    applicationId: params.applicationId,
    interaction: interaction as unknown as Record<string, unknown>,
    db,
    ...(guild && { token: guild.bot_token }),
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

/**
 * Computes when an interaction's token stops being valid. Rows created
 * before expiry was recorded fall back to 15 minutes after `created_at`
 * (SQLite stores it as UTC without a zone designator); an unparsable
 * `created_at` counts as already expired.
 * @param row - Interaction expiry columns
 * @returns Expiry as epoch milliseconds
 */
function tokenExpiresAt(
  row: Pick<InteractionRow, 'token_expires_at' | 'created_at'>
): number {
  if (row.token_expires_at !== null) return row.token_expires_at
  const expiresAt =
    Date.parse(`${row.created_at.replace(' ', 'T')}Z`) +
    INTERACTION_TOKEN_TTL_MS
  // An unparsable created_at (hand-edited or imported DB) fails closed.
  return Number.isFinite(expiresAt) ? expiresAt : 0
}

/**
 * Reports whether a webhook-style `(application_id, token)` pair names an
 * interaction whose 15-minute token has expired (naturally or through test
 * control). Unknown pairs are not expired: they are simply not interactions.
 * @param db - Database
 * @param applicationId - Application ID (used as the pseudo-webhook ID)
 * @param token - Interaction token (used as the pseudo-webhook token)
 * @returns True only for a known interaction whose token expired
 */
export function isInteractionTokenExpired(
  db: Database,
  applicationId: string,
  token: string
): boolean {
  const row = db
    .prepare(
      'SELECT token_expires_at, created_at FROM interactions WHERE application_id = ? AND token = ?'
    )
    .get(applicationId, token) as
    Pick<InteractionRow, 'token_expires_at' | 'created_at'> | undefined
  return row !== undefined && tokenExpiresAt(row) <= Date.now()
}

/** Result of expiring an interaction token through test control. */
export interface ExpireInteractionTokenResult {
  interaction_id: string
  application_id: string
  /** ISO 8601 instant the token stopped (or will stop) being valid. */
  token_expires_at: string
}

/**
 * Expires one interaction's token immediately. Idempotent: a token that is
 * already expired keeps its earlier expiry instant. Only the token is
 * affected; messages the interaction produced stay.
 * @param db - Database
 * @param interactionId - Exact interaction ID
 * @param applicationId - Exact application ID owning the interaction
 * @param token - Interaction token credential
 * @returns The recorded expiry, or null for unknown or mismatched credentials
 */
export function expireInteractionToken(
  db: Database,
  interactionId: string,
  applicationId: string,
  token: string
): ExpireInteractionTokenResult | null {
  const row = db
    .prepare(
      'SELECT token_expires_at, created_at FROM interactions WHERE id = ? AND application_id = ? AND token = ?'
    )
    .get(interactionId, applicationId, token) as
    Pick<InteractionRow, 'token_expires_at' | 'created_at'> | undefined
  if (!row) return null
  const expiresAt = Math.min(tokenExpiresAt(row), Date.now())
  db.prepare('UPDATE interactions SET token_expires_at = ? WHERE id = ?').run(
    expiresAt,
    interactionId
  )
  return {
    interaction_id: interactionId,
    application_id: applicationId,
    token_expires_at: new Date(expiresAt).toISOString(),
  }
}

/** Durable initial callback state; never includes the interaction token. */
export interface InteractionCallbackObservation {
  interaction_id: string
  application_id: string
  responded: boolean
  /** Null for pending interactions and acknowledged rows predating recording. */
  initial_callback_type: number | null
  /** The normalized modal; present only when the accepted callback was type 9. */
  modal?: ModalObject
  /**
   * The normalized autocomplete choices; present only when the accepted
   * callback was type 8 (`[]` for an empty result).
   */
  choices?: AutocompleteChoice[]
  /**
   * The latest callback type refused because it is not allowed for this
   * interaction's type; absent when none was refused. A refusal does not
   * acknowledge the interaction.
   */
  rejected_callback_type?: number
  /**
   * Why the latest callback was refused for a reason other than its type:
   * `deadline` when it arrived after an armed initial callback deadline.
   * Absent when no callback was refused that way.
   */
  rejected_reason?: 'deadline'
  /** ISO 8601 instant of the latest `deadline` refusal; present with it. */
  rejected_at?: string
}

/**
 * Reads the accepted callback only when all three correlation keys match.
 * @param db - Database
 * @param interactionId - Exact interaction ID
 * @param applicationId - Exact application ID
 * @param token - Interaction token credential
 * @returns Recorded state, or null for unknown or mismatched credentials
 */
export function getInteractionCallbackObservation(
  db: Database,
  interactionId: string,
  applicationId: string,
  token: string
): InteractionCallbackObservation | null {
  const row = db
    .prepare(
      `SELECT id, application_id, responded, initial_callback_type, modal_json,
              choices_json, rejected_callback_type, rejected_reason, rejected_at
       FROM interactions WHERE id = ? AND application_id = ? AND token = ?`
    )
    .get(interactionId, applicationId, token) as
    | Pick<
        InteractionRow,
        | 'id'
        | 'application_id'
        | 'responded'
        | 'initial_callback_type'
        | 'modal_json'
        | 'choices_json'
        | 'rejected_callback_type'
        | 'rejected_reason'
        | 'rejected_at'
      >
    | undefined
  return row
    ? {
        interaction_id: row.id,
        application_id: row.application_id,
        responded: row.responded === 1,
        initial_callback_type: row.initial_callback_type,
        ...(row.initial_callback_type === 9 &&
          row.modal_json && {
            modal: JSON.parse(row.modal_json) as ModalObject,
          }),
        ...(row.initial_callback_type === 8 && {
          choices: row.choices_json
            ? (JSON.parse(row.choices_json) as AutocompleteChoice[])
            : [],
        }),
        ...(row.rejected_callback_type !== null && {
          rejected_callback_type: row.rejected_callback_type,
        }),
        ...(row.rejected_reason === 'deadline' &&
          row.rejected_at !== null && {
            rejected_reason: 'deadline' as const,
            rejected_at: new Date(row.rejected_at).toISOString(),
          }),
      }
    : null
}

/** Callback (initial response) payload for POST .../callback */
export interface InteractionCallbackPayload {
  type: number
  data?: {
    content?: string | null
    embeds?: unknown[] | null
    components?: MessageComponents | null
    tts?: boolean | null
    flags?: number | null
    /** Autocomplete result (type 8) choices, validated on the way in. */
    choices?: unknown
    /** Modal (type 9) fields, validated by `parseModal`. */
    custom_id?: string
    title?: string
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
  | { ok: false; reason: 'deadline_passed' }
  | { ok: false; reason: 'modal_not_allowed' }
  | { ok: false; reason: 'autocomplete_only' }
  | { ok: false; reason: 'autocomplete_result_not_allowed' }

/**
 * Handles POST /interactions/:id/:token/callback. Type 4 (CHANNEL_MESSAGE_
 * WITH_SOURCE) creates the original response. Type 5 creates a loading
 * original that can be completed through the webhook edit endpoint.
 * Type 9 records the normalized modal for test control to read and submit;
 * it is refused for interaction types that cannot open a modal. Type 8
 * records the normalized autocomplete choices; an autocomplete interaction
 * accepts only type 8, and type 8 answers only an autocomplete interaction.
 * A callback type refused for the interaction's type is recorded as
 * `rejected_callback_type` without acknowledging the interaction. Types 6/7
 * retain this mock's acknowledgement-only behavior.
 * When a guild's initial callback deadline is armed, a callback arriving
 * after it is refused as `deadline_passed` before anything else is checked
 * or stored; it is recorded as `rejected_reason` and leaves the interaction
 * unacknowledged.
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
  const deadlineAt = findInteractionCallbackDeadlineAt(db, row)
  if (deadlineAt !== null && Date.now() > deadlineAt) {
    // Remember the lateness so a harness can fail fast instead of waiting for
    // an acknowledgement that can no longer come.
    db.prepare(
      "UPDATE interactions SET rejected_reason = 'deadline', rejected_at = ? WHERE id = ?"
    ).run(Date.now(), row.id)
    return { ok: false, reason: 'deadline_passed' }
  }
  // Discord only lets commands and message components open a modal; PING,
  // autocomplete, and modal submissions cannot. An autocomplete interaction
  // takes only an autocomplete result, which no other interaction takes.
  const refusal =
    row.type === 4 && payload.type !== 8
      ? 'autocomplete_only'
      : row.type !== 4 && payload.type === 8
        ? 'autocomplete_result_not_allowed'
        : payload.type === 9 && row.type !== 2 && row.type !== 3
          ? 'modal_not_allowed'
          : undefined
  if (refusal) {
    // Remember the refusal so a harness can fail fast instead of waiting for
    // an acknowledgement that cannot come from this callback.
    db.prepare(
      'UPDATE interactions SET rejected_callback_type = ? WHERE id = ?'
    ).run(payload.type, row.id)
    return { ok: false, reason: refusal }
  }

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
        'UPDATE interactions SET responded = 1, initial_callback_type = ?, initial_response_message_id = ? WHERE id = ?'
      ).run(payload.type, messageId, row.id)
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
          content: deferred ? undefined : (payload.data?.content ?? undefined),
          tts: deferred ? undefined : (payload.data?.tts ?? undefined),
          embeds: deferred ? undefined : (payload.data?.embeds ?? undefined),
          components: deferred ? undefined : payload.data?.components,
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
    const { modal } = payload.type === 9 ? parseModal(payload.data) : {}
    const choices =
      payload.type === 8 ? parseAutocompleteChoices(payload.data).choices : null
    db.prepare(
      'UPDATE interactions SET responded = 1, initial_callback_type = ?, modal_json = ?, choices_json = ? WHERE id = ?'
    ).run(
      payload.type,
      modal ? JSON.stringify(modal) : null,
      choices ? JSON.stringify(choices) : null,
      row.id
    )
  }

  return {
    ok: true,
    response: resource ? { interaction, resource } : { interaction },
  }
}
