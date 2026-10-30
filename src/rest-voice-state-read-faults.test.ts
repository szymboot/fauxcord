import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { initializeDatabase } from './db'
import {
  seedBot,
  seedGuild,
  seedMember,
  seedVoiceChannel,
  seedVoiceState,
} from './test-helpers'

const token = 'Bot voice-read-owner'
const otherToken = 'Bot voice-read-other'
const botUser = '100000000000000001'
const failure = { status: 500, code: 0, message: 'Internal Server Error' }

describe('voice state read REST faults', () => {
  let db: ReturnType<typeof initializeDatabase>
  let server: ReturnType<typeof buildApp>
  let guild: string
  let otherGuild: string
  let connected: string
  let idle: string

  /** Sends requests through the assembled middleware and real routes. */
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

  /** Arms a bounded voice-state read failure. */
  async function arm(
    path: string,
    times = 1,
    extra: Record<string, unknown> = {}
  ) {
    const response = await request('/_test/rest-faults', 'POST', {
      method: 'GET',
      path,
      times,
      ...failure,
      ...extra,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as { id: string; guild_id: string }
  }

  /** Checks the retained observation without consuming a control. */
  async function counters(id: string, remaining: number, consumed: number) {
    await expect(
      request(`/_test/rest-faults/${id}`).then((response) => response.json())
    ).resolves.toMatchObject({ remaining, consumed })
  }

  /** Snapshots the stored voice state rows for side-effect checks. */
  function voiceRows(): unknown[] {
    return db
      .prepare('SELECT * FROM guild_voice_states ORDER BY guild_id, user_id')
      .all()
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    server = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, token, botUser)
    seedBot(db, otherToken, '100000000000000002')
    guild = seedGuild(db, token)
    otherGuild = seedGuild(db, otherToken, '222222222222222223')
    const channel = seedVoiceChannel(db, guild)
    connected = seedMember(db, guild, '555555555555555551')
    idle = seedMember(db, guild, '555555555555555552')
    seedMember(db, guild, botUser)
    seedVoiceState(db, guild, connected, channel)
    seedVoiceState(db, guild, botUser, channel)
  })

  afterEach(() => {
    server.unsubscribeGateway()
    server.wss.close()
    db.close()
  })

  it.each([
    failure,
    { status: 403, code: 50_013, message: 'Missing Permissions' },
    { status: 404, code: 10_065, message: 'Unknown Voice State' },
  ])(
    'returns $status without side effects, then reads normal state',
    async (error) => {
      const path = `/guilds/${guild}/voice-states/${connected}`
      const before = voiceRows()
      const fault = await arm(path, 3, error)
      expect(fault.guild_id).toBe(guild)
      for (const prefix of ['/api/v10', '/api', '']) {
        const response = await request(`${prefix}${path}`)
        expect(response.status).toBe(error.status)
        await expect(response.json()).resolves.toEqual({
          code: error.code,
          message: error.message,
        })
      }
      expect(voiceRows()).toEqual(before)
      await counters(fault.id, 0, 3)
      const success = await request(path)
      expect(success.status).toBe(200)
      await expect(success.json()).resolves.toMatchObject({
        guild_id: guild,
        user_id: connected,
      })
      await counters(fault.id, 0, 3)
      const rearmed = await arm(path)
      expect(rearmed.id).not.toBe(fault.id)
    }
  )

  it('keeps the no-voice-state and unknown-member distinction after exhaustion', async () => {
    const missing = '555555555555555599'
    const idlePath = `/guilds/${guild}/voice-states/${idle}`
    const missingPath = `/guilds/${guild}/voice-states/${missing}`
    const idleFault = await arm(idlePath)
    const missingFault = await arm(missingPath)
    expect(await status(idlePath)).toBe(500)
    expect(await status(missingPath)).toBe(500)
    await counters(idleFault.id, 0, 1)
    await counters(missingFault.id, 0, 1)

    const noState = await request(idlePath)
    expect(noState.status).toBe(404)
    await expect(noState.json()).resolves.toMatchObject({ code: 10_065 })
    const unknown = await request(missingPath)
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toMatchObject({ code: 10_007 })
  })

  it('matches only the exact guild, user, method and owning bot', async () => {
    const path = `/guilds/${guild}/voice-states/${connected}`
    const fault = await arm(path)
    expect(await status(`/guilds/${guild}/voice-states/${idle}`)).toBe(404)
    expect(await status(`/guilds/${guild}/members/${connected}`)).toBe(200)
    expect(
      await status(`/guilds/${guild}/voice-states/${connected}/`)
    ).not.toBe(500)
    expect(
      await status(
        `/guilds/${otherGuild}/voice-states/${connected}`,
        'GET',
        undefined,
        otherToken
      )
    ).toBe(404)
    await request(path, 'PATCH', { suppress: false })
    await request(path, 'POST')
    await request(path, 'HEAD')
    await request(path, 'DELETE')
    await counters(fault.id, 1, 0)
    expect(await status(path)).toBe(500)
    await counters(fault.id, 0, 1)
  })

  it('does not consume for non-owner, invalid or Bearer callers', async () => {
    const path = `/guilds/${guild}/voice-states/${connected}`
    const fault = await arm(path)
    for (const auth of ['', 'Bot missing', 'Bearer missing'])
      expect(await status(path, 'GET', undefined, auth)).toBe(401)
    await request(path, 'GET', undefined, otherToken)
    await counters(fault.id, 1, 0)
    expect(await status(path)).toBe(500)
    await counters(fault.id, 0, 1)
  })

  it('keeps owner scoping when auth is disabled, including Bearer tokens', async () => {
    const path = `/guilds/${guild}/voice-states/${connected}`
    const fault = await arm(path)
    const disabled = buildApp(db, {
      baseUrl: 'http://localhost',
      disableAuth: true,
    })
    try {
      for (const auth of ['Bot unregistered', otherToken, 'Bearer accepted']) {
        const response = await disabled.app.request(path, {
          headers: { Authorization: auth },
        })
        expect(response.status).not.toBe(500)
      }
      await counters(fault.id, 1, 0)
      const response = await disabled.app.request(path, {
        headers: { Authorization: token },
      })
      expect(response.status).toBe(500)
      await counters(fault.id, 0, 1)
    } finally {
      disabled.unsubscribeGateway()
      disabled.wss.close()
    }
  })

  it('resolves @me and %40me to the calling bot but never to other users', async () => {
    const own = await arm(`/guilds/${guild}/voice-states/${botUser}`, 2)
    const other = await arm(`/guilds/${guild}/voice-states/${connected}`)
    expect(await status(`/guilds/${guild}/voice-states/@me`)).toBe(500)
    expect(await status(`/api/v10/guilds/${guild}/voice-states/%40me`)).toBe(
      500
    )
    await counters(own.id, 0, 2)
    await counters(other.id, 1, 0)
    const success = await request(`/guilds/${guild}/voice-states/@me`)
    expect(success.status).toBe(200)
    await expect(success.json()).resolves.toMatchObject({ user_id: botUser })
    expect(await status(`/guilds/${guild}/voice-states/%40me`)).toBe(200)
    await request(`/guilds/${guild}/voice-states/@me`, 'PATCH', {
      suppress: false,
    })
    await counters(other.id, 1, 0)
    // A non-owner bot's @me is its own user, so it cannot consume this control.
    await request(
      `/guilds/${guild}/voice-states/@me`,
      'GET',
      undefined,
      otherToken
    )
    await counters(other.id, 1, 0)
  })

  it('applies explicit modes to the voice state read', async () => {
    const path = `/guilds/${guild}/voice-states/${connected}`
    const fault = await arm(path, 1, {
      status: 429,
      code: 0,
      message: 'Too Many Requests',
      mode: 'rate_limit',
      retry_after: 2,
    })
    const response = await request(path)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('2')
    await counters(fault.id, 0, 1)
    expect(await status(path)).toBe(200)
  })

  it('bounds concurrent reads and rejects an active duplicate', async () => {
    const path = `/guilds/${guild}/voice-states/${connected}`
    const fault = await arm(path, 3)
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'GET',
        path,
        times: 1,
        ...failure,
      })
    ).toBe(409)
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(path))
    )
    expect(
      responses.filter((response) => response.status === 500)
    ).toHaveLength(3)
    expect(
      responses.filter((response) => response.status === 200)
    ).toHaveLength(5)
    await counters(fault.id, 0, 3)
  })

  it.each(['control deletion', 'reset', 'scoped reset', 'guild deletion'])(
    'cleans active and exhausted controls on %s',
    async (cleanup) => {
      const path = `/guilds/${guild}/voice-states/${connected}`
      const active = await arm(path, 2)
      await request(path)
      const exhausted = await arm(`/guilds/${guild}/voice-states/${idle}`)
      await request(`/guilds/${guild}/voice-states/${idle}`)
      const foreign = await arm(`/guilds/${otherGuild}/voice-states/${idle}`)
      switch (cleanup) {
        case 'control deletion': {
          expect(
            await status(`/_test/rest-faults/${active.id}`, 'DELETE')
          ).toBe(204)
          await request(`/_test/rest-faults/${exhausted.id}`, 'DELETE')
          expect(await status(path)).toBe(200)
          expect(await status(`/_test/rest-faults/${active.id}`)).toBe(404)
          return
        }
        case 'reset': {
          await request('/_test/reset', 'POST', {})
          break
        }
        case 'scoped reset': {
          await request('/_test/reset', 'POST', { token })
          break
        }
        case 'guild deletion': {
          await request(`/guilds/${guild}`, 'DELETE')
          break
        }
      }
      for (const fault of [active, exhausted])
        expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      expect(await status(`/_test/rest-faults/${foreign.id}`)).toBe(
        cleanup === 'reset' ? 404 : 200
      )
    }
  )

  it.each([
    { path: '/guilds/123/voice-states/@me' },
    { path: '/guilds/123/voice-states/%40me' },
    { path: '/guilds/123/voice-states/456/' },
    { path: '/guilds/123/voice-states/456?limit=1' },
    { path: '/guilds/123/voice-states/*' },
    { path: '/guilds/123/voice-states' },
    { path: '/guilds/123/voice-states/456', guild_id: '789' },
    { path: '/guilds/123/voice-states/456', guild_id: 123 },
    { path: '/guilds/123/voice-states/456', recipient_id: '456' },
    { path: '/guilds/123/voice-states/456', query: { limit: 1 } },
  ])('rejects invalid selector %j', async (selector) => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'GET',
        times: 1,
        ...failure,
        ...selector,
      })
    ).toBe(400)
  })

  it('rejects unknown guilds and non-GET voice-state selectors', async () => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'GET',
        path: '/guilds/123/voice-states/456',
        times: 1,
        ...failure,
      })
    ).toBe(404)
    for (const method of ['PATCH', 'DELETE', 'PUT', 'POST'])
      expect(
        await status('/_test/rest-faults', 'POST', {
          method,
          path: `/guilds/${guild}/voice-states/${connected}`,
          times: 1,
          ...failure,
        })
      ).toBe(400)
  })

  it('accepts a matching explicit guild_id', async () => {
    const fault = await arm(`/guilds/${guild}/voice-states/${connected}`, 1, {
      guild_id: guild,
    })
    expect(fault.guild_id).toBe(guild)
  })
})
