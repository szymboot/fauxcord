import { typeError, type ValidationErrors } from './common'

/** ISO 8601 datetimes with a timezone and a valid time of day. */
const PREMIUM_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/**
 * Validates the narrow fixture input, rejecting unsupported fields.
 * @param payload - Parsed JSON object
 * @returns Field errors; omission and null are valid
 */
export function validateMemberPremiumFixture(
  payload: Record<string, unknown>
): ValidationErrors {
  const errors = Object.create(null) as ValidationErrors
  for (const field of Object.keys(payload)) {
    if (field !== 'premium_since') {
      errors[field] = {
        _errors: [
          { code: 'UNKNOWN_FIELD', message: 'Unsupported fixture field.' },
        ],
      }
    }
  }
  const value = payload.premium_since
  if (value === undefined || value === null) return errors
  if (typeof value !== 'string') {
    errors.premium_since = { _errors: [typeError('string')] }
    return errors
  }
  const calendarDate = value.slice(0, 10)
  const calendarTimestamp = Date.parse(`${calendarDate}T00:00:00Z`)
  if (
    !PREMIUM_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    !Number.isFinite(calendarTimestamp) ||
    new Date(calendarTimestamp).toISOString().slice(0, 10) !== calendarDate
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
