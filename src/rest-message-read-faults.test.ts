import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { initializeDatabase } from './db'
import { seedBot, seedChannel, seedGuild, seedMessage } from './test-helpers'

const token = 'Bot message-read-owner'
const otherToken = 'Bot message-read-other'
const failure = { status: 500, code: 0, message: 'Internal Server Error' }

describe('single message read REST faults', () => {
  let db: ReturnType<typeof initializeDatabase>
  let server: ReturnType<typeof buildApp>
  let guild: string
  let otherGuild: string
  let channel: string
  let siblingChannel: string
  let otherChannel: string
  let message: string
  let sibling: string
  let foreign: string

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

  /** Arms a bounded single message read failure. */
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
    return (await response.json()) as {
      id: string
      guild_id: string
      channel_id: string | null
      query?: unknown
    }
  }

  /** Checks the retained counters without consuming a control. */
  async function counters(id: string, remaining: number, consumed: number) {
    await expect(
      request(`/_test/rest-faults/${id}`).then((response) => response.json())
    ).resolves.toMatchObject({ remaining, consumed })
  }

  /** Snapshots stored messages for side-effect checks. */
  function messageRows(): unknown[] {
    return db.prepare('SELECT * FROM messages ORDER BY id').all()
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    server = buildApp(db, { baseUrl: 'http://localhost', disableAuth: false })
    seedBot(db, token, '100000000000000001')
    seedBot(db, otherToken, '100000000000000002')
    guild = seedGuild(db, token)
    otherGuild = seedGuild(db, otherToken, '222222222222222223')
    channel = seedChannel(db, guild)
    siblingChannel = seedChannel(db, guild, '333333333333333335')
    otherChannel = seedChannel(db, otherGuild, '333333333333333334')
    message = seedMessage(db, channel, '100000000000000001', token, 'Rules')
    sibling = seedMessage(db, channel, '100000000000000001', token, 'Sibling')
    foreign = seedMessage(
      db,
      otherChannel,
      '100000000000000002',
      otherToken,
      'Foreign'
    )
  })

  afterEach(() => {
    server.unsubscribeGateway()
    server.wss.close()
    db.close()
  })

  it.each([
    failure,
    { status: 503, code: 0, message: 'Service Unavailable' },
    { status: 403, code: 50_013, message: 'Missing Permissions' },
    { status: 404, code: 10_008, message: 'Unknown Message' },
  ])(
    'returns $status without side effects, then reads the message normally',
    async (error) => {
      const path = `/channels/${channel}/messages/${message}`
      const before = messageRows()
      const fault = await arm(path, 3, error)
      expect(fault.guild_id).toBe(guild)
      expect(fault.channel_id).toBe(channel)
      for (const prefix of ['/api/v10', '/api', '']) {
        const response = await request(`${prefix}${path}`)
        expect(response.status).toBe(error.status)
        await expect(response.json()).resolves.toEqual({
          code: error.code,
          message: error.message,
        })
      }
      expect(messageRows()).toEqual(before)
      await counters(fault.id, 0, 3)
      const success = await request(path)
      expect(success.status).toBe(200)
      await expect(success.json()).resolves.toMatchObject({
        id: message,
        channel_id: channel,
        content: 'Rules',
      })
      await counters(fault.id, 0, 3)
      expect(messageRows()).toEqual(before)
      const rearmed = await arm(path)
      expect(rearmed.id).not.toBe(fault.id)
    }
  )

  it('arms a message that does not exist yet and keeps the ordinary 404 after exhaustion', async () => {
    const path = `/channels/${channel}/messages/444444444444444444`
    const fault = await arm(path)
    expect(await status(path)).toBe(500)
    await counters(fault.id, 0, 1)
    const response = await request(path)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 10_008 })
  })

  it('matches only the exact message, channel, method and owning bot', async () => {
    const path = `/channels/${channel}/messages/${message}`
    const fault = await arm(path)
    expect(await status(`/channels/${channel}/messages/${sibling}`)).toBe(200)
    expect(
      await status(`/channels/${siblingChannel}/messages/${message}`)
    ).toBe(404)
    expect(await status(`/channels/${channel}/messages`)).toBe(200)
    expect(await status(`/channels/${channel}/messages?limit=1`)).toBe(200)
    expect(await status(`/channels/${channel}/messages/pins`)).toBe(200)
    expect(await status(`${path}/`)).not.toBe(500)
    expect(
      await status(
        `/channels/${otherChannel}/messages/${foreign}`,
        'GET',
        undefined,
        otherToken
      )
    ).toBe(200)
    await request(path, 'PATCH', { content: 'Edited' })
    await request(path, 'POST')
    await request(path, 'HEAD')
    await counters(fault.id, 1, 0)
    expect(await request(path).then((response) => response.status)).toBe(500)
    await counters(fault.id, 0, 1)
    // DELETE of the same message is never selected by the GET control.
    const deleteFault = await arm(path)
    expect(await status(path, 'DELETE')).toBe(204)
    await counters(deleteFault.id, 1, 0)
  })

  it('does not consume for non-owner, invalid or Bearer callers', async () => {
    const path = `/channels/${channel}/messages/${message}`
    const fault = await arm(path)
    for (const auth of ['', 'Bot missing', 'Bearer missing'])
      expect(await status(path, 'GET', undefined, auth)).toBe(401)
    await request(path, 'GET', undefined, otherToken)
    await counters(fault.id, 1, 0)
    expect(await status(path)).toBe(500)
    await counters(fault.id, 0, 1)
  })

  it('keeps owner scoping when auth is disabled, including Bearer tokens', async () => {
    const path = `/channels/${channel}/messages/${message}`
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

  it('applies explicit modes to the message read', async () => {
    const path = `/channels/${channel}/messages/${message}`
    const limited = await arm(path, 1, {
      status: 429,
      code: 0,
      message: 'Too Many Requests',
      mode: 'rate_limit',
      retry_after: 2,
    })
    const response = await request(path)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('2')
    await counters(limited.id, 0, 1)
    expect(await status(path)).toBe(200)

    const delayed = await arm(path, 1, {
      status: 504,
      code: 0,
      message: 'Gateway Timeout',
      mode: 'delay',
      delay_ms: 20,
    })
    const started = Date.now()
    expect(await status(path)).toBe(504)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
    await counters(delayed.id, 0, 1)
    expect(await status(path)).toBe(200)

    const dropped = await arm(path, 1, { mode: 'disconnect' })
    // An in-process request cannot be torn down; it reports the fallback.
    expect(await status(path)).toBe(501)
    await counters(dropped.id, 0, 1)
    expect(await status(path)).toBe(200)
  })

  it('bounds concurrent reads and rejects an active duplicate', async () => {
    const path = `/channels/${channel}/messages/${message}`
    const fault = await arm(path, 3)
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'GET',
        path,
        times: 1,
        ...failure,
      })
    ).toBe(409)
    // A different message of the same channel is an independent selector.
    await arm(`/channels/${channel}/messages/${sibling}`)
    // The same message for another bot's channel is independent too.
    await arm(`/channels/${otherChannel}/messages/${foreign}`)
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
    // After exhaustion the same selector may be armed again.
    expect(await arm(path)).toMatchObject({ channel_id: channel })
  })

  it('does not disturb the list selector of the same channel', async () => {
    const listPath = `/channels/${channel}/messages`
    const path = `${listPath}/${message}`
    const list = await arm(listPath, 1, { query: {} })
    const single = await arm(path)
    expect(single.query === undefined || single.query === '').toBe(true)
    expect(await status(path)).toBe(500)
    await counters(list.id, 1, 0)
    await counters(single.id, 0, 1)
    expect(await status(listPath)).toBe(500)
    await counters(list.id, 0, 1)
  })

  it.each([
    'control deletion',
    'reset',
    'scoped reset',
    'guild deletion',
    'channel deletion',
  ])('cleans active and exhausted controls on %s', async (cleanup) => {
    const path = `/channels/${channel}/messages/${message}`
    const active = await arm(path, 2)
    await request(path)
    const exhausted = await arm(`/channels/${channel}/messages/${sibling}`)
    await request(`/channels/${channel}/messages/${sibling}`)
    const kept = await arm(`/channels/${siblingChannel}/messages/${message}`)
    const foreignFault = await arm(
      `/channels/${otherChannel}/messages/${foreign}`
    )
    switch (cleanup) {
      case 'control deletion': {
        expect(await status(`/_test/rest-faults/${active.id}`, 'DELETE')).toBe(
          204
        )
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
      case 'channel deletion': {
        expect(await status(`/channels/${channel}`, 'DELETE')).toBe(200)
        break
      }
    }
    for (const fault of [active, exhausted])
      expect(await status(`/_test/rest-faults/${fault.id}`)).toBe(404)
    if (cleanup === 'channel deletion')
      expect(await status(`/_test/rest-faults/${kept.id}`)).toBe(200)
    expect(await status(`/_test/rest-faults/${foreignFault.id}`)).toBe(
      cleanup === 'reset' ? 404 : 200
    )
  })

  it.each([
    { path: '/channels/123/messages/456/' },
    { path: '/channels/123/messages/456?limit=1' },
    { path: '/channels/123/messages/*' },
    { path: '/channels/{channelId}/messages/{messageId}' },
    { path: '/channels/123/messages/pins' },
    { path: '/channels/123/messages/@original' },
    { path: '/channels/123/messages/123456789012345678901' },
    { path: '/api/v10/channels/123/messages/456' },
    { path: '/channels/123/messages/456/reactions' },
    { path: '/channels/123/messages/456', guild_id: '789' },
    { path: '/channels/123/messages/456', guild_id: 123 },
    { path: '/channels/123/messages/456', recipient_id: '456' },
    { path: '/channels/123/messages/456', query: {} },
    { path: '/channels/123/messages/456', query: { limit: 1 } },
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

  it('rejects guild_id even when it matches the channel guild', async () => {
    expect(
      await status('/_test/rest-faults', 'POST', {
        method: 'GET',
        path: `/channels/${channel}/messages/${message}`,
        guild_id: guild,
        times: 1,
        ...failure,
      })
    ).toBe(400)
  })

  it('answers an unknown channel like the message list selector', async () => {
    const body = {
      method: 'GET',
      times: 1,
      ...failure,
    }
    const list = await request('/_test/rest-faults', 'POST', {
      ...body,
      path: '/channels/123/messages',
    })
    const single = await request('/_test/rest-faults', 'POST', {
      ...body,
      path: '/channels/123/messages/456',
    })
    expect(single.status).toBe(404)
    expect(single.status).toBe(list.status)
    expect(await single.json()).toEqual(await list.json())
  })

  it('mirrors the selector in REST observations', async () => {
    const path = `/channels/${channel}/messages/${message}`
    const created = await request('/_test/rest-observations', 'POST', {
      method: 'GET',
      path,
    })
    expect(created.status).toBe(201)
    const observation = (await created.json()) as { id: string }
    await request(`/channels/${channel}/messages/${sibling}`)
    await request(path, 'GET', undefined, otherToken)
    await request(path)
    const snapshot = await request(
      `/_test/rest-observations/${observation.id}`
    ).then((response) => response.json())
    expect(snapshot).toMatchObject({ count: 1, path })
    expect(
      await status('/_test/rest-observations', 'POST', {
        method: 'GET',
        path,
        guild_id: guild,
      })
    ).toBe(400)
  })

  it('rejects non-GET selectors other than the existing message ones', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'])
      expect(
        await status('/_test/rest-faults', 'POST', {
          method,
          path: `/channels/${channel}/messages/${message}`,
          times: 1,
          ...failure,
        })
      ).toBe(method === 'PUT' ? 400 : 201)
  })
})
