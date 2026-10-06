import { requiredError, typeError, type ValidationErrors } from './common'

/**
 * Validates the explicit actor and one Unicode RGI emoji sequence. Custom emoji
 * and arbitrary strings are outside the test producer's persistence model.
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
  if (
    typeof payload.emoji !== 'string' ||
    !/^\p{RGI_Emoji}$/v.test(payload.emoji)
  ) {
    errors.emoji = {
      _errors: [
        {
          code: 'INVALID_EMOJI',
          message: 'Must be one Unicode emoji sequence.',
        },
      ],
    }
  }
  return errors
}
