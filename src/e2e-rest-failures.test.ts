import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  let uploadPath: string
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
  async function arm(
    path: string,
    method: string,
    times = 1,
    responseFailure = failure
  ) {
    const response = await request('/_test/rest-faults', 'POST', {
      path,
      method,
      times,
      ...responseFailure,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as { id: string }
  }

  beforeEach(async () => {
    uploadPath = await mkdtemp(path.join(tmpdir(), 'fauxcord-rest-faults-'))
    server = await createRealServer({ uploadPath })
    seedBot(server.db, token)
    guild = seedGuild(server.db, token)
    channel = seedChannel(server.db, guild)
    user = seedMember(server.db, guild)
    role = seedRole(server.db, guild)
  })

  afterEach(async () => {
    await server.close()
  })

  it.each([
    failure,
    { status: 500, code: 0, message: 'Internal Server Error' },
  ])(
    'fails message sends with $status before any side effects',
    async (error) => {
      const messagePath = `/channels/${channel}/messages`
      const fault = await arm(messagePath, 'POST', 1, error)
      const ws = new WebSocket(server.baseUrl.replace('http:', 'ws:'))
      const ready = Promise.withResolvers<undefined>()
      const barrier = Promise.withResolvers<undefined>()
      const created = Promise.withResolvers<Frame>()
      const events: Frame[] = []
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
        if (frame.op === GatewayOp.HeartbeatAck) barrier.resolve(undefined)
        if (frame.t !== 'MESSAGE_CREATE') return
        events.push(frame)
        created.resolve(frame)
      })
      await ready.promise
      const form = new FormData()
      form.set(
        'payload_json',
        JSON.stringify({
          content: 'edit log',
          poll: {
            question: { text: 'Was this edit helpful?' },
            answers: [
              { poll_media: { text: 'Yes' } },
              { poll_media: { text: 'No' } },
            ],
            duration: 24,
            layout_type: 1,
          },
        })
      )
      form.set('files[0]', new File(['edit details'], 'edit.txt'))
      const response = await fetch(`${server.baseUrl}/api/v10${messagePath}`, {
        method: 'POST',
        headers: { Authorization: token },
        body: form,
      })
      expect(response.status).toBe(error.status)
      expect(response.headers.get('X-RateLimit-Bucket')).toBe(
        'mock-post-channels'
      )
      await expect(response.json()).resolves.toEqual({
        code: error.code,
        message: error.message,
      })
      await expect(
        request(`/_test/messages/${channel}`).then((res) => res.json())
      ).resolves.toEqual({ messages: [] })
      for (const table of [
        'messages',
        'attachments',
        'polls',
        'poll_answers',
      ]) {
        expect(server.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
      }
      expect(
        server.db
          .prepare('SELECT last_message_id FROM channels WHERE id = ?')
          .get(channel)
      ).toEqual({ last_message_id: null })
      await expect(readdir(uploadPath)).resolves.toEqual([])
      // ACK is a barrier for any Gateway frames queued by the failed send.
      ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }))
      await barrier.promise
      expect(events).toEqual([])
      await expect(
        request(`/_test/rest-faults/${fault.id}`).then((res) => res.json())
      ).resolves.toMatchObject({
        method: 'POST',
        path: messagePath,
        guild_id: guild,
        channel_id: channel,
        remaining: 0,
        consumed: 1,
      })
      const sent = await fetch(`${server.baseUrl}${messagePath}`, {
        method: 'POST',
        headers: { Authorization: token },
        body: form,
      })
      expect(sent.status).toBe(200)
      const message = (await sent.json()) as { id: string }
      expect(await created.promise).toMatchObject({
        t: 'MESSAGE_CREATE',
        d: { id: message.id, channel_id: channel },
      })
      expect(events).toHaveLength(1)
      for (const table of ['messages', 'attachments', 'polls']) {
        expect(server.db.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(
          1
        )
      }
      expect(
        server.db.prepare('SELECT * FROM poll_answers').all()
      ).toHaveLength(2)
      expect(await readdir(uploadPath, { recursive: true })).not.toEqual([])
      ws.close()
    }
  )

  it('matches only authenticated exact message sends across all prefixes', async () => {
    const messagePath = `/channels/${channel}/messages`
    const fault = await arm(messagePath, 'POST', 3)
    for (const authorization of [undefined, 'Bot unknown']) {
      await expect(
        fetch(`${server.baseUrl}${messagePath}`, {
          method: 'POST',
          headers: authorization ? { Authorization: authorization } : {},
        })
      ).resolves.toMatchObject({ status: 401 })
    }
    await expect(request(messagePath)).resolves.toMatchObject({ status: 200 })
    await expect(request(messagePath, 'PATCH', {})).resolves.toMatchObject({
      status: 404,
    })
    for (const suffix of ['/', '/123', '/bulk-delete']) {
      await expect(
        request(`${messagePath}${suffix}`, 'POST', {})
      ).resolves.toMatchObject({
        status: suffix === '/bulk-delete' ? 400 : 404,
      })
    }
    const otherChannel = seedChannel(server.db, guild, '333333333333333334')
    const otherGuild = seedGuild(server.db, token, '222222222222222223')
    const otherGuildChannel = seedChannel(
      server.db,
      otherGuild,
      '333333333333333335'
    )
    for (const id of [otherChannel, otherGuildChannel]) {
      await expect(
        request(`/channels/${id}/messages`, 'POST', { content: 'unrelated' })
      ).resolves.toMatchObject({ status: 200 })
    }
    await expect(
      request(`/_test/rest-faults/${fault.id}`).then((res) => res.json())
    ).resolves.toMatchObject({ remaining: 3, consumed: 0 })
    await expect(
      request('/_test/rest-faults', 'POST', {
        path: messagePath,
        method: 'POST',
        ...failure,
      })
    ).resolves.toMatchObject({ status: 409 })
    // Faults precede payload validation and ignore query parameters.
    for (const prefix of ['/api/v10', '/api', '']) {
      await expect(
        request(`${prefix}${messagePath}?nonce=123`, 'POST', {})
      ).resolves.toMatchObject({ status: 403 })
    }
    await expect(request(messagePath, 'POST', {})).resolves.toMatchObject({
      status: 400,
    })
    await expect(
      request(messagePath, 'POST', { content: 'after exhaustion' })
    ).resolves.toMatchObject({ status: 200 })
    await expect(
      request(`/_test/rest-faults/${fault.id}`).then((res) => res.json())
    ).resolves.toMatchObject({ remaining: 0, consumed: 3 })
    const rearmed = await arm(messagePath, 'POST')
    await expect(
      request(`/_test/rest-faults/${rearmed.id}`, 'DELETE')
    ).resolves.toMatchObject({ status: 204 })
    await expect(
      request(messagePath, 'POST', { content: 'after removal' })
    ).resolves.toMatchObject({ status: 200 })
  })

  it.each([
    '/channels/*/messages',
    '/channels/{channelId}/messages',
    '/channels/1/messages/',
    '/channels/1/messages?wait=true',
    '/api/v10/channels/1/messages',
    '/channels/1/messages/2',
    '/channels/1/messages/bulk-delete',
    '/channels/123456789012345678901/messages',
    '/guilds/1/members/2',
  ])('rejects unsupported POST selector %s', async (selector) => {
    await expect(
      request('/_test/rest-faults', 'POST', {
        path: selector,
        method: 'POST',
        ...failure,
      })
    ).resolves.toMatchObject({ status: 400 })
  })

  it('rejects message-send faults for unknown channels and channels without a guild', async () => {
    server.db
      .prepare("INSERT INTO channels (id, type, name) VALUES ('456', 1, 'dm')")
      .run()
    for (const id of ['123', '456']) {
      await expect(
        request('/_test/rest-faults', 'POST', {
          path: `/channels/${id}/messages`,
          method: 'POST',
          ...failure,
        })
      ).resolves.toMatchObject({ status: 404 })
    }
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
      const send = await arm(`/channels/${channel}/messages`, 'POST')
      await request(`/channels/${channel}/messages`, 'POST', {
        content: 'fail',
      })
      const activeSend = await arm(`/channels/${channel}/messages`, 'POST')
      const other = await arm(`/guilds/${otherGuild}/bans/${user}`, 'PUT')
      const otherChannel = seedChannel(
        server.db,
        otherGuild,
        '333333333333333336'
      )
      const otherSend = await arm(`/channels/${otherChannel}/messages`, 'POST')
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
      for (const fault of [send, activeSend]) {
        await expect(
          request(`/_test/rest-faults/${fault.id}`)
        ).resolves.toMatchObject({ status: 404 })
      }
      await expect(
        request(`/_test/rest-faults/${otherSend.id}`)
      ).resolves.toMatchObject({ status: cleanup === 'reset' ? 404 : 200 })
      await expect(
        request(`/_test/rest-faults/${other.id}`)
      ).resolves.toMatchObject({ status: cleanup === 'reset' ? 404 : 200 })
    }
  )

  it.each(['PUT', 'POST'])(
    'keeps %s faults isolated between database instances and allows explicit cancellation',
    async (method) => {
      const selector =
        method === 'POST'
          ? `/channels/${channel}/messages`
          : `/guilds/${guild}/bans/${user}`
      const fault = await arm(selector, method)
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
    }
  )

  it.each(['PATCH', 'POST'])(
    'bounds concurrent %s attempts and allows rearming an exhausted selector',
    async (method) => {
      const path =
        method === 'POST'
          ? `/channels/${channel}/messages`
          : `/guilds/${guild}/members/${user}`
      const payload = method === 'POST' ? { content: 'send' } : { mute: true }
      const fault = await arm(path, method, 3)
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => request(path, method, payload))
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
      if (method === 'POST') {
        expect(
          server.db
            .prepare('SELECT * FROM messages WHERE channel_id = ?')
            .all(channel)
        ).toHaveLength(5)
      }
      const rearmed = await arm(path, method)
      expect(rearmed.id).not.toBe(fault.id)
      await expect(
        request(
          path,
          method,
          method === 'POST' ? { content: 'blocked' } : { mute: false }
        )
      ).resolves.toMatchObject({ status: 403 })
      await expect(
        request(path).then((response) => response.json())
      ).resolves.toMatchObject(
        method === 'POST' ? expect.any(Array) : { mute: true }
      )
      await request('/_test/reset', 'POST', { token })
      await expect(
        request(`/_test/rest-faults/${fault.id}`)
      ).resolves.toMatchObject({ status: 404 })
      await expect(
        request(`/_test/rest-faults/${rearmed.id}`)
      ).resolves.toMatchObject({ status: 404 })
    }
  )

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
