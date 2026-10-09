/** Validation for the locale override on test interactions. */

import type { Locale } from 'discord-api-types/v10'
import { typeError, type ValidationErrors } from './common'
import { validateMessageEmbeds } from './message'

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
 * Validates callback structure, modeled direct-message field types, and the
 * flags accepted by a deferred response.
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
    const embedErrors = validateMessageEmbeds(data.embeds)
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
