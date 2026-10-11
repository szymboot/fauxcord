import { requiredError, typeError, type ValidationErrors } from './common'
import { parseReactionEmoji } from '../services/reaction-emoji'

/**
 * Checks whether a test reaction emoji is one Unicode RGI emoji sequence or a
 * custom emoji in Discord's `name:id` / animated `a:name:id` form.
 * @param emoji - Untrusted emoji value
 * @returns Whether the emoji has a supported shape
 */
function isSupportedTestEmoji(emoji: unknown): emoji is string {
  return typeof emoji === 'string'
    ? /^\p{RGI_Emoji}$/v.test(emoji) || parseReactionEmoji(emoji).id !== null
    : false
}

/**
 * Validates the explicit actor and one Unicode RGI emoji sequence or custom
 * `name:id` / `a:name:id` emoji. Arbitrary strings are rejected.
 * @param payload - Parsed JSON object from the test control route
 * @returns Discord field errors, empty when valid
 */
export function validateTestReaction(
  payload: Record<string, unknown>
): ValidationErrors {
  const errors = Object.create(null) as ValidationErrors
  if (typeof payload.user_id !== 'string' || !payload.user_id.trim()) {
    errors.user_id = {
      _errors: [
        payload.user_id === undefined
          ? requiredError()
          : typeError('non-empty string'),
      ],
    }
  }
  if (!isSupportedTestEmoji(payload.emoji)) {
    errors.emoji = {
      _errors: [
        {
          code: 'INVALID_EMOJI',
          message:
            'Must be one Unicode emoji sequence or a custom emoji (name:id).',
        },
      ],
    }
  }
  return errors
}
