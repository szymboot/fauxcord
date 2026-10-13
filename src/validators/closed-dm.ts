import { typeError, type ValidationErrors } from './common'

/** Identifies a human recipient and the owning bot's guild cleanup scope. */
export interface ClosedDmRequest {
  guild_id: string
  user_id: string
}

/** Validates fixture fields without converting snowflakes to numbers. */
export function validateClosedDm(value: unknown): ValidationErrors {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { body: { _errors: [typeError('object')] } }
  const body = value as Record<string, unknown>
  const errors: ValidationErrors = {}
  for (const key of ['guild_id', 'user_id']) {
    const id = body[key]
    if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id))
      errors[key] = {
        _errors: [
          {
            code: 'BASE_TYPE_BAD_TYPE',
            message: 'Must be a nonzero Snowflake ID string.',
          },
        ],
      }
  }
  for (const key of Object.keys(body)) {
    if (!['guild_id', 'user_id'].includes(key))
      errors.body = {
        _errors: [{ code: 'UNKNOWN_FIELD', message: 'Unknown field.' }],
      }
  }
  return errors
}
