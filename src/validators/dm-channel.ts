import type { ValidationErrors } from './common'
import { validateClosedDm, type ClosedDmRequest } from './closed-dm'

/** Identifies the owning bot's guild and the human end of a 1:1 DM. */
export type DmChannelRequest = ClosedDmRequest

/**
 * Validates DM channel control fields with the closed-DM fixture rules: both
 * IDs are required nonzero Snowflake strings and extra fields are rejected.
 * @param value - Parsed JSON body, or an object built from query parameters
 * @returns Discord-format field errors, empty when valid
 */
export function validateDmChannelRequest(value: unknown): ValidationErrors {
  return validateClosedDm(value)
}
