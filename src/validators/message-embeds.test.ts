import { describe, expect, it } from 'vitest'
import { validateMessageCreate } from './message'

/** Builds an embed with one of the six budgeted text properties. */
function textEmbed(path: string, text: unknown): Record<string, unknown> {
  switch (path) {
    case 'fields.0.name': {
      return { fields: [{ name: text, value: '' }] }
    }
    case 'fields.0.value': {
      return { fields: [{ name: '', value: text }] }
    }
    case 'footer.text': {
      return { footer: { text } }
    }
    case 'author.name': {
      return { author: { name: text } }
    }
    default: {
      return { [path]: text }
    }
  }
}

const textLimits = [
  ['title', 256],
  ['description', 4096],
  ['fields.0.name', 256],
  ['fields.0.value', 1024],
  ['footer.text', 2048],
  ['author.name', 256],
] as const

describe('message embed text validation', () => {
  for (const [path, limit] of textLimits) {
    it.each(['a', '🐝', 'é', '\u200B'])(
      'enforces the inclusive %s bound for ' + path,
      (character) => {
        expect(
          validateMessageCreate({
            embeds: [textEmbed(path, character.repeat(limit))],
          })
        ).toEqual({})
        expect(
          validateMessageCreate({
            embeds: [textEmbed(path, character.repeat(limit + 1))],
          })[`embeds.0.${path}`]
        ).toEqual({
          _errors: [
            {
              code: 'BASE_TYPE_MAX_LENGTH',
              message: `Must be ${limit} or fewer in length.`,
            },
          ],
        })
      }
    )

    it('excludes surrounding whitespace for ' + path, () => {
      expect(
        validateMessageCreate({
          embeds: [textEmbed(path, '\t \n' + 'x'.repeat(limit) + '\r\n ')],
        })
      ).toEqual({})
      expect(validateMessageCreate({ embeds: [textEmbed(path, '')] })).toEqual(
        {}
      )
      expect(
        validateMessageCreate({ embeds: [textEmbed(path, ' \n ')] })
      ).toEqual({})
    })

    it.each([1, true, [], {}])(
      'rejects malformed text %j for ' + path,
      (text) => {
        expect(
          validateMessageCreate({ embeds: [textEmbed(path, text)] })[
            `embeds.0.${path}`
          ]._errors[0].code
        ).toBe('BASE_TYPE_BAD_TYPE')
      }
    )
  }

  it('counts combining marks separately, without grapheme normalization', () => {
    expect(
      validateMessageCreate({ embeds: [{ title: 'e\u0301'.repeat(128) }] })
    ).toEqual({})
    expect(
      validateMessageCreate({ embeds: [{ title: 'e\u0301'.repeat(129) }] })[
        'embeds.0.title'
      ]
    ).toBeDefined()
  })

  it('sums every budgeted property across embeds and leaves other properties/content out', () => {
    const embeds = [
      {
        title: 't'.repeat(256),
        description: 'd'.repeat(3000),
        fields: [{ name: 'n'.repeat(256), value: 'v'.repeat(1024) }],
        footer: { text: 'f'.repeat(1208) },
        author: { name: 'a'.repeat(256) },
        url: 'https://example.com/' + 'x'.repeat(100),
      },
      { description: ' \n \t' },
    ]
    expect(
      validateMessageCreate({ content: 'c'.repeat(2000), embeds })
    ).toEqual({})
    expect(
      validateMessageCreate({ embeds: [...embeds, { title: 'x' }] }).embeds
        ._errors[0].code
    ).toBe('EMBED_SIZE_EXCEEDS_MAX')
    expect(
      validateMessageCreate({
        embeds: [
          { description: '🐝'.repeat(3000) },
          { description: '🐝'.repeat(3000) },
        ],
      })
    ).toEqual({})
    expect(
      validateMessageCreate({
        embeds: [
          { description: '🐝'.repeat(3000) },
          { description: '🐝'.repeat(3001) },
        ],
      }).embeds
    ).toBeDefined()
  })

  it('checks all embeds even when URLs match', () => {
    expect(
      validateMessageCreate({
        embeds: Array.from({ length: 2 }, () => ({
          url: 'https://example.com',
          description: 'x'.repeat(3001),
        })),
      }).embeds
    ).toBeDefined()
  })

  it('accepts count boundaries and rejects one more field or embed', () => {
    const fields = Array.from({ length: 25 }, () => ({ name: '', value: '' }))
    expect(
      validateMessageCreate({
        embeds: Array.from({ length: 10 }, () => ({ fields })),
      })
    ).toEqual({})
    expect(
      validateMessageCreate({
        embeds: [{ fields: [...fields, { name: '', value: '' }] }],
      })['embeds.0.fields']
    ).toBeDefined()
    expect(
      validateMessageCreate({ embeds: Array.from({ length: 11 }, () => ({})) })
        .embeds
    ).toBeDefined()
  })

  it.each([null, undefined, []])(
    'accepts empty embed collection %j',
    (embeds) => {
      expect(validateMessageCreate({ embeds })).toEqual({})
    }
  )

  it('preserves optional nullable text/objects and requires field name/value strings', () => {
    expect(
      validateMessageCreate({
        embeds: [
          {
            title: null,
            description: null,
            fields: null,
            footer: null,
            author: null,
          },
          { footer: {}, author: {} },
          { footer: { text: null }, author: { name: null } },
        ],
      })
    ).toEqual({})
    for (const property of ['name', 'value']) {
      const field = { name: '', value: '' } as Record<string, unknown>
      field[property] = undefined
      expect(
        validateMessageCreate({ embeds: [{ fields: [field] }] })[
          `embeds.0.fields.0.${property}`
        ]._errors[0].code
      ).toBe('BASE_TYPE_REQUIRED')
      field[property] = null
      expect(
        validateMessageCreate({ embeds: [{ fields: [field] }] })[
          `embeds.0.fields.0.${property}`
        ]._errors[0].code
      ).toBe('BASE_TYPE_BAD_TYPE')
    }
  })

  it.each([true, 123, 'bad', {}])(
    'rejects malformed embed collections %j',
    (embeds) => {
      expect(validateMessageCreate({ embeds }).embeds._errors[0].code).toBe(
        'BASE_TYPE_BAD_TYPE'
      )
    }
  )

  it.each([null, true, 123, 'bad', []])(
    'rejects malformed embed/field entries %j',
    (value) => {
      expect(
        validateMessageCreate({ embeds: [value] })['embeds.0']._errors[0].code
      ).toBe('BASE_TYPE_BAD_TYPE')
      expect(
        validateMessageCreate({ embeds: [{ fields: [value] }] })[
          'embeds.0.fields.0'
        ]._errors[0].code
      ).toBe('BASE_TYPE_BAD_TYPE')
    }
  )

  it.each([true, 123, 'bad', []])(
    'rejects malformed nested objects %j',
    (value) => {
      for (const property of ['author', 'footer']) {
        expect(
          validateMessageCreate({ embeds: [{ [property]: value }] })[
            `embeds.0.${property}`
          ]._errors[0].code
        ).toBe('BASE_TYPE_BAD_TYPE')
      }
    }
  )

  it.each([true, 123, 'bad', {}])(
    'rejects malformed field collections %j',
    (fields) => {
      expect(
        validateMessageCreate({ embeds: [{ fields }] })['embeds.0.fields']
          ._errors[0].code
      ).toBe('BASE_TYPE_BAD_TYPE')
    }
  )

  it('reports multiple errors deterministically without mutating input or leaking a budget', () => {
    const payload = {
      embeds: [
        { title: false, fields: [{ name: 123 }, null], footer: { text: {} } },
        null,
      ],
    }
    const copy = structuredClone(payload)
    const errors = validateMessageCreate(payload)
    expect(Object.keys(errors)).toEqual([
      'embeds.0.title',
      'embeds.0.footer.text',
      'embeds.0.fields.0.name',
      'embeds.0.fields.0.value',
      'embeds.0.fields.1',
      'embeds.1',
    ])
    expect(validateMessageCreate(payload)).toEqual(errors)
    expect(payload).toEqual(copy)
    expect(validateMessageCreate({ embeds: [{ title: 'ok' }] })).toEqual({})
  })
})
