import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRealServer,
  seedBot,
  seedGuild,
  seedMember,
  seedRole,
  type RealServerContext,
} from './test-helpers'
import { joinTestGuildMember } from './services/test-control'
import type { RestMemberReadHold } from './services/rest-member-read-holds'
import type { RestFault } from './services/rest-faults'

const TOKEN = 'Bot member-hold'
const OTHER_TOKEN = 'Bot member-hold-other'
const GUILD = '222222222222222222'
const OTHER_GUILD = '333333333333333333'
const USER = '100000000000000001'
const OTHER_USER = '100000000000000002'
const MISSING_USER = '100000000000000777'
let server: RealServerContext
let roleId: string

/** Issues real HTTP with a short failure bound, including during teardown. */
function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(server.baseUrl + path, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(3000),
  })
}

/** Resolves an HTTP result to its status code, draining the body. */
async function code(pending: Promise<Response>): Promise<number> {
  const response = await pending
  await response.arrayBuffer()
  return response.status
}

/** Resolves an HTTP result to its parsed JSON body. */
async function json(pending: Promise<Response>): Promise<unknown> {
  const response = await pending
  return response.json()
}

/** Resolves an HTTP result to its raw text body. */
async function text(pending: Promise<Response>): Promise<string> {
  const response = await pending
  return response.text()
}

/** Reads the member as the owning bot, optionally under a version prefix. */
function readMember(
  prefix = '',
  user = USER,
  token: string | null = TOKEN
): Promise<Response> {
  return request(`${prefix}/guilds/${GUILD}/members/${user}`, {
    headers: token ? { Authorization: token } : {},
  })
}

/** Performs a control request, serializing non-string bodies as JSON. */
function control(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  let payload: string | undefined
  if (typeof body === 'string') payload = body
  else if (body !== undefined) payload = JSON.stringify(body)
  return request(path, { method, body: payload })
}

/** Arms a hold for the default guild/user and returns its public status. */
async function arm(
  overrides: Record<string, unknown> = {}
): Promise<RestMemberReadHold> {
  const response = await control('POST', '/_test/rest-member-read-holds', {
    guild_id: GUILD,
    user_id: USER,
    timeout_ms: 10_000,
    ...overrides,
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<RestMemberReadHold>
}

/** Reads server-side arrival evidence. */
async function status(id: string): Promise<RestMemberReadHold> {
  const response = await request(`/_test/rest-member-read-holds/${id}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return response.json() as Promise<RestMemberReadHold>
}

/** Waits on explicit server state with a bounded polling assertion. */
async function waitFor(
  id: string,
  state: RestMemberReadHold['state']
): Promise<void> {
  await expect.poll(() => status(id)).toMatchObject({ state })
}

/** Releases a control through the public API. */
function release(id: string): Promise<Response> {
  return control('POST', `/_test/rest-member-read-holds/${id}/release`)
}

/** Starts a read and records whether it already settled. */
function startRead(prefix = ''): {
  pending: Promise<Response>
  settled: () => boolean
} {
  let settled = false
  const pending = readMember(prefix).then((response) => {
    settled = true
    return response
  })
  return { pending, settled: () => settled }
}

/** Adds the seeded role to the member through the real REST route. */
async function addRole(): Promise<void> {
  const response = await request(
    `/guilds/${GUILD}/members/${USER}/roles/${roleId}`,
    { method: 'PUT', headers: { Authorization: TOKEN } }
  )
  expect(response.status).toBe(204)
}

/** Kicks the member through the real REST route. */
function kick(): Promise<Response> {
  return request(`/guilds/${GUILD}/members/${USER}`, {
    method: 'DELETE',
    headers: { Authorization: TOKEN },
  })
}

beforeEach(async () => {
  server = await createRealServer()
  seedBot(server.db, TOKEN)
  seedBot(server.db, OTHER_TOKEN, '999999999999999999')
  seedGuild(server.db, TOKEN, GUILD)
  seedGuild(server.db, OTHER_TOKEN, OTHER_GUILD)
  seedMember(server.db, GUILD, USER)
  seedMember(server.db, GUILD, OTHER_USER)
  seedMember(server.db, OTHER_GUILD, USER)
  roleId = seedRole(server.db, GUILD)
})

afterEach(async () => {
  await server.close()
})

describe('member read snapshot holds over actual HTTP', () => {
  it.each(['/api/v10', '/api', ''])(
    'returns the arrival snapshot after a role change under "%s"',
    async (prefix) => {
      const baseline = await readMember(prefix)
      const nativeBody = await baseline.text()
      expect(JSON.parse(nativeBody)).toMatchObject({ roles: [] })
      const hold = await arm()
      const { pending, settled } = startRead(prefix)
      await waitFor(hold.id, 'holding')
      expect(await status(hold.id)).toMatchObject({
        arrived: 1,
        arrived_at: expect.any(String),
        snapshot_status: 200,
        finished_at: null,
      })
      expect(settled()).toBe(false)
      await addRole()
      expect(await json(readMember(prefix))).toMatchObject({ roles: [roleId] })
      expect(settled()).toBe(false)
      expect(await code(release(hold.id))).toBe(200)
      const response = await pending
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe(
        baseline.headers.get('Content-Type')
      )
      expect(response.headers.get('X-RateLimit-Bucket')).toBe(
        baseline.headers.get('X-RateLimit-Bucket')
      )
      expect(await response.text()).toBe(nativeBody)
      expect(await status(hold.id)).toMatchObject({ state: 'released' })
    }
  )

  it('returns the snapshot after the member left, then a 404 snapshot for an absent member', async () => {
    const baseline = await text(readMember())
    const hold = await arm()
    const { pending } = startRead()
    await waitFor(hold.id, 'holding')
    expect(await code(kick())).toBe(204)
    expect(await code(readMember())).toBe(404)
    expect(joinTestGuildMember(server.db, GUILD, USER, 'rejoined')).toBeTruthy()
    expect(await json(readMember())).toMatchObject({ nick: 'rejoined' })
    await release(hold.id)
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(baseline)

    // Absent at arrival: the snapshot is the native 404 even though the
    // member rejoins while the read is held.
    expect(await code(kick())).toBe(204)
    const absent = await arm()
    const absentRead = startRead()
    await waitFor(absent.id, 'holding')
    expect(await status(absent.id)).toMatchObject({ snapshot_status: 404 })
    expect(joinTestGuildMember(server.db, GUILD, USER)).toBeTruthy()
    expect(await code(readMember())).toBe(200)
    await release(absent.id)
    const stale = await absentRead.pending
    expect(stale.status).toBe(404)
    await expect(stale.json()).resolves.toMatchObject({ code: 10_007 })
  })

  it('arms for a member that does not exist yet and snapshots the native 404', async () => {
    const hold = await arm({ user_id: MISSING_USER })
    const pending = readMember('', MISSING_USER)
    await waitFor(hold.id, 'holding')
    expect(await status(hold.id)).toMatchObject({ snapshot_status: 404 })
    seedMember(server.db, GUILD, MISSING_USER)
    expect(await code(readMember('', MISSING_USER))).toBe(200)
    await release(hold.id)
    const response = await pending
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      code: 10_007,
      message: 'Unknown Member',
    })
  })

  it('is one-shot even while the first request is held', async () => {
    const hold = await arm()
    const first = startRead()
    await waitFor(hold.id, 'holding')
    expect(await code(readMember())).toBe(200)
    expect(first.settled()).toBe(false)
    expect(await status(hold.id)).toMatchObject({ arrived: 1 })
    await release(hold.id)
    expect(await code(first.pending)).toBe(200)
    expect(await code(readMember())).toBe(200)
  })

  it('only the guild owning bot consumes the control', async () => {
    const hold = await arm()
    const others = [
      readMember('', OTHER_USER),
      request(`/guilds/${OTHER_GUILD}/members/${USER}`, {
        headers: { Authorization: OTHER_TOKEN },
      }),
      request(`/guilds/${GUILD}/members/${USER}`, {
        headers: { Authorization: OTHER_TOKEN },
      }),
      request(`/guilds/${GUILD}/members?limit=1`, {
        headers: { Authorization: TOKEN },
      }),
      request(`/guilds/${GUILD}/members/${USER}`, {
        method: 'PATCH',
        headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: 'changed' }),
      }),
      request('/_mock/health'),
    ]
    const codes = await Promise.all(others.map((pending) => code(pending)))
    expect(codes).toEqual([200, 200, 200, 200, 200, 200])
    expect(await code(readMember('', USER, null))).toBe(401)
    expect(await status(hold.id)).toMatchObject({
      state: 'armed',
      arrived: 0,
    })
    const { pending } = startRead()
    await waitFor(hold.id, 'holding')
    await release(hold.id)
    expect(await code(pending)).toBe(200)
  })

  it('returns the snapshot on timeout and never holds a retry', async () => {
    const hold = await arm({ timeout_ms: 400 })
    const { pending } = startRead()
    await waitFor(hold.id, 'holding')
    await addRole()
    const response = await pending
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ roles: [] })
    expect(await status(hold.id)).toMatchObject({ state: 'timed_out' })
    expect(await json(readMember())).toMatchObject({ roles: [roleId] })
    const unused = await arm({ user_id: OTHER_USER, timeout_ms: 50 })
    await waitFor(unused.id, 'timed_out')
    expect(await status(unused.id)).toMatchObject({ arrived: 0 })
  })

  it('disarms on client disconnect', async () => {
    const hold = await arm()
    const controller = new AbortController()
    const pending = request(`/guilds/${GUILD}/members/${USER}`, {
      headers: { Authorization: TOKEN },
      signal: controller.signal,
    })
    const rejected = expect(pending).rejects.toThrow()
    await waitFor(hold.id, 'holding')
    controller.abort()
    await rejected
    await waitFor(hold.id, 'disconnected')
    expect(await status(hold.id)).toMatchObject({
      arrived: 1,
      finished_at: expect.any(String),
    })
    expect(await code(readMember())).toBe(200)
  })

  it('DELETE resumes the held request with its snapshot', async () => {
    const hold = await arm()
    const { pending } = startRead()
    await waitFor(hold.id, 'holding')
    await addRole()
    expect(
      await code(control('DELETE', `/_test/rest-member-read-holds/${hold.id}`))
    ).toBe(204)
    const response = await pending
    await expect(response.json()).resolves.toMatchObject({ roles: [] })
    expect(
      await code(request(`/_test/rest-member-read-holds/${hold.id}`))
    ).toBe(404)
  })

  it.each(['reset', 'guild', 'bot', 'shutdown'])(
    'unblocks on %s without stranding HTTP',
    async (action) => {
      const hold = await arm()
      const other = await arm({ guild_id: OTHER_GUILD })
      const { pending } = startRead()
      await waitFor(hold.id, 'holding')
      let closing: Promise<void> | undefined
      switch (action) {
        case 'reset': {
          await control('POST', '/_test/reset', { token: OTHER_TOKEN })
          expect(await status(hold.id)).toMatchObject({ state: 'holding' })
          await control('POST', '/_test/reset', { token: TOKEN })
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
          await control('DELETE', `/_test/setup/${encodeURIComponent(TOKEN)}`)
          break
        }
        default: {
          closing = server.close()
        }
      }
      // The snapshot was computed before the control ended.
      expect(await code(pending)).toBe(200)
      await closing
      if (action === 'shutdown') return
      expect(
        await code(request(`/_test/rest-member-read-holds/${hold.id}`))
      ).toBe(404)
      const otherCode = await code(
        request(`/_test/rest-member-read-holds/${other.id}`)
      )
      // Cleanup is scoped: the other bot's control survives, except that the
      // reset case deliberately resets that bot first.
      expect(otherCode).toBe(action === 'reset' ? 404 : 200)
    }
  )

  it('a global reset removes controls of every bot', async () => {
    const own = await arm()
    const foreign = await arm({ guild_id: OTHER_GUILD })
    await control('POST', '/_test/reset')
    for (const id of [own.id, foreign.id])
      expect(await code(request(`/_test/rest-member-read-holds/${id}`))).toBe(
        404
      )
  })

  it('validates selectors, rejects duplicates, and release is idempotent', async () => {
    for (const body of [
      {},
      { guild_id: GUILD, user_id: USER },
      { guild_id: GUILD, user_id: USER, timeout_ms: 0 },
      { guild_id: GUILD, user_id: USER, timeout_ms: 60_001 },
      { guild_id: GUILD, user_id: USER, timeout_ms: 1.5 },
      { guild_id: GUILD, user_id: '@me', timeout_ms: 1000 },
      { guild_id: GUILD, user_id: 123, timeout_ms: 1000 },
      { guild_id: 'abc', user_id: USER, timeout_ms: 1000 },
      { guild_id: GUILD, user_id: USER, timeout_ms: '1000' },
      '{',
    ])
      expect(
        await code(control('POST', '/_test/rest-member-read-holds', body))
      ).toBe(400)
    expect(
      await code(
        control('POST', '/_test/rest-member-read-holds', {
          guild_id: '123',
          user_id: USER,
          timeout_ms: 1000,
        })
      )
    ).toBe(404)
    const hold = await arm()
    expect(
      await code(
        control('POST', '/_test/rest-member-read-holds', {
          guild_id: GUILD,
          user_id: USER,
          timeout_ms: 1000,
        })
      )
    ).toBe(409)
    // Releasing an armed control disarms it, so it can no longer claim a read.
    expect(await code(release(hold.id))).toBe(200)
    expect(await code(release(hold.id))).toBe(200)
    expect(await status(hold.id)).toMatchObject({ state: 'released' })
    expect(await code(readMember())).toBe(200)
    expect(await status(hold.id)).toMatchObject({ arrived: 0 })
    const next = await arm()
    expect(next.id).not.toBe(hold.id)
    expect(await code(request('/_test/rest-member-read-holds/missing'))).toBe(
      404
    )
    expect(
      await code(control('DELETE', '/_test/rest-member-read-holds/missing'))
    ).toBe(404)
    expect(
      await code(
        control('POST', '/_test/rest-member-read-holds/missing/release')
      )
    ).toBe(404)
  })
})

describe('member read holds combined with REST faults', () => {
  /** Arms a one-attempt fault on the member read. */
  async function armFault(): Promise<RestFault> {
    const response = await control('POST', '/_test/rest-faults', {
      method: 'GET',
      path: `/guilds/${GUILD}/members/${USER}`,
      times: 1,
      status: 500,
      code: 0,
      message: 'Member read failed',
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  it('lets a matching fault pre-empt the hold, which stays armed', async () => {
    const hold = await arm()
    const fault = await armFault()
    const failed = await readMember()
    expect(failed.status).toBe(500)
    await expect(failed.json()).resolves.toEqual({
      message: 'Member read failed',
      code: 0,
    })
    expect(await status(hold.id)).toMatchObject({ state: 'armed', arrived: 0 })
    expect(await json(request(`/_test/rest-faults/${fault.id}`))).toMatchObject(
      { remaining: 0, consumed: 1 }
    )
    const { pending } = startRead()
    await waitFor(hold.id, 'holding')
    await release(hold.id)
    expect(await code(pending)).toBe(200)
  })

  it('returns a released snapshot as is, even if a fault was armed meanwhile', async () => {
    const hold = await arm()
    const { pending } = startRead()
    await waitFor(hold.id, 'holding')
    const fault = await armFault()
    await release(hold.id)
    expect(await code(pending)).toBe(200)
    expect(await json(request(`/_test/rest-faults/${fault.id}`))).toMatchObject(
      { remaining: 1, consumed: 0 }
    )
  })
})
