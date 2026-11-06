/**
 * Validators for the invite-related test controls.
 */

import { validateInviteCreate } from './channel'
import { requiredError, typeError } from './common'

/**
 * Validates a human-created invite fixture body. max_age/max_uses share the
 * native invite limits; inviter_id must be a string (Snowflakes lose precision
 * as JSON numbers); temporary and delete_event_on_exhaustion must be
 * booleans when present.
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
