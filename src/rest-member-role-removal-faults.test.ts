import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { buildApp } from './app'
import { closeDatabase, initializeDatabase, type Database } from './db'
import { gatewayBus } from './gateway/bus'
import { GatewayOp } from './gateway/opcodes'
import { addMemberRole } from './services/guild-members'
import {
  createRealServer,
  seedBot,
  seedGuild,
  seedMember,
  seedRole,
  type RealServerContext,
} from './test-helpers'
import { consumeRestFault, type RestFault } from './services/rest-faults'

const token = 'Bot role-removal-owner'
const otherToken = 'Bot role-removal-other'
const otherGuildId = '222222222222222223'
const user = '555555555555555555'
const otherUser = '555555555555555556'
const failure = { status: 403, code: 50_013, message: 'Missing Permissions' }

/** Seeds an owned guild whose member holds one removable role. */
function seed(db: Database) {
  seedBot(db, token)
  seedBot(db, otherToken, '111111111111111112')
  const guild = seedGuild(db, token)
  seedGuild(db, otherToken, otherGuildId)
  seedMember(db, guild, user)
  seedMember(db, guild, otherUser)
  const role = seedRole(db, guild, 'muted')
  const otherRole = seedRole(db, guild, 'other')
  addMemberRole(db, guild, user, role)
  addMemberRole(db, guild, user, otherRole)
  addMemberRole(db, guild, otherUser, role)
  return { guild, role, otherRole }
}

/** Snapshots every role assignment and member row touched by the route. */
function snapshot(db: Database): unknown[] {
  return ['member_roles', 'guild_members'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  )
}

/** Lists the role IDs currently held by a member, in storage order. */
function roleIds(db: Database, guild: string, member = user): string[] {
  return (
    db
      .prepare(
        'SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ? ORDER BY rowid'
      )
      .all(guild, member) as { role_id: string }[]
  ).map((row) => row.role_id)
}

describe('member role removal REST faults through full buildApp', () => {
  let db: Database
  let built: ReturnType<typeof buildApp>
  let guild: string
  let role: string
  let otherRole: string
  let path: string

  /** Calls the assembled app with normal authentication and all middleware. */
  async function request(
    route: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ): Promise<Response> {
    return built.app.request(route, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Arms the exact member role removal selector through the control API. */
  async function arm(
    overrides: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'DELETE',
      path,
      ...failure,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Returns the status of a completed request. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Reads retained consumption without entering any native route. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    built = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    ;({ guild, role, otherRole } = seed(db))
    path = `/guilds/${guild}/members/${user}/roles/${role}`
  })

  afterEach(() => {
    built.shutdownRestFaults()
    built.shutdownRestPageHolds()
    built.unsubscribeGateway()
    built.wss.close()
    closeDatabase(db)
    vi.restoreAllMocks()
  })

  it('keeps the role and emits nothing across all prefixes, then removes it on retry', async () => {
    const fault = await arm({ times: 3 })
    expect(fault).toMatchObject({
      method: 'DELETE',
      path,
      guild_id: guild,
      channel_id: null,
      remaining: 3,
      consumed: 0,
    })
    const before = snapshot(db)
    const events = vi.spyOn(gatewayBus, 'emit')
    for (const prefix of ['/api/v10', '/api', '']) {
      const response = await request(prefix + path, 'DELETE')
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        code: failure.code,
        message: failure.message,
      })
      expect(snapshot(db)).toEqual(before)
    }
    expect(events).not.toHaveBeenCalled()
    expect(await inspect(fault.id)).toMatchObject({ consumed: 3, remaining: 0 })

    expect(await status(path, 'DELETE')).toBe(204)
    expect(roleIds(db, guild)).toEqual([otherRole])
    expect(events.mock.calls.map(([name]) => name)).toEqual([
      'guild.member.update',
    ])
    expect(await inspect(fault.id)).toMatchObject({ consumed: 3, remaining: 0 })
  })

  it('prearms before the member or role exists and fails ahead of native lookups', async () => {
    const missingMember = '555555555555555599'
    const missingRole = '777777777777777799'
    const target = `/guilds/${guild}/members/${missingMember}/roles/${missingRole}`
    const fault = await arm({ path: target })
    expect(await status(target, 'DELETE')).toBe(403)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1, remaining: 0 })
    const missing = await request(target, 'DELETE')
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({
      message: 'Unknown Role',
      code: 10_011,
    })
  })

  it('fails the @everyone role selector before native role validation', async () => {
    const target = `/guilds/${guild}/members/${user}/roles/${guild}`
    await arm({ path: target })
    expect(await status(target, 'DELETE')).toBe(403)
    expect(await status(target, 'DELETE')).toBe(400)
  })

  it('does not match another role, member, guild, bot, method, or unauthenticated request', async () => {
    const foreignGuild = otherGuildId
    const foreignRole = seedRole(db, foreignGuild, 'foreign')
    seedMember(db, foreignGuild, user)
    addMemberRole(db, foreignGuild, user, foreignRole)
    const fault = await arm()
    const before = snapshot(db)
    for (const auth of ['', 'Bot missing', 'Bearer missing'])
      expect(await status(path, 'DELETE', undefined, auth)).toBe(401)
    for (const method of ['GET', 'POST', 'PATCH'])
      expect(await status(path, method)).not.toBe(403)
    expect(snapshot(db)).toEqual(before)
    // The kick route and the PUT assignment route share nothing with the selector.
    expect(await status(path, 'PUT')).toBe(204)
    expect(
      await status(`/guilds/${guild}/members/${user}/roles/${otherRole}`, 'PUT')
    ).toBe(204)
    expect(
      await status(
        `/guilds/${guild}/members/${user}/roles/${otherRole}`,
        'DELETE'
      )
    ).toBe(204)
    expect(
      await status(
        `/guilds/${guild}/members/${otherUser}/roles/${role}`,
        'DELETE'
      )
    ).toBe(204)
    expect(
      await status(
        `/guilds/${foreignGuild}/members/${user}/roles/${foreignRole}`,
        'DELETE',
        undefined,
        otherToken
      )
    ).toBe(204)
    // Leading-zero aliases are distinct concrete selectors, not numeric coercions.
    expect(
      await status(`/guilds/${guild}/members/${user}/roles/0${role}`, 'DELETE')
    ).toBe(404)
    expect(roleIds(db, guild)).toEqual([role])
    expect(await inspect(fault.id)).toMatchObject({ consumed: 0, remaining: 1 })
    expect(await status(path, 'DELETE')).toBe(403)
    expect(roleIds(db, guild)).toEqual([role])
  })

  it('keeps the PUT assignment and DELETE removal selectors independent', async () => {
    const assignment = await arm({ method: 'PUT', status: 500 })
    const removal = await arm()
    expect(await status(path, 'DELETE')).toBe(403)
    expect(await inspect(assignment.id)).toMatchObject({
      consumed: 0,
      remaining: 1,
    })
    expect(await inspect(removal.id)).toMatchObject({
      consumed: 1,
      remaining: 0,
    })
    expect(await status(path, 'PUT')).toBe(500)
    expect(await inspect(assignment.id)).toMatchObject({
      consumed: 1,
      remaining: 0,
    })
    expect(roleIds(db, guild)).toEqual([role, otherRole])
    expect(await status(path, 'DELETE')).toBe(204)
    expect(roleIds(db, guild)).toEqual([otherRole])
  })

  it('keeps member update, kick, and role removal controls independent', async () => {
    const memberPath = `/guilds/${guild}/members/${user}`
    const patch = await arm({ method: 'PATCH', path: memberPath })
    const removal = await arm()
    expect(await status(path, 'DELETE')).toBe(403)
    expect(await inspect(patch.id)).toMatchObject({ consumed: 0, remaining: 1 })
    expect(await status(memberPath, 'PATCH', { nick: 'x' })).toBe(403)
    // Member kick is not a supported selector and is unaffected.
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'DELETE',
        path: memberPath,
        ...failure,
      })
    ).toBe(400)
    expect(await status(memberPath, 'DELETE')).toBe(204)
    expect(await inspect(removal.id)).toMatchObject({
      consumed: 1,
      remaining: 0,
    })
  })

  it('retains legacy cross-token mutation behavior and active selector conflicts', async () => {
    const fault = await arm()
    for (const overrides of [
      failure,
      { mode: 'disconnect' },
      { mode: 'rate_limit', retry_after: 0.1 },
      { mode: 'delay', delay_ms: 5 },
    ])
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'DELETE',
          path,
          ...overrides,
        })
      ).toBe(409)
    expect(await status(path, 'DELETE', undefined, otherToken)).toBe(403)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1, remaining: 0 })
    const rearmed = await arm()
    expect(rearmed.id).not.toBe(fault.id)
    expect(await status(`/_test/rest-faults/${rearmed.id}`, 'DELETE')).toBe(204)
    expect(await status(`/_test/rest-faults/${rearmed.id}`, 'DELETE')).toBe(404)
    expect(await status(path, 'DELETE')).toBe(204)
  })

  it('bounds concurrent consumption to the configured budget', async () => {
    const fault = await arm({ times: 2 })
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(path, 'DELETE'))
    )
    expect(
      responses.map((response) => response.status).toSorted((a, b) => a - b)
    ).toEqual([204, 204, 204, 403, 403])
    expect(await inspect(fault.id)).toMatchObject({ consumed: 2, remaining: 0 })
    expect(roleIds(db, guild)).toEqual([otherRole])
  })

  it('keeps failure consumption outside native transaction rollback', async () => {
    const fault = await arm()
    const before = snapshot(db)
    db.exec(`CREATE TRIGGER reject_role_removal BEFORE DELETE ON member_roles
      BEGIN SELECT RAISE(ABORT, 'native removal attempted'); END`)
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    expect(await status(path, 'DELETE')).toBe(403)
    expect(errors).not.toHaveBeenCalled()
    expect(await status(path, 'DELETE')).toBe(500)
    expect(errors).toHaveBeenCalledOnce()
    expect(snapshot(db)).toEqual(before)
    expect(await inspect(fault.id)).toMatchObject({ consumed: 1, remaining: 0 })
    db.exec('DROP TRIGGER reject_role_removal')
    expect(await status(path, 'DELETE')).toBe(204)
  })

  it.each([
    '/guilds/1/members/2/roles',
    '/guilds/1/members/2/roles/',
    '/guilds/1/members/2/roles/3/',
    '/guilds/1/members/2/roles/3?x=1',
    '/guilds/1/members/2/roles/*',
    '/guilds/*/members/2/roles/3',
    '/guilds/1/members/*/roles/3',
    '/guilds/{guildID}/members/{userID}/roles/{roleID}',
    '/guilds/1/members/2/roles/1.5',
    '/guilds/-1/members/2/roles/3',
    '/guilds/1/members/@me/roles/3',
    '/guilds/1/roles/3',
    '/guilds/1/members/2',
    '/guilds/1/members/2/roles/3/extra',
    '/api/guilds/1/members/2/roles/3',
    '/api/v10/guilds/1/members/2/roles/3',
    `/guilds/${'1'.repeat(21)}/members/2/roles/3`,
    `/guilds/1/members/${'1'.repeat(21)}/roles/3`,
    `/guilds/1/members/2/roles/${'1'.repeat(21)}`,
  ])(
    'rejects malformed or unsupported DELETE selector %s',
    async (selector) => {
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'DELETE',
          path: selector,
          ...failure,
        })
      ).toBe(400)
    }
  )

  it.each([
    { method: 'delete' },
    { query: {} },
    { recipient_id: '123' },
    { times: 0 },
    { times: 101 },
    { times: 1.5 },
    { status: 200 },
    { status: 600 },
    { code: -1 },
    { message: '' },
    { mode: 'rate_limit', retry_after: 0 },
    { mode: 'delay', delay_ms: 0 },
    { mode: 'disconnect', timeout_ms: 60_001 },
    { mode: 'unknown' },
  ])(
    'rejects invalid role removal fault configuration %j',
    async (overrides) => {
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'DELETE',
          path,
          ...failure,
          ...overrides,
        })
      ).toBe(400)
    }
  )

  it('requires an existing guild without accepting a guild override', async () => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'DELETE',
        path: `/guilds/999999999999999999/members/${user}/roles/${role}`,
        ...failure,
      })
    ).toBe(404)
    const fault = await arm({ guild_id: otherGuildId })
    expect(fault.guild_id).toBe(guild)
    expect(fault.path).toBe(path)
  })

  it.each(
    [
      'cancel',
      'reset',
      'scoped reset',
      'setup deletion',
      'guild deletion',
    ].flatMap((cleanup) => [
      { cleanup, mode: undefined },
      { cleanup, mode: 'rate_limit' },
    ])
  )(
    'removes active and exhausted DELETE controls on $cleanup ($mode) with scope isolation',
    async ({ cleanup, mode }) => {
      const configuration = mode ? { mode, retry_after: 0.02, status: 429 } : {}
      const exhausted = await arm(configuration)
      await request(path, 'DELETE')
      const active = await arm(configuration)
      const foreignRole = seedRole(db, otherGuildId, 'foreign')
      const other = await arm({
        path: `/guilds/${otherGuildId}/members/${user}/roles/${foreignRole}`,
        ...configuration,
      })
      const target =
        cleanup === 'cancel'
          ? `/_test/rest-faults/${active.id}`
          : cleanup.includes('reset')
            ? '/_test/reset'
            : cleanup === 'setup deletion'
              ? `/_test/setup/${encodeURIComponent(token)}`
              : `/guilds/${guild}`
      expect(
        await status(
          target,
          cleanup.includes('reset') ? 'POST' : 'DELETE',
          cleanup.includes('reset')
            ? cleanup === 'scoped reset'
              ? { token }
              : {}
            : undefined
        )
      ).toBeLessThan(300)
      if (cleanup === 'cancel')
        expect(
          await status(`/_test/rest-faults/${exhausted.id}`, 'DELETE')
        ).toBe(204)
      for (const fault of [active, exhausted])
        expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${other.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
    }
  )
})

describe('member role removal transport faults over real HTTP and Gateway', () => {
  let server: RealServerContext
  let guild: string
  let role: string
  let otherRole: string
  let path: string

  /** Sends a bounded request to the real production HTTP server. */
  function request(
    route: string,
    method = 'GET',
    body?: unknown,
    auth = token
  ) {
    return fetch(server.baseUrl + route, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  }

  /** Arms the same public control for all supported explicit transport modes. */
  async function arm(overrides: Record<string, unknown>): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'DELETE',
      path,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Reads arrival and completion evidence without guessing request timing. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Connects a GuildMembers subscriber and provides ordered ACK barriers. */
  async function gateway() {
    const ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
    const ready = Promise.withResolvers<undefined>()
    let ack = Promise.withResolvers<undefined>()
    const updates: unknown[] = []
    ws.on('error', ready.reject)
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { op: number; t?: string }
      if (frame.op === GatewayOp.Hello)
        ws.send(
          JSON.stringify({
            op: GatewayOp.Identify,
            d: {
              token,
              intents:
                GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
            },
          })
        )
      else if (frame.t === 'READY') ready.resolve(undefined)
      if (frame.t === 'GUILD_MEMBER_UPDATE') updates.push(frame)
      if (frame.op === GatewayOp.HeartbeatAck) ack.resolve(undefined)
    })
    await ready.promise
    return {
      updates,
      close: () => {
        ws.close()
      },
      barrier: async () => {
        ack = Promise.withResolvers<undefined>()
        ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
        await ack.promise
      },
    }
  }

  /** Proves socket destruction, with no synthetic HTTP response or fetch retry. */
  function disconnected(route: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const attempt = httpRequest(server.baseUrl + route, {
        method: 'DELETE',
        headers: { Authorization: token },
      })
      attempt.on('response', (response) => {
        response.resume()
        reject(new Error(`Unexpected HTTP response: ${response.statusCode}`))
      })
      attempt.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') resolve()
        else reject(error)
      })
      attempt.setTimeout(2000, () => {
        attempt.destroy(new Error('Disconnect attempt timed out'))
      })
      attempt.end()
    })
  }

  beforeEach(async () => {
    server = await createRealServer()
    ;({ guild, role, otherRole } = seed(server.db))
    path = `/guilds/${guild}/members/${user}/roles/${role}`
  })

  afterEach(async () => {
    await server.close()
  })

  it.each(['rate_limit', 'delay', 'disconnect'] as const)(
    'keeps %s owner-scoped, consumes exact retries, and never dispatches a failed removal',
    async (mode) => {
      const fault = await arm({
        mode,
        times: 3,
        ...(mode === 'rate_limit' && { retry_after: 0.02, global: true }),
        ...(mode === 'delay' && { delay_ms: 20 }),
      })
      const listener = await gateway()
      const before = snapshot(server.db)
      // Explicit modes bind the guild's owning bot, never another bot's attempt.
      expect(
        consumeRestFault(server.db, 'DELETE', path, otherToken)
      ).toBeUndefined()
      expect(
        await request(path, 'DELETE', undefined, 'Bot unknown').then(
          (response) => response.status
        )
      ).toBe(401)
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 0,
        remaining: 3,
      })
      for (const prefix of ['/api/v10', '/api', '']) {
        if (mode === 'disconnect') await disconnected(prefix + path)
        else {
          const response = await request(prefix + path, 'DELETE')
          expect(response.status).toBe(mode === 'rate_limit' ? 429 : 504)
          if (mode === 'rate_limit') {
            expect(response.headers.get('Retry-After')).toBe('1')
            expect(response.headers.get('X-RateLimit-Global')).toBe('true')
            await expect(response.json()).resolves.toEqual({
              message: 'You are being rate limited.',
              retry_after: 0.02,
              global: true,
            })
          }
        }
        expect(snapshot(server.db)).toEqual(before)
      }
      await listener.barrier()
      expect(listener.updates).toEqual([])
      expect(await inspect(fault.id)).toMatchObject({
        consumed: 3,
        remaining: 0,
        state: 'exhausted',
        outcomes: {
          pending: 0,
          cancelled: 0,
          responded: mode === 'disconnect' ? 0 : 3,
          disconnected: mode === 'disconnect' ? 3 : 0,
          delayed: mode === 'delay' ? 3 : 0,
        },
      })
      expect(
        await request(path, 'DELETE').then((response) => response.status)
      ).toBe(204)
      await listener.barrier()
      expect(listener.updates).toHaveLength(1)
      expect(roleIds(server.db, guild)).toEqual([otherRole])
      listener.close()
    }
  )

  it.each(['cancel', 'expire'])(
    'does not resume a delayed removal after %s and applies it on retry',
    async (action) => {
      const listener = await gateway()
      const fault = await arm({
        mode: 'delay',
        delay_ms: 60_000,
        timeout_ms: action === 'expire' ? 500 : 30_000,
        times: 2,
      })
      const before = snapshot(server.db)
      const pending = request(path, 'DELETE')
      await expect
        .poll(() => inspect(fault.id))
        .toMatchObject({ consumed: 1, outcomes: { pending: 1 } })
      if (action === 'cancel')
        expect(
          await request(`/_test/rest-faults/${fault.id}`, 'DELETE').then(
            (response) => response.status
          )
        ).toBe(204)
      const delayed = await pending
      expect(delayed.status).toBe(504)
      expect(snapshot(server.db)).toEqual(before)
      await listener.barrier()
      expect(listener.updates).toEqual([])
      if (action === 'expire')
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 0,
          consumed: 1,
          state: 'expired',
          outcomes: { pending: 0, cancelled: 1, responded: 0 },
        })
      else
        expect(
          await request(`/_test/rest-faults/${fault.id}`).then(
            (response) => response.status
          )
        ).toBe(404)
      expect(
        await request(path, 'DELETE').then((response) => response.status)
      ).toBe(204)
      await listener.barrier()
      expect(listener.updates).toHaveLength(1)
      expect(roleIds(server.db, guild)).toEqual([otherRole])
      listener.close()
    }
  )
})
