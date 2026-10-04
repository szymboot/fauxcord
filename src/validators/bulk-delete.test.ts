import { describe, expect, it } from 'vitest'
import { parseBulkDeleteMessages } from './bulk-delete'

describe('bulk-delete Snowflake parser', () => {
  it('preserves adjacent 19-digit integer tokens that JSON.parse normally rounds together', () => {
    expect(
      parseBulkDeleteMessages(
        '{"messages":[1556333187267956736,1556333187267956737]}'
      )
    ).toEqual(['1556333187267956736', '1556333187267956737'])
  })

  it('accepts escaped property names and strings using actual JSON semantics', () => {
    expect(
      parseBulkDeleteMessages(
        String.raw`{"messa\u0067es":["155633318726795673\u0036","1556333187267956737"]}`
      )
    ).toEqual(['1556333187267956736', '1556333187267956737'])
  })

  it('does not treat a nested or quoted messages field as the request array', () => {
    expect(
      parseBulkDeleteMessages('{"nested":{"messages":["1","2"]}}')
    ).toBeNull()
    expect(parseBulkDeleteMessages('{"messages":"[1,2]"}')).toBeNull()
  })

  it('uses the final duplicate property as JSON.parse does, without extracting earlier IDs', () => {
    expect(
      parseBulkDeleteMessages('{"messages":["1","2"],"messages":["3","4"]}')
    ).toEqual(['3', '4'])
    expect(
      parseBulkDeleteMessages('{"messages":["1","2"],"messages":null}')
    ).toBeNull()
  })

  it.each([
    '-0',
    '1.0',
    '1e3',
    '1e400',
    '"01"',
    '"-1"',
    '" 1"',
    '"18446744073709551616"',
  ])('rejects a non-Snowflake token: %s', (id) => {
    expect(parseBulkDeleteMessages(`{"messages":[${id},"2"]}`)).toBeNull()
  })
})
