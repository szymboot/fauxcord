import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { GatewayOp } from './gateway/opcodes'
import {
  createRealServer,
  seedBot,
  seedGuild,
  seedChannel,
  seedMember,
  seedRole,
  type RealServerContext,
} from './test-helpers'

/** Native Gateway frame used as the barrier for bot REST requests. */
interface Frame {
  op: number
  t?: string
  d: { id?: string; channel_id?: string; content?: string }
}

const token = 'Bot rest-faults'
const messageId = '100000000000000099'
const failure = { status: 403, code: 50_013, message: 'Missing Permissions' }

describe('deterministic REST failure controls', () => {
  let server: RealServerContext
  let guild: string
  let channel: string
  let user: string
  let role: string

  /** Sends JSON requests to the actual assembled HTTP server. */
  function request(path: string, method = 'GET', body?: unknown) {
    return fetch(`${server.baseUrl}${path}`, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Arms one exact request and returns its inspectable control ID. */
  async function arm(path: string, method: string, times = 1) {
    const response = await request('/_test/rest-faults', 'POST', {
      path,
      method,
      times,
      ...failure,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as { id: string }
  }

  beforeEach(async () => {
    server = await createRealServer()
    seedBot(server.db, token)
    guild = seedGuild(server.db, token)
    channel = seedChannel(server.db, guild)
    user = seedMember(server.db, guild)
    role = seedRole(server.db, guild)
  })

  afterEach(async () => {
    await server.close()
  })

  it.each(['delete', 'ban', 'patch', 'role'] as const)(
    'fails %s from native MESSAGE_CREATE without mutation, then succeeds',
    async (operation) => {
      const messagePath = `/channels/${channel}/messages/${messageId}`
      const memberPath = `/guilds/${guild}/members/${user}`
      const path = {
        delete: messagePath,
        ban: `/guilds/${guild}/bans/${user}`,
        patch: memberPath,
        role: `${memberPath}/roles/${role}`,
      }[operation]
      const method =
        operation === 'delete'
          ? 'DELETE'
          : operation === 'patch'
            ? 'PATCH'
            : 'PUT'
      const body =
        operation === 'patch'
          ? { mute: true }
          : operation === 'ban'
            ? { delete_message_seconds: 3600 }
            : undefined
      const fault = await arm(path, method)
      const ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
      const mutations: string[] = []
      const barrier = Promise.withResolvers<undefined>()
      // Attach before IDENTIFY; the listener acts as the bot's event handler.
      const ready = Promise.withResolvers<undefined>()
      const attempt = Promise.withResolvers<Response>()
      ws.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as Frame
        if (frame.op === GatewayOp.HeartbeatAck) barrier.resolve(undefined)
        if (
          frame.t &&
          [
            'MESSAGE_DELETE',
            'GUILD_BAN_ADD',
            'GUILD_MEMBER_UPDATE',
            'GUILD_MEMBER_REMOVE',
          ].includes(frame.t)
        )
          mutations.push(frame.t)
        if (frame.op === GatewayOp.Hello) {
          ws.send(
            JSON.stringify({
              op: GatewayOp.Identify,
              d: {
                token,
                intents:
                  GatewayIntentBits.GuildMessages |
                  GatewayIntentBits.GuildMembers |
                  GatewayIntentBits.GuildModeration,
              },
            })
          )
        }
        if (frame.t === 'READY') ready.resolve(undefined)
        if (frame.t !== 'MESSAGE_CREATE') {
          return
        }

        request(`/api/v10${path}`, method, body)
          .then((response) => {
            expect(frame.d).toMatchObject({
              id: messageId,
              channel_id: channel,
              content: 'trigger',
            })
            return response
          })
          .then(attempt.resolve, attempt.reject)
      })
      await ready.promise
      const injected = await request(
        `/_test/channels/${channel}/messages`,
        'POST',
        {
          id: messageId,
          content: 'trigger',
          author: { id: user },
        }
      )
      expect(injected.status).toBe(201)
      const response = await attempt.promise
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        code: 50_013,
        message: 'Missing Permissions',
      })
      await expect(
        request(`/_test/rest-faults/${fault.id}`).then((res) => res.json())
      ).resolves.toMatchObject({ remaining: 0, consumed: 1 })
      await expect(request(messagePath)).resolves.toMatchObject({ status: 200 })
      await expect(
        request(`/guilds/${guild}/bans/${user}`)
      ).resolves.toMatchObject({ status: 404 })
      await expect(
        request(memberPath).then((res) => res.json())
      ).resolves.toMatchObject({ mute: false, roles: [] })
      // ACK is a barrier for all mutation frames queued by the failed attempt.
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      await barrier.promise
      expect(mutations).toEqual([])
      await expect(request(`/api${path}`, method, body)).resolves.toMatchObject(
        { status: operation === 'patch' ? 200 : 204 }
      )
      if (operation === 'delete' || operation === 'ban')
        await expect(request(messagePath)).resolves.toMatchObject({
          status: 404,
        })
      switch (operation) {
        case 'ban': {
          await expect(
            request(`/guilds/${guild}/bans/${user}`)
          ).resolves.toMatchObject({ status: 200 })
          break
        }
        case 'patch': {
          await expect(
            request(memberPath).then((res) => res.json())
          ).resolves.toMatchObject({ mute: true })
          break
        }
        case 'role': {
          await expect(
            request(memberPath).then((res) => res.json())
          ).resolves.toMatchObject({ roles: [role] })
          break
        }
      }
      ws.close()
    }
  )

  it('dispatches create then delete, with a genuinely absent message at bot DELETE', async () => {
    const ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
    const events: string[] = []
    const ready = Promise.withResolvers<undefined>()
    const attempt = Promise.withResolvers<Response>()
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.op === GatewayOp.Hello)
        ws.send(
          JSON.stringify({
            op: GatewayOp.Identify,
            d: { token, intents: GatewayIntentBits.GuildMessages },
          })
        )
      if (frame.t === 'READY') ready.resolve(undefined)
      if (frame.t?.startsWith('MESSAGE_')) events.push(frame.t)
      if (frame.t === 'MESSAGE_CREATE')
        request(`/channels/${channel}/messages/${frame.d.id}`, 'DELETE').then(
          attempt.resolve,
          attempt.reject
        )
    })
    await ready.promise
    const injected = await request(
      `/_test/channels/${channel}/messages`,
      'POST',
      {
        content: 'vanishing trigger',
        author: { id: user },
        remove_after_create: true,
      }
    )
    expect(injected.status).toBe(201)
    const message = (await injected.json()) as { id: string }
    const response = await attempt.promise
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      code: 10_008,
      message: 'Unknown Message',
    })
    await expect(
      request(`/channels/${channel}/messages/${message.id}`)
    ).resolves.toMatchObject({ status: 404 })
    expect(events).toEqual(['MESSAGE_CREATE', 'MESSAGE_DELETE'])
    await expect(
      request(`/_test/messages/${channel}`).then((res) => res.json())
    ).resolves.toEqual({ messages: [] })
    ws.close()
  })

  it('counts only authenticated matching method and exact targets across all prefixes', async () => {
    const path = `/guilds/${guild}/members/${user}`
    const fault = await arm(path, 'PATCH', 2)
    await expect(
      fetch(`${server.baseUrl}${path}`, { method: 'PATCH' })
    ).resolves.toMatchObject({ status: 401 })
    await expect(request(path)).resolves.toMatchObject({ status: 200 })
    const otherUser = seedMember(server.db, guild)
    await expect(
      request(`/guilds/${guild}/members/${otherUser}`, 'PATCH', {
        mute: true,
      })
    ).resolves.toMatchObject({ status: 200 })
    const otherGuild = seedGuild(server.db, token, '222222222222222223')
    seedMember(server.db, otherGuild, user)
    await expect(
      request(`/guilds/${otherGuild}/members/${user}`, 'PATCH', {
        mute: true,
      })
    ).resolves.toMatchObject({ status: 200 })
    const duplicate = await request('/_test/rest-faults', 'POST', {
      path,
      method: 'PATCH',
      ...failure,
    })
    expect(duplicate.status).toBe(409)
    await expect(
      request(`/api/v10${path}?reason=test`, 'PATCH', { mute: true })
    ).resolves.toMatchObject({ status: 403 })
    await expect(
      request(`/api${path}`, 'PATCH', { mute: true })
    ).resolves.toMatchObject({ status: 403 })
    await expect(request(path, 'PATCH', { mute: true })).resolves.toMatchObject(
      { status: 200 }
    )
    await expect(
      request(`/_test/rest-faults/${fault.id}`).then((res) => res.json())
    ).resolves.toMatchObject({ remaining: 0, consumed: 2 })
  })

  it.each([
    'reset',
    'scoped reset',
    'teardown',
    'guild deletion',
    'channel deletion',
  ])(
    'clears faults on %s without affecting another environment',
    async (cleanup) => {
      const otherToken = 'Bot another-environment'
      seedBot(server.db, otherToken)
      const otherGuild = seedGuild(server.db, otherToken, '222222222222222224')
      const own = await arm(
        `/channels/${channel}/messages/${messageId}`,
        'DELETE'
      )
      const other = await arm(`/guilds/${otherGuild}/bans/${user}`, 'PUT')
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
      await expect(
        request(`/_test/rest-faults/${own.id}`)
      ).resolves.toMatchObject({ status: 404 })
      await expect(
        request(`/_test/rest-faults/${other.id}`)
      ).resolves.toMatchObject({ status: cleanup === 'reset' ? 404 : 200 })
    }
  )

  it('keeps faults isolated between database instances and allows explicit cancellation', async () => {
    const fault = await arm(`/guilds/${guild}/bans/${user}`, 'PUT')
    const second = await createRealServer()
    try {
      await expect(
        fetch(`${second.baseUrl}/_test/rest-faults/${fault.id}`)
      ).resolves.toMatchObject({ status: 404 })
    } finally {
      await second.close()
    }
    await expect(
      request(`/_test/rest-faults/${fault.id}`, 'DELETE')
    ).resolves.toMatchObject({ status: 204 })
    await expect(
      request(`/_test/rest-faults/${fault.id}`, 'DELETE')
    ).resolves.toMatchObject({ status: 404 })
  })

  it('bounds concurrent attempts and allows rearming an exhausted selector', async () => {
    const path = `/guilds/${guild}/members/${user}`
    const fault = await arm(path, 'PATCH', 3)
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(path, 'PATCH', { mute: true }))
    )
    expect(
      responses.filter((response) => response.status === 403)
    ).toHaveLength(3)
    expect(
      responses.filter((response) => response.status === 200)
    ).toHaveLength(5)
    await expect(
      request(`/_test/rest-faults/${fault.id}`).then((response) =>
        response.json()
      )
    ).resolves.toMatchObject({ remaining: 0, consumed: 3 })
    const rearmed = await arm(path, 'PATCH')
    expect(rearmed.id).not.toBe(fault.id)
    await expect(
      request(path, 'PATCH', { mute: false })
    ).resolves.toMatchObject({ status: 403 })
    await expect(
      request(path).then((response) => response.json())
    ).resolves.toMatchObject({ mute: true })
    await request('/_test/reset', 'POST', { token })
    await expect(
      request(`/_test/rest-faults/${fault.id}`)
    ).resolves.toMatchObject({ status: 404 })
    await expect(
      request(`/_test/rest-faults/${rearmed.id}`)
    ).resolves.toMatchObject({ status: 404 })
  })

  it('does not match another message, channel, or role', async () => {
    const messagePath = `/channels/${channel}/messages/${messageId}`
    const messageFault = await arm(messagePath, 'DELETE')
    const otherChannel = seedChannel(server.db, guild, '333333333333333334')
    await expect(
      request(`/channels/${otherChannel}/messages/${messageId}`, 'DELETE')
    ).resolves.toMatchObject({ status: 404 })
    await expect(
      request(`/channels/${channel}/messages/123`, 'DELETE')
    ).resolves.toMatchObject({ status: 404 })
    const roleFault = await arm(
      `/guilds/${guild}/members/${user}/roles/${role}`,
      'PUT'
    )
    const otherRole = seedRole(server.db, guild)
    await expect(
      request(`/guilds/${guild}/members/${user}/roles/${otherRole}`, 'PUT')
    ).resolves.toMatchObject({ status: 204 })
    for (const fault of [messageFault, roleFault]) {
      await expect(
        request(`/_test/rest-faults/${fault.id}`).then((response) =>
          response.json()
        )
      ).resolves.toMatchObject({ remaining: 1, consumed: 0 })
    }
  })

  it('accepts a chosen failure and a default one-shot count', async () => {
    const path = `/guilds/${guild}/bans/${user}`
    const response = await request('/_test/rest-faults', 'POST', {
      path,
      method: 'PUT',
      status: 502,
      code: 0,
      message: 'Upstream failed',
    })
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      times: 1,
      remaining: 1,
      consumed: 0,
    })
    const failed = await request(path, 'PUT')
    expect(failed.status).toBe(502)
    expect(failed.headers.get('X-RateLimit-Bucket')).toBe('mock-put-guilds')
    await expect(failed.json()).resolves.toEqual({
      code: 0,
      message: 'Upstream failed',
    })
    await expect(request(path, 'PUT')).resolves.toMatchObject({ status: 204 })
  })

  it('rejects duplicate message IDs without overwriting and defaults to a retained message', async () => {
    const path = `/_test/channels/${channel}/messages`
    const payload = { id: messageId, content: 'original', author: { id: user } }
    await expect(request(path, 'POST', payload)).resolves.toMatchObject({
      status: 201,
    })
    await expect(
      request(path, 'POST', {
        ...payload,
        content: 'overwrite',
        remove_after_create: true,
      })
    ).resolves.toMatchObject({ status: 409 })
    await expect(
      request(`/channels/${channel}/messages/${messageId}`).then((response) =>
        response.json()
      )
    ).resolves.toMatchObject({ content: 'original' })
  })

  it.each([
    { id: 123 },
    { id: 'invalid' },
    { remove_after_create: 'true' },
    { remove_after_create: null },
  ])('rejects invalid message injection options %j', async (options) => {
    await expect(
      request(`/_test/channels/${channel}/messages`, 'POST', {
        content: 'trigger',
        author: { id: user },
        ...options,
      })
    ).resolves.toMatchObject({ status: 400 })
    await expect(
      request(`/_test/messages/${channel}`).then((response) => response.json())
    ).resolves.toEqual({ messages: [] })
  })

  it.each([
    null,
    [],
    {},
    { times: 0 },
    { times: 101 },
    { times: 1.5 },
    { times: null },
    { status: 200 },
    { status: 600 },
    { code: -1 },
    { message: '' },
    { method: 'GET' },
    { path: '/guilds/*/bans/*' },
    { path: '/api/v10/guilds/1/bans/2' },
  ])('rejects invalid fault configuration %j', async (override) => {
    const body =
      override === null || Array.isArray(override)
        ? override
        : {
            path: `/guilds/${guild}/bans/${user}`,
            method: 'PUT',
            ...failure,
            ...override,
          }
    // An empty object by itself is invalid too.
    const response = await request(
      '/_test/rest-faults',
      'POST',
      override && Object.keys(override).length === 0 ? {} : body
    )
    expect(response.status).toBe(400)
  })

  it('rejects malformed JSON and unknown scopes', async () => {
    await expect(
      fetch(`${server.baseUrl}/_test/rest-faults`, {
        method: 'POST',
        body: '{',
      })
    ).resolves.toMatchObject({ status: 400 })
    await expect(
      request('/_test/rest-faults', 'POST', {
        path: '/guilds/123/bans/456',
        method: 'PUT',
        ...failure,
      })
    ).resolves.toMatchObject({ status: 404 })
    await expect(request('/_test/rest-faults/missing')).resolves.toMatchObject({
      status: 404,
    })
  })
})
