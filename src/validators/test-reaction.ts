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
 * Validates the explicit actor, one Unicode RGI emoji sequence or custom
 * `name:id` / `a:name:id` emoji, and the optional `burst` flag shared by the
 * human reaction add and removal controls. Arbitrary strings are rejected.
 * @param payload - Parsed JSON object from the test control route
 * @returns Discord field errors, empty when valid
 */
function validateReactionTarget(
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
  if (payload.burst !== undefined && typeof payload.burst !== 'boolean') {
    errors.burst = { _errors: [typeError('boolean')] }
  }
  return errors
}

/**
 * Validates a human reaction add. Besides the shared target fields, a burst
 * add may carry `burst_colors`: "#rrggbb" strings echoed in the Gateway event
 * and the message reaction summary. Colors are rejected on normal reactions.
 * @param payload - Parsed JSON object from the test control route
 * @returns Discord field errors, empty when valid
 */
export function validateTestReaction(
  payload: Record<string, unknown>
): ValidationErrors {
  const errors = validateReactionTarget(payload)
  const colors = payload.burst_colors
  if (colors === undefined) return errors
  if (payload.burst !== true) {
    errors.burst_colors = {
      _errors: [
        {
          code: 'BURST_COLORS_REQUIRE_BURST',
          message: 'burst_colors is only allowed when burst is true.',
        },
      ],
    }
  } else if (
    !Array.isArray(colors) ||
    colors.some(
      (color) => !(typeof color === 'string' && /^#[\da-f]{6}$/i.test(color))
    )
  ) {
    errors.burst_colors = {
      _errors: [typeError('array of "#rrggbb" strings')],
    }
  }
  return errors
}

/**
 * Validates a human reaction removal: the actor, emoji and optional `burst`
 * flag selecting which membership type to remove.
 * @param payload - Parsed JSON object from the test control route
 * @returns Discord field errors, empty when valid
 */
export function validateTestReactionRemoval(
  payload: Record<string, unknown>
): ValidationErrors {
  return validateReactionTarget(payload)
}
