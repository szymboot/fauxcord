import { typeError, type ValidationErrors } from './common'
import { normalizeMemberJoinDate } from './member-join-date'

/** ISO 8601 datetimes with a timezone and a valid time of day. */
const PREMIUM_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/**
 * Validates the narrow fixture input, rejecting unsupported fields.
 * @param payload - Parsed JSON object
 * @returns Field errors; omission preserves and only premium_since accepts null
 */
export function validateMemberDateFixture(
  payload: Record<string, unknown>
): ValidationErrors {
  const errors = Object.create(null) as ValidationErrors
  for (const field of Object.keys(payload)) {
    if (field !== 'premium_since' && field !== 'joined_at') {
      errors[field] = {
        _errors: [
          { code: 'UNKNOWN_FIELD', message: 'Unsupported fixture field.' },
        ],
      }
    }
  }
  if (
    payload.joined_at !== undefined &&
    normalizeMemberJoinDate(payload.joined_at) === null
  ) {
    errors.joined_at = {
      _errors: [
        {
          code: 'BASE_TYPE_BAD_FORMAT',
          message: 'Must be a valid ISO8601 timestamp with a timezone.',
        },
      ],
    }
  }
  const value = payload.premium_since
  if (value === undefined || value === null) return errors
  if (typeof value !== 'string') {
    errors.premium_since = { _errors: [typeError('string')] }
    return errors
  }
  if (
    !PREMIUM_TIMESTAMP.test(value) ||
    normalizeMemberJoinDate(value) === null
  ) {
    errors.premium_since = {
      _errors: [
        {
          code: 'BASE_TYPE_BAD_FORMAT',
          message: 'Must be a valid ISO8601 timestamp with a timezone.',
        },
      ],
    }
  }
  return errors
}
