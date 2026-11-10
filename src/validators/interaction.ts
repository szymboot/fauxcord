/** Validation for the locale override on test interactions. */

import { requiredError, typeError, type ValidationErrors } from './common'
import { text, validateMessageComponents } from './message-components'
import { validateMessageEmbeds } from './message'
import { parseAutocompleteChoices } from './autocomplete'
import { isDiscordLocale } from './locales'
import { parseModal } from './modal'

/**
 * Validates an optional invoking-user locale before creating an interaction.
 * @param locale - Raw locale value supplied by the caller
 * @returns Discord-shaped field errors, or an empty object when valid
 */
export function validateInteractionLocale(locale: unknown): ValidationErrors {
  if (locale === undefined) return {}
  if (typeof locale !== 'string') {
    return { locale: { _errors: [typeError('string')] } }
  }
  return isDiscordLocale(locale)
    ? {}
    : {
        locale: {
          _errors: [
            {
              code: 'BASE_TYPE_CHOICES',
              message: 'Value must be a supported Discord locale.',
            },
          ],
        },
      }
}

/**
 * Validates callback structure, modeled direct-message field types, the
 * flags accepted by a deferred response, autocomplete choices (type 8), and
 * modal definitions (type 9).
 * Other callback data retains the mock's existing scope.
 * @param payload - Untrusted callback JSON
 * @returns Discord-shaped validation errors
 */
export function validateInteractionCallback(
  payload: unknown
): ValidationErrors {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return { body: { _errors: [typeError('object')] } }
  }
  const callback = payload as { type?: unknown; data?: unknown }
  if (
    typeof callback.type !== 'number' ||
    ![1, 4, 5, 6, 7, 8, 9, 10, 12, 13].includes(callback.type)
  ) {
    return {
      type: {
        _errors: [
          {
            code: 'BASE_TYPE_CHOICES',
            message: 'Value must be a supported interaction callback type.',
          },
        ],
      },
    }
  }
  if (callback.type === 8 && callback.data != null) {
    if (typeof callback.data !== 'object' || Array.isArray(callback.data)) {
      return { data: { _errors: [typeError('object')] } }
    }
    const errors: ValidationErrors = {}
    for (const [path, error] of Object.entries(
      parseAutocompleteChoices(callback.data).errors
    )) {
      errors[`data.${path}`] = error
    }
    return errors
  }
  if (callback.type === 9 && callback.data !== undefined) {
    if (
      typeof callback.data !== 'object' ||
      callback.data === null ||
      Array.isArray(callback.data)
    ) {
      return { data: { _errors: [typeError('object')] } }
    }
    const errors: ValidationErrors = {}
    for (const [path, error] of Object.entries(
      parseModal(callback.data).errors
    )) {
      errors[`data.${path}`] = error
    }
    return errors
  }
  if (
    callback.data === undefined ||
    (callback.type === 8 && callback.data === null)
  )
    return {}
  if (
    typeof callback.data !== 'object' ||
    callback.data === null ||
    Array.isArray(callback.data)
  ) {
    return { data: { _errors: [typeError('object')] } }
  }
  if (callback.type === 4) {
    const data = callback.data as Record<string, unknown>
    const errors: ValidationErrors = {
      ...(data.content != null &&
        typeof data.content !== 'string' && {
          'data.content': { _errors: [typeError('string')] },
        }),
      ...(data.tts != null &&
        typeof data.tts !== 'boolean' && {
          'data.tts': { _errors: [typeError('boolean')] },
        }),
      ...(data.flags != null &&
        (typeof data.flags !== 'number' ||
          !Number.isSafeInteger(data.flags)) && {
          'data.flags': { _errors: [typeError('integer')] },
        }),
    }
    const embedErrors = {
      ...validateMessageEmbeds(data.embeds),
      ...validateMessageComponents(data.components, data.flags),
    }
    for (const [path, error] of Object.entries(embedErrors)) {
      errors[`data.${path}`] = error
    }
    return errors
  }
  if (callback.type !== 5) return {}
  const { flags } = callback.data as { flags?: unknown }
  return flags !== undefined && flags !== 0 && flags !== 64
    ? {
        'data.flags': {
          _errors: [
            {
              code: 'BASE_TYPE_CHOICES',
              message:
                'Deferred responses only support the EPHEMERAL flag (64).',
            },
          ],
        },
      }
    : {}
}

/** Fields accepted by `POST /_test/interactions` that need validation. */
export interface TestInteractionFields {
  application_id?: unknown
  channel_id?: unknown
  message_id?: unknown
  custom_id?: unknown
  user_id?: unknown
  guild_id?: unknown
  command_name?: unknown
  command_type?: unknown
  target_id?: unknown
  type?: unknown
  options?: unknown
  locale?: unknown
}

/** Snowflake string check shared by component interaction identifiers. */
const SNOWFLAKE = /^[1-9]\d{0,19}$/

/**
 * Validates a simulated MESSAGE_COMPONENT (type 3) interaction request: the
 * identifiers of the application, channel, message, and clicking user are
 * required, `guild_id` is optional, and every command-only field is refused.
 * @param fields - Request body fields
 * @returns Discord-shaped field errors, or an empty object when valid
 */
function validateTestComponentInteraction(
  fields: TestInteractionFields
): ValidationErrors {
  const errors = validateInteractionLocale(fields.locale)
  for (const key of [
    'application_id',
    'channel_id',
    'message_id',
    'user_id',
  ] as const) {
    if (fields[key] === undefined) errors[key] = { _errors: [requiredError()] }
    else if (typeof fields[key] !== 'string' || !SNOWFLAKE.test(fields[key]))
      errors[key] = { _errors: [typeError('Snowflake string')] }
  }
  if (
    fields.guild_id !== undefined &&
    (typeof fields.guild_id !== 'string' || !SNOWFLAKE.test(fields.guild_id))
  ) {
    errors.guild_id = { _errors: [typeError('Snowflake string')] }
  }
  // Same required/type/character-count rule as the button's own custom_id.
  text(fields.custom_id, 'custom_id', 100, errors, true)
  for (const key of [
    'command_name',
    'command_type',
    'target_id',
    'options',
  ] as const) {
    if (fields[key] !== undefined) {
      errors[key] = {
        _errors: [
          {
            code: 'BASE_TYPE_BAD_VALUE',
            message: 'Not allowed for MESSAGE_COMPONENT (3) interactions.',
          },
        ],
      }
    }
  }
  return errors
}

/**
 * Counts the options marked `focused: true` anywhere in an option tree
 * (subcommands and subcommand groups nest their options) and records the
 * first malformed option.
 * @param options - Raw option list
 * @param path - Error path of the list
 * @param errors - Collector for validation errors
 * @returns How many focused options the tree holds
 */
function countFocusedOptions(
  options: unknown,
  path: string,
  errors: ValidationErrors
): number {
  if (options === undefined) return 0
  if (!Array.isArray(options)) {
    errors[path] = { _errors: [typeError('list')] }
    return 0
  }
  let focused = 0
  for (const [index, option] of options.entries()) {
    const optionPath = `${path}.${index}`
    if (
      typeof option !== 'object' ||
      option === null ||
      Array.isArray(option)
    ) {
      errors[optionPath] = { _errors: [typeError('object')] }
      continue
    }
    const {
      focused: isFocused,
      value,
      options: nested,
    } = option as {
      focused?: unknown
      value?: unknown
      options?: unknown
    }
    if (isFocused === true) {
      focused += 1
      // Discord sends the partially typed text as a string for every
      // option type, including integer and number options.
      if (value !== undefined && typeof value !== 'string') {
        errors[`${optionPath}.value`] = { _errors: [typeError('string')] }
      }
    }
    focused += countFocusedOptions(nested, `${optionPath}.options`, errors)
  }
  return focused
}

/**
 * Validates which options a CHAT_INPUT request focuses: an autocomplete
 * interaction (`type: 4`) has exactly one focused option anywhere in its
 * option tree, an APPLICATION_COMMAND interaction has none. Other
 * interaction types keep their options unvalidated.
 * @param fields - Request body fields
 * @param errors - Collector for validation errors
 */
function validateFocusedOptions(
  fields: TestInteractionFields,
  errors: ValidationErrors
): void {
  const interactionType = fields.type ?? 2
  if (interactionType !== 2 && interactionType !== 4) return
  const optionErrors: ValidationErrors = {}
  const focused = countFocusedOptions(fields.options, 'options', optionErrors)
  if (Object.keys(optionErrors).length > 0) {
    Object.assign(errors, optionErrors)
    return
  }
  if (interactionType === 4 && focused !== 1) {
    errors.options = {
      _errors: [
        {
          code: 'BASE_TYPE_BAD_VALUE',
          message:
            'AUTOCOMPLETE (4) interactions need exactly one option with focused: true.',
        },
      ],
    }
  } else if (interactionType === 2 && focused > 0) {
    errors.options = {
      _errors: [
        {
          code: 'BASE_TYPE_BAD_VALUE',
          message: 'Only AUTOCOMPLETE (4) interactions have a focused option.',
        },
      ],
    }
  }
}

/**
 * Validates the fields of a simulated interaction request. A MESSAGE_COMPONENT
 * (`type: 3`) button click is validated as such; otherwise the fields that
 * select the command kind are checked: `command_type` (1 CHAT_INPUT, 2 USER), the USER command's
 * `target_id`, the invoking user's locale, and the focused option of
 * autocomplete (`type: 4`) versus command (`type: 2`) requests. `command_type` defaults to 2
 * when a `target_id` is given and to 1 otherwise.
 * @param body - Untrusted request body
 * @returns Discord-shaped field errors, or an empty object when valid
 */
export function validateTestInteraction(body: unknown): ValidationErrors {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { body: { _errors: [typeError('object')] } }
  }
  const fields = body as TestInteractionFields
  if (fields.type === 3) return validateTestComponentInteraction(fields)
  const errors = validateInteractionLocale(fields.locale)
  const choices = (message: string): ValidationErrors[string] => ({
    _errors: [{ code: 'BASE_TYPE_CHOICES', message }],
  })
  const bad = (message: string): ValidationErrors[string] => ({
    _errors: [{ code: 'BASE_TYPE_BAD_VALUE', message }],
  })
  const { command_type: commandType, target_id: targetId } = fields
  if (commandType !== undefined && commandType !== 1 && commandType !== 2) {
    errors.command_type = choices(
      commandType === 3
        ? 'MESSAGE commands (3) are not supported; use 1 (CHAT_INPUT) or 2 (USER).'
        : 'Value must be 1 (CHAT_INPUT) or 2 (USER).'
    )
    return errors
  }
  const kind = commandType ?? (targetId === undefined ? 1 : 2)
  if (kind === 1) {
    if (targetId !== undefined) {
      errors.target_id = bad(
        'Only USER commands (command_type 2) have a target.'
      )
    }
    validateFocusedOptions(fields, errors)
    return errors
  }
  if (targetId === undefined) {
    errors.target_id = { _errors: [requiredError()] }
  } else if (
    typeof targetId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(targetId)
  ) {
    errors.target_id = { _errors: [typeError('Snowflake string')] }
  }
  if (fields.type !== undefined && fields.type !== 2) {
    errors.type = bad('USER commands are APPLICATION_COMMAND interactions (2).')
  }
  if (
    fields.options !== undefined &&
    !(Array.isArray(fields.options) && fields.options.length === 0)
  ) {
    errors.options = bad('USER commands do not take options.')
  }
  return errors
}

/**
 * Validates the body of `POST /_test/interactions/:id/modal-submit`.
 * @param body - Untrusted request body
 * @returns Discord-shaped field errors, or an empty object when valid
 */
export function validateModalSubmitRequest(body: unknown): ValidationErrors {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { body: { _errors: [typeError('object')] } }
  }
  const { custom_id: customId, values } = body as {
    custom_id?: unknown
    values?: unknown
  }
  const errors: ValidationErrors = {}
  if (customId === undefined) {
    errors.custom_id = { _errors: [requiredError()] }
  } else if (typeof customId !== 'string') {
    errors.custom_id = { _errors: [typeError('string')] }
  }
  if (
    values !== undefined &&
    (typeof values !== 'object' || values === null || Array.isArray(values))
  ) {
    errors.values = { _errors: [typeError('object')] }
  }
  return errors
}
