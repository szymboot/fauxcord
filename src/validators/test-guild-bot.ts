import { typeError, type ValidationErrors } from './common'

/** Request body of `POST /_test/guilds/:guildId/bot`. */
export interface TestGuildBotJoinRequest {
  /** Setup token of the bot to add, with or without the `Bot ` prefix. */
  token?: string
  /** Application (bot user) ID of the bot to add. */
  application_id?: string
  /** Existing guild role IDs to assign to the bot member (not `@everyone`). */
  roles?: string[]
}

/**
 * Validates the bot join fixture contract: unsupported fields are rejected,
 * `token` and `application_id` must be non-empty strings with at least one of
 * them present, and `roles` must be an array of non-empty strings.
 * @param payload - Parsed JSON object
 * @returns Field errors, empty for a valid request
 */
export function validateTestGuildBotJoin(
  payload: Record<string, unknown>
): ValidationErrors {
  const errors = Object.create(null) as ValidationErrors
  for (const field of Object.keys(payload)) {
    if (field !== 'token' && field !== 'application_id' && field !== 'roles') {
      errors[field] = {
        _errors: [
          { code: 'UNKNOWN_FIELD', message: 'Unsupported fixture field.' },
        ],
      }
    }
  }
  for (const field of ['token', 'application_id'] as const) {
    const value = payload[field]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      errors[field] = { _errors: [typeError('string')] }
    } else if (value.trim().length === 0) {
      errors[field] = {
        _errors: [
          { code: 'BASE_TYPE_REQUIRED', message: 'This field is required' },
        ],
      }
    }
  }
  if (payload.token === undefined && payload.application_id === undefined) {
    errors.token = {
      _errors: [
        {
          code: 'BASE_TYPE_REQUIRED',
          message: 'Either token or application_id is required.',
        },
      ],
    }
  }
  if (payload.roles !== undefined) {
    if (!Array.isArray(payload.roles)) {
      errors.roles = { _errors: [typeError('list')] }
    } else if (
      payload.roles.some(
        (role: unknown) => typeof role !== 'string' || role.length === 0
      )
    ) {
      errors.roles = { _errors: [typeError('snowflake')] }
    }
  }
  return errors
}
