import { typeError, type ValidationErrors } from './common'
import { GUILD_LIMITS } from './guild'

/**
 * Validates the narrow role fixture contract, rejecting unsupported fields.
 * @param payload - Parsed JSON object
 * @returns Field errors, empty for a valid name and optional managed boolean
 */
export function validateTestRole(
  payload: Record<string, unknown>
): ValidationErrors {
  const errors = Object.create(null) as ValidationErrors
  for (const field of Object.keys(payload)) {
    if (field !== 'name' && field !== 'managed') {
      errors[field] = {
        _errors: [
          { code: 'UNKNOWN_FIELD', message: 'Unsupported fixture field.' },
        ],
      }
    }
  }
  if (typeof payload.name !== 'string') {
    errors.name = { _errors: [typeError('string')] }
  } else if (
    payload.name.length === 0 ||
    payload.name.length > GUILD_LIMITS.NAME_MAX
  ) {
    errors.name = {
      _errors: [
        {
          code: 'BASE_TYPE_BAD_LENGTH',
          message: `Must be between 1 and ${GUILD_LIMITS.NAME_MAX} in length.`,
        },
      ],
    }
  }
  if (payload.managed !== undefined && typeof payload.managed !== 'boolean') {
    errors.managed = { _errors: [typeError('boolean')] }
  }
  return errors
}
