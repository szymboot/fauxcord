import { describe, expect, it } from 'vitest'
import {
  parseRestFaultInteractionSelector,
  validateRestFault,
} from './rest-fault'

const failure = { status: 503, code: 0, message: 'Failed' }

/** Validates a selector with the shared failure defaults. */
function validate(
  method: string,
  path: string,
  extra: Record<string, unknown> = {}
): ReturnType<typeof validateRestFault> {
  return validateRestFault({ method, path, ...failure, ...extra })
}

describe('appeal selectors', () => {
  const accepted: [string, string, Record<string, unknown>?][] = [
    ['GET', '/guilds/222/channels'],
    ['GET', '/guilds/222/channels', { guild_id: '222' }],
    ['DELETE', '/users/@me/guilds/222'],
    ['DELETE', '/users/@me/guilds/222', { guild_id: '222' }],
    ['POST', '/interactions/444/callback'],
    ['GET', '/interactions/444/messages/@original'],
    ['PATCH', '/interactions/444/messages/@original'],
    ['DELETE', '/interactions/444/messages/@original'],
    [
      'DELETE',
      '/interactions/444/messages/@original',
      { mode: 'rate_limit', status: 429, retry_after: 1 },
    ],
    [
      'PATCH',
      '/interactions/444/messages/@original',
      { mode: 'delay', delay_ms: 5 },
    ],
  ]

  it.each(accepted)('accepts %s %s', (method, path, extra) => {
    expect(validate(method, path, extra)).toMatchObject({ method, path })
  })

  const rejected: [string, string, Record<string, unknown>?][] = [
    ['GET', '/guilds/222/channels', { guild_id: '333' }],
    ['GET', '/guilds/222/channels', { query: { limit: 1 } }],
    ['GET', '/guilds/222/channels', { recipient_id: '1' }],
    ['GET', '/guilds/222/channels/'],
    ['DELETE', '/users/@me/guilds/222', { guild_id: '333' }],
    ['DELETE', '/users/@me/guilds/222', { guild_id: 222 }],
    ['DELETE', '/users/@me/guilds/222', { query: {} }],
    ['DELETE', '/users/@me/guilds/222', { recipient_id: '1' }],
    ['DELETE', '/users/@me/guilds/abc'],
    ['DELETE', '/users/%40me/guilds/222'],
    ['GET', '/users/@me/guilds/222'],
    ['POST', '/interactions/444/callback', { guild_id: '222' }],
    ['POST', '/interactions/444/callback', { query: {} }],
    ['POST', '/interactions/444/callback', { recipient_id: '1' }],
    ['POST', '/interactions/444/secret-token/callback'],
    ['POST', '/interactions/abc/callback'],
    ['GET', '/interactions/444/callback'],
    ['POST', '/interactions/444/messages/@original'],
    ['DELETE', '/interactions/444/messages/@original', { guild_id: '222' }],
    ['DELETE', '/interactions/444/messages/@original', { query: {} }],
    ['DELETE', '/interactions/444/messages/@original', { recipient_id: '1' }],
    ['DELETE', '/interactions/444/secret-token/messages/@original'],
    ['DELETE', '/interactions/abc/messages/@original'],
    ['DELETE', '/webhooks/111/secret-token/messages/@original'],
    ['GET', '/interactions/444/messages/@original', { guild_id: '222' }],
    ['PATCH', '/interactions/444/messages/@original', { query: {} }],
    ['GET', '/webhooks/111/secret-token/messages/@original'],
    ['PATCH', '/webhooks/111/secret-token/messages/@original'],
  ]

  it.each(rejected)('rejects %s %s %j', (method, path, extra) => {
    expect(validate(method, path, extra)).toBeUndefined()
  })

  it('extracts interaction IDs only from token-free selectors', () => {
    expect(
      parseRestFaultInteractionSelector('POST', '/interactions/4/callback')
    ).toBe('4')
    expect(
      parseRestFaultInteractionSelector('GET', '/interactions/4/callback')
    ).toBeUndefined()
    expect(
      parseRestFaultInteractionSelector(
        'DELETE',
        '/interactions/4/messages/@original'
      )
    ).toBe('4')
  })
})
