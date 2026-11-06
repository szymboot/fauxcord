/**
 * Validators for the invite-related test controls.
 */

import { validateInviteCreate } from './channel'
import { maxLengthError, requiredError, typeError } from './common'
import { normalizeMemberJoinDate } from './member-join-date'

/**
 * Validates a human-created invite fixture body. max_age/max_uses share the
 * native invite limits; inviter_id must be a string (Snowflakes lose precision
 * as JSON numbers); temporary and delete_event_on_exhaustion must be
 * booleans when present; created_at (null means now) must be an ISO 8601
 * timestamp with a timezone that is not in the future.
 * @param payload - Parsed JSON object (untrusted)
 * @returns Field-keyed error map (empty when valid)
 */
export function validateTestInvite(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const errors = validateInviteCreate({
    max_age: payload.max_age as number | null | undefined,
    max_uses: payload.max_uses as number | null | undefined,
  })
  if (payload.inviter_id === undefined || payload.inviter_id === null) {
    errors.inviter_id = { _errors: [requiredError()] }
  } else if (
    typeof payload.inviter_id !== 'string' ||
    payload.inviter_id.length === 0
  ) {
    errors.inviter_id = { _errors: [typeError('string')] }
  }
  if (
    payload.temporary !== undefined &&
    payload.temporary !== null &&
    typeof payload.temporary !== 'boolean'
  ) {
    errors.temporary = { _errors: [typeError('boolean')] }
  }
  if (
    payload.delete_event_on_exhaustion !== undefined &&
    payload.delete_event_on_exhaustion !== null &&
    typeof payload.delete_event_on_exhaustion !== 'boolean'
  ) {
    errors.delete_event_on_exhaustion = { _errors: [typeError('boolean')] }
  }
  const createdAt = payload.created_at
  if (createdAt !== undefined && createdAt !== null) {
    if (typeof createdAt !== 'string') {
      errors.created_at = { _errors: [typeError('string')] }
    } else if (normalizeMemberJoinDate(createdAt) === null) {
      errors.created_at = {
        _errors: [
          {
            code: 'BASE_TYPE_BAD_FORMAT',
            message: 'Must be a valid ISO8601 timestamp with a timezone.',
          },
        ],
      }
    } else if (Date.parse(createdAt) > Date.now()) {
      errors.created_at = {
        _errors: [
          {
            code: 'DATE_RANGE_INVALID',
            message: 'Must not be in the future.',
          },
        ],
      }
    }
  }
  return errors
}

/**
 * Validates the optional invite_code of a test member join. When present it
 * must be a non-empty string; null is rejected rather than treated as absent
 * so a mistaken payload cannot silently skip invite attribution.
 * @param payload - Parsed JSON object (untrusted)
 * @returns Field-keyed error map (empty when valid)
 */
export function validateTestJoinInviteCode(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const value = payload.invite_code
  if (value === undefined) return {}
  return typeof value !== 'string' || value.length === 0
    ? { invite_code: { _errors: [typeError('string')] } }
    : {}
}

/** Maximum length of an audit log reason, as on Discord's header. */
const AUDIT_REASON_MAX_LENGTH = 512

/**
 * Validates the body of the member invite deletion control. `actor_id` must be
 * a non-empty string (Snowflakes lose precision as JSON numbers); `reason`
 * (null means none) must be a string of at most 512 characters.
 * @param payload - Parsed JSON object (untrusted)
 * @returns Field-keyed error map (empty when valid)
 */
export function validateTestInviteDelete(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const errors: Record<string, unknown> = {}
  if (payload.actor_id === undefined || payload.actor_id === null) {
    errors.actor_id = { _errors: [requiredError()] }
  } else if (
    typeof payload.actor_id !== 'string' ||
    payload.actor_id.length === 0
  ) {
    errors.actor_id = { _errors: [typeError('string')] }
  }
  const { reason } = payload
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== 'string') {
      errors.reason = { _errors: [typeError('string')] }
    } else if (reason.length > AUDIT_REASON_MAX_LENGTH) {
      errors.reason = { _errors: [maxLengthError(AUDIT_REASON_MAX_LENGTH)] }
    }
  }
  return errors
}
