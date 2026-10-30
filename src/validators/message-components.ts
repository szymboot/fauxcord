/** Validation and response normalization for classic rows of buttons. */

import type {
  APIActionRowComponent,
  APIButtonComponentWithCustomId,
  APIButtonComponentWithURL,
} from 'discord-api-types/v10'
import {
  maxLengthError,
  requiredError,
  typeError,
  type ValidationErrors,
} from './common'

/** The supported classic message component subset. */
export type MessageComponents = APIActionRowComponent<
  APIButtonComponentWithCustomId | APIButtonComponentWithURL
>[]

/** Link style, typed without importing Discord runtime values. */
const LINK_BUTTON_STYLE: APIButtonComponentWithURL['style'] = 5

/** Checks an untrusted component or emoji object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Adds an invalid component field error using the shared dotted paths. */
export function invalid(
  errors: ValidationErrors,
  path: string,
  message: string
): void {
  errors[path] = { _errors: [{ code: 'BASE_TYPE_BAD_VALUE', message }] }
}

/** Validates a component string without trimming developer identifiers. */
export function text(
  value: unknown,
  path: string,
  maximum: number,
  errors: ValidationErrors,
  required = false
): void {
  if (value == null) {
    if (required) errors[path] = { _errors: [requiredError()] }
    return
  }
  if (typeof value !== 'string') {
    errors[path] = { _errors: [typeError('string')] }
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  if ([...value].length > maximum) {
    errors[path] = { _errors: [maxLengthError(maximum)] }
  } else if (required && value.length === 0) {
    errors[path] = { _errors: [requiredError()] }
  }
}

/** Validates the emoji shape; no live Discord emoji lookup is performed. */
export function emoji(
  value: unknown,
  path: string,
  errors: ValidationErrors
): void {
  if (value == null) return
  if (!isObject(value)) {
    errors[path] = { _errors: [typeError('object')] }
    return
  }
  text(value.name, `${path}.name`, 32, errors)
  if (
    value.id != null &&
    (typeof value.id !== 'string' || !/^[1-9]\d{0,19}$/.test(value.id))
  ) {
    errors[`${path}.id`] = { _errors: [typeError('Snowflake string')] }
  }
  if (!value.id && !value.name) {
    invalid(errors, path, 'An emoji must have an id or name.')
  }
  if (value.animated != null && typeof value.animated !== 'boolean') {
    errors[`${path}.animated`] = { _errors: [typeError('boolean')] }
  }
}

/** Validates one button and tracks message-wide custom identifier uniqueness. */
function button(
  value: unknown,
  path: string,
  ids: Set<string>,
  errors: ValidationErrors
): void {
  if (!isObject(value)) {
    errors[path] = { _errors: [typeError('object')] }
    return
  }
  if (value.type !== 2) {
    invalid(
      errors,
      `${path}.type`,
      'Only classic buttons (type 2) are supported.'
    )
    return
  }
  if (value.id != null && value.id !== 0) {
    invalid(errors, `${path}.id`, 'Only legacy component id 0 is supported.')
  }
  if (![1, 2, 3, 4, 5].includes(value.style as number)) {
    invalid(errors, `${path}.style`, 'Button style must be 1, 2, 3, 4, or 5.')
  }
  text(value.label, `${path}.label`, 80, errors)
  emoji(value.emoji, `${path}.emoji`, errors)
  if (
    !(typeof value.label === 'string' && value.label.length > 0) &&
    value.emoji == null
  ) {
    invalid(errors, `${path}.label`, 'A button must have a label or emoji.')
  }
  if (value.disabled != null && typeof value.disabled !== 'boolean') {
    errors[`${path}.disabled`] = { _errors: [typeError('boolean')] }
  }
  if (value.sku_id != null) {
    invalid(errors, `${path}.sku_id`, 'Premium buttons are not supported.')
  }
  if (value.style === 5) {
    text(value.url, `${path}.url`, 512, errors, true)
    if (typeof value.url === 'string' && !URL.canParse(value.url)) {
      invalid(errors, `${path}.url`, 'Must be a valid URL.')
    } else if (
      typeof value.url === 'string' &&
      !['http:', 'https:', 'discord:'].includes(new URL(value.url).protocol)
    ) {
      invalid(errors, `${path}.url`, 'Must use http, https, or discord.')
    }
    if (value.custom_id != null) {
      invalid(
        errors,
        `${path}.custom_id`,
        'Link buttons cannot have a custom_id.'
      )
    }
  } else {
    text(value.custom_id, `${path}.custom_id`, 100, errors, true)
    if (typeof value.custom_id === 'string') {
      if (ids.has(value.custom_id)) {
        invalid(
          errors,
          `${path}.custom_id`,
          'Component custom_id must be unique within the message.'
        )
      }
      ids.add(value.custom_id)
    }
    if (value.url != null) {
      invalid(errors, `${path}.url`, 'Non-link buttons cannot have a url.')
    }
  }
}

/** Validates untrusted components and rejects unsupported components v2. */
export function validateMessageComponents(
  components: unknown,
  flags?: unknown
): ValidationErrors {
  const errors: ValidationErrors = {}
  if (typeof flags === 'number' && (flags & 32_768) !== 0) {
    invalid(errors, 'flags', 'Components v2 are not supported.')
  }
  if (components == null) return errors
  if (!Array.isArray(components)) {
    errors.components = { _errors: [typeError('array')] }
    return errors
  }
  if (components.length > 5) {
    errors.components = { _errors: [maxLengthError(5)] }
  }
  const ids = new Set<string>()
  for (const [index, row] of components.entries()) {
    const path = `components.${index}`
    if (!isObject(row)) {
      errors[path] = { _errors: [typeError('object')] }
      continue
    }
    if (row.type !== 1) {
      invalid(
        errors,
        `${path}.type`,
        'Only classic action rows (type 1) are supported.'
      )
      continue
    }
    if (row.id != null && row.id !== 0) {
      invalid(errors, `${path}.id`, 'Only legacy component id 0 is supported.')
    }
    const children: unknown = row.components
    if (!Array.isArray(children)) {
      errors[`${path}.components`] = { _errors: [typeError('array')] }
      continue
    }
    if (children.length === 0 || children.length > 5) {
      invalid(
        errors,
        `${path}.components`,
        'An action row must contain 1 to 5 buttons.'
      )
    }
    for (const [childIndex, child] of children.entries()) {
      button(child, `${path}.components.${childIndex}`, ids, errors)
    }
  }
  return errors
}

/**
 * Copies validated classic components into their stored response shape.
 * Legacy IDs are 0; null optional fields and unknown fields are omitted.
 */
export function normalizeMessageComponents(
  components: MessageComponents | null | undefined
): MessageComponents {
  return (components ?? []).map((row) => ({
    type: 1,
    id: 0,
    components: row.components.map((component) => {
      const { emoji: icon } = component
      return {
        type: 2,
        id: 0,
        style: component.style,
        ...(component.label != null && { label: component.label }),
        ...(component.disabled != null && { disabled: component.disabled }),
        ...(icon != null && {
          emoji: {
            ...(icon.id != null && { id: icon.id }),
            ...(icon.name != null && { name: icon.name }),
            ...(icon.animated != null && { animated: icon.animated }),
          },
        }),
        ...(component.style === LINK_BUTTON_STYLE
          ? { url: component.url }
          : { custom_id: component.custom_id }),
      }
    }),
  })) as MessageComponents
}
