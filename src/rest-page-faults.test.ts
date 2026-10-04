import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { initializeDatabase } from './db'
import {
  createRealServer,
  seedBan,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedMessage,
} from './test-helpers'

const token = 'Bot page-owner'
const otherToken = 'Bot page-other'
const failure = { status: 500, code: 0, message: 'Page failed' }

describe('page-specific REST GET faults', () => {
  let db: ReturnType<typeof initializeDatabase>
  let server: ReturnType<typeof buildApp>
  let guild: string
  let channel: string
  let otherGuild: string
  let otherChannel: string

  /** Sends requests through production middleware and route assembly. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ) {
    return server.app.request(path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Returns a response status for concise route assertions. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Creates a fault with an exact page query and bounded attempts. */
  async function arm(path: string, query: unknown = {}, times = 1) {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'GET',
      path,
      query,
      times,
      ...failure,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as { id: string; query: unknown }
  }

  /** Observes counters anonymously without issuing the targeted bot GET. */
  async function counters(id: string, remaining: number, consumed: number) {
    const response = await server.app.request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      remaining,
      consumed,
    })
  }

  /** Builds a concrete list path for the chosen fixture scope. */
  function listPath(route: string, other = false) {
    return route === 'messages'
      ? `/channels/${other ? otherChannel : channel}/messages`
      : `/guilds/${other ? otherGuild : guild}/${route}`
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    server = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, token, '100000000000000001')
    seedBot(db, otherToken, '100000000000000002')
    guild = seedGuild(db, token)
    otherGuild = seedGuild(db, otherToken, '222222222222222223')
    channel = seedChannel(db, guild)
    otherChannel = seedChannel(db, otherGuild, '333333333333333334')
    for (const id of [
      '555555555555555551',
      '555555555555555552',
      '555555555555555553',
    ]) {
      seedMember(db, guild, id)
      seedBan(db, guild, id)
      const message = seedMessage(db, channel, id, token, `Message ${id}`)
      db.prepare('UPDATE messages SET id = ? WHERE id = ?').run(id, message)
    }
  })

  afterEach(() => {
    server.unsubscribeGateway()
    server.wss.close()
    db.close()
  })

  for (const route of ['members', 'bans', 'messages']) {
    it(`faults a concrete later ${route} page and recovers its native data`, async () => {
      const path = listPath(route)
      const cursor = '555555555555555552'
      const direction = route === 'messages' ? 'before' : 'after'
      const page = { limit: 1, [direction]: cursor }
      const url = `${path}?${direction}=${cursor}&limit=1`
      const baseline = await request(url)
      expect(baseline.status).toBe(200)
      const data: unknown = await baseline.json()
      expect(data).toMatchObject([
        route === 'messages'
          ? { id: '555555555555555551' }
          : { user: { id: '555555555555555553' } },
      ])
      const fault = await arm(path, page, 2)
      for (const mismatch of [
        `${path}?limit=1`,
        `${path}?${direction}=555555555555555551&limit=1`,
        `${path}?${direction}=${cursor}&limit=2`,
        `${listPath(route, true)}?${direction}=${cursor}&limit=1`,
        `${path}/`,
        `${path}/123?${direction}=${cursor}&limit=1`,
      ])
        expect(await status(mismatch)).not.toBe(500)
      for (const auth of ['', 'Bot invalid', 'Bearer invalid'])
        expect(await status(url, 'GET', undefined, auth)).toBe(401)
      expect(await status(url, 'GET', undefined, otherToken)).toBe(200)
      await request(url, 'HEAD')
      await counters(fault.id, 2, 0)
      for (const prefix of ['/api', '/api/v10']) {
        const response = await request(
          `${prefix}${path}?limit=01&${direction}=0${cursor}&trace=ignored`
        )
        expect(response.status).toBe(500)
        await expect(response.json()).resolves.toEqual({
          code: 0,
          message: 'Page failed',
        })
      }
      await counters(fault.id, 0, 2)
      await expect(
        request(url).then((response) => response.json())
      ).resolves.toEqual(data)
      const rearmed = await arm(path, page)
      expect(rearmed.id).not.toBe(fault.id)
      expect(await status(`/_test/rest-faults/${rearmed.id}`, 'DELETE')).toBe(
        204
      )
      expect(await status(`/_test/rest-faults/${rearmed.id}`)).toBe(404)
      await expect(
        request(url).then((response) => response.json())
      ).resolves.toEqual(data)
    })

    it(`bounds simultaneous attempts and separates ${route} page conflicts`, async () => {
      const path = listPath(route)
      const first = await arm(path, { limit: '01' }, 3)
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'GET',
          path,
          query: { limit: 1 },
          ...failure,
        })
      ).toBe(409)
      const next = await arm(path, { limit: 1, after: '555555555555555552' })
      const results = await Promise.all(
        Array.from({ length: 12 }, () => request(`${path}?limit=1`))
      )
      expect(results.filter((result) => result.status === 500)).toHaveLength(3)
      expect(results.filter((result) => result.status === 200)).toHaveLength(9)
      await counters(first.id, 0, 3)
      await counters(next.id, 1, 0)
      expect(await status(`${path}?after=555555555555555552&limit=1`)).toBe(500)
    })

    it(`does not consume ${route} faults for malformed or ambiguous page queries`, async () => {
      const path = listPath(route)
      const fault = await arm(path)
      for (const query of [
        'limit=0',
        'limit=1x',
        'limit=1&limit=1',
        'after=1&after=1',
        'after=1&before=2',
        'after=bad',
      ])
        await request(`${path}?${query}`)
      await counters(fault.id, 1, 0)
      expect(await status(path)).toBe(500)
      expect(await status(path)).toBe(200)
    })
  }

  it.each([
    { route: 'bans', direction: 'before' },
    { route: 'messages', direction: 'after' },
    { route: 'messages', direction: 'around' },
  ])(
    'matches $route $direction and rejects equivalent active queries',
    async ({ route, direction }) => {
      const path = listPath(route)
      const fault = await arm(path, {
        [direction]: '555555555555555552',
        limit: 1,
      })
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'GET',
          path,
          query: { limit: '01', [direction]: '0555555555555555552' },
          ...failure,
        })
      ).toBe(409)
      expect(
        await status(`${path}?${direction}=555555555555555553&limit=1`)
      ).toBe(200)
      await counters(fault.id, 1, 0)
      expect(
        await status(`${path}?${direction}=555555555555555552&limit=1`)
      ).toBe(500)
      expect(
        await status(`${path}?${direction}=555555555555555552&limit=1`)
      ).toBe(200)
    }
  )

  it.each([
    'reset',
    'scoped reset',
    'teardown',
    'guild deletion',
    'channel deletion',
  ])('cleans active and exhausted page controls on %s', async (cleanup) => {
    const own = [
      await arm(listPath('members')),
      await arm(listPath('bans')),
      await arm(listPath('messages')),
    ]
    await request(listPath('messages'))
    own.push(await arm(listPath('messages')))
    const other = await arm(listPath('messages', true))
    switch (cleanup) {
      case 'reset': {
        await request('/_test/reset', 'POST', {})
        break
      }
      case 'scoped reset': {
        await request('/_test/reset', 'POST', { token })
        break
      }
      case 'teardown': {
        await request(`/_test/setup/${encodeURIComponent(token)}`, 'DELETE')
        break
      }
      case 'guild deletion': {
        await request(`/guilds/${guild}`, 'DELETE')
        break
      }
      case 'channel deletion': {
        await request(`/channels/${channel}`, 'DELETE')
        break
      }
    }
    for (const [index, fault] of own.entries())
      expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(
        cleanup === 'channel deletion' && index < 2 ? 200 : 404
      )
    expect(await status(`/_test/rest-faults/${other.id}`)).toBe(
      cleanup === 'reset' ? 404 : 200
    )
    if (cleanup === 'reset' || cleanup === 'scoped reset')
      for (const route of ['members', 'bans', 'messages'])
        expect(await status(listPath(route))).toBe(200)
  })

  it.each([
    { route: 'members', query: null },
    { route: 'members', query: [] },
    { route: 'members', query: { before: '1' } },
    { route: 'bans', query: { around: '1' } },
    { route: 'messages', query: { after: '1', before: '2' } },
    { route: 'messages', query: { around: '1', after: '2' } },
    { route: 'messages', query: { limit: 101 } },
    { route: 'members', query: { limit: 1001 } },
    { route: 'bans', query: { limit: 0 } },
    { route: 'bans', query: { limit: 1.5 } },
    { route: 'bans', query: { limit: null } },
    { route: 'bans', query: { limit: '1x' } },
    { route: 'bans', query: { after: 123 } },
    { route: 'bans', query: { after: '*' } },
    { route: 'bans', query: { after: '123456789012345678901' } },
    { route: 'bans', query: { unknown: '1' } },
  ])(
    'rejects invalid control query $query for $route',
    async ({ route, query }) => {
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'GET',
          path: listPath(route),
          query,
          ...failure,
        })
      ).toBe(400)
    }
  )

  it('validates scope, legacy query fields, and exact numeric paths', async () => {
    for (const selector of [
      { path: listPath('messages'), guild_id: guild },
      { path: listPath('members'), guild_id: otherGuild },
      { path: `/guilds/${guild}/audit-logs`, query: {} },
      { path: `/guilds/${guild}/members/123`, query: {} },
      { path: '/users/123', guild_id: guild, query: {} },
      { path: `${listPath('bans')}?after=123` },
      { path: '/guilds/*/members' },
    ])
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'GET',
          ...failure,
          ...selector,
        })
      ).toBe(400)
    for (const path of [
      '/guilds/123/members',
      '/guilds/123/bans',
      '/channels/123/messages',
    ])
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'GET',
          path,
          ...failure,
        })
      ).toBe(404)
  })

  it('normalizes default limits, member after=0, and message around cursors', async () => {
    for (const route of ['members', 'bans', 'messages']) {
      const path = listPath(route)
      const fault = await arm(path)
      const limit = route === 'members' ? 1 : route === 'bans' ? 1000 : 50
      expect(fault.query).toEqual(
        route === 'members' ? { limit, after: '0' } : { limit }
      )
      expect(
        await status(
          `${path}?limit=${limit}${route === 'members' ? '&after=00' : ''}`
        )
      ).toBe(500)
    }
    const around = await arm(listPath('messages'), {
      around: '0555555555555555552',
      limit: '02',
    })
    expect(around.query).toEqual({ limit: 2, around: '555555555555555552' })
    expect(
      await status(`${listPath('messages')}?around=555555555555555552&limit=2`)
    ).toBe(500)
  })
})

describe('page faults over real HTTP', () => {
  it('bounds concurrent matching attempts while unrelated pages and same-bot scopes run natively', async () => {
    const server = await createRealServer()
    try {
      seedBot(server.db, token)
      const guild = seedGuild(server.db, token)
      const siblingGuild = seedGuild(server.db, token, '222222222222222224')
      const channel = seedChannel(server.db, guild)
      const siblingChannel = seedChannel(server.db, guild, '333333333333333335')
      for (const [path, unrelated] of [
        [`/guilds/${guild}/members`, `/guilds/${siblingGuild}/members`],
        [`/guilds/${guild}/bans`, `/guilds/${siblingGuild}/bans`],
        [
          `/channels/${channel}/messages`,
          `/channels/${siblingChannel}/messages`,
        ],
      ]) {
        const response = await fetch(`${server.baseUrl}/_test/rest-faults`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'GET',
            path,
            query: { after: '555555555555555552', limit: 1 },
            times: 3,
            ...failure,
          }),
        })
        expect(response.status).toBe(201)
        const fault = (await response.json()) as { id: string }
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            fetch(
              `${server.baseUrl}${index < 8 ? path : unrelated}?after=${index < 6 || index >= 8 ? '555555555555555552' : '555555555555555553'}&limit=1`,
              { headers: { Authorization: token } }
            )
          )
        )
        expect(results.filter((result) => result.status === 500)).toHaveLength(
          3
        )
        expect(results.filter((result) => result.status === 200)).toHaveLength(
          9
        )
        const observation = await fetch(
          `${server.baseUrl}/_test/rest-faults/${fault.id}`
        )
        await expect(observation.json()).resolves.toMatchObject({
          remaining: 0,
          consumed: 3,
        })
        const recovered = await fetch(
          `${server.baseUrl}${path}?after=555555555555555552&limit=1`,
          { headers: { Authorization: token } }
        )
        expect(recovered.status).toBe(200)
        await expect(recovered.json()).resolves.toEqual([])
      }
    } finally {
      await server.close()
    }
  })
})
