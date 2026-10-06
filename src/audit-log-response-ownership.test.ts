import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRealServer,
  seedBot,
  seedGuild,
  seedChannel,
  type RealServerContext,
} from './test-helpers'

const TOKEN = 'Bot ownership'
const BOT = '111111111111111111'
const GUILD = '222222222222222222'
const KEY = 'harness-random-ownership-key'
let server: RealServerContext

/** Sends ownership requests over real HTTP, independently of Discord auth. */
function request(path: string, method = 'GET', body?: unknown, token?: string) {
  return fetch(server.baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: token }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(2000),
  })
}

/** Provides a bounded control whose ownership is known before sending POST. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    ownership_key: KEY,
    bot_id: BOT,
    guild_id: GUILD,
    query: { action_type: 72, limit: 1 },
    entries: [{ action_type: 999, options: { odd: [null, {}, false] } }],
    ttl_ms: 60_000,
    ...overrides,
  }
}

/** Builds the exact ownership address, including the expected scope. */
function address(key = KEY, bot = BOT, guild = GUILD) {
  return `/_test/audit-log-responses/by-key/${key}?bot_id=${bot}&guild_id=${guild}`
}

/** Returns status for compact assertions on retry and isolation failures. */
async function status(response: Promise<Response>) {
  const result = await response
  return result.status
}

/** Reads the normalized control and current evidence. */
async function read(response: Promise<Response>) {
  const result = await response
  return result.json() as Promise<Record<string, unknown>>
}

beforeEach(async () => {
  server = await createRealServer()
  seedBot(server.db, TOKEN, BOT)
  seedGuild(server.db, TOKEN, GUILD)
})

afterEach(async () => {
  await server.close()
})

describe('recoverable ownership of audit response controls', () => {
  it('recovers an undecoded create response, consumes once, and cleans up only that control', async () => {
    const channel = seedChannel(server.db, GUILD)
    const fixture = await request(`/_test/guilds/${GUILD}/audit-logs`, 'POST', {
      id: '100',
      action_type: 72,
      user_id: BOT,
      target_id: BOT,
      options: { channel_id: channel, count: '1' },
    })
    expect(fixture.status).toBe(201)
    const unrelated = await read(
      request(
        '/_test/audit-log-responses',
        'POST',
        payload({ ownership_key: 'unrelated', query: {} })
      )
    )
    const created = await request(
      '/_test/audit-log-responses',
      'POST',
      payload()
    )
    expect(created.status).toBe(201)
    await created.body?.cancel()
    const recoveredResponse = await request(address())
    expect(recoveredResponse.headers.get('Cache-Control')).toBe('no-store')
    const recovered = (await recoveredResponse.json()) as Record<
      string,
      unknown
    >
    expect(recovered).toMatchObject({
      ownership_key: KEY,
      remaining: 1,
      consumed: 0,
    })
    expect(
      await read(
        request(
          `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
          'GET',
          undefined,
          TOKEN
        )
      )
    ).toMatchObject({ audit_log_entries: payload().entries })
    const retry = await read(
      request('/_test/audit-log-responses', 'POST', payload())
    )
    expect(retry).toMatchObject({
      id: recovered.id,
      remaining: 0,
      consumed: 1,
      state: 'exhausted',
    })
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await status(request(address(), 'DELETE'))).toBe(204)
    expect(await status(request(address()))).toBe(404)
    expect(
      await status(
        request(`/_test/audit-log-responses/${String(recovered.id)}`)
      )
    ).toBe(404)
    expect(
      await status(request('/_test/audit-log-responses', 'POST', payload()))
    ).toBe(409)
    expect(
      await status(
        request(`/_test/audit-log-responses/${String(unrelated.id)}`)
      )
    ).toBe(200)
    expect(
      server.db.prepare('SELECT id FROM test_audit_log_responses').all()
    ).toEqual([{ id: unrelated.id }])
    expect(
      await read(
        request(
          `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
          'GET',
          undefined,
          TOKEN
        )
      )
    ).toMatchObject({ audit_log_entries: [{ id: '100' }] })
  })

  it('reserves cleanup before a delayed create, without deleting a selector owned by another key', async () => {
    const other = await read(
      request(
        '/_test/audit-log-responses',
        'POST',
        payload({ ownership_key: 'other' })
      )
    )
    expect(await status(request(address(), 'DELETE'))).toBe(204)
    expect(
      await status(request('/_test/audit-log-responses', 'POST', payload()))
    ).toBe(409)
    expect(
      await status(request(`/_test/audit-log-responses/${String(other.id)}`))
    ).toBe(200)
  })

  it('deduplicates concurrent retries and equivalent normalized JSON without extending TTL', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        read(request('/_test/audit-log-responses', 'POST', payload()))
      )
    )
    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    const reordered = payload({
      times: 1,
      query: { limit: '1', action_type: '72' },
      entries: [{ options: { odd: [null, {}, false] }, action_type: 999 }],
    })
    expect(
      await read(request('/_test/audit-log-responses', 'POST', reordered))
    ).toEqual(results[0])
    expect(
      server.db.prepare('SELECT id FROM test_audit_log_responses').all()
    ).toHaveLength(1)
  })

  it.each([
    { entries: [] },
    { query: {} },
    { times: 2 },
    { ttl_ms: 1000 },
    { entries: [{ action_type: 999, options: { odd: [false, {}, null] } }] },
  ])(
    'rejects changed payload %j without mutating the original',
    async (overrides) => {
      const original = await read(
        request('/_test/audit-log-responses', 'POST', payload())
      )
      expect(
        await status(
          request('/_test/audit-log-responses', 'POST', payload(overrides))
        )
      ).toBe(409)
      expect(await read(request(address()))).toEqual(original)
    }
  )

  it('does not reserve a key on a selector conflict or invalid request', async () => {
    await request(
      '/_test/audit-log-responses',
      'POST',
      payload({ ownership_key: 'other' })
    )
    expect(
      await status(request('/_test/audit-log-responses', 'POST', payload()))
    ).toBe(409)
    expect(
      await status(
        request('/_test/audit-log-responses', 'POST', payload({ query: {} }))
      )
    ).toBe(201)
    expect(
      await status(
        request(
          '/_test/audit-log-responses',
          'POST',
          payload({ ownership_key: 'valid-later', ttl_ms: 0 })
        )
      )
    ).toBe(400)
    expect(
      await status(
        request(
          '/_test/audit-log-responses',
          'POST',
          payload({ ownership_key: 'valid-later', query: { limit: 2 } })
        )
      )
    ).toBe(201)
  })

  it('leaves a new key unreserved after an unknown-scope POST', async () => {
    expect(
      await status(
        request(
          '/_test/audit-log-responses',
          'POST',
          payload({ guild_id: '999999999999999999' })
        )
      )
    ).toBe(404)
    expect(
      server.db.prepare('SELECT * FROM test_audit_log_response_owners').all()
    ).toEqual([])
    expect(
      await status(request('/_test/audit-log-responses', 'POST', payload()))
    ).toBe(201)
  })

  it('accepts key length bounds and keeps key case significant', async () => {
    for (const [key, query] of [
      ['a', {}],
      ['A', { limit: 2 }],
      ['a'.repeat(128), { limit: 3 }],
    ] as const) {
      expect(
        await status(
          request(
            '/_test/audit-log-responses',
            'POST',
            payload({ ownership_key: key, query })
          )
        )
      ).toBe(201)
      expect(await read(request(address(key)))).toMatchObject({
        ownership_key: key,
        query,
      })
    }
    expect(await status(request(address('A'), 'DELETE'))).toBe(204)
    expect(await status(request(address('a')))).toBe(200)
  })

  it('keeps bot and guild scope exact on retries, recovery and cleanup', async () => {
    await request('/_test/audit-log-responses', 'POST', payload())
    const otherBot = '444444444444444444'
    const otherGuild = '555555555555555555'
    seedBot(server.db, 'Bot other-owner', otherBot)
    seedGuild(server.db, 'Bot other-owner', otherGuild)
    const sameBotGuild = seedGuild(server.db, TOKEN, '666666666666666666')
    for (const [bot, guild] of [
      [otherBot, otherGuild],
      [BOT, sameBotGuild],
      [otherBot, GUILD],
    ]) {
      for (const method of ['GET', 'DELETE'])
        expect(await status(request(address(KEY, bot, guild), method))).toBe(
          404
        )
      expect(
        await status(
          request(
            '/_test/audit-log-responses',
            'POST',
            payload({ bot_id: bot, guild_id: guild })
          )
        )
      ).toBe(409)
    }
    expect(await status(request(address()))).toBe(200)
  })

  it('pins keyed consumption and retries to the original exact token', async () => {
    await request('/_test/audit-log-responses', 'POST', payload())
    const replacement = 'Bot replacement-token'
    seedBot(server.db, replacement, BOT)
    server.db
      .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
      .run(replacement, GUILD)
    for (const token of [TOKEN, replacement]) {
      await request(
        `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
        'GET',
        undefined,
        token
      )
    }
    expect(await read(request(address()))).toMatchObject({
      remaining: 1,
      consumed: 0,
    })
    expect(
      await status(request('/_test/audit-log-responses', 'POST', payload()))
    ).toBe(409)
    expect(await status(request(address(), 'DELETE'))).toBe(204)
  })

  it('retains expiry evidence on retry and lets a fresh key rearm independently', async () => {
    const original = await read(
      request('/_test/audit-log-responses', 'POST', payload({ ttl_ms: 1 }))
    )
    await expect
      .poll(async () => {
        const result = await read(request(address()))
        return result.state
      })
      .toBe('expired')
    const fresh = await read(
      request(
        '/_test/audit-log-responses',
        'POST',
        payload({ ownership_key: 'fresh' })
      )
    )
    expect(
      await read(
        request('/_test/audit-log-responses', 'POST', payload({ ttl_ms: 1 }))
      )
    ).toMatchObject({
      id: original.id,
      expires_at: original.expires_at,
      state: 'expired',
      consumed: 0,
    })
    expect(await status(request(address(), 'DELETE'))).toBe(204)
    expect(
      await status(request(`/_test/audit-log-responses/${String(fresh.id)}`))
    ).toBe(200)
  })

  it.each(['id', 'reset', 'guild', 'setup'])(
    'keeps the key closed after %s cleanup, including recreated scope',
    async (action) => {
      const original = await read(
        request('/_test/audit-log-responses', 'POST', payload())
      )
      switch (action) {
        case 'id': {
          await request(
            `/_test/audit-log-responses/${String(original.id)}`,
            'DELETE'
          )
          break
        }
        case 'reset': {
          await request('/_test/reset', 'POST', { token: TOKEN })
          break
        }
        case 'guild': {
          await request(`/guilds/${GUILD}`, 'DELETE', undefined, TOKEN)
          break
        }
        case 'setup': {
          await request(`/_test/setup/${encodeURIComponent(TOKEN)}`, 'DELETE')
          break
        }
      }
      expect(await status(request(address()))).toBe(404)
      expect(await status(request(address(), 'DELETE'))).toBe(204)
      seedBot(server.db, TOKEN, BOT)
      seedGuild(server.db, TOKEN, GUILD)
      expect(
        await status(request('/_test/audit-log-responses', 'POST', payload()))
      ).toBe(409)
      expect(
        await status(
          request(
            '/_test/audit-log-responses',
            'POST',
            payload({ ownership_key: 'new-key' })
          )
        )
      ).toBe(201)
    }
  )

  it('closes the key regardless of concurrent create and cleanup ordering', async () => {
    const [created, removed] = await Promise.all([
      request('/_test/audit-log-responses', 'POST', payload()),
      request(address(), 'DELETE'),
    ])
    expect([201, 409]).toContain(created.status)
    expect(removed.status).toBe(204)
    expect(await status(request(address()))).toBe(404)
    expect(
      await status(request('/_test/audit-log-responses', 'POST', payload()))
    ).toBe(409)
    expect(
      server.db.prepare('SELECT * FROM test_audit_log_responses').all()
    ).toEqual([])
  })

  it('preserves unusual nested object keys during value-equivalent retries', async () => {
    const entries = JSON.parse(
      '[{"options":{"__proto__":{"x":1},"constructor":null,"z":[{}]},"id":null}]'
    ) as unknown
    const original = await read(
      request('/_test/audit-log-responses', 'POST', payload({ entries }))
    )
    const reordered = JSON.parse(
      '[{"id":null,"options":{"z":[{}],"constructor":null,"__proto__":{"x":1}}}]'
    ) as unknown
    expect(
      await read(
        request(
          '/_test/audit-log-responses',
          'POST',
          payload({ entries: reordered })
        )
      )
    ).toEqual(original)
    const response = await read(
      request(
        `/guilds/${GUILD}/audit-logs?limit=1&action_type=72`,
        'GET',
        undefined,
        TOKEN
      )
    )
    expect(response.audit_log_entries).toEqual(entries)
    expect(JSON.stringify(original)).not.toContain(TOKEN)
    expect(original).not.toHaveProperty('token_hash')
  })

  it.each([
    null,
    '',
    42,
    'a'.repeat(129),
    'space key',
    'slash/key',
    'trailing\n',
    'trailing\r',
    '非ascii',
  ])('rejects invalid ownership key %j', async (key) => {
    expect(
      await status(
        request(
          '/_test/audit-log-responses',
          'POST',
          payload({ ownership_key: key })
        )
      )
    ).toBe(400)
    expect(
      server.db.prepare('SELECT id FROM test_audit_log_responses').all()
    ).toEqual([])
  })

  it('validates lookup scope without deleting anything, and distinguishes unknown keys', async () => {
    await request('/_test/audit-log-responses', 'POST', payload())
    for (const suffix of [
      '',
      `?bot_id=${BOT}`,
      `?bot_id=${BOT}&guild_id=0`,
      `?bot_id=${BOT}&guild_id=${GUILD}&extra=1`,
      `?bot_id=${BOT}&bot_id=${BOT}&guild_id=${GUILD}`,
    ]) {
      for (const method of ['GET', 'DELETE'])
        expect(
          await status(
            request(`/_test/audit-log-responses/by-key/${KEY}${suffix}`, method)
          )
        ).toBe(400)
    }
    expect(await status(request(address('unknown')))).toBe(404)
    expect(
      await status(
        request(address('unknown', BOT, '999999999999999999'), 'DELETE')
      )
    ).toBe(404)
    expect(await status(request(address()))).toBe(200)
  })

  it('isolates the same ownership key across database instances', async () => {
    await request('/_test/audit-log-responses', 'POST', payload())
    const second = await createRealServer()
    try {
      seedBot(second.db, TOKEN, BOT)
      seedGuild(second.db, TOKEN, GUILD)
      const missing = await fetch(second.baseUrl + address())
      expect(missing.status).toBe(404)
      const created = await fetch(
        second.baseUrl + '/_test/audit-log-responses',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload()),
        }
      )
      expect(created.status).toBe(201)
      expect(await status(request(address(), 'DELETE'))).toBe(204)
      const retained = await fetch(second.baseUrl + address())
      expect(retained.status).toBe(200)
    } finally {
      await second.close()
    }
  })
})
