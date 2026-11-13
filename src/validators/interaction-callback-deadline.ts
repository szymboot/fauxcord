import { typeError, type ValidationErrors } from './common'

/** Default initial callback deadline, as documented by Discord. */
export const DEFAULT_CALLBACK_DEADLINE_MS = 3000
/** Smallest accepted deadline, so tests can use very short ones. */
export const MIN_CALLBACK_DEADLINE_MS = 1
/** Largest accepted deadline. */
export const MAX_CALLBACK_DEADLINE_MS = 60_000

/** Validated request arming the initial callback deadline for a guild. */
export interface InteractionCallbackDeadlineRequest {
  guild_id: string
  deadline_ms: number
}

/**
 * Validates a deadline request without converting snowflakes to numbers.
 * `deadline_ms` is optional and defaults to 3000; unknown fields are rejected.
 * @param value - Parsed request body
 * @returns Field errors, empty when the request is valid
 */
export function validateInteractionCallbackDeadline(
  value: unknown
): ValidationErrors {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { body: { _errors: [typeError('object')] } }
  const body = value as Record<string, unknown>
  const errors: ValidationErrors = {}
  const guildId = body.guild_id
  if (typeof guildId !== 'string' || !/^[1-9]\d{0,19}$/.test(guildId))
    errors.guild_id = {
      _errors: [
        {
          code: 'BASE_TYPE_BAD_TYPE',
          message: 'Must be a nonzero Snowflake ID string.',
        },
      ],
    }
  const deadline = body.deadline_ms
  if (
    deadline !== undefined &&
    (typeof deadline !== 'number' ||
      !Number.isSafeInteger(deadline) ||
      deadline < MIN_CALLBACK_DEADLINE_MS ||
      deadline > MAX_CALLBACK_DEADLINE_MS)
  )
    errors.deadline_ms = {
      _errors: [
        {
          code: 'NUMBER_TYPE_RANGE',
          message: `Must be an integer between ${MIN_CALLBACK_DEADLINE_MS} and ${MAX_CALLBACK_DEADLINE_MS}.`,
        },
      ],
    }
  for (const key of Object.keys(body)) {
    if (!['guild_id', 'deadline_ms'].includes(key))
      errors.body = {
        _errors: [{ code: 'UNKNOWN_FIELD', message: 'Unknown field.' }],
      }
  }
  return errors
}
