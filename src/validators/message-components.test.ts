import { describe, expect, it } from 'vitest'
import { validateMessageCreate } from './message'
import {
  normalizeMessageComponents,
  type MessageComponents,
} from './message-components'

/** Wraps buttons in a classic action row. */
function rows(...buttons: unknown[]): unknown[] {
  return [{ type: 1, components: buttons }]
}

const buy = { type: 2, style: 1, label: 'Buy', custom_id: 'shop_item_buy_1' }

describe('classic message component validation', () => {
  it.each([
    undefined,
    null,
    [],
    rows(buy),
    rows({ type: 2, style: 5, label: 'Link', url: 'https://example.com' }),
  ])('accepts %j', (components) => {
    expect(validateMessageCreate({ components })).toEqual({})
  })

  it.each([
    false,
    {},
    [null],
    [false],
    [[]],
    [{ type: 2 }],
    [{ type: 1 }],
    [{ type: 1, components: [] }],
    [{ type: 1, components: [null] }],
    rows({ ...buy, type: 3 }),
    rows({ ...buy, style: 6 }),
    rows({ ...buy, style: '1' }),
    rows({ ...buy, custom_id: '' }),
    rows({ ...buy, custom_id: 'x'.repeat(101) }),
    rows({ ...buy, custom_id: undefined }),
    rows({ ...buy, url: 'https://example.com' }),
    rows({ ...buy, sku_id: '123' }),
    rows({ ...buy, label: 'x'.repeat(81) }),
    rows({ ...buy, label: undefined }),
    rows({ ...buy, disabled: 1 }),
    rows({ ...buy, emoji: {} }),
    rows({ ...buy, emoji: false }),
    rows({ ...buy, emoji: { name: 'x', animated: 'true' } }),
    rows({ ...buy, emoji: { id: 'not-a-snowflake' } }),
    rows({ ...buy, style: 5, custom_id: undefined }),
    rows({ ...buy, style: 5, url: 'https://example.com' }),
    rows({ ...buy, style: 5, custom_id: undefined, url: 'bad' }),
    rows({
      ...buy,
      style: 5,
      custom_id: undefined,
      url: 'https://example.com/' + 'x'.repeat(512),
    }),
    rows(buy, buy),
    [...rows(buy), ...rows(buy)],
    rows(
      ...Array.from({ length: 6 }, (_, i) => ({ ...buy, custom_id: String(i) }))
    ),
    Array.from({ length: 6 }, (_, i) => ({
      type: 1,
      components: [{ ...buy, custom_id: String(i) }],
    })),
  ])('rejects malformed or unsupported components %j', (components) => {
    expect(Object.keys(validateMessageCreate({ components }))).not.toHaveLength(
      0
    )
  })

  it('accepts inclusive limits, emoji-only buttons, and all classic styles', () => {
    const components = Array.from({ length: 5 }, (_, row) => ({
      type: 1,
      components: Array.from({ length: 5 }, (_, button) => ({
        ...buy,
        style: (button % 4) + 1,
        label: '🐝'.repeat(80),
        custom_id: `${row}${button}` + '🐝'.repeat(98),
        disabled: false,
        emoji: { id: null, name: '🐝', animated: false },
      })),
    }))
    expect(validateMessageCreate({ components })).toEqual({})
    expect(
      validateMessageCreate({
        components: rows({ ...buy, label: undefined, emoji: { id: '123' } }),
      })
    ).toEqual({})
  })

  it('rejects the components v2 flag even with no components', () => {
    expect(validateMessageCreate({ flags: 32_768 })).toHaveProperty('flags')
  })

  it('normalizes optional null fields by button style without losing custom IDs', () => {
    const components = rows(
      { ...buy, url: null, sku_id: null, disabled: null, emoji: null },
      {
        type: 2,
        style: 5,
        label: 'Link',
        url: 'https://example.com',
        custom_id: null,
      }
    )
    expect(validateMessageCreate({ components })).toEqual({})
    expect(normalizeMessageComponents(components as MessageComponents)).toEqual(
      [
        {
          type: 1,
          id: 0,
          components: [
            { ...buy, id: 0 },
            {
              type: 2,
              id: 0,
              style: 5,
              label: 'Link',
              url: 'https://example.com',
            },
          ],
        },
      ]
    )
  })
})
