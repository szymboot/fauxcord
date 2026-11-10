/** Discord's supported locales. */

import type { Locale } from 'discord-api-types/v10'

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
 * Reports whether a value is a locale Discord supports.
 * @param value - Candidate locale identifier
 * @returns True for a supported locale
 */
export function isDiscordLocale(value: string): boolean {
  return Object.hasOwn(DISCORD_LOCALES, value)
}
