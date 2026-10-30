/**
 * Modal validation, normalization, and submission building.
 *
 * Supports the Discord modal component subset that carries user input:
 * Label (18) wrapping a Text Input (4) or String Select (3), and the legacy
 * Action Row (1) wrapping one Text Input. Every other component is rejected
 * explicitly. Field errors use the shared dotted-path format.
 */

import {
  maxLengthError,
  requiredError,
  typeError,
  type ValidationErrors,
} from './common'
import { emoji, invalid, isObject, text } from './message-components'

/** Component type numbers used by modals. */
const ACTION_ROW = 1
const STRING_SELECT = 3
const TEXT_INPUT = 4
const LABEL = 18

/** Largest value of the 32-bit component `id`. */
const MAX_COMPONENT_ID = 2_147_483_647

/** Text Input as shown in a modal, with defaults applied. */
export interface ModalTextInput {
  type: 4
  id: number
  custom_id: string
  style: 1 | 2
  label?: string
  placeholder?: string
  value?: string
  required: boolean
  min_length?: number
  max_length?: number
}

/** One option of a modal String Select. */
export interface ModalSelectOption {
  label: string
  value: string
  description?: string
  emoji?: Record<string, unknown>
  default?: boolean
}

/** String Select as shown in a modal, with defaults applied. */
export interface ModalStringSelect {
  type: 3
  id: number
  custom_id: string
  placeholder?: string
  options: ModalSelectOption[]
  min_values: number
  max_values: number
  required: boolean
}

/** Label wrapping one input component. */
export interface ModalLabel {
  type: 18
  id: number
  label: string
  description?: string
  component: ModalTextInput | ModalStringSelect
}

/** Legacy Action Row wrapping one Text Input. */
export interface ModalActionRow {
  type: 1
  id: number
  components: [ModalTextInput]
}

/** A top-level modal component. */
export type ModalComponent = ModalLabel | ModalActionRow

/** A validated, normalized modal. */
export interface ModalObject {
  custom_id: string
  title: string
  components: ModalComponent[]
}

/** Result of parsing an untrusted modal callback `data` object. */
export type ParsedModal =
  | { errors: ValidationErrors; modal?: undefined }
  | { errors: Record<string, never>; modal: ModalObject }

/** Mutable state shared while walking one modal. */
interface ParseState {
  errors: ValidationErrors
  customIds: Set<string>
  explicitIds: Set<number>
}

/** Marks an unsupported component type with an explicit message. */
function unsupported(
  state: ParseState,
  path: string,
  type: unknown,
  supported: string
): void {
  invalid(
    state.errors,
    `${path}.type`,
    `Component type ${typeof type === 'number' ? type : 'unknown'} is not supported in modals here. Supported: ${supported}.`
  )
}

/** Validates an optional integer in an inclusive range. */
function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  state: ParseState
): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    state.errors[path] = { _errors: [typeError('integer')] }
    return undefined
  }
  if (value < minimum || value > maximum) {
    invalid(state.errors, path, `Must be between ${minimum} and ${maximum}.`)
    return undefined
  }
  return value
}

/** Validates an optional boolean. */
function bool(
  value: unknown,
  path: string,
  state: ParseState
): boolean | undefined {
  if (value == null) return undefined
  if (typeof value !== 'boolean') {
    state.errors[path] = { _errors: [typeError('boolean')] }
    return undefined
  }
  return value
}

/** Validates an input's `custom_id` and enforces modal-wide uniqueness. */
function customId(
  value: unknown,
  path: string,
  state: ParseState
): string | undefined {
  text(value, path, 100, state.errors, true)
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (state.customIds.has(value)) {
    invalid(state.errors, path, 'Component custom_id must be unique.')
    return undefined
  }
  state.customIds.add(value)
  return value
}

/** Validates the optional component `id`; 0 or absent means auto-assigned. */
function componentId(value: unknown, path: string, state: ParseState): number {
  const id = integer(value, `${path}.id`, 0, MAX_COMPONENT_ID, state) ?? 0
  if (id !== 0) {
    if (state.explicitIds.has(id)) {
      invalid(state.errors, `${path}.id`, 'Component id must be unique.')
    }
    state.explicitIds.add(id)
  }
  return id
}

/** Validates one Text Input; legacy rows must carry their own label. */
function textInput(
  value: Record<string, unknown>,
  path: string,
  state: ParseState,
  legacyLabel: boolean
): ModalTextInput {
  const id = componentId(value.id, path, state)
  const custom = customId(value.custom_id, `${path}.custom_id`, state)
  if (value.style !== 1 && value.style !== 2) {
    invalid(
      state.errors,
      `${path}.style`,
      'Text input style must be 1 (short) or 2 (paragraph).'
    )
  }
  const minLength = integer(
    value.min_length,
    `${path}.min_length`,
    0,
    4000,
    state
  )
  const maxLength = integer(
    value.max_length,
    `${path}.max_length`,
    1,
    4000,
    state
  )
  if (
    minLength !== undefined &&
    maxLength !== undefined &&
    minLength > maxLength
  ) {
    invalid(
      state.errors,
      `${path}.min_length`,
      'min_length cannot exceed max_length.'
    )
  }
  const required = bool(value.required, `${path}.required`, state)
  text(value.label, `${path}.label`, 45, state.errors, legacyLabel)
  text(value.placeholder, `${path}.placeholder`, 100, state.errors)
  text(value.value, `${path}.value`, 4000, state.errors)
  return {
    type: TEXT_INPUT,
    id,
    custom_id: custom ?? '',
    style: value.style === 2 ? 2 : 1,
    ...(typeof value.label === 'string' &&
      value.label.length > 0 && { label: value.label }),
    ...(typeof value.placeholder === 'string' &&
      value.placeholder.length > 0 && { placeholder: value.placeholder }),
    ...(typeof value.value === 'string' &&
      value.value.length > 0 && { value: value.value }),
    required: required ?? true,
    ...(minLength !== undefined && minLength > 0 && { min_length: minLength }),
    ...(maxLength !== undefined && { max_length: maxLength }),
  }
}

/** Validates the options of a String Select; returns the normalized list. */
function selectOptions(
  value: unknown,
  path: string,
  state: ParseState
): ModalSelectOption[] {
  if (!Array.isArray(value)) {
    state.errors[path] = {
      _errors: [value == null ? requiredError() : typeError('array')],
    }
    return []
  }
  if (value.length === 0 || value.length > 25) {
    invalid(state.errors, path, 'A select menu must have 1 to 25 options.')
  }
  const seen = new Set<string>()
  const options: ModalSelectOption[] = []
  for (const [index, raw] of value.entries()) {
    const optionPath = `${path}.${index}`
    if (!isObject(raw)) {
      state.errors[optionPath] = { _errors: [typeError('object')] }
      continue
    }
    text(raw.label, `${optionPath}.label`, 100, state.errors, true)
    text(raw.value, `${optionPath}.value`, 100, state.errors, true)
    text(raw.description, `${optionPath}.description`, 100, state.errors)
    emoji(raw.emoji, `${optionPath}.emoji`, state.errors)
    bool(raw.default, `${optionPath}.default`, state)
    if (typeof raw.value === 'string') {
      if (seen.has(raw.value)) {
        invalid(
          state.errors,
          `${optionPath}.value`,
          'Option values must be unique.'
        )
      }
      seen.add(raw.value)
    }
    options.push({
      label: typeof raw.label === 'string' ? raw.label : '',
      value: typeof raw.value === 'string' ? raw.value : '',
      ...(typeof raw.description === 'string' &&
        raw.description.length > 0 && { description: raw.description }),
      ...(isObject(raw.emoji) && { emoji: raw.emoji }),
      ...(raw.default === true && { default: true }),
    })
  }
  return options
}

/** Validates one String Select; it may only appear inside a Label. */
function stringSelect(
  value: Record<string, unknown>,
  path: string,
  state: ParseState
): ModalStringSelect {
  const id = componentId(value.id, path, state)
  const custom = customId(value.custom_id, `${path}.custom_id`, state)
  const options = selectOptions(value.options, `${path}.options`, state)
  text(value.placeholder, `${path}.placeholder`, 150, state.errors)
  const minValues = integer(
    value.min_values,
    `${path}.min_values`,
    0,
    25,
    state
  )
  const maxValues = integer(
    value.max_values,
    `${path}.max_values`,
    1,
    25,
    state
  )
  // Compare the effective bounds: both default to 1 when omitted.
  if ((minValues ?? 1) > (maxValues ?? 1)) {
    invalid(
      state.errors,
      `${path}.min_values`,
      'min_values cannot exceed max_values.'
    )
  }
  if ((minValues ?? 1) > options.length) {
    invalid(
      state.errors,
      `${path}.min_values`,
      'min_values cannot exceed the number of options.'
    )
  }
  const required = bool(value.required, `${path}.required`, state)
  if (minValues === 0 && required !== false) {
    invalid(
      state.errors,
      `${path}.min_values`,
      'min_values must be omitted or at least 1 when required is omitted or true.'
    )
  }
  if (value.disabled != null && value.disabled !== false) {
    invalid(
      state.errors,
      `${path}.disabled`,
      'Select menus cannot be disabled in modals.'
    )
  }
  const defaults = options.filter((option) => option.default === true).length
  if (defaults > (maxValues ?? 1)) {
    invalid(
      state.errors,
      `${path}.options`,
      'More default options than max_values allows.'
    )
  }
  return {
    type: STRING_SELECT,
    id,
    custom_id: custom ?? '',
    ...(typeof value.placeholder === 'string' &&
      value.placeholder.length > 0 && { placeholder: value.placeholder }),
    options,
    min_values: minValues ?? 1,
    max_values: maxValues ?? 1,
    required: required ?? true,
  }
}

/** Validates a Label and its single input component. */
function label(
  value: Record<string, unknown>,
  path: string,
  state: ParseState
): ModalLabel | undefined {
  const id = componentId(value.id, path, state)
  text(value.label, `${path}.label`, 45, state.errors, true)
  text(value.description, `${path}.description`, 100, state.errors)
  const child = value.component
  if (!isObject(child)) {
    state.errors[`${path}.component`] = {
      _errors: [child == null ? requiredError() : typeError('object')],
    }
    return undefined
  }
  const childPath = `${path}.component`
  let component: ModalTextInput | ModalStringSelect | undefined
  if (child.type === TEXT_INPUT) {
    component = textInput(child, childPath, state, false)
  } else if (child.type === STRING_SELECT) {
    component = stringSelect(child, childPath, state)
  } else {
    unsupported(
      state,
      childPath,
      child.type,
      'text input (4) and string select (3)'
    )
    return undefined
  }
  return {
    type: LABEL,
    id,
    label: typeof value.label === 'string' ? value.label : '',
    ...(typeof value.description === 'string' &&
      value.description.length > 0 && { description: value.description }),
    component,
  }
}

/** Validates a legacy Action Row holding exactly one Text Input. */
function actionRow(
  value: Record<string, unknown>,
  path: string,
  state: ParseState
): ModalActionRow | undefined {
  const id = componentId(value.id, path, state)
  const children: unknown = value.components
  if (!Array.isArray(children)) {
    state.errors[`${path}.components`] = { _errors: [typeError('array')] }
    return undefined
  }
  if (children.length !== 1) {
    invalid(
      state.errors,
      `${path}.components`,
      'A modal action row must contain exactly one text input.'
    )
  }
  const child: unknown = children[0]
  const childPath = `${path}.components.0`
  if (!isObject(child)) {
    state.errors[childPath] = { _errors: [typeError('object')] }
    return undefined
  }
  if (child.type !== TEXT_INPUT) {
    invalid(
      state.errors,
      `${childPath}.type`,
      'Only text inputs (4) can be placed directly in an action row; wrap other inputs in a label (18).'
    )
    return undefined
  }
  return {
    type: ACTION_ROW,
    id,
    components: [textInput(child, childPath, state, true)],
  }
}

/** Visits every component in document order, parents before children. */
function assignIds(components: ModalComponent[], state: ParseState): void {
  let next = 1
  /** Returns the explicit id or the next free sequential id. */
  const take = (id: number): number => {
    if (id !== 0) return id
    while (state.explicitIds.has(next)) next++
    return next++
  }
  for (const top of components) {
    top.id = take(top.id)
    if (top.type === LABEL) top.component.id = take(top.component.id)
    else top.components[0].id = take(top.components[0].id)
  }
}

/** Validates the top-level modal components, in document order. */
function topLevel(raw: unknown, state: ParseState): ModalComponent[] {
  const components: ModalComponent[] = []
  if (!Array.isArray(raw)) {
    state.errors.components = {
      _errors: [raw == null ? requiredError() : typeError('array')],
    }
    return components
  }
  if (raw.length === 0 || raw.length > 5) {
    state.errors.components = {
      _errors: [raw.length === 0 ? requiredError() : maxLengthError(5)],
    }
  }
  for (const [index, top] of raw.entries()) {
    const path = `components.${index}`
    if (!isObject(top)) {
      state.errors[path] = { _errors: [typeError('object')] }
      continue
    }
    let parsed: ModalComponent | undefined
    if (top.type === LABEL) parsed = label(top, path, state)
    else if (top.type === ACTION_ROW) parsed = actionRow(top, path, state)
    else unsupported(state, path, top.type, 'label (18) and action row (1)')
    if (parsed) components.push(parsed)
  }
  return components
}

/**
 * Validates and normalizes the `data` of a MODAL (type 9) callback.
 * Unknown fields (for example a `flags` value set by libraries) are ignored.
 * @param data - Untrusted callback data
 * @returns Field errors relative to `data`, or the normalized modal
 */
export function parseModal(data: unknown): ParsedModal {
  if (!isObject(data)) {
    return { errors: { '': { _errors: [typeError('object')] } } }
  }
  const state: ParseState = {
    errors: {},
    customIds: new Set(),
    explicitIds: new Set(),
  }
  text(data.custom_id, 'custom_id', 100, state.errors, true)
  text(data.title, 'title', 45, state.errors, true)
  const components = topLevel(data.components, state)
  if (Object.keys(state.errors).length > 0) return { errors: state.errors }
  assignIds(components, state)
  return {
    errors: {},
    modal: {
      custom_id: data.custom_id as string,
      title: data.title as string,
      components,
    },
  }
}

/** One input of a modal, flattened for submission handling. */
export type ModalInput = ModalTextInput | ModalStringSelect

/**
 * Lists a modal's inputs in document order.
 * @param modal - Normalized modal
 * @returns Every Text Input and String Select
 */
export function modalInputs(modal: ModalObject): ModalInput[] {
  return modal.components.map((top) =>
    top.type === LABEL ? top.component : top.components[0]
  )
}

/** The value Discord's client would submit for an input left untouched. */
function untouched(input: ModalInput): string | string[] {
  return input.type === TEXT_INPUT
    ? (input.value ?? '')
    : input.options
        .filter((option) => option.default === true)
        .map((option) => option.value)
}

/** Validates one text value; returns a message or null. */
function textProblem(input: ModalTextInput, value: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const length = [...value].length
  if (length === 0) return input.required ? 'This field is required.' : null
  if (input.min_length !== undefined && length < input.min_length) {
    return `Must be ${input.min_length} or more in length.`
  }
  if (length > (input.max_length ?? 4000)) {
    return `Must be ${input.max_length ?? 4000} or fewer in length.`
  }
  return input.style === 1 && /[\n\r]/.test(value)
    ? 'A short text input cannot contain line breaks.'
    : null
}

/** Validates the chosen select values; returns a message or null. */
function selectProblem(
  input: ModalStringSelect,
  values: string[]
): string | null {
  const known = new Set(input.options.map((option) => option.value))
  const unknown = values.find((value) => !known.has(value))
  if (unknown !== undefined) {
    return `Unknown option value ${JSON.stringify(unknown)}.`
  }
  if (new Set(values).size !== values.length) {
    return 'Selected values must be unique.'
  }
  if (values.length === 0 && !input.required) return null
  const minimum = input.required
    ? Math.max(input.min_values, 1)
    : input.min_values
  if (values.length < minimum) {
    return `Select at least ${minimum} ${minimum === 1 ? 'option' : 'options'}.`
  }
  return values.length > input.max_values
    ? `Select at most ${input.max_values} ${input.max_values === 1 ? 'option' : 'options'}.`
    : null
}

/** Builds Discord's submitted shape for one input. */
function submitted(
  input: ModalInput,
  value: string | string[]
): Record<string, unknown> {
  return input.type === TEXT_INPUT
    ? {
        type: TEXT_INPUT,
        id: input.id,
        custom_id: input.custom_id,
        value,
      }
    : {
        type: STRING_SELECT,
        id: input.id,
        custom_id: input.custom_id,
        values: value,
      }
}

/** Result of checking submitted values against a shown modal. */
export type ModalSubmission =
  | { errors: ValidationErrors; data?: undefined }
  | {
      errors: Record<string, never>
      data: { custom_id: string; components: Record<string, unknown>[] }
    }

/**
 * Checks values against the modal and builds the MODAL_SUBMIT `data`.
 * Inputs without a supplied value submit what the client would for an
 * untouched field: the pre-filled text, or the default select options.
 * @param modal - The modal that was shown
 * @param values - Submitted values keyed by input `custom_id`
 * @returns Field errors keyed `values.<custom_id>`, or the interaction data
 */
export function buildModalSubmission(
  modal: ModalObject,
  values: Record<string, unknown>
): ModalSubmission {
  const errors: ValidationErrors = {}
  const inputs = modalInputs(modal)
  const known = new Set(inputs.map((input) => input.custom_id))
  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      invalid(
        errors,
        `values.${key}`,
        'No component with this custom_id exists in the shown modal.'
      )
    }
  }
  const chosen = new Map<string, string | string[]>()
  for (const input of inputs) {
    const path = `values.${input.custom_id}`
    const supplied = Object.hasOwn(values, input.custom_id)
      ? values[input.custom_id]
      : undefined
    const value = supplied === undefined ? untouched(input) : supplied
    if (input.type === TEXT_INPUT) {
      if (typeof value !== 'string') {
        errors[path] = { _errors: [typeError('string')] }
        continue
      }
      const problem = textProblem(input, value)
      if (problem) invalid(errors, path, problem)
      chosen.set(input.custom_id, value)
    } else {
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string')
      ) {
        errors[path] = { _errors: [typeError('array of strings')] }
        continue
      }
      const problem = selectProblem(input, value as string[])
      if (problem) invalid(errors, path, problem)
      chosen.set(input.custom_id, value as string[])
    }
  }
  if (Object.keys(errors).length > 0) return { errors }
  /** Submitted value of an input already validated above. */
  const valueOf = (input: ModalInput): string | string[] =>
    chosen.get(input.custom_id) ?? untouched(input)
  return {
    errors: {},
    data: {
      custom_id: modal.custom_id,
      components: modal.components.map((top) =>
        top.type === LABEL
          ? {
              type: LABEL,
              id: top.id,
              component: submitted(top.component, valueOf(top.component)),
            }
          : {
              type: ACTION_ROW,
              id: top.id,
              components: [
                submitted(top.components[0], valueOf(top.components[0])),
              ],
            }
      ),
    },
  }
}
