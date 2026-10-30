/** Validation for the locale override on test interactions. */

import type { Locale } from 'discord-api-types/v10'
import { requiredError, typeError, type ValidationErrors } from './common'
import { validateMessageComponents } from './message-components'
import { validateMessageEmbeds } from './message'
import { parseModal } from './modal'

/** Discord's supported locales, checked against the installed API types. */
const DISCORD_LOCALES = {
  id: true,
  'en-US': true,
  'en-GB': true,
  bg: true,
  'zh-CN': true,
  'zh-TW': true,
  hr: true,
  cs: true,
  da: true,
  nl: true,
  fi: true,
  fr: true,
  de: true,
  el: true,
  hi: true,
  hu: true,
  it: true,
  ja: true,
  ko: true,
  lt: true,
  no: true,
  pl: true,
  'pt-BR': true,
  ro: true,
  ru: true,
  'es-ES': true,
  'es-419': true,
  'sv-SE': true,
  th: true,
  tr: true,
  uk: true,
  vi: true,
} satisfies Record<`${Locale}`, boolean>

/**
 * Validates an optional invoking-user locale before creating an interaction.
 * @param locale - Raw locale value supplied by the caller
 * @returns Discord-shaped field errors, or an empty object when valid
 */
export function validateInteractionLocale(locale: unknown): ValidationErrors {
  if (locale === undefined) return {}
  if (typeof locale !== 'string') {
    return { locale: { _errors: [typeError('string')] } }
  }
  return Object.hasOwn(DISCORD_LOCALES, locale)
    ? {}
    : {
        locale: {
          _errors: [
            {
              code: 'BASE_TYPE_CHOICES',
              message: 'Value must be a supported Discord locale.',
            },
          ],
        },
      }
}

/**
 * Validates callback structure, modeled direct-message field types, the
 * flags accepted by a deferred response, and modal definitions (type 9).
 * Other callback data retains the mock's existing scope.
 * @param payload - Untrusted callback JSON
 * @returns Discord-shaped validation errors
 */
export function validateInteractionCallback(
  payload: unknown
): ValidationErrors {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return { body: { _errors: [typeError('object')] } }
  }
  const callback = payload as { type?: unknown; data?: unknown }
  if (
    typeof callback.type !== 'number' ||
    ![1, 4, 5, 6, 7, 8, 9, 10, 12, 13].includes(callback.type)
  ) {
    return {
      type: {
        _errors: [
          {
            code: 'BASE_TYPE_CHOICES',
            message: 'Value must be a supported interaction callback type.',
          },
        ],
      },
    }
  }
  if (callback.type === 9 && callback.data !== undefined) {
    if (
      typeof callback.data !== 'object' ||
      callback.data === null ||
      Array.isArray(callback.data)
    ) {
      return { data: { _errors: [typeError('object')] } }
    }
    const errors: ValidationErrors = {}
    for (const [path, error] of Object.entries(
      parseModal(callback.data).errors
    )) {
      errors[`data.${path}`] = error
    }
    return errors
  }
  if (callback.data === undefined) return {}
  if (
    typeof callback.data !== 'object' ||
    callback.data === null ||
    Array.isArray(callback.data)
  ) {
    return { data: { _errors: [typeError('object')] } }
  }
  if (callback.type === 4) {
    const data = callback.data as Record<string, unknown>
    const errors: ValidationErrors = {
      ...(data.content != null &&
        typeof data.content !== 'string' && {
          'data.content': { _errors: [typeError('string')] },
        }),
      ...(data.tts != null &&
        typeof data.tts !== 'boolean' && {
          'data.tts': { _errors: [typeError('boolean')] },
        }),
      ...(data.flags != null &&
        (typeof data.flags !== 'number' ||
          !Number.isSafeInteger(data.flags)) && {
          'data.flags': { _errors: [typeError('integer')] },
        }),
    }
    const embedErrors = {
      ...validateMessageEmbeds(data.embeds),
      ...validateMessageComponents(data.components, data.flags),
    }
    for (const [path, error] of Object.entries(embedErrors)) {
      errors[`data.${path}`] = error
    }
    return errors
  }
  if (callback.type !== 5) return {}
  const { flags } = callback.data as { flags?: unknown }
  return flags !== undefined && flags !== 0 && flags !== 64
    ? {
        'data.flags': {
          _errors: [
            {
              code: 'BASE_TYPE_CHOICES',
              message:
                'Deferred responses only support the EPHEMERAL flag (64).',
            },
          ],
        },
      }
    : {}
}

/** Fields accepted by `POST /_test/interactions` that need validation. */
export interface TestInteractionFields {
  command_type?: unknown
  target_id?: unknown
  type?: unknown
  options?: unknown
  locale?: unknown
}

/**
 * Validates the fields of a simulated interaction request that select the
 * command kind: `command_type` (1 CHAT_INPUT, 2 USER), the USER command's
 * `target_id`, and the invoking user's locale. `command_type` defaults to 2
 * when a `target_id` is given and to 1 otherwise.
 * @param body - Untrusted request body
 * @returns Discord-shaped field errors, or an empty object when valid
 */
export function validateTestInteraction(body: unknown): ValidationErrors {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { body: { _errors: [typeError('object')] } }
  }
  const fields = body as TestInteractionFields
  const errors = validateInteractionLocale(fields.locale)
  const choices = (message: string): ValidationErrors[string] => ({
    _errors: [{ code: 'BASE_TYPE_CHOICES', message }],
  })
  const bad = (message: string): ValidationErrors[string] => ({
    _errors: [{ code: 'BASE_TYPE_BAD_VALUE', message }],
  })
  const { command_type: commandType, target_id: targetId } = fields
  if (commandType !== undefined && commandType !== 1 && commandType !== 2) {
    errors.command_type = choices(
      commandType === 3
        ? 'MESSAGE commands (3) are not supported; use 1 (CHAT_INPUT) or 2 (USER).'
        : 'Value must be 1 (CHAT_INPUT) or 2 (USER).'
    )
    return errors
  }
  const kind = commandType ?? (targetId === undefined ? 1 : 2)
  if (kind === 1) {
    if (targetId !== undefined) {
      errors.target_id = bad(
        'Only USER commands (command_type 2) have a target.'
      )
    }
    return errors
  }
  if (targetId === undefined) {
    errors.target_id = { _errors: [requiredError()] }
  } else if (
    typeof targetId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(targetId)
  ) {
    errors.target_id = { _errors: [typeError('Snowflake string')] }
  }
  if (fields.type !== undefined && fields.type !== 2) {
    errors.type = bad('USER commands are APPLICATION_COMMAND interactions (2).')
  }
  if (
    fields.options !== undefined &&
    !(Array.isArray(fields.options) && fields.options.length === 0)
  ) {
    errors.options = bad('USER commands do not take options.')
  }
  return errors
}

/**
 * Validates the body of `POST /_test/interactions/:id/modal-submit`.
 * @param body - Untrusted request body
 * @returns Discord-shaped field errors, or an empty object when valid
 */
export function validateModalSubmitRequest(body: unknown): ValidationErrors {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { body: { _errors: [typeError('object')] } }
  }
  const { custom_id: customId, values } = body as {
    custom_id?: unknown
    values?: unknown
  }
  const errors: ValidationErrors = {}
  if (customId === undefined) {
    errors.custom_id = { _errors: [requiredError()] }
  } else if (typeof customId !== 'string') {
    errors.custom_id = { _errors: [typeError('string')] }
  }
  if (
    values !== undefined &&
    (typeof values !== 'object' || values === null || Array.isArray(values))
  ) {
    errors.values = { _errors: [typeError('object')] }
  }
  return errors
}
