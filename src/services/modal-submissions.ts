/**
 * Modal submission service
 *
 * Simulates a user submitting a modal the bot showed through a type-9
 * interaction callback. Each submission is a new MODAL_SUBMIT interaction.
 */

import { randomBytes } from 'node:crypto'
import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import type { ValidationErrors } from '../validators/common'
import { buildModalSubmission, type ModalObject } from '../validators/modal'
import { createInteraction, type InteractionObject } from './interactions'
import { resolveInteractionScope } from './interaction-scope'

/** Request body accepted by POST /_test/interactions/:id/modal-submit */
export interface ModalSubmitRequest {
  /** Must equal the `custom_id` of the modal that was shown. */
  custom_id: string
  /** Submitted values keyed by input `custom_id`. */
  values?: Record<string, unknown>
}

/** Result of a modal submission attempt */
export type SubmitModalResult =
  | { ok: true; interaction: InteractionObject }
  | {
      ok: false
      reason: 'not_found' | 'unknown_guild' | 'unknown_channel'
    }
  | { ok: false; reason: 'invalid'; errors: ValidationErrors }

/**
 * Submits the modal shown for an interaction as the same user, guild,
 * channel, and locale, dispatching a native MODAL_SUBMIT (type 5)
 * INTERACTION_CREATE. The shown modal is not consumed: submitting again
 * creates another independent interaction, as Discord does per submit. The
 * guild and channel gating of interaction creation applies again, so a bot
 * removed from the guild since the modal was shown receives nothing.
 * @param db - Database
 * @param interactionId - Interaction the modal was shown for
 * @param applicationId - Application that owns the interaction
 * @param token - Token of that interaction
 * @param request - Modal `custom_id` and submitted values
 * @returns The new interaction, or why nothing was submitted
 */
export function submitTestModal(
  db: Database,
  interactionId: string,
  applicationId: string,
  token: string,
  request: ModalSubmitRequest
): SubmitModalResult {
  const row = db
    .prepare(
      `SELECT guild_id, channel_id, locale, user_id, initial_callback_type, modal_json
       FROM interactions WHERE id = ? AND application_id = ? AND token = ?`
    )
    .get(interactionId, applicationId, token) as
    | {
        guild_id: string | null
        channel_id: string | null
        locale: string
        user_id: string
        initial_callback_type: number | null
        modal_json: string | null
      }
    | undefined
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.initial_callback_type !== 9 || !row.modal_json) {
    return {
      ok: false,
      reason: 'invalid',
      errors: {
        interaction_id: {
          _errors: [
            {
              code: 'BASE_TYPE_BAD_VALUE',
              message:
                'No modal has been shown for this interaction; the bot must first accept a MODAL (9) callback.',
            },
          ],
        },
      },
    }
  }
  const scope = resolveInteractionScope(
    db,
    applicationId,
    row.guild_id ?? undefined,
    row.channel_id ?? undefined
  )
  if (!scope.ok) return scope

  const modal = JSON.parse(row.modal_json) as ModalObject
  const submission = buildModalSubmission(modal, request.values ?? {})
  const errors: ValidationErrors = {
    ...(request.custom_id !== modal.custom_id && {
      custom_id: {
        _errors: [
          {
            code: 'BASE_TYPE_BAD_VALUE',
            message: `Must equal the shown modal's custom_id (${JSON.stringify(modal.custom_id)}).`,
          },
        ],
      },
    }),
    ...submission.errors,
  }
  if (!submission.data || Object.keys(errors).length > 0) {
    return { ok: false, reason: 'invalid', errors }
  }

  const interaction = createInteraction(db, {
    interactionId: generateSnowflake(),
    applicationId,
    token: randomBytes(48).toString('base64url'),
    type: 5,
    locale: row.locale,
    guildId: scope.guildId,
    channelId: row.channel_id ?? undefined,
    data: submission.data,
    userId: row.user_id,
  })
  return { ok: true, interaction }
}
