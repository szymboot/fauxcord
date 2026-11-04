import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatewayBus } from './gateway/bus'
import type { RestFault } from './services/rest-faults'
import {
  createRealServer,
  seedApplicationCommand,
  seedBot,
  seedChannel,
  seedGuild,
  seedInteraction,
  seedWebhook,
  type RealServerContext,
} from './test-helpers'

const token = 'Bot appeal-owner'
const otherToken = 'Bot other-appeal-owner'
const botUser = '100000000000000001'
const otherBotUser = '100000000000000002'
/** Direct message response that creates the interaction's original. */
const messageCallback = { type: 4, data: { content: 'original' } }
const failure = { status: 503, code: 0, message: 'Appeal request failed' }

/** Interaction fixture returned by `POST /_test/interactions`. */
interface Simulated {
  id: string
  token: string
  application_id: string
}

/** One selector under test with the native request that consumes it. */
interface Scenario {
  name: string
  method: string
  /** Bare selector path for the current fixture. */
  selector: () => string
  /** Sends the native request, optionally under an API prefix. */
  call: (prefix?: string) => Promise<Response>
  /** A request that must run its ordinary route without consuming a control. */
  foreign: () => Promise<Response>
  foreignStatus: number
  /** Status of the ordinary route after the control is exhausted. */
  ok: number
}

describe('appeal REST fault selectors', () => {
  let server: RealServerContext
  let guild: string
  let channel: string
  let otherGuild: string
  let otherChannel: string
  let interaction: Simulated
  let otherInteraction: Simulated

  /** Sends a bounded request through the assembled app and real HTTP socket. */
  function request(
    path: string,
    method = 'GET',
    body?: unknown,
    auth: string | null = token
  ): Promise<Response> {
    return fetch(server.baseUrl + path, {
      method,
      headers: {
        ...(auth !== null && { Authorization: auth }),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  }

  /** Resolves a pending response to its status. */
  function code(response: Promise<Response>): Promise<number> {
    return response.then((resolved) => resolved.status)
  }

  /** Returns a response status for concise route assertions. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Arms a selector with the shared failure defaults. */
  async function arm(
    method: string,
    path: string,
    options: Record<string, unknown> = {}
  ): Promise<RestFault> {
    const response = await request('/_test/rest-faults', 'POST', {
      method,
      path,
      ...failure,
      ...options,
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<RestFault>
  }

  /** Reads retained consumption and mode evidence through the control API. */
  async function inspect(id: string): Promise<RestFault> {
    const response = await request(`/_test/rest-faults/${id}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<RestFault>
  }

  /** Captures every table the selected routes could change. */
  function snapshot(): unknown[] {
    return ['channels', 'guilds', 'interactions', 'messages'].map((table) =>
      server.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    )
  }

  /** Simulates an interaction the way the harness does. */
  async function simulate(
    applicationId: string,
    guildId: string,
    channelId: string
  ): Promise<Simulated> {
    const response = await request(
      '/_test/interactions',
      'POST',
      {
        application_id: applicationId,
        command_name: 'appeal',
        guild_id: guildId,
        channel_id: channelId,
      },
      null
    )
    expect(response.status).toBe(201)
    return response.json() as Promise<Simulated>
  }

  /** Sends the initial callback for an interaction without bot authorization. */
  function callback(
    target: Simulated,
    body: unknown = messageCallback,
    prefix = ''
  ): Promise<Response> {
    return request(
      `${prefix}/interactions/${target.id}/${target.token}/callback`,
      'POST',
      body,
      null
    )
  }

  /** Sends an `@original` request addressed by the interaction token. */
  function original(
    target: Simulated,
    method: string,
    prefix = '',
    credential = target.token
  ): Promise<Response> {
    return request(
      `${prefix}/webhooks/${target.application_id}/${credential}/messages/@original`,
      method,
      method === 'PATCH' ? { content: 'edited' } : undefined,
      null
    )
  }

  /** Reads the observable callback state for an interaction. */
  async function observation(target: Simulated): Promise<{
    responded: boolean
    initial_callback_type: number | null
  }> {
    const response = await fetch(
      `${server.baseUrl}/_test/interactions/${target.id}/callback?application_id=${target.application_id}`,
      { headers: { 'X-Interaction-Token': target.token } }
    )
    expect(response.status).toBe(200)
    return response.json() as Promise<{
      responded: boolean
      initial_callback_type: number | null
    }>
  }

  /** Content of an interaction's recorded original response. */
  function originalContent(target: Simulated): string | undefined {
    const row = server.db
      .prepare(
        `SELECT m.content FROM interactions i JOIN messages m
        ON m.id = i.initial_response_message_id WHERE i.id = ?`
      )
      .get(target.id) as { content: string } | undefined
    return row?.content
  }

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token, botUser)
    seedBot(server.db, otherToken, otherBotUser)
    guild = seedGuild(server.db, token)
    channel = seedChannel(server.db, guild)
    otherGuild = seedGuild(server.db, otherToken, '222222222222222223')
    otherChannel = seedChannel(server.db, otherGuild, '333333333333333334')
    seedApplicationCommand(server.db, botUser, null, 'appeal')
    seedApplicationCommand(server.db, otherBotUser, null, 'appeal')
    interaction = await simulate(botUser, guild, channel)
    otherInteraction = await simulate(otherBotUser, otherGuild, otherChannel)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await server.close()
  })

  const scenarios: Scenario[] = [
    {
      name: 'guild channel read',
      method: 'GET',
      selector: () => `/guilds/${guild}/channels`,
      call: (prefix = '') => request(`${prefix}/guilds/${guild}/channels`),
      foreign: () =>
        request(`/guilds/${guild}/channels`, 'GET', undefined, otherToken),
      foreignStatus: 200,
      ok: 200,
    },
    {
      name: 'guild leave',
      method: 'DELETE',
      selector: () => `/users/@me/guilds/${guild}`,
      call: (prefix = '') =>
        request(`${prefix}/users/@me/guilds/${guild}`, 'DELETE'),
      foreign: () =>
        request(`/users/@me/guilds/${guild}`, 'DELETE', undefined, otherToken),
      foreignStatus: 404,
      ok: 204,
    },
    {
      name: 'initial callback',
      method: 'POST',
      selector: () => `/interactions/${interaction.id}/callback`,
      call: (prefix = '') => callback(interaction, undefined, prefix),
      foreign: () =>
        request(
          `/interactions/${interaction.id}/wrong-token/callback`,
          'POST',
          { type: 4, data: { content: 'original' } },
          null
        ),
      foreignStatus: 404,
      ok: 204,
    },
    {
      name: 'original response read',
      method: 'GET',
      selector: () => `/interactions/${interaction.id}/messages/@original`,
      call: (prefix = '') => original(interaction, 'GET', prefix),
      foreign: () => original(interaction, 'GET', '', 'wrong-token'),
      foreignStatus: 404,
      ok: 200,
    },
    {
      name: 'original response edit',
      method: 'PATCH',
      selector: () => `/interactions/${interaction.id}/messages/@original`,
      call: (prefix = '') => original(interaction, 'PATCH', prefix),
      foreign: () => original(interaction, 'PATCH', '', 'wrong-token'),
      foreignStatus: 404,
      ok: 200,
    },
    {
      name: 'original response delete',
      method: 'DELETE',
      selector: () => `/interactions/${interaction.id}/messages/@original`,
      call: (prefix = '') => original(interaction, 'DELETE', prefix),
      foreign: () => original(interaction, 'DELETE', '', 'wrong-token'),
      foreignStatus: 404,
      ok: 204,
    },
  ]

  describe.each(scenarios)('$name', (scenario) => {
    /** Creates the original response the @original routes operate on. */
    async function prepare(): Promise<void> {
      if (scenario.name.startsWith('original'))
        expect(await code(callback(interaction))).toBe(204)
    }

    it('consumes exact attempts across prefixes without changing state', async () => {
      await prepare()
      const before = snapshot()
      const events = vi.spyOn(gatewayBus, 'emit')
      const fault = await arm(scenario.method, scenario.selector(), {
        times: 3,
      })
      expect(fault).toMatchObject({
        method: scenario.method,
        path: scenario.selector(),
        guild_id: guild,
        times: 3,
        remaining: 3,
        consumed: 0,
      })
      expect(fault.query).toBeUndefined()
      for (const prefix of ['/api/v10', '/api', '']) {
        const response = await scenario.call(prefix)
        expect(response.status).toBe(503)
        await expect(response.json()).resolves.toEqual({
          code: failure.code,
          message: failure.message,
        })
        expect(snapshot()).toEqual(before)
      }
      expect(events).not.toHaveBeenCalled()
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
      expect(await code(scenario.call())).toBe(scenario.ok)
      const next = await arm(scenario.method, scenario.selector())
      expect(next.id).not.toBe(fault.id)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 3,
      })
    })

    it('does not consume for foreign callers, credentials or paths', async () => {
      await prepare()
      const fault = await arm(scenario.method, scenario.selector())
      expect(await code(scenario.foreign())).toBe(scenario.foreignStatus)
      await request(scenario.selector() + '/extra', scenario.method)
      await request(
        scenario.selector(),
        scenario.method === 'GET' ? 'POST' : 'GET'
      )
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 1,
        consumed: 0,
      })
      expect(await code(scenario.call())).toBe(503)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 1,
      })
    })

    it.each(['rate_limit', 'delay', 'disconnect'] as const)(
      'supports %s without mutation and then recovers',
      async (mode) => {
        await prepare()
        const fault = await arm(scenario.method, scenario.selector(), {
          mode,
          status: mode === 'rate_limit' ? 429 : 503,
          ...(mode === 'rate_limit' && { retry_after: 0.025 }),
          ...(mode === 'delay' && { delay_ms: 30 }),
        })
        expect(
          await status('/_test/rest-faults', 'POST', {
            method: scenario.method,
            path: scenario.selector(),
            ...failure,
          })
        ).toBe(409)
        await scenario.foreign().catch(() => undefined)
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 1,
          consumed: 0,
        })
        const before = snapshot()
        const attempt = scenario.call()
        if (mode === 'disconnect') await expect(attempt).rejects.toThrow()
        else {
          const response = await attempt
          expect(response.status).toBe(mode === 'rate_limit' ? 429 : 503)
          if (mode === 'rate_limit') {
            expect(response.headers.get('X-RateLimit-Bucket')).toBe(
              `fault-${fault.id}`
            )
            await expect(response.json()).resolves.toEqual({
              message: failure.message,
              retry_after: 0.025,
              global: false,
            })
          }
        }
        expect(snapshot()).toEqual(before)
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 0,
          consumed: 1,
          state: 'exhausted',
          outcomes: {
            pending: 0,
            ...(mode === 'disconnect' ? { disconnected: 1 } : { responded: 1 }),
            ...(mode === 'delay' && { delayed: 1 }),
          },
        })
        expect(await code(scenario.call())).toBe(scenario.ok)
      }
    )

    it.each(['cancel', 'reset', 'scoped reset', 'other scoped reset'])(
      'removes active and exhausted controls on %s',
      async (cleanup) => {
        await prepare()
        const exhausted = await arm(scenario.method, scenario.selector())
        await scenario.call()
        const active = await arm(scenario.method, scenario.selector())
        if (cleanup === 'cancel') {
          for (const fault of [exhausted, active])
            expect(
              await status(`/_test/rest-faults/${fault.id}`, 'DELETE')
            ).toBe(204)
        } else {
          const reset =
            cleanup === 'reset'
              ? {}
              : { token: cleanup === 'scoped reset' ? token : otherToken }
          expect(await status('/_test/reset', 'POST', reset)).toBe(204)
        }
        for (const fault of [exhausted, active])
          expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(
            cleanup === 'other scoped reset' ? 200 : 404
          )
        if (cleanup === 'cancel')
          expect(await code(scenario.call())).toBe(scenario.ok)
      }
    )

    it.each(['cancel', 'reset', 'scoped reset', 'expiry'])(
      'releases an in-flight delay on %s without resuming the route',
      async (cleanup) => {
        await prepare()
        const before = snapshot()
        const fault = await arm(scenario.method, scenario.selector(), {
          mode: 'delay',
          delay_ms: 60_000,
          timeout_ms: cleanup === 'expiry' ? 500 : 60_000,
        })
        const pending = scenario.call()
        await expect
          .poll(() => inspect(fault.id))
          .toMatchObject({ consumed: 1, outcomes: { pending: 1 } })
        if (cleanup === 'cancel') {
          expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(
            204
          )
        } else if (cleanup !== 'expiry') {
          expect(
            await status(
              '/_test/reset',
              'POST',
              cleanup === 'reset' ? {} : { token }
            )
          ).toBe(204)
        }
        expect(await code(pending)).toBe(503)
        if (!cleanup.includes('reset')) expect(snapshot()).toEqual(before)
        if (cleanup === 'expiry') {
          expect(await inspect(fault.id)).toMatchObject({
            state: 'expired',
            remaining: 0,
            consumed: 1,
            outcomes: { pending: 0, cancelled: 1, responded: 0 },
          })
        } else expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
      }
    )

    it('rejects malformed selectors and unsupported fields', async () => {
      const id = /\d{10,}/.exec(scenario.selector())?.[0] ?? ''
      const invalid = [
        { path: scenario.selector() + '/' },
        { path: scenario.selector() + '?limit=1' },
        { path: scenario.selector() + '/extra' },
        { path: '/api/v10' + scenario.selector() },
        { path: scenario.selector().replace(id, '*') },
        { path: scenario.selector().replace(id, '{id}') },
        { path: scenario.selector().replace(id, 'abc') },
        { path: scenario.selector().replace(id, '123456789012345678901') },
        { method: scenario.method === 'GET' ? 'HEAD' : 'OPTIONS' },
        { query: {} },
        { query: { limit: 1 } },
        { recipient_id: '123' },
        { guild_id: otherGuild },
        { guild_id: null },
        { guild_id: 123 },
      ]
      for (const override of invalid) {
        const response = await request('/_test/rest-faults', 'POST', {
          method: scenario.method,
          path: scenario.selector(),
          ...failure,
          ...override,
        })
        expect(response.status, JSON.stringify(override)).toBe(400)
      }
    })
  })

  describe('guild channel read', () => {
    it('accepts a matching guild_id and rejects it for other guilds', async () => {
      const fault = await arm('GET', `/guilds/${guild}/channels`, {
        guild_id: guild,
      })
      expect(fault.guild_id).toBe(guild)
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'GET',
          path: `/guilds/${guild}/channels`,
          guild_id: otherGuild,
          ...failure,
        })
      ).toBe(400)
    })

    it('requires an existing guild', async () => {
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'GET',
          path: '/guilds/123/channels',
          ...failure,
        })
      ).toBe(404)
    })

    it('is independent of guild channel creation and ignores request queries', async () => {
      const read = await arm('GET', `/guilds/${guild}/channels`)
      const create = await arm('POST', `/guilds/${guild}/channels`)
      expect(
        await status(`/guilds/${guild}/channels?with_counts=true`, 'GET')
      ).toBe(503)
      expect(await inspect(read.id)).toMatchObject({ consumed: 1 })
      expect(await inspect(create.id)).toMatchObject({ consumed: 0 })
      const listing = await request(`/guilds/${guild}/channels`)
      await expect(listing.json()).resolves.toHaveLength(1)
      expect(
        await status(
          `/guilds/${guild}/channels`,
          'POST',
          { name: 'new', type: 0 },
          token
        )
      ).toBe(503)
      expect(await inspect(create.id)).toMatchObject({ consumed: 1 })
    })
  })

  describe('guild leave', () => {
    /** Names of the Gateway events emitted since spying began. */
    function names(events: { mock: { calls: unknown[][] } }): string[] {
      return events.mock.calls.map((call) => String(call[0]))
    }

    it('keeps the bot attached and emits nothing until the fault is spent', async () => {
      const events = vi.spyOn(gatewayBus, 'emit')
      await arm('DELETE', `/users/@me/guilds/${guild}`, { times: 2 })
      for (const path of [
        `/users/@me/guilds/${guild}`,
        `/users/%40me/guilds/${guild}`,
      ])
        expect(await status(path, 'DELETE')).toBe(503)
      expect(names(events)).toEqual([])
      const present = (): number =>
        (
          server.db
            .prepare('SELECT bot_present FROM guilds WHERE id = ?')
            .get(guild) as { bot_present: number }
        ).bot_present
      expect(present()).toBe(1)
      expect(await status(`/users/@me/guilds/${guild}`, 'DELETE')).toBe(204)
      expect(present()).toBe(0)
      expect(names(events)).toEqual(
        expect.arrayContaining(['guild.member.remove', 'guild.delete'])
      )
    })

    it('binds the calling bot even without a mode and scopes the path guild', async () => {
      const fault = await arm('DELETE', `/users/@me/guilds/${guild}`, {
        guild_id: guild,
      })
      expect(fault).toMatchObject({ guild_id: guild, channel_id: null })
      expect(
        await status(
          `/users/@me/guilds/${otherGuild}`,
          'DELETE',
          undefined,
          otherToken
        )
      ).toBe(204)
      expect(
        await status(
          `/users/@me/guilds/${guild}`,
          'DELETE',
          undefined,
          otherToken
        )
      ).toBe(404)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 0 })
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'DELETE',
          path: `/users/@me/guilds/${guild}`,
          guild_id: otherGuild,
          ...failure,
        })
      ).toBe(400)
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'DELETE',
          path: '/users/@me/guilds/123',
          ...failure,
        })
      ).toBe(404)
    })

    it('rejects selectors that are not the exact leave path', async () => {
      for (const path of [
        '/users/@me/guilds',
        '/users/@me/guilds/',
        `/users/%40me/guilds/${guild}`,
        `/users/${botUser}/guilds/${guild}`,
        `/users/@me/guilds/${guild}/member`,
      ])
        expect(
          await status('/_test/rest-faults', 'POST', {
            method: 'DELETE',
            path,
            ...failure,
          }),
          path
        ).toBe(400)
    })
  })

  describe('initial interaction callback', () => {
    it('leaves the interaction unacknowledged so a retry behaves natively', async () => {
      const fault = await arm(
        'POST',
        `/interactions/${interaction.id}/callback`
      )
      expect(fault).toMatchObject({
        guild_id: guild,
        channel_id: channel,
        path: `/interactions/${interaction.id}/callback`,
      })
      expect(JSON.stringify(fault)).not.toContain(interaction.token)
      expect(await code(callback(interaction))).toBe(503)
      expect(await observation(interaction)).toEqual({
        interaction_id: interaction.id,
        application_id: botUser,
        responded: false,
        initial_callback_type: null,
      })
      expect(originalContent(interaction)).toBeUndefined()
      expect(await code(callback(interaction))).toBe(204)
      expect(await observation(interaction)).toMatchObject({
        responded: true,
        initial_callback_type: 4,
      })
      expect(originalContent(interaction)).toBe('original')
      expect(await code(callback(interaction))).toBe(400)
    })

    it('fails before body validation and keeps native validation afterwards', async () => {
      await arm('POST', `/interactions/${interaction.id}/callback`)
      expect(await code(callback(interaction, 'not an object'))).toBe(503)
      expect(await code(callback(interaction, { type: 99 }))).toBe(400)
    })

    it('matches only the interaction the ID and token identify', async () => {
      const fault = await arm(
        'POST',
        `/interactions/${interaction.id}/callback`
      )
      expect(
        await status(
          `/interactions/${interaction.id}/${otherInteraction.token}/callback`,
          'POST',
          { type: 4, data: { content: 'x' } },
          null
        )
      ).toBe(404)
      expect(await code(callback(otherInteraction))).toBe(204)
      expect(
        await status(
          `/interactions/${interaction.token}/${interaction.id}/callback`,
          'POST',
          { type: 4 },
          null
        )
      ).toBe(404)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 0 })
      // The caller's own bot credentials cannot substitute for the token.
      expect(
        await status(
          `/interactions/${interaction.id}/${interaction.token}/callback`,
          'POST',
          { type: 4, data: { content: 'x' } },
          otherToken
        )
      ).toBe(503)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 1 })
    })

    it('never consumes a control through its pseudo-path', async () => {
      const callbackFault = await arm(
        'POST',
        `/interactions/${interaction.id}/callback`
      )
      const readFault = await arm(
        'GET',
        `/interactions/${interaction.id}/messages/@original`
      )
      const editFault = await arm(
        'PATCH',
        `/interactions/${interaction.id}/messages/@original`
      )
      for (const [method, path] of [
        ['POST', `/interactions/${interaction.id}/callback`],
        ['GET', `/interactions/${interaction.id}/messages/@original`],
        ['PATCH', `/interactions/${interaction.id}/messages/@original`],
      ])
        for (const auth of [token, null])
          expect(
            await status(
              path,
              method,
              method === 'GET' ? undefined : { type: 4 },
              auth
            ),
            path
          ).toBe(auth === null ? 401 : 404)
      for (const fault of [callbackFault, readFault, editFault])
        expect(await inspect(fault.id)).toMatchObject({
          remaining: 1,
          consumed: 0,
        })
    })

    it('rejects selectors carrying the secret token', async () => {
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'POST',
          path: `/interactions/${interaction.id}/${interaction.token}/callback`,
          ...failure,
        })
      ).toBe(400)
    })

    it('arms only for stored interactions of a guild whose bot is the application', async () => {
      const unknown = '/interactions/123/callback'
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'POST',
          path: unknown,
          ...failure,
        })
      ).toBe(404)
      // A DM-style interaction has no guild to scope cleanup to.
      server.db
        .prepare(
          `INSERT INTO interactions (id, application_id, token, type, user_id)
          VALUES ('777', ?, 'dm-token', 2, '888')`
        )
        .run(botUser)
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'POST',
          path: '/interactions/777/callback',
          ...failure,
        })
      ).toBe(404)
      server.db
        .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
        .run(otherToken, guild)
      expect(
        await status('/_test/rest-faults', 'POST', {
          method: 'POST',
          path: `/interactions/${interaction.id}/callback`,
          ...failure,
        })
      ).toBe(404)
    })

    it('derives the guild from the channel of channel-only interactions', async () => {
      const seeded = seedInteraction(server.db, botUser, channel, '555')
      const fault = await arm(
        'POST',
        `/interactions/${seeded.interactionId}/callback`
      )
      expect(fault).toMatchObject({ guild_id: guild, channel_id: channel })
      expect(
        await status(
          `/interactions/${seeded.interactionId}/${seeded.interactionToken}/callback`,
          'POST',
          { type: 5 },
          null
        )
      ).toBe(503)
    })

    it('is invalidated by owner reassignment and channel deletion', async () => {
      const reassigned = await arm(
        'POST',
        `/interactions/${interaction.id}/callback`
      )
      server.db
        .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
        .run(otherToken, guild)
      expect(await status(`/_test/rest-faults/${reassigned.id}`)).toBe(404)
      expect(await code(callback(interaction))).toBe(204)
      const deleted = await arm(
        'POST',
        `/interactions/${otherInteraction.id}/callback`
      )
      server.db.prepare('DELETE FROM channels WHERE id = ?').run(otherChannel)
      expect(await status(`/_test/rest-faults/${deleted.id}`)).toBe(404)
    })

    it('arms each interaction independently', async () => {
      const first = await arm(
        'POST',
        `/interactions/${interaction.id}/callback`
      )
      const second = await arm(
        'POST',
        `/interactions/${otherInteraction.id}/callback`,
        { status: 500 }
      )
      expect(await code(callback(otherInteraction))).toBe(500)
      expect(await inspect(first.id)).toMatchObject({ consumed: 0 })
      expect(await inspect(second.id)).toMatchObject({ consumed: 1 })
    })
  })

  describe('original interaction response', () => {
    beforeEach(async () => {
      expect(await code(callback(interaction))).toBe(204)
    })

    it('does not change the message when an edit is faulted', async () => {
      await arm('PATCH', `/interactions/${interaction.id}/messages/@original`)
      expect(await code(original(interaction, 'PATCH'))).toBe(503)
      expect(originalContent(interaction)).toBe('original')
      const edited = await original(interaction, 'PATCH')
      expect(edited.status).toBe(200)
      await expect(edited.json()).resolves.toMatchObject({ content: 'edited' })
      expect(originalContent(interaction)).toBe('edited')
    })

    it('keeps the message readable when a delete is faulted, then deletes it', async () => {
      const fault = await arm(
        'DELETE',
        `/interactions/${interaction.id}/messages/@original`,
        { status: 401, code: 50_027, message: 'Invalid Webhook Token' }
      )
      const failed = await original(interaction, 'DELETE')
      expect(failed.status).toBe(401)
      await expect(failed.json()).resolves.toEqual({
        code: 50_027,
        message: 'Invalid Webhook Token',
      })
      expect(originalContent(interaction)).toBe('original')
      const read = await original(interaction, 'GET')
      expect(read.status).toBe(200)
      await expect(read.json()).resolves.toMatchObject({ content: 'original' })
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 0,
        consumed: 1,
      })
      expect(await code(original(interaction, 'DELETE'))).toBe(204)
      expect(originalContent(interaction)).toBeUndefined()
      expect(await code(original(interaction, 'GET'))).toBe(404)
    })

    it('fails a delete with Unknown Message while the message survives', async () => {
      await arm(
        'DELETE',
        `/interactions/${interaction.id}/messages/@original`,
        {
          status: 404,
          code: 10_008,
          message: 'Unknown Message',
        }
      )
      const failed = await original(interaction, 'DELETE')
      expect(failed.status).toBe(404)
      await expect(failed.json()).resolves.toEqual({
        code: 10_008,
        message: 'Unknown Message',
      })
      expect(originalContent(interaction)).toBe('original')
    })

    it('deletes natively once the control is cancelled', async () => {
      const fault = await arm(
        'DELETE',
        `/interactions/${interaction.id}/messages/@original`,
        { times: 5 }
      )
      expect(await code(original(interaction, 'DELETE'))).toBe(503)
      expect(await status(`/_test/rest-faults/${fault.id}`, 'DELETE')).toBe(204)
      expect(originalContent(interaction)).toBe('original')
      expect(await code(original(interaction, 'DELETE'))).toBe(204)
      expect(originalContent(interaction)).toBeUndefined()
    })

    it('is consumed only by the selected interaction and exact route', async () => {
      expect(await code(callback(otherInteraction))).toBe(204)
      const fault = await arm(
        'DELETE',
        `/interactions/${interaction.id}/messages/@original`
      )
      const read = await arm(
        'GET',
        `/interactions/${interaction.id}/messages/@original`
      )
      const patch = await arm(
        'PATCH',
        `/interactions/${interaction.id}/messages/@original`
      )
      // Another interaction's original, with its own token, is untouched.
      expect(await code(original(otherInteraction, 'DELETE'))).toBe(204)
      // GET and PATCH keep their own selectors.
      expect(await code(original(interaction, 'GET'))).toBe(503)
      expect(await code(original(interaction, 'PATCH'))).toBe(503)
      // A wrong token or a followup message route never consumes the control.
      expect(await code(original(interaction, 'DELETE', '', 'wrong'))).toBe(404)
      expect(
        await status(
          `/webhooks/${interaction.application_id}/${interaction.token}/messages/123456789012345678`,
          'DELETE',
          undefined,
          null
        )
      ).toBe(404)
      expect(await inspect(fault.id)).toMatchObject({
        remaining: 1,
        consumed: 0,
      })
      expect(await inspect(read.id)).toMatchObject({ consumed: 1 })
      expect(await inspect(patch.id)).toMatchObject({ consumed: 1 })
      expect(originalContent(interaction)).toBe('original')
      expect(await code(original(interaction, 'DELETE'))).toBe(503)
      expect(originalContent(interaction)).toBe('original')
    })

    it('fails reads and edits through independent controls', async () => {
      const read = await arm(
        'GET',
        `/interactions/${interaction.id}/messages/@original`
      )
      const edit = await arm(
        'PATCH',
        `/interactions/${interaction.id}/messages/@original`,
        { status: 500 }
      )
      expect(await code(original(interaction, 'GET'))).toBe(503)
      expect(await inspect(read.id)).toMatchObject({ consumed: 1 })
      expect(await inspect(edit.id)).toMatchObject({ consumed: 0 })
      const body = await original(interaction, 'GET')
      await expect(body.json()).resolves.toMatchObject({ content: 'original' })
      expect(await code(original(interaction, 'PATCH'))).toBe(500)
      expect(originalContent(interaction)).toBe('original')
    })

    it('does not intercept real webhooks or other @original methods', async () => {
      const fault = await arm(
        'GET',
        `/interactions/${interaction.id}/messages/@original`
      )
      const patch = await arm(
        'PATCH',
        `/interactions/${interaction.id}/messages/@original`
      )
      const webhook = seedWebhook(server.db, channel, guild)
      expect(
        await status(
          `/webhooks/${webhook.webhookId}/${webhook.webhookToken}/messages/@original`,
          'GET',
          undefined,
          null
        )
      ).toBe(404)
      expect(
        await status(
          `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
          'DELETE',
          undefined,
          null
        )
      ).toBe(204)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 0 })
      expect(await inspect(patch.id)).toMatchObject({ consumed: 0 })
    })

    it('requires the application and token to match the interaction', async () => {
      const fault = await arm(
        'GET',
        `/interactions/${interaction.id}/messages/@original`
      )
      expect(
        await status(
          `/webhooks/${otherBotUser}/${interaction.token}/messages/@original`,
          'GET',
          undefined,
          null
        )
      ).toBe(404)
      expect(await inspect(fault.id)).toMatchObject({ consumed: 0 })
    })
  })
})
