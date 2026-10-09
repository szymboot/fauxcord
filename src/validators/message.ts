/**
 * Message validation
 *
 * Provides validation conforming to Discord API v10 message limits.
 */

import {
  maxLengthError,
  requiredError,
  typeError,
  type ValidationErrors,
} from './common'

/** Message creation request type */
export interface MessageCreatePayload {
  content?: string
  tts?: boolean
  /** Discord clients may send null (e.g. discordgo). null is treated the same as an empty array */
  embeds?: EmbedPayload[] | null
  message_reference?: { message_id?: string }
  components?: unknown[]
  flags?: number
  attachments?: unknown[]
  sticker_ids?: string[] | null
  poll?: PollCreatePayloadField
}

/** Embed type */
export interface EmbedPayload {
  title?: string | null
  description?: string | null
  fields?: { name: string; value: string; inline?: boolean | null }[] | null
  footer?: { text?: string | null; icon_url?: string } | null
  author?: { name?: string | null; url?: string; icon_url?: string } | null
  url?: string
  color?: number
  timestamp?: string
  image?: { url: string }
  thumbnail?: { url: string }
}

/** Message limit values */
export const MESSAGE_LIMITS = {
  CONTENT_MAX: 2000,
  EMBEDS_MAX: 10,
  EMBED_TOTAL_CHARS: 6000,
  ATTACHMENTS_MAX: 10,
  EMBED_TITLE_MAX: 256,
  EMBED_DESCRIPTION_MAX: 4096,
  EMBED_FIELDS_MAX: 25,
  EMBED_FIELD_NAME_MAX: 256,
  EMBED_FIELD_VALUE_MAX: 1024,
  EMBED_FOOTER_TEXT_MAX: 2048,
  EMBED_AUTHOR_NAME_MAX: 256,
} as const

/** Untrusted message fields read by the shared create/edit validator. */
interface MessageValidationInput {
  content?: unknown
  embeds?: unknown
}

/** Checks a JSON value before accessing its properties. */
function isEmbedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates one budgeted embed string and returns its character count.
 * Discord trims surrounding whitespace; JSON Schema maxLength counts Unicode
 * code points, rather than UTF-16 code units or user-perceived graphemes.
 * Optional strings accept null; field names and values are required strings,
 * with no minimum length in the official RichEmbedField request schema.
 */
function validateEmbedText(
  value: unknown,
  path: string,
  limit: number,
  errors: ValidationErrors,
  required = false
): number {
  if (value === undefined || (!required && value === null)) {
    if (required) errors[path] = { _errors: [requiredError()] }
    return 0
  }
  if (typeof value !== 'string') {
    errors[path] = { _errors: [typeError('string')] }
    return 0
  }
  // Code points are intentional here: grapheme segmentation would disagree
  // with the official request schema (e.g. combining marks count separately).
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const length = [...value.trim()].length
  if (length > limit) errors[path] = { _errors: [maxLengthError(limit)] }
  return length
}

/**
 * Validates embed text, nested text containers, and the message-wide budget.
 * Reads untrusted JSON without coercion or mutation. Null/omitted collections
 * and optional objects are empty; embed and field entries must be objects.
 * @param embeds - Untrusted embed collection
 * @returns Discord validation errors, keyed by the offending field path
 */
export function validateMessageEmbeds(embeds: unknown): ValidationErrors {
  const errors: ValidationErrors = {}
  if (embeds === undefined || embeds === null) return errors
  if (!Array.isArray(embeds)) {
    return { embeds: { _errors: [typeError('array')] } }
  }
  if (embeds.length > MESSAGE_LIMITS.EMBEDS_MAX) {
    errors.embeds = { _errors: [maxLengthError(MESSAGE_LIMITS.EMBEDS_MAX)] }
  }

  let total = 0
  for (const [index, embed] of embeds.entries()) {
    const path = `embeds.${index}`
    if (!isEmbedObject(embed)) {
      errors[path] = { _errors: [typeError('object')] }
      continue
    }
    total += validateEmbedText(
      embed.title,
      `${path}.title`,
      MESSAGE_LIMITS.EMBED_TITLE_MAX,
      errors
    )
    total += validateEmbedText(
      embed.description,
      `${path}.description`,
      MESSAGE_LIMITS.EMBED_DESCRIPTION_MAX,
      errors
    )
    for (const [property, textProperty, limit] of [
      ['footer', 'text', MESSAGE_LIMITS.EMBED_FOOTER_TEXT_MAX],
      ['author', 'name', MESSAGE_LIMITS.EMBED_AUTHOR_NAME_MAX],
    ] as const) {
      const nested = embed[property]
      if (nested === undefined || nested === null) continue
      if (!isEmbedObject(nested)) {
        errors[`${path}.${property}`] = { _errors: [typeError('object')] }
        continue
      }
      total += validateEmbedText(
        nested[textProperty],
        `${path}.${property}.${textProperty}`,
        limit,
        errors
      )
    }
    const fields: unknown = embed.fields
    if (fields === undefined || fields === null) continue
    if (!Array.isArray(fields)) {
      errors[`${path}.fields`] = { _errors: [typeError('array')] }
      continue
    }
    if (fields.length > MESSAGE_LIMITS.EMBED_FIELDS_MAX) {
      errors[`${path}.fields`] = {
        _errors: [maxLengthError(MESSAGE_LIMITS.EMBED_FIELDS_MAX)],
      }
    }
    for (const [fieldIndex, field] of fields.entries()) {
      const fieldPath = `${path}.fields.${fieldIndex}`
      if (!isEmbedObject(field)) {
        errors[fieldPath] = { _errors: [typeError('object')] }
        continue
      }
      total += validateEmbedText(
        field.name,
        `${fieldPath}.name`,
        MESSAGE_LIMITS.EMBED_FIELD_NAME_MAX,
        errors,
        true
      )
      total += validateEmbedText(
        field.value,
        `${fieldPath}.value`,
        MESSAGE_LIMITS.EMBED_FIELD_VALUE_MAX,
        errors,
        true
      )
      if (field.inline != null && typeof field.inline !== 'boolean') {
        errors[`${fieldPath}.inline`] = { _errors: [typeError('boolean')] }
      }
    }
  }
  if (total > MESSAGE_LIMITS.EMBED_TOTAL_CHARS) {
    if (!Object.hasOwn(errors, 'embeds')) errors.embeds = { _errors: [] }
    errors.embeds._errors.push({
      code: 'EMBED_SIZE_EXCEEDS_MAX',
      message: `Embed size exceeds maximum size of ${MESSAGE_LIMITS.EMBED_TOTAL_CHARS}.`,
    })
  }
  return errors
}

/**
 * Validates a message creation or edit payload before any mutation.
 * @param payload - Untrusted message fields to validate
 * @param _hasAttachments - Whether attachments are present (currently unused)
 * @returns Validation error map (empty object if no errors)
 */
export function validateMessageCreate(
  payload: MessageValidationInput,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _hasAttachments = false
): ValidationErrors {
  return {
    ...(typeof payload.content === 'string' &&
      payload.content.length > MESSAGE_LIMITS.CONTENT_MAX && {
        content: { _errors: [maxLengthError(MESSAGE_LIMITS.CONTENT_MAX)] },
      }),
    ...validateMessageEmbeds(payload.embeds),
  }
}

/**
 * Checks whether a message is empty.
 * @param payload - Payload to check
 * @param hasAttachments - Whether attachments are present
 * @param hasStickers - Whether validated stickers are present
 * @returns true if empty
 */
export function isEmptyMessage(
  payload: MessageCreatePayload,
  hasAttachments: boolean,
  hasStickers = false
): boolean {
  const hasContent = payload.content && payload.content.length > 0
  const hasEmbeds = Array.isArray(payload.embeds) && payload.embeds.length > 0
  return !hasContent && !hasEmbeds && !hasAttachments && !hasStickers
}

/** Poll answer payload (a single option in a poll) */
export interface PollAnswerPayload {
  poll_media: {
    text: string
    emoji?: { id?: string | null; name?: string } | null
  }
}

/** `poll` field payload of a message-create request */
export interface PollCreatePayloadField {
  question: { text: string }
  answers: PollAnswerPayload[]
  duration?: number
  allow_multiselect?: boolean
}

/** Poll limit values (from the Discord spec) */
export const POLL_LIMITS = {
  QUESTION_MAX: 300,
  ANSWER_TEXT_MAX: 55,
  ANSWERS_MIN: 1,
  ANSWERS_MAX: 10,
  DURATION_MAX: 768,
} as const

/**
 * `poll` field shape as seen by the validator: every nested field is
 * declared optional/unknown, since the caller casts an untrusted JSON body
 * to this type before validation — the guards below must not assume any
 * field actually conforms to `PollCreatePayloadField` at runtime.
 */
interface PollCreateValidationInput {
  question?: { text?: unknown }
  answers?: { poll_media?: { text?: unknown } }[]
  duration?: unknown
}

/**
 * Validates a message creation `poll` field.
 * @param payload - The `poll` field to validate
 * @returns Validation error map (empty when valid)
 */
export function validatePollCreate(
  payload: PollCreateValidationInput
): ValidationErrors {
  const errors: ValidationErrors = {}

  if (
    typeof payload.question?.text !== 'string' ||
    payload.question.text.length === 0
  ) {
    errors['poll.question.text'] = { _errors: [requiredError()] }
  } else if (payload.question.text.length > POLL_LIMITS.QUESTION_MAX) {
    errors['poll.question.text'] = {
      _errors: [maxLengthError(POLL_LIMITS.QUESTION_MAX)],
    }
  }

  if (
    !Array.isArray(payload.answers) ||
    payload.answers.length < POLL_LIMITS.ANSWERS_MIN
  ) {
    errors['poll.answers'] = { _errors: [requiredError()] }
  } else if (payload.answers.length > POLL_LIMITS.ANSWERS_MAX) {
    errors['poll.answers'] = {
      _errors: [maxLengthError(POLL_LIMITS.ANSWERS_MAX)],
    }
  } else {
    for (const [i, answer] of payload.answers.entries()) {
      const text = answer.poll_media?.text
      if (typeof text !== 'string' || text.length === 0) {
        errors[`poll.answers.${i}.poll_media.text`] = {
          _errors: [requiredError()],
        }
      } else if (text.length > POLL_LIMITS.ANSWER_TEXT_MAX) {
        errors[`poll.answers.${i}.poll_media.text`] = {
          _errors: [maxLengthError(POLL_LIMITS.ANSWER_TEXT_MAX)],
        }
      }
    }
  }

  if (
    payload.duration !== undefined &&
    (typeof payload.duration !== 'number' ||
      payload.duration <= 0 ||
      payload.duration > POLL_LIMITS.DURATION_MAX)
  ) {
    errors['poll.duration'] = {
      _errors: [
        {
          code: 'NUMBER_TYPE_MAX',
          message: `Must be an integer between 1 and ${POLL_LIMITS.DURATION_MAX}.`,
        },
      ],
    }
  }

  return errors
}
