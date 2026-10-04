import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRealServer,
  seedBot,
  seedGuild,
  type RealServerContext,
} from './test-helpers'
import { createTestUser, joinTestGuildMember } from './services/test-control'
import { createGuildBan } from './services/guild-bans'
import type { RestPageHold } from './services/rest-page-holds'
import type { RestFault } from './services/rest-faults'
import type { RestFaultQuery } from './validators/rest-fault'

const TOKEN = 'Bot page-hold'
const OTHER_TOKEN = 'Bot other'
const GUILD = '222222222222222222'
const OTHER_GUILD = '333333333333333333'
const CURSOR = '100000000000000001'
let server: RealServerContext

/** Issues real HTTP with a short failure bound, including during teardown. */
function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(server.baseUrl + path, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(2000),
  })
}

/** Projects an awaited HTTP result while keeping assertions concise. */
async function select<T, R>(
  promise: Promise<T>,
  project: (value: T) => R
): Promise<R> {
  const value = await promise
  return project(value)
}

/** Arms an exact page and returns its public status. */
async function arm(
  route = 'members',
  overrides: Record<string, unknown> = {}
): Promise<RestPageHold> {
  const response = await request('/_test/rest-page-holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: `/guilds/${GUILD}/${route}`,
      after: CURSOR,
      timeout_ms: 10_000,
      ...overrides,
    }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<RestPageHold>
}

/** Arms the existing page fault API without duplicating its selector logic. */
async function armFault(
  path: string,
  query: RestFaultQuery
): Promise<RestFault> {
  const response = await request('/_test/rest-faults', {
    method: 'POST',
    body: JSON.stringify({
      method: 'GET',
      path,
      query,
      times: 1,
      status: 500,
      code: 0,
      message: 'Page failed',
    }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<RestFault>
}

/** Observes the existing fault's counters using its public control endpoint. */
async function faultCounters(
  id: string,
  remaining: number,
  consumed: number
): Promise<void> {
  const response = await request(`/_test/rest-faults/${id}`)
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toMatchObject({ remaining, consumed })
}

/** Reads server-side arrival evidence; polling never infers importer persistence. */
async function status(id: string): Promise<RestPageHold> {
  const response = await request(`/_test/rest-page-holds/${id}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return response.json() as Promise<RestPageHold>
}

/** Waits on explicit server state with a bounded polling assertion. */
async function waitFor(
  id: string,
  state: RestPageHold['state']
): Promise<void> {
  await expect
    .poll(async () => await select(status(id), (value) => value.state))
    .toBe(state)
}

beforeEach(async () => {
  server = await createRealServer()
  seedBot(server.db, TOKEN)
  seedBot(server.db, OTHER_TOKEN, '999999999999999999')
  seedGuild(server.db, TOKEN, GUILD)
  seedGuild(server.db, TOKEN, OTHER_GUILD)
  for (const id of [CURSOR, '100000000000000002']) {
    createTestUser(server.db, { id, username: `member-${id}` })
    joinTestGuildMember(server.db, GUILD, id)
  }
  for (const id of ['100000000000000003', '100000000000000004']) {
    createTestUser(server.db, { id, username: `banned-${id}` })
    createGuildBan(server.db, GUILD, id, 'test reason')
  }
})

afterEach(async () => {
  await server.close()
})

describe('one-shot REST page holds over actual HTTP', () => {
  it.each([
    ['members', '/api/v10'],
    ['members', '/api'],
    ['members', ''],
    ['bans', '/api/v10'],
    ['bans', '/api'],
    ['bans', ''],
  ])(
    'holds %s under %s and returns the native page on release',
    async (route, prefix) => {
      const path = `${prefix}/guilds/${GUILD}/${route}?after=${CURSOR}&limit=1`
      const headers = { Authorization: TOKEN }
      const baseline = await request(path, { headers })
      const body = await baseline.text()
      const hold = await arm(route)
      let settled = false
      const pending = request(path, { headers }).then((response) => {
        settled = true
        return response
      })
      await waitFor(hold.id, 'holding')
      expect(settled).toBe(false)
      expect(await status(hold.id)).toMatchObject({
        arrived: 1,
        arrived_at: expect.any(String),
        finished_at: null,
      })

      for (const otherPath of [
        `${prefix}/guilds/${GUILD}/${route}?limit=1`,
        `${prefix}/guilds/${GUILD}/${route}?after=100000000000000000`,
        `${prefix}/guilds/${OTHER_GUILD}/${route}?after=${CURSOR}`,
        `${prefix}/guilds/${GUILD}/${route === 'members' ? 'bans' : 'members'}?after=${CURSOR}`,
        '/_mock/health',
      ]) {
        expect(
          await select(request(otherPath, { headers }), (value) => value.status)
        ).toBe(200)
      }
      expect(
        await select(
          request(path, { headers: { Authorization: OTHER_TOKEN } }),
          (value) => value.status
        )
      ).toBe(200)
      // A claimed control is one-shot even while its first request is still held.
      expect(
        await select(request(path, { headers }), (value) => value.status)
      ).toBe(200)
      expect(await select(request(path), (value) => value.status)).toBe(401)
      expect(settled).toBe(false)
      const release = await request(
        `/_test/rest-page-holds/${hold.id}/release`,
        { method: 'POST' }
      )
      expect(release.status).toBe(200)
      const response = await pending
      expect(response.status).toBe(baseline.status)
      expect(response.headers.get('Content-Type')).toBe(
        baseline.headers.get('Content-Type')
      )
      expect(response.headers.get('X-RateLimit-Bucket')).toBe(
        baseline.headers.get('X-RateLimit-Bucket')
      )
      expect(await response.text()).toBe(body)
      expect(await select(status(hold.id), (value) => value.state)).toBe(
        'released'
      )
      expect(
        await select(request(path, { headers }), (value) => value.text())
      ).toBe(body)
    }
  )

  it('requires exact missing/zero cursors and supports bans before', async () => {
    const headers = { Authorization: TOKEN }
    const first = await arm('members', { after: null })
    expect(
      await select(
        request(`/guilds/${GUILD}/members?after=0`, { headers }),
        (value) => value.status
      )
    ).toBe(200)
    expect(await select(status(first.id), (value) => value.arrived)).toBe(0)
    const pending = request(`/guilds/${GUILD}/members`, { headers })
    await waitFor(first.id, 'holding')
    await request(`/_test/rest-page-holds/${first.id}/release`, {
      method: 'POST',
    })
    expect(await select(pending, (value) => value.status)).toBe(200)
    const before = await arm('bans', {
      after: null,
      before: '100000000000000004',
    })
    const path = `/guilds/${GUILD}/bans?before=100000000000000004`
    expect(
      await select(
        request(path + '&after=0', { headers }),
        (value) => value.status
      )
    ).toBe(200)
    const banPage = request(path, { headers })
    await waitFor(before.id, 'holding')
    await request(`/_test/rest-page-holds/${before.id}/release`, {
      method: 'POST',
    })
    expect(await select(banPage, (value) => value.json())).toMatchObject([
      { user: { id: '100000000000000003' } },
    ])
  })

  it('expires from arming, releases held HTTP, and never holds a retry', async () => {
    const hold = await arm('members', { timeout_ms: 500 })
    const path = `/guilds/${GUILD}/members?after=${CURSOR}`
    const headers = { Authorization: TOKEN }
    const pending = request(path, { headers })
    await waitFor(hold.id, 'holding')
    expect(await select(pending, (value) => value.status)).toBe(200)
    expect(await select(status(hold.id), (value) => value.state)).toBe(
      'timed_out'
    )
    expect(
      await select(request(path, { headers }), (value) => value.status)
    ).toBe(200)
    const unused = await arm('bans', { timeout_ms: 50 })
    await waitFor(unused.id, 'timed_out')
    expect(await select(status(unused.id), (value) => value.arrived)).toBe(0)
    expect(
      await select(
        request(`/guilds/${GUILD}/bans?after=${CURSOR}`, { headers }),
        (value) => value.status
      )
    ).toBe(200)
  })

  it('disarms on client disconnect before the same bot restarts', async () => {
    const hold = await arm()
    const controller = new AbortController()
    const path = `/guilds/${GUILD}/members?after=${CURSOR}`
    const pending = request(path, {
      headers: { Authorization: TOKEN },
      signal: controller.signal,
    })
    const rejected = expect(pending).rejects.toThrow()
    await waitFor(hold.id, 'holding')
    controller.abort()
    await rejected
    await waitFor(hold.id, 'disconnected')
    expect(await select(status(hold.id), (value) => value.arrived)).toBe(1)
    expect(
      await select(
        request(path, { headers: { Authorization: TOKEN } }),
        (value) => value.status
      )
    ).toBe(200)
  })

  it.each(['remove', 'reset', 'guild', 'bot', 'shutdown'])(
    'unblocks on %s without stranding HTTP',
    async (action) => {
      const hold = await arm()
      const other = await arm('bans', { path: `/guilds/${OTHER_GUILD}/bans` })
      const path = `/guilds/${GUILD}/members?after=${CURSOR}`
      const pending = request(path, { headers: { Authorization: TOKEN } })
      await waitFor(hold.id, 'holding')
      let closing: Promise<void> | undefined
      switch (action) {
        case 'remove': {
          expect(
            await select(
              request(`/_test/rest-page-holds/${hold.id}`, {
                method: 'DELETE',
              }),
              (value) => value.status
            )
          ).toBe(204)

          break
        }
        case 'reset': {
          // A reset for another bot must leave this hold in place.
          await request('/_test/reset', {
            method: 'POST',
            body: JSON.stringify({ token: OTHER_TOKEN }),
          })
          expect(await select(status(hold.id), (value) => value.state)).toBe(
            'holding'
          )
          await request('/_test/reset', {
            method: 'POST',
            body: JSON.stringify({ token: TOKEN }),
          })

          break
        }
        case 'guild': {
          await request(`/guilds/${GUILD}`, {
            method: 'DELETE',
            headers: { Authorization: TOKEN },
          })

          break
        }
        case 'bot': {
          await request(`/_test/setup/${encodeURIComponent(TOKEN)}`, {
            method: 'DELETE',
          })

          break
        }
        default: {
          closing = server.close()
        }
      }
      const response = await pending
      expect(response.status).toBe(
        ['guild', 'bot'].includes(action) ? 404 : 200
      )
      await response.arrayBuffer()
      await closing
      if (action === 'shutdown') {
        return
      }

      expect(
        await select(
          request(`/_test/rest-page-holds/${hold.id}`),
          (value) => value.status
        )
      ).toBe(404)
      if (['remove', 'guild'].includes(action))
        expect(await select(status(other.id), (value) => value.state)).toBe(
          'armed'
        )
      else
        expect(
          await select(
            request(`/_test/rest-page-holds/${other.id}`),
            (value) => value.status
          )
        ).toBe(404)
    }
  )

  it('isolates simultaneous holds across bots and global reset removes both', async () => {
    const foreignGuild = seedGuild(server.db, OTHER_TOKEN, '444444444444444444')
    const own = await arm()
    const foreign = await arm('bans', { path: `/guilds/${foreignGuild}/bans` })
    const ownPath = `${own.path}?after=${CURSOR}`
    const foreignPath = `${foreign.path}?after=${CURSOR}`
    const ownPending = request(ownPath, { headers: { Authorization: TOKEN } })
    const foreignPending = request(foreignPath, {
      headers: { Authorization: OTHER_TOKEN },
    })
    await waitFor(own.id, 'holding')
    await waitFor(foreign.id, 'holding')
    await request('/_test/reset', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    })
    const ownResponse = await ownPending
    expect(ownResponse.status).toBe(200)
    await ownResponse.arrayBuffer()
    const foreignStatus = await status(foreign.id)
    expect(foreignStatus.state).toBe('holding')
    await request('/_test/reset', { method: 'POST' })
    const foreignResponse = await foreignPending
    expect(foreignResponse.status).toBe(200)
    await foreignResponse.arrayBuffer()
    for (const id of [own.id, foreign.id]) {
      const removed = await request(`/_test/rest-page-holds/${id}`)
      expect(removed.status).toBe(404)
    }
  })

  it('isolates controls between actual servers with identical tokens and guild IDs', async () => {
    const second = await createRealServer()
    try {
      seedBot(second.db, TOKEN)
      seedGuild(second.db, TOKEN, GUILD)
      const hold = await arm()
      const response = await fetch(
        `${second.baseUrl}${hold.path}?after=${CURSOR}`,
        {
          headers: { Authorization: TOKEN },
          signal: AbortSignal.timeout(2000),
        }
      )
      expect(response.status).toBe(200)
      await response.arrayBuffer()
      const untouched = await status(hold.id)
      expect(untouched.arrived).toBe(0)
      await request(`/_test/rest-page-holds/${hold.id}`, { method: 'DELETE' })
    } finally {
      await second.close()
    }
  })

  it('validates selectors, rejects active duplicates, and can disarm before arrival', async () => {
    for (const body of [
      {},
      { path: `/guilds/${GUILD}/members`, timeout_ms: 1000 },
      {
        path: `/guilds/${GUILD}/members`,
        after: null,
        before: '123',
        timeout_ms: 1000,
      },
      {
        path: `/guilds/${GUILD}/bans`,
        after: '123',
        before: '456',
        timeout_ms: 1000,
      },
      {
        path: `/guilds/${GUILD}/members?after=123`,
        after: '123',
        timeout_ms: 1000,
      },
      { path: `/guilds/${GUILD}/members`, after: 123, timeout_ms: 1000 },
      { path: `/guilds/${GUILD}/members`, after: null, timeout_ms: 60_001 },
      { path: `/guilds/${GUILD}/members`, after: null, timeout_ms: 0 },
    ]) {
      expect(
        await select(
          request('/_test/rest-page-holds', {
            method: 'POST',
            body: JSON.stringify(body),
          }),
          (value) => value.status
        )
      ).toBe(400)
    }
    expect(
      await select(
        request('/_test/rest-page-holds', { method: 'POST', body: '{' }),
        (value) => value.status
      )
    ).toBe(400)
    expect(
      await select(
        request('/_test/rest-page-holds', {
          method: 'POST',
          body: JSON.stringify({
            path: '/guilds/123/members',
            after: null,
            timeout_ms: 1000,
          }),
        }),
        (value) => value.status
      )
    ).toBe(404)
    const hold = await arm()
    expect(
      await select(
        request('/_test/rest-page-holds', {
          method: 'POST',
          body: JSON.stringify({
            path: hold.path,
            after: hold.after,
            timeout_ms: 1000,
          }),
        }),
        (value) => value.status
      )
    ).toBe(409)
    expect(
      await select(
        request(`${hold.path}?after=${CURSOR}&after=${CURSOR}`, {
          headers: { Authorization: TOKEN },
        }),
        (value) => value.status
      )
    ).toBe(200)
    expect(await select(status(hold.id), (value) => value.arrived)).toBe(0)
    await request(`/_test/rest-page-holds/${hold.id}/release`, {
      method: 'POST',
    })
    expect(await select(status(hold.id), (value) => value.state)).toBe(
      'released'
    )
    expect(
      await select(
        request(`${hold.path}?after=${CURSOR}`, {
          headers: { Authorization: TOKEN },
        }),
        (value) => value.status
      )
    ).toBe(200)
    const next = await arm()
    expect(next.id).not.toBe(hold.id)
    for (const method of ['GET', 'DELETE', 'POST']) {
      expect(
        await select(
          request(
            '/_test/rest-page-holds/missing' +
              (method === 'POST' ? '/release' : ''),
            { method }
          ),
          (value) => value.status
        )
      ).toBe(404)
    }
  })
})

describe('page holds combined with existing page-specific REST faults', () => {
  it.each([
    {
      route: 'members',
      prefix: '/api/v10',
      direction: 'after',
      cursor: CURSOR,
    },
    { route: 'members', prefix: '/api', direction: 'after', cursor: CURSOR },
    { route: 'bans', prefix: '', direction: 'after', cursor: CURSOR },
    {
      route: 'bans',
      prefix: '/api/v10',
      direction: 'before',
      cursor: '100000000000000004',
    },
  ])(
    'defers the $route $direction fault under $prefix until release',
    async ({ route, prefix, direction, cursor }) => {
      const path = `/guilds/${GUILD}/${route}`
      const url = `${prefix}${path}?${direction}=${cursor}&limit=1`
      const headers = { Authorization: TOKEN }
      const baseline = await request(url, { headers })
      const nativeBody = await baseline.text()
      const hold = await arm(
        route,
        direction === 'before'
          ? { after: null, before: cursor }
          : { after: cursor }
      )
      const fault = await armFault(path, { limit: 1, [direction]: cursor })
      let settled = false
      const pending = request(url, { headers }).then((response) => {
        settled = true
        return response
      })
      await waitFor(hold.id, 'holding')
      await faultCounters(fault.id, 1, 0)
      for (const other of [
        `${prefix}${path}?limit=1`,
        `${prefix}${path}?${direction}=${cursor}&limit=2`,
        `${prefix}/guilds/${OTHER_GUILD}/${route}?${direction}=${cursor}&limit=1`,
        `${prefix}/guilds/${GUILD}/${route === 'members' ? 'bans' : 'members'}?after=${CURSOR}&limit=1`,
        '/_mock/health',
      ]) {
        const response = await request(other, { headers })
        expect(response.status).toBe(200)
        await response.arrayBuffer()
      }
      const otherBot = await request(url, {
        headers: { Authorization: OTHER_TOKEN },
      })
      expect(otherBot.status).toBe(200)
      await otherBot.arrayBuffer()
      await faultCounters(fault.id, 1, 0)
      expect(settled).toBe(false)
      await request(`/_test/rest-page-holds/${hold.id}/release`, {
        method: 'POST',
      })
      const failed = await pending
      expect(failed.status).toBe(500)
      await expect(failed.json()).resolves.toEqual({
        message: 'Page failed',
        code: 0,
      })
      await faultCounters(fault.id, 0, 1)
      const recovered = await request(url, { headers })
      expect(recovered.status).toBe(200)
      expect(await recovered.text()).toBe(nativeBody)
      const released = await status(hold.id)
      expect(released.state).toBe('released')
    }
  )

  it.each(['remove', 'reset', 'disconnect', 'shutdown'])(
    'does not strand a faulted page during $0 cleanup',
    async (action) => {
      const hold = await arm()
      const fault = await armFault(hold.path, { limit: 1, after: CURSOR })
      const url = `${hold.path}?after=${CURSOR}&limit=1`
      const headers = { Authorization: TOKEN }
      const controller = new AbortController()
      const pending = request(url, {
        headers,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
      })
      const rejected =
        action === 'disconnect' ? expect(pending).rejects.toThrow() : undefined
      await waitFor(hold.id, 'holding')
      await faultCounters(fault.id, 1, 0)
      let closing: Promise<void> | undefined
      switch (action) {
        case 'remove': {
          await request(`/_test/rest-page-holds/${hold.id}`, {
            method: 'DELETE',
          })
          break
        }
        case 'reset': {
          await request('/_test/reset', {
            method: 'POST',
            body: JSON.stringify({ token: TOKEN }),
          })
          break
        }
        case 'disconnect': {
          controller.abort()
          await rejected
          await waitFor(hold.id, 'disconnected')
          await faultCounters(fault.id, 1, 0)
          break
        }
        default: {
          closing = server.close()
        }
      }
      if (action === 'disconnect') {
        const retry = await request(url, { headers })
        expect(retry.status).toBe(500)
        await retry.arrayBuffer()
      } else {
        const response = await pending
        expect(response.status).toBe(action === 'reset' ? 200 : 500)
        await response.arrayBuffer()
      }
      await closing
      if (action === 'shutdown') return
      if (action === 'reset') {
        const removed = await request(`/_test/rest-faults/${fault.id}`)
        expect(removed.status).toBe(404)
      } else {
        await faultCounters(fault.id, 0, 1)
      }
      const recovered = await request(url, { headers })
      expect(recovered.status).toBe(200)
      await recovered.arrayBuffer()
    }
  )
})
