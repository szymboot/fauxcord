import { describe, expect, it } from 'vitest'
import { buildMuteModalData } from '../test-helpers'
import {
  buildModalSubmission,
  modalInputs,
  parseModal,
  type ModalObject,
} from './modal'

/** Parses data that must be valid and returns the normalized modal. */
function accepted(data: unknown): ModalObject {
  const parsed = parseModal(data)
  expect(parsed.errors).toEqual({})
  if (!parsed.modal) throw new Error('modal expected')
  return parsed.modal
}

/** Returns the error paths of data that must be invalid. */
function rejected(data: unknown): string[] {
  const parsed = parseModal(data)
  expect(parsed.modal).toBeUndefined()
  return Object.keys(parsed.errors)
}

/** A minimal valid Label-wrapped text input modal with overrides. */
function modalWith(input: Record<string, unknown>): Record<string, unknown> {
  return {
    custom_id: 'm',
    title: 'T',
    components: [
      {
        type: 18,
        label: 'L',
        component: { type: 4, custom_id: 'a', style: 1, ...input },
      },
    ],
  }
}

describe('parseModal', () => {
  it('normalizes defaults, assigns sequential ids, and ignores flags', () => {
    const modal = accepted(buildMuteModalData('42'))
    expect(modal).not.toHaveProperty('flags')
    expect(modal.components.map((top) => top.id)).toEqual([1, 3, 5, 7])
    expect(modal.components[0]).toEqual({
      type: 18,
      id: 1,
      label: 'Reason',
      component: {
        type: 4,
        id: 2,
        custom_id: 'reason',
        style: 2,
        required: true,
        max_length: 500,
      },
    })
    expect(modal.components[2]).toMatchObject({
      component: {
        type: 3,
        id: 6,
        custom_id: 'mute_type',
        min_values: 1,
        max_values: 1,
        required: true,
      },
    })
    expect(modalInputs(modal).map((input) => input.custom_id)).toEqual([
      'reason',
      'duration',
      'mute_type',
      'visibility',
    ])
  })

  it('keeps explicit ids and skips them when numbering', () => {
    const modal = accepted({
      custom_id: 'm',
      title: 'T',
      components: [
        {
          type: 18,
          id: 1,
          label: 'A',
          component: { type: 4, id: 2, custom_id: 'a', style: 1 },
        },
        {
          type: 18,
          label: 'B',
          component: { type: 4, custom_id: 'b', style: 1 },
        },
      ],
    })
    expect(modal.components.map((top) => top.id)).toEqual([1, 3])
    expect(modalInputs(modal).map((input) => input.id)).toEqual([2, 4])
  })

  it('accepts the legacy action row text input with its own label', () => {
    const modal = accepted({
      custom_id: 'legacy',
      title: 'Legacy',
      components: [
        {
          type: 1,
          components: [
            { type: 4, custom_id: 'a', style: 1, label: 'Name', value: 'x' },
          ],
        },
      ],
    })
    expect(modal.components[0]).toMatchObject({
      type: 1,
      id: 1,
      components: [{ type: 4, id: 2, label: 'Name', value: 'x' }],
    })
  })

  it.each([
    [{ type: 10, content: 'hi' }, 'components.0.type'],
    [{ type: 17, components: [] }, 'components.0.type'],
    [
      {
        type: 18,
        label: 'L',
        component: { type: 5, custom_id: 'u' },
      },
      'components.0.component.type',
    ],
    [
      {
        type: 18,
        label: 'L',
        component: { type: 19, custom_id: 'f' },
      },
      'components.0.component.type',
    ],
    [
      {
        type: 1,
        components: [
          { type: 3, custom_id: 's', options: [{ label: 'a', value: 'a' }] },
        ],
      },
      'components.0.components.0.type',
    ],
  ])('rejects unsupported component %j', (component, path) => {
    const parsed = parseModal({
      custom_id: 'm',
      title: 'T',
      components: [component],
    })
    expect(Object.keys(parsed.errors)).toEqual([path])
    expect(parsed.errors[path]._errors[0].message).toMatch(
      /not supported|wrap other inputs/
    )
  })

  it.each([
    ['missing custom_id', { custom_id: undefined }, 'custom_id'],
    ['long title', { title: 'x'.repeat(46) }, 'title'],
    ['no components', { components: [] }, 'components'],
    [
      'too many components',
      { components: Array.from({ length: 6 }, () => ({})) },
      'components',
    ],
    ['non-array components', { components: {} }, 'components'],
  ])('rejects %s', (_name, override, path) => {
    const data = { ...modalWith({}), ...override }
    expect(rejected(data)).toContain(path)
  })

  it.each([
    ['bad style', { style: 3 }, 'components.0.component.style'],
    ['empty custom_id', { custom_id: '' }, 'components.0.component.custom_id'],
    [
      'min above max',
      { min_length: 5, max_length: 2 },
      'components.0.component.min_length',
    ],
    ['zero max_length', { max_length: 0 }, 'components.0.component.max_length'],
    [
      'long placeholder',
      { placeholder: 'x'.repeat(101) },
      'components.0.component.placeholder',
    ],
    [
      'non-boolean required',
      { required: 'yes' },
      'components.0.component.required',
    ],
  ])('rejects a text input with %s', (_name, override, path) => {
    expect(rejected(modalWith(override))).toContain(path)
  })

  it('rejects duplicate custom_ids and duplicate explicit ids', () => {
    const input = (id: number): Record<string, unknown> => ({
      type: 18,
      id,
      label: 'L',
      component: { type: 4, custom_id: 'same', style: 1 },
    })
    const paths = rejected({
      custom_id: 'm',
      title: 'T',
      components: [input(1), input(1)],
    })
    expect(paths).toContain('components.1.component.custom_id')
    expect(paths).toContain('components.1.id')
  })

  it.each([
    ['no options', { options: [] }, 'components.0.component.options'],
    ['disabled', { disabled: true }, 'components.0.component.disabled'],
    [
      'min above max',
      { min_values: 2, max_values: 1 },
      'components.0.component.min_values',
    ],
    [
      'two defaults for one value',
      {
        options: [
          { label: 'a', value: 'a', default: true },
          { label: 'b', value: 'b', default: true },
        ],
      },
      'components.0.component.options',
    ],
    [
      'duplicate values',
      {
        options: [
          { label: 'a', value: 'a' },
          { label: 'b', value: 'a' },
        ],
      },
      'components.0.component.options.1.value',
    ],
    [
      'option without label',
      { options: [{ value: 'a' }] },
      'components.0.component.options.0.label',
    ],
  ])('rejects a select with %s', (_name, override, path) => {
    expect(
      rejected({
        custom_id: 'm',
        title: 'T',
        components: [
          {
            type: 18,
            label: 'L',
            component: {
              type: 3,
              custom_id: 's',
              options: [{ label: 'a', value: 'a' }],
              ...override,
            },
          },
        ],
      })
    ).toContain(path)
  })

  it('requires the label text and a single component in a label', () => {
    expect(
      rejected({
        custom_id: 'm',
        title: 'T',
        components: [
          { type: 18, component: { type: 4, custom_id: 'a', style: 1 } },
        ],
      })
    ).toContain('components.0.label')
    expect(
      rejected({
        custom_id: 'm',
        title: 'T',
        components: [{ type: 18, label: 'L' }],
      })
    ).toContain('components.0.component')
  })
})

describe('buildModalSubmission', () => {
  const modal = accepted(buildMuteModalData('42'))

  it('uses defaults for untouched fields and nests values like Discord', () => {
    const result = buildModalSubmission(modal, { reason: 'spam' })
    expect(result.errors).toEqual({})
    expect(result.data).toEqual({
      custom_id: 'user_mute:42',
      components: [
        {
          type: 18,
          id: 1,
          component: { type: 4, id: 2, custom_id: 'reason', value: 'spam' },
        },
        {
          type: 18,
          id: 3,
          component: { type: 4, id: 4, custom_id: 'duration', value: '' },
        },
        {
          type: 18,
          id: 5,
          component: {
            type: 3,
            id: 6,
            custom_id: 'mute_type',
            values: ['text'],
          },
        },
        {
          type: 18,
          id: 7,
          component: {
            type: 3,
            id: 8,
            custom_id: 'visibility',
            values: ['public'],
          },
        },
      ],
    })
  })

  it('submits chosen select values and optional text', () => {
    const result = buildModalSubmission(modal, {
      reason: 'x',
      duration: '1h',
      mute_type: ['voice'],
      visibility: ['private'],
    })
    expect(result.errors).toEqual({})
    expect(JSON.stringify(result.data)).toContain('"values":["voice"]')
    expect(JSON.stringify(result.data)).toContain('"value":"1h"')
  })

  it('submits the pre-filled text of an untouched input', () => {
    const prefilled = accepted(modalWith({ value: 'hello' }))
    expect(buildModalSubmission(prefilled, {}).data).toMatchObject({
      components: [{ component: { value: 'hello' } }],
    })
  })

  it.each([
    ['unknown component', { reason: 'x', nope: 'y' }, 'values.nope'],
    ['missing required text', {}, 'values.reason'],
    ['empty required text', { reason: '' }, 'values.reason'],
    ['too long text', { reason: 'x'.repeat(501) }, 'values.reason'],
    ['text of the wrong type', { reason: 5 }, 'values.reason'],
    [
      'line break in a short input',
      { reason: 'x', duration: '1\n2' },
      'values.duration',
    ],
    [
      'unknown select value',
      { reason: 'x', mute_type: ['both'] },
      'values.mute_type',
    ],
    [
      'too many select values',
      { reason: 'x', mute_type: ['text', 'voice'] },
      'values.mute_type',
    ],
    [
      'empty required select',
      { reason: 'x', mute_type: [] },
      'values.mute_type',
    ],
    [
      'duplicate select values',
      { reason: 'x', visibility: ['public', 'public'] },
      'values.visibility',
    ],
    [
      'select of the wrong type',
      { reason: 'x', visibility: 'public' },
      'values.visibility',
    ],
  ])('rejects %s', (_name, values, path) => {
    const result = buildModalSubmission(modal, values)
    expect(result.data).toBeUndefined()
    expect(Object.keys(result.errors)).toContain(path)
  })

  it('honours min_length for non-empty text only when optional', () => {
    const bounded = accepted(modalWith({ min_length: 3, required: false }))
    expect(buildModalSubmission(bounded, {}).errors).toEqual({})
    expect(
      Object.keys(buildModalSubmission(bounded, { a: 'ab' }).errors)
    ).toEqual(['values.a'])
    expect(buildModalSubmission(bounded, { a: 'abc' }).errors).toEqual({})
  })

  it('applies min_values and max_values and lets optional selects be empty', () => {
    const multi = accepted({
      custom_id: 'm',
      title: 'T',
      components: [
        {
          type: 18,
          label: 'L',
          component: {
            type: 3,
            custom_id: 's',
            required: false,
            min_values: 2,
            max_values: 3,
            options: ['a', 'b', 'c', 'd'].map((value) => ({
              label: value,
              value,
            })),
          },
        },
      ],
    })
    expect(buildModalSubmission(multi, {}).errors).toEqual({})
    expect(
      Object.keys(buildModalSubmission(multi, { s: ['a'] }).errors)
    ).toEqual(['values.s'])
    expect(buildModalSubmission(multi, { s: ['a', 'd'] }).errors).toEqual({})
    expect(
      Object.keys(
        buildModalSubmission(multi, { s: ['a', 'b', 'c', 'd'] }).errors
      )
    ).toEqual(['values.s'])
  })

  it('does not treat prototype keys as components', () => {
    const result = buildModalSubmission(
      modal,
      JSON.parse('{"reason":"x","__proto__":"y"}') as Record<string, unknown>
    )
    expect(Object.keys(result.errors)).toEqual(['values.__proto__'])
  })
})
