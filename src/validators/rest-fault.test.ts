import { describe, expect, it } from 'vitest'
import {
  isRestFaultApplicationScoped,
  parseRestFaultApplicationCommandSelector,
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

describe('application command selectors', () => {
  const commands = '/applications/111/guilds/222/commands'
  const accepted: [string, string, Record<string, unknown>?][] = [
    ['GET', commands],
    ['GET', commands, { guild_id: '222' }],
    ['PUT', commands],
    ['PUT', commands, { guild_id: '222' }],
    ['GET', `${commands}/permissions`],
    ['GET', `${commands}/permissions`, { guild_id: '222' }],
    ['GET', `${commands}/333/permissions`],
    ['GET', `${commands}/333/permissions`, { guild_id: '222' }],
    ['PUT', `${commands}/333/permissions`],
    ['PUT', `${commands}/333/permissions`, { guild_id: '222' }],
    ['GET', '/guilds/222/roles'],
    ['GET', '/guilds/222/roles', { guild_id: '222' }],
    ['PUT', commands, { mode: 'rate_limit', status: 429, retry_after: 1 }],
    ['GET', `${commands}/333/permissions`, { mode: 'delay', delay_ms: 5 }],
    ['PUT', `${commands}/333/permissions`, { mode: 'disconnect' }],
    ['GET', '/guilds/222/roles', { times: 3 }],
  ]

  it.each(accepted)('accepts %s %s %j', (method, path, extra) => {
    expect(validate(method, path, extra)).toMatchObject({ method, path })
  })

  const rejected: [string, string, Record<string, unknown>?][] = [
    // The guild is the path segment, never the application.
    ['GET', commands, { guild_id: '111' }],
    ['GET', commands, { guild_id: '333' }],
    ['PUT', commands, { guild_id: '333' }],
    ['GET', `${commands}/permissions`, { guild_id: '333' }],
    ['GET', `${commands}/333/permissions`, { guild_id: '333' }],
    ['PUT', `${commands}/333/permissions`, { guild_id: '111' }],
    ['GET', '/guilds/222/roles', { guild_id: '333' }],
    ['GET', commands, { guild_id: 222 }],
    ['PUT', commands, { guild_id: 222 }],
    // Only exact, numeric, bare paths are selectors.
    ['GET', '/applications/abc/guilds/222/commands'],
    ['GET', '/applications/111/guilds/abc/commands'],
    ['GET', '/applications/111/guilds/222/commands/abc/permissions'],
    ['GET', '/applications/111/guilds/222/commands/'],
    ['GET', '/applications/111/guilds/222/commands/333'],
    ['GET', '/applications/111/commands'],
    ['GET', '/applications/111/guilds/222/commands/333/permissions/'],
    ['GET', '/api/v10/applications/111/guilds/222/commands'],
    ['GET', `${commands}?with_localizations=true`],
    ['GET', '/guilds/222/roles/'],
    ['GET', '/guilds/abc/roles'],
    ['GET', '/guilds/222/roles/333'],
    // Only the documented methods are selectors.
    ['POST', commands],
    ['PATCH', commands],
    ['DELETE', commands],
    ['PUT', `${commands}/permissions`],
    ['POST', `${commands}/333/permissions`],
    ['DELETE', `${commands}/333/permissions`],
    ['PUT', '/guilds/222/roles'],
    ['POST', '/guilds/222/roles'],
    // They are not page reads, DM creations or body selectors.
    ['GET', commands, { query: { limit: 1 } }],
    ['GET', '/guilds/222/roles', { query: {} }],
    ['PUT', commands, { query: {} }],
    ['GET', commands, { recipient_id: '1' }],
    ['PUT', `${commands}/333/permissions`, { recipient_id: '1' }],
  ]

  it.each(rejected)('rejects %s %s %j', (method, path, extra) => {
    expect(validate(method, path, extra)).toBeUndefined()
  })

  it('extracts the application and guild only from the new selectors', () => {
    expect(
      parseRestFaultApplicationCommandSelector(
        'GET',
        `${commands}/9/permissions`
      )
    ).toEqual({ applicationId: '111', guildId: '222' })
    expect(parseRestFaultApplicationCommandSelector('PUT', commands)).toEqual({
      applicationId: '111',
      guildId: '222',
    })
    expect(
      parseRestFaultApplicationCommandSelector('PUT', `${commands}/permissions`)
    ).toBeUndefined()
    expect(
      parseRestFaultApplicationCommandSelector('DELETE', commands)
    ).toBeUndefined()
  })

  it('marks only the application selectors as application scoped', () => {
    expect(isRestFaultApplicationScoped('GET', '/guilds/222/roles')).toBe(true)
    expect(isRestFaultApplicationScoped('PUT', commands)).toBe(true)
    expect(isRestFaultApplicationScoped('GET', '/guilds/222/channels')).toBe(
      false
    )
    expect(isRestFaultApplicationScoped('PUT', '/guilds/222/roles')).toBe(false)
  })
})
