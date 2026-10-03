/** Validation for the locale override on test interactions. */

import type { Locale } from 'discord-api-types/v10'
import { typeError, type ValidationErrors } from './common'

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
