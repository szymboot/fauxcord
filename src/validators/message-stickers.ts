import { maxLengthError, typeError, type ValidationErrors } from './common'

/** Discord permits at most three stickers in a message. */
export const MESSAGE_STICKERS_MAX = 3

/** Validates creation input without trusting parsed JSON types or numeric IDs. */
export function validateMessageStickers(payload: {
  sticker_ids?: unknown
  sticker_items?: unknown
  flags?: unknown
}): ValidationErrors {
  const errors: ValidationErrors = {
    ...(payload.sticker_items !== undefined && {
      sticker_items: {
        _errors: [
          {
            code: 'BASE_TYPE_BAD_TYPE',
            message: 'Use sticker_ids; sticker_items is a response field.',
          },
        ],
      },
    }),
  }
  const ids = payload.sticker_ids
  if (ids === undefined || ids === null) return errors
  if (!Array.isArray(ids)) {
    errors.sticker_ids = { _errors: [typeError('array')] }
  } else if (ids.length > MESSAGE_STICKERS_MAX) {
    errors.sticker_ids = { _errors: [maxLengthError(MESSAGE_STICKERS_MAX)] }
  } else if (
    ids.some(
      (id: unknown) =>
        typeof id !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(id) ||
        BigInt(id) > 18_446_744_073_709_551_615n
    ) ||
    new Set(ids).size !== ids.length
  ) {
    errors.sticker_ids = {
      _errors: [
        {
          code: 'BASE_TYPE_BAD_TYPE',
          message: 'Sticker IDs must be distinct nonzero snowflake strings.',
        },
      ],
    }
  } else if (
    ids.length > 0 &&
    typeof payload.flags === 'number' &&
    payload.flags & ((1 << 13) | (1 << 15))
  ) {
    errors.sticker_ids = {
      _errors: [
        {
          code: 'BASE_TYPE_BAD_TYPE',
          message:
            'Stickers cannot be sent with voice messages or components v2.',
        },
      ],
    }
  }
  return errors
}

/** Error for catalog identities that cannot be used in the target channel. */
export function unusableMessageStickersError(): ValidationErrors {
  return {
    sticker_ids: {
      _errors: [
        {
          code: 'STICKER_INVALID',
          message:
            'Unknown, unavailable, or unsupported sticker for this channel.',
        },
      ],
    },
  }
}
