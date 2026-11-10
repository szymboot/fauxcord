/** Validation and normalization of autocomplete results (callback type 8). */

import {
  maxLengthError,
  requiredError,
  typeError,
  type ValidationErrors,
} from './common'
import { isDiscordLocale } from './locales'

/** Most choices Discord accepts in one autocomplete result. */
export const MAX_AUTOCOMPLETE_CHOICES = 25

/** Longest choice name, string choice value, and localized name. */
const MAX_TEXT_LENGTH = 100

/** One normalized autocomplete choice. */
export interface AutocompleteChoice {
  name: string
  value: string | number
  name_localizations?: Record<string, string>
}

/** Result of parsing an autocomplete result's `data`. */
export interface ParsedAutocomplete {
  /** Normalized choices; empty for a missing or empty result. */
  choices: AutocompleteChoice[]
  /** Discord-shaped errors keyed by path relative to `data`. */
  errors: ValidationErrors
}

/**
 * Reports whether a string's length, counted in Unicode code points as
 * Discord does, is within a range.
 * @param value - String to measure
 * @param min - Minimum length
 * @param max - Maximum length
 * @returns True when within range
 */
function lengthWithin(value: string, min: number, max: number): boolean {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const length = [...value].length
  return length >= min && length <= max
}

/**
 * Builds the error Discord returns for a string outside a length range.
 * @param min - Minimum length
 * @param max - Maximum length
 * @returns Validation error entry
 */
function lengthError(min: number, max: number): ValidationErrors[string] {
  return {
    _errors: [
      min === 0
        ? maxLengthError(max)
        : {
            code: 'BASE_TYPE_BAD_LENGTH',
            message: `Must be between ${min} and ${max} in length.`,
          },
    ],
  }
}

/**
 * Parses the `name_localizations` of one choice: an object of supported
 * locales to names of 1-100 characters. `null` counts as absent.
 * @param value - Raw `name_localizations`
 * @param path - Error path of the field
 * @param errors - Collector for validation errors
 * @returns The localizations, or undefined when absent or invalid
 */
function parseLocalizations(
  value: unknown,
  path: string,
  errors: ValidationErrors
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors[path] = { _errors: [typeError('dict')] }
    return undefined
  }
  const result: Record<string, string> = {}
  for (const [locale, name] of Object.entries(value)) {
    if (!isDiscordLocale(locale)) {
      errors[`${path}.${locale}`] = {
        _errors: [
          {
            code: 'BASE_TYPE_CHOICES',
            message: 'Value must be a supported Discord locale.',
          },
        ],
      }
    } else if (typeof name !== 'string') {
      errors[`${path}.${locale}`] = { _errors: [typeError('string')] }
    } else if (lengthWithin(name, 1, MAX_TEXT_LENGTH)) {
      result[locale] = name
    } else {
      errors[`${path}.${locale}`] = lengthError(1, MAX_TEXT_LENGTH)
    }
  }
  return result
}

/**
 * Validates and normalizes the `data` of an autocomplete result. Missing
 * `data`, or missing or null `choices`, is an empty result (clients such as
 * DiscordGo omit `choices` when it is empty). Message fields that libraries
 * send with zero values (`content`, `tts`, `embeds`, `components`) are
 * ignored.
 * @param data - Raw callback `data` (already checked to be an object when
 * present)
 * @returns Normalized choices and Discord-shaped errors relative to `data`
 */
export function parseAutocompleteChoices(data: unknown): ParsedAutocomplete {
  const errors: ValidationErrors = {}
  const choices: AutocompleteChoice[] = []
  const raw =
    typeof data === 'object' && data !== null
      ? (data as { choices?: unknown }).choices
      : undefined
  if (raw === undefined || raw === null) return { choices, errors }
  if (!Array.isArray(raw)) {
    errors.choices = { _errors: [typeError('list')] }
    return { choices, errors }
  }
  if (raw.length > MAX_AUTOCOMPLETE_CHOICES) {
    errors.choices = { _errors: [maxLengthError(MAX_AUTOCOMPLETE_CHOICES)] }
    return { choices, errors }
  }
  for (const [index, entry] of raw.entries()) {
    const path = `choices.${index}`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors[path] = { _errors: [typeError('object')] }
      continue
    }
    const choice = entry as {
      name?: unknown
      value?: unknown
      name_localizations?: unknown
    }
    let valid = true
    if (choice.name === undefined || choice.name === null) {
      errors[`${path}.name`] = { _errors: [requiredError()] }
      valid = false
    } else if (typeof choice.name !== 'string') {
      errors[`${path}.name`] = { _errors: [typeError('string')] }
      valid = false
    } else if (!lengthWithin(choice.name, 1, MAX_TEXT_LENGTH)) {
      errors[`${path}.name`] = lengthError(1, MAX_TEXT_LENGTH)
      valid = false
    }
    if (choice.value === undefined || choice.value === null) {
      errors[`${path}.value`] = { _errors: [requiredError()] }
      valid = false
    } else if (typeof choice.value === 'string') {
      if (!lengthWithin(choice.value, 0, MAX_TEXT_LENGTH)) {
        errors[`${path}.value`] = lengthError(0, MAX_TEXT_LENGTH)
        valid = false
      }
    } else if (
      typeof choice.value !== 'number' ||
      !Number.isFinite(choice.value)
    ) {
      errors[`${path}.value`] = { _errors: [typeError('string or number')] }
      valid = false
    }
    const before = Object.keys(errors).length
    const localizations = parseLocalizations(
      choice.name_localizations,
      `${path}.name_localizations`,
      errors
    )
    if (Object.keys(errors).length !== before) valid = false
    if (valid) {
      choices.push({
        name: choice.name as string,
        value: choice.value as string | number,
        ...(localizations && { name_localizations: localizations }),
      })
    }
  }
  return { choices, errors }
}
