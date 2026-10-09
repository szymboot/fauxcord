import { typeError, type ValidationErrors } from './common'

/**
 * Validates the global-name-only human fixture; omission preserves, null clears.
 * @param payload - Parsed JSON object
 * @returns Field errors, including every unsupported field
 */
export function validateTestUserGlobalName(
  payload: Record<string, unknown>
): ValidationErrors {
  const errors = Object.create(null) as ValidationErrors
  for (const field of Object.keys(payload)) {
    if (field !== 'global_name') {
      errors[field] = {
        _errors: [
          { code: 'UNKNOWN_FIELD', message: 'Unsupported fixture field.' },
        ],
      }
    }
  }
  if (
    payload.global_name !== undefined &&
    payload.global_name !== null &&
    typeof payload.global_name !== 'string'
  ) {
    errors.global_name = { _errors: [typeError('string or null')] }
  }
  return errors
}
