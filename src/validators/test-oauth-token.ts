import type { UserTokenParams } from '../services/oauth2'
import { requiredError, typeError, type ValidationErrors } from './common'

/** Default lifetime of an issued token, in seconds (7 days). */
export const DEFAULT_TEST_TOKEN_EXPIRES_IN = 604_800

/** Longest accepted token lifetime, in seconds (30 days). */
export const MAX_TEST_TOKEN_EXPIRES_IN = 2_592_000

/** Result of validating a user-bound token request. */
export type TestOAuthTokenValidation =
  { ok: true; value: UserTokenParams } | { ok: false; errors: ValidationErrors }

/** A scope is single-space separated printable, non-space ASCII tokens. */
const SCOPE_PATTERN = /^[!-~]+(?: [!-~]+)*$/

/**
 * Builds a one-error field map entry.
 * @param code - Error code
 * @param message - Error message
 * @returns Field error container
 */
function fieldError(
  code: string,
  message: string
): { _errors: { code: string; message: string }[] } {
  return { _errors: [{ code, message }] }
}

/**
 * Validates the user-bound OAuth token control payload: a non-empty
 * `client_id` and `user_id`, a space-separated `scope`, and an optional
 * positive integer `expires_in` bounded to 30 days. Unsupported fields are
 * rejected.
 * @param payload - Parsed JSON value
 * @returns The normalized request or field errors, or undefined when the body
 * is not a JSON object
 */
export function validateTestOAuthToken(
  payload: unknown
): TestOAuthTokenValidation | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return undefined
  const body = payload as Record<string, unknown>
  const errors = Object.create(null) as ValidationErrors

  for (const field of Object.keys(body)) {
    if (!['client_id', 'user_id', 'scope', 'expires_in'].includes(field))
      errors[field] = fieldError('UNKNOWN_FIELD', 'Unsupported fixture field.')
  }
  for (const field of ['client_id', 'user_id'] as const) {
    const value = body[field]
    if (value === undefined) errors[field] = { _errors: [requiredError()] }
    else if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 100 ||
      value.trim() !== value
    )
      errors[field] = { _errors: [typeError('non-empty string')] }
  }
  if (body.scope === undefined) errors.scope = { _errors: [requiredError()] }
  else if (
    typeof body.scope !== 'string' ||
    body.scope.length > 1000 ||
    !SCOPE_PATTERN.test(body.scope)
  )
    errors.scope = fieldError(
      'INVALID_SCOPE',
      'Scope must be single-space separated scope names.'
    )
  if (
    body.expires_in !== undefined &&
    (typeof body.expires_in !== 'number' ||
      !Number.isSafeInteger(body.expires_in) ||
      body.expires_in < 1 ||
      body.expires_in > MAX_TEST_TOKEN_EXPIRES_IN)
  )
    errors.expires_in = fieldError(
      'INVALID_EXPIRES_IN',
      `expires_in must be an integer from 1 to ${MAX_TEST_TOKEN_EXPIRES_IN} seconds.`
    )

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          clientId: body.client_id as string,
          userId: body.user_id as string,
          scope: body.scope as string,
          expiresIn:
            (body.expires_in as number | undefined) ??
            DEFAULT_TEST_TOKEN_EXPIRES_IN,
        },
      }
}
