import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRealServer,
  seedMember,
  seedMessage,
  type RealServerContext,
} from './test-helpers'
import { setupTestEnvironment } from './services/test-control'
import type { RestPageHold } from './services/rest-page-holds'
import type { RestFault } from './services/rest-faults'
import type { RestObservationSnapshot } from './services/rest-observations'

const TOKEN = 'Bot history-hold'
const OTHER_TOKEN = 'Bot history-other'
const BOT = '111111111111111111'
const OTHER_BOT = '999999999999999999'
const GUILD = '222222222222222222'
const OTHER_GUILD = '333333333333333333'
const CHANNEL = '444444444444444444'
const OTHER_CHANNEL = '555555555555555555'
const CURSOR = '100000000000000001'
const HISTORY_PATH = `/channels/${CHANNEL}/messages`
const HEADERS = { Authorization: TOKEN }
const VIEW_CHANNEL = 1n << 10n
const MANAGE_MESSAGES = 1n << 13n
const READ_MESSAGE_HISTORY = 1n << 16n

let server: RealServerContext
let owner: string
let first: string
let second: string

/** Issues real HTTP with a short failure bound, including during teardown. */
function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(server.baseUrl + path, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(2000),
  })
}

/** Completes a request, draining its body, and returns the status. */
async function statusOf(path: string, init?: RequestInit): Promise<number> {
  // Native requests use the history bot unless the caller says otherwise.
  const response = await request(path, init ?? { headers: HEADERS })
  await response.arrayBuffer()
  return response.status
}

/** Posts a hold selector to the control endpoint. */
function postHold(body: unknown): Promise<Response> {
  return request('/_test/rest-page-holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Arms a message history page and returns its public status. */
async function arm(
  selector: Record<string, unknown> = {}
): Promise<RestPageHold> {
  const response = await postHold({
    path: HISTORY_PATH,
    timeout_ms: 10_000,
    ...selector,
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<RestPageHold>
}

/** Reads server-side arrival evidence. */
async function status(id: string): Promise<RestPageHold> {
  const response = await request(`/_test/rest-page-holds/${id}`)
  expect(response.status).toBe(200)
  return response.json() as Promise<RestPageHold>
}

/** Waits on explicit server state with a bounded polling assertion. */
async function waitFor(
  id: string,
  state: RestPageHold['state']
): Promise<void> {
  await expect
    .poll(async () => {
      const current = await status(id)
      return current.state
    })
    .toBe(state)
}

/** Releases a hold through the control endpoint. */
async function release(id: string): Promise<void> {
  expect(
    await statusOf(`/_test/rest-page-holds/${id}/release`, { method: 'POST' })
  ).toBe(200)
}

/** Reads the message IDs of a completed history response. */
async function messageIds(response: Response): Promise<string[]> {
  const messages = (await response.json()) as { id: string }[]
  return messages.map((message) => message.id)
}

/** Arms a one-attempt fault on a history page. */
async function armFault(
  query: Record<string, unknown> = {}
): Promise<RestFault> {
  const response = await request('/_test/rest-faults', {
    method: 'POST',
    body: JSON.stringify({
      method: 'GET',
      path: HISTORY_PATH,
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

/** Reads a fault's attempt counters. */
async function faultCounters(id: string): Promise<unknown> {
  const response = await request(`/_test/rest-faults/${id}`)
  expect(response.status).toBe(200)
  const { remaining, consumed } = (await response.json()) as RestFault
  return { remaining, consumed }
}

/** Replaces the channel's `@everyone` overwrite while a request is held. */
function denyEveryone(permissions: bigint): void {
  server.db
    .prepare(
      `INSERT INTO channel_overwrites (channel_id, id, type, allow, deny)
       VALUES (?, ?, 0, '0', ?)`
    )
    .run(CHANNEL, GUILD, String(permissions))
}

beforeEach(async () => {
  server = await createRealServer()
  const fixtureGuild = setupTestEnvironment(server.db, {
    token: 'Bot owner-fixture',
    guilds: [{ name: 'Owner fixture' }],
  }).guilds[0].id
  owner = seedMember(server.db, fixtureGuild)
  setupTestEnvironment(server.db, {
    token: TOKEN,
    user: { id: BOT },
    guilds: [
      {
        id: GUILD,
        name: 'History guild',
        owner_id: owner,
        channels: [
          { id: CHANNEL, name: 'general' },
          { id: OTHER_CHANNEL, name: 'random' },
        ],
      },
    ],
  })
  setupTestEnvironment(server.db, {
    token: OTHER_TOKEN,
    user: { id: OTHER_BOT },
    guilds: [{ id: OTHER_GUILD, name: 'Other guild' }],
  })
  first = seedMessage(server.db, CHANNEL, BOT, TOKEN, 'first')
  second = seedMessage(server.db, CHANNEL, BOT, TOKEN, 'second')
})

afterEach(async () => {
  await server.close()
})

describe('message history page holds over actual HTTP', () => {
  it.each(['/api/v10', '/api', ''])(
    'holds one history read under %s and reads current messages on release',
    async (prefix) => {
      const path = `${prefix}${HISTORY_PATH}?limit=100`
      const hold = await arm()
      expect(hold).toMatchObject({
        path: HISTORY_PATH,
        guild_id: GUILD,
        before: null,
        after: null,
        around: null,
        state: 'armed',
        arrived: 0,
        arrived_at: null,
      })
      let settled = false
      const pending = request(path, { headers: HEADERS }).then((response) => {
        settled = true
        return response
      })
      await waitFor(hold.id, 'holding')
      expect(await status(hold.id)).toMatchObject({
        arrived: 1,
        arrived_at: expect.any(String),
        finished_at: null,
      })

      for (const other of [
        `${prefix}/channels/${OTHER_CHANNEL}/messages`,
        `${prefix}${HISTORY_PATH}/${first}`,
        `${prefix}${HISTORY_PATH}?before=${CURSOR}`,
        `${prefix}/channels/${CHANNEL}`,
        '/_mock/health',
      ])
        expect(await statusOf(other)).toBe(200)
      // The claim is one-shot: a second read of the same page is not held.
      expect(await statusOf(path)).toBe(200)
      expect(await statusOf(path, {})).toBe(401)
      expect(settled).toBe(false)

      const added = seedMessage(server.db, CHANNEL, BOT, TOKEN, 'while held')
      server.db.prepare('DELETE FROM messages WHERE id = ?').run(first)
      await release(hold.id)
      const response = await pending
      expect(response.status).toBe(200)
      expect(await messageIds(response)).toEqual([added, second])
      expect(await status(hold.id)).toMatchObject({
        state: 'released',
        arrived: 1,
        finished_at: expect.any(String),
      })
    }
  )

  it('shows whether a second read arrives while the first one is deleting', async () => {
    const secondRead = await arm()
    // The first command read its history before the hold was claimed: the
    // control selects the next matching request, which is the second command's.
    expect(secondRead.arrived_at).toBeNull()
    const pending = request(`${HISTORY_PATH}?limit=100`, { headers: HEADERS })
    await waitFor(secondRead.id, 'holding')
    // Bulk deletion needs MANAGE_MESSAGES, here as a member overwrite.
    server.db
      .prepare(
        `INSERT INTO channel_overwrites (channel_id, id, type, allow, deny)
         VALUES (?, ?, 1, ?, '0')`
      )
      .run(CHANNEL, BOT, String(MANAGE_MESSAGES))
    expect(
      await statusOf(`${HISTORY_PATH}/bulk-delete`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [first, second] }),
      })
    ).toBe(204)
    await release(secondRead.id)
    expect(await messageIds(await pending)).toEqual([])
  })

  it('never claims a hold for another bot or for other methods', async () => {
    const hold = await arm()
    const foreign = await statusOf(HISTORY_PATH, {
      headers: { Authorization: OTHER_TOKEN },
    })
    expect(foreign).toBe(403)
    expect(
      await statusOf(HISTORY_PATH, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'new' }),
      })
    ).toBe(200)
    expect(await status(hold.id)).toMatchObject({ state: 'armed', arrived: 0 })
  })

  it.each(['before', 'after', 'around'])(
    'matches only the exact %s cursor',
    async (name) => {
      const hold = await arm({ [name]: CURSOR })
      expect(hold).toMatchObject({
        before: null,
        after: null,
        around: null,
        [name]: CURSOR,
      })
      const others = ['before', 'after', 'around'].filter((o) => o !== name)
      for (const query of [
        '',
        '?limit=1',
        `?${name}=100000000000000002`,
        `?${name}=0${CURSOR}`,
        `?${name}=`,
        `?${others[0]}=${CURSOR}`,
        `?${others[1]}=${CURSOR}`,
        `?${name}=${CURSOR}&${others[0]}=${CURSOR}`,
        `?${name}=${CURSOR}&${others[1]}=`,
        `?${name}=${CURSOR}&${name}=${CURSOR}`,
      ])
        expect(await statusOf(HISTORY_PATH + query)).toBe(200)
      expect(await status(hold.id)).toMatchObject({ arrived: 0 })
      const pending = statusOf(
        `${HISTORY_PATH}?limit=7&unrelated=x&${name}=${CURSOR}`
      )
      await waitFor(hold.id, 'holding')
      await release(hold.id)
      expect(await pending).toBe(200)
    }
  )

  it('requires every cursor to be absent for a null selector', async () => {
    const hold = await arm({ before: null, after: null, around: null })
    for (const query of [
      `?before=${CURSOR}`,
      '?after=0',
      `?around=${CURSOR}`,
      '?before=',
    ])
      expect(await statusOf(HISTORY_PATH + query)).toBe(200)
    expect(await status(hold.id)).toMatchObject({ arrived: 0 })
    const pending = statusOf(`${HISTORY_PATH}?limit=1`)
    await waitFor(hold.id, 'holding')
    await release(hold.id)
    expect(await pending).toBe(200)
  })

  it.each([
    { before: CURSOR, after: CURSOR },
    { before: CURSOR, around: CURSOR },
    { after: CURSOR, around: CURSOR },
    { before: CURSOR, after: CURSOR, around: CURSOR },
    { before: 123 },
    { after: '' },
    { around: 'abc' },
    { before: '1'.repeat(21) },
    { before: '18446744073709551616' },
    { after: '99999999999999999999' },
    { around: '01' },
    { around: false },
    { path: `${HISTORY_PATH}?before=${CURSOR}` },
    { path: `/api/v10${HISTORY_PATH}` },
    { path: `${HISTORY_PATH}/${CURSOR}` },
    { path: `${HISTORY_PATH}/` },
    { path: `${HISTORY_PATH}/pins` },
    { path: '/channels/abc/messages' },
    { timeout_ms: 0 },
    { timeout_ms: 60_001 },
    { timeout_ms: undefined },
  ])('rejects the message selector %j with 400', async (selector) => {
    expect(
      await statusOf('/_test/rest-page-holds', {
        method: 'POST',
        body: JSON.stringify({
          path: HISTORY_PATH,
          timeout_ms: 1000,
          ...selector,
        }),
      })
    ).toBe(400)
  })

  it.each([
    { path: `/guilds/${GUILD}/members`, after: null, around: CURSOR },
    { path: `/guilds/${GUILD}/members`, after: null, before: CURSOR },
    { path: `/guilds/${GUILD}/bans`, after: null, around: CURSOR },
    { path: `/guilds/${GUILD}/bans`, before: CURSOR },
    { path: `/guilds/${GUILD}/members` },
  ])('keeps the guild page selector rules for %j', async (selector) => {
    const response = await postHold({ timeout_ms: 1000, ...selector })
    expect(response.status).toBe(400)
  })

  it.each(['0', '18446744073709551615'])(
    'accepts the Snowflake range boundary %s as a cursor',
    async (before) => {
      expect(await arm({ before })).toMatchObject({ before })
    }
  )

  it('keeps accepting any decimal string as a guild page cursor', async () => {
    for (const after of ['007', '99999999999999999999']) {
      const response = await postHold({
        path: `/guilds/${GUILD}/members`,
        after,
        timeout_ms: 1000,
      })
      expect(response.status).toBe(201)
    }
  })

  it.each(['members', 'bans'])(
    'ignores an around query parameter on guild %s pages',
    async (route) => {
      const path = `/guilds/${GUILD}/${route}`
      const hold = await arm({ path, after: null, around: null })
      const pending = statusOf(`${path}?around=${CURSOR}`)
      await waitFor(hold.id, 'holding')
      await release(hold.id)
      expect(await pending).toBeLessThan(500)
    }
  )

  it('returns 404 for an unknown channel', async () => {
    const response = await postHold({
      path: '/channels/123456789012345678/messages',
      timeout_ms: 1000,
    })
    expect(response.status).toBe(404)
  })

  it.each([1, 3])('returns 400 for a DM channel of type %i', async (type) => {
    server.db
      .prepare('INSERT INTO channels (id, type) VALUES (?, ?)')
      .run('666666666666666666', type)
    const response = await postHold({
      path: '/channels/666666666666666666/messages',
      timeout_ms: 1000,
    })
    expect(response.status).toBe(400)
  })

  it.each([
    [0, 201],
    [2, 201],
    [5, 201],
    [10, 201],
    [11, 201],
    [12, 201],
    [13, 201],
    [4, 400],
    [14, 400],
    [15, 400],
    [16, 400],
  ])('answers a guild channel of type %i with %i', async (type, expected) => {
    server.db
      .prepare('UPDATE channels SET type = ? WHERE id = ?')
      .run(type, CHANNEL)
    const response = await postHold({ path: HISTORY_PATH, timeout_ms: 1000 })
    expect(response.status).toBe(expected)
  })

  it('rejects only an active identical selector with 409', async () => {
    const hold = await arm()
    const duplicate = await postHold({
      path: HISTORY_PATH,
      before: null,
      around: null,
      timeout_ms: 1000,
    })
    expect(duplicate.status).toBe(409)
    for (const selector of [
      { before: CURSOR },
      { after: CURSOR },
      { around: CURSOR },
      { path: `/channels/${OTHER_CHANNEL}/messages` },
    ]) {
      await arm(selector)
      const again = await postHold({
        path: HISTORY_PATH,
        timeout_ms: 1000,
        ...selector,
      })
      expect(again.status).toBe(409)
    }
    const pending = statusOf(HISTORY_PATH)
    await waitFor(hold.id, 'holding')
    const whileHolding = await postHold({
      path: HISTORY_PATH,
      timeout_ms: 1000,
    })
    expect(whileHolding.status).toBe(409)
    await release(hold.id)
    expect(await pending).toBe(200)
    const next = await arm()
    expect(next.id).not.toBe(hold.id)
  })

  it.each([
    [VIEW_CHANNEL, 403, { code: 50_001, message: 'Missing Access' }],
    [READ_MESSAGE_HISTORY, 200, []],
  ])(
    'checks permissions when the released request runs (denied %s)',
    async (denied, expectedStatus, expectedBody) => {
      const hold = await arm()
      const pending = request(HISTORY_PATH, { headers: HEADERS })
      await waitFor(hold.id, 'holding')
      denyEveryone(denied)
      await release(hold.id)
      const response = await pending
      expect(response.status).toBe(expectedStatus)
      expect(await response.json()).toEqual(expectedBody)
    }
  )

  it('claims a read the bot may not perform yet and allows it after release', async () => {
    denyEveryone(VIEW_CHANNEL)
    const hold = await arm()
    const pending = request(HISTORY_PATH, { headers: HEADERS })
    await waitFor(hold.id, 'holding')
    server.db
      .prepare('DELETE FROM channel_overwrites WHERE channel_id = ?')
      .run(CHANNEL)
    await release(hold.id)
    expect(await messageIds(await pending)).toEqual([second, first])
  })

  it('expires into the native page and never holds the retry', async () => {
    const hold = await arm({ timeout_ms: 500 })
    expect(await statusOf(HISTORY_PATH)).toBe(200)
    expect(await status(hold.id)).toMatchObject({
      state: 'timed_out',
      arrived: 1,
    })
    expect(await statusOf(HISTORY_PATH)).toBe(200)
  })

  it('disarms on client disconnect', async () => {
    const hold = await arm()
    const controller = new AbortController()
    const rejected = expect(
      request(HISTORY_PATH, { headers: HEADERS, signal: controller.signal })
    ).rejects.toThrow()
    await waitFor(hold.id, 'holding')
    controller.abort()
    await rejected
    await waitFor(hold.id, 'disconnected')
    expect(await statusOf(HISTORY_PATH)).toBe(200)
  })
})

describe('message history page holds with REST faults and observations', () => {
  it('defers a fault on the same page until release', async () => {
    const hold = await arm({ before: CURSOR })
    const fault = await armFault({ before: CURSOR, limit: 100 })
    const url = `${HISTORY_PATH}?before=${CURSOR}&limit=100`
    const pending = request(url, { headers: HEADERS })
    await waitFor(hold.id, 'holding')
    expect(await faultCounters(fault.id)).toEqual({
      remaining: 1,
      consumed: 0,
    })
    await release(hold.id)
    const failed = await pending
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ message: 'Page failed', code: 0 })
    expect(await faultCounters(fault.id)).toEqual({
      remaining: 0,
      consumed: 1,
    })
    expect(await statusOf(url)).toBe(200)
  })

  it('consumes no fault when the held client disconnects', async () => {
    const hold = await arm()
    const fault = await armFault()
    const controller = new AbortController()
    const rejected = expect(
      request(HISTORY_PATH, { headers: HEADERS, signal: controller.signal })
    ).rejects.toThrow()
    await waitFor(hold.id, 'holding')
    controller.abort()
    await rejected
    await waitFor(hold.id, 'disconnected')
    expect(await faultCounters(fault.id)).toEqual({
      remaining: 1,
      consumed: 0,
    })
    expect(await statusOf(HISTORY_PATH)).toBe(500)
  })

  /** Arms an observation of the history read. */
  async function observe(): Promise<string> {
    const response = await request('/_test/rest-observations', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', path: HISTORY_PATH }),
    })
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }
    return id
  }

  /** Reads an observation snapshot. */
  async function observation(id: string): Promise<RestObservationSnapshot> {
    const response = await request(`/_test/rest-observations/${id}`)
    return response.json() as Promise<RestObservationSnapshot>
  }

  it.each([
    { fault: false, expected: 200 },
    { fault: true, expected: 500 },
  ])(
    'observes a held read once, with its final status $expected',
    async ({ fault, expected }) => {
      const observed = await observe()
      if (fault) await armFault()
      const hold = await arm()
      const pending = statusOf(HISTORY_PATH)
      await waitFor(hold.id, 'holding')
      expect(await observation(observed)).toMatchObject({
        count: 0,
        requests: [],
      })
      const late = await observe()
      await release(hold.id)
      expect(await pending).toBe(expected)
      // An observation created after arrival does not count the held request.
      expect(await observation(late)).toMatchObject({ count: 0 })
      expect(await observation(observed)).toMatchObject({
        count: 1,
        requests: [{ method: 'GET', path: HISTORY_PATH, status: expected }],
      })
    }
  )

  it('observes a disconnected held read once, as the undelivered 204', async () => {
    const observed = await observe()
    const hold = await arm()
    const controller = new AbortController()
    const rejected = expect(
      request(HISTORY_PATH, { headers: HEADERS, signal: controller.signal })
    ).rejects.toThrow()
    await waitFor(hold.id, 'holding')
    controller.abort()
    await rejected
    await expect
      .poll(async () => {
        const snapshot = await observation(observed)
        return snapshot.requests.map((entry) => entry.status)
      })
      .toEqual([204])
  })
})

describe('message history page hold cleanup', () => {
  const otherPath = `/channels/${OTHER_CHANNEL}/messages`

  it('removes the holds of a deleted channel and unblocks its request', async () => {
    const held = await arm()
    const armed = await arm({ before: CURSOR })
    const survivor = await arm({ path: otherPath })
    const pending = request(HISTORY_PATH, { headers: HEADERS })
    await waitFor(held.id, 'holding')
    expect(
      await statusOf(`/api/v10/channels/${CHANNEL}`, {
        method: 'DELETE',
        headers: HEADERS,
      })
    ).toBe(200)
    const response = await pending
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      message: 'Unknown Channel',
      code: 10_003,
    })
    for (const id of [held.id, armed.id])
      expect(await statusOf(`/_test/rest-page-holds/${id}`, {})).toBe(404)
    expect(await status(survivor.id)).toMatchObject({ state: 'armed' })
  })

  it('removes the holds of a channel that setup moves to another guild', async () => {
    const hold = await arm()
    const pending = statusOf(HISTORY_PATH)
    await waitFor(hold.id, 'holding')
    setupTestEnvironment(server.db, {
      token: 'Bot channel-mover',
      guilds: [
        {
          id: '777777777777777777',
          name: 'New home',
          channels: [{ id: CHANNEL, name: 'general' }],
        },
      ],
    })
    // The released read now meets a channel of a guild the bot is not in.
    expect(await pending).toBe(403)
    expect(await statusOf(`/_test/rest-page-holds/${hold.id}`, {})).toBe(404)
  })

  it.each([HISTORY_PATH, `/guilds/${GUILD}/members`])(
    'unblocks %s as soon as another setup takes the guild over',
    async (path) => {
      const hold = await arm({ path, after: null })
      const pending = statusOf(path)
      await waitFor(hold.id, 'holding')
      expect(
        await statusOf('/_test/setup', {
          method: 'POST',
          body: JSON.stringify({
            token: 'Bot takeover',
            guilds: [{ id: GUILD, name: 'Taken over' }],
          }),
        })
      ).toBe(201)
      // No hold control is read first: setup itself must resume the request.
      expect(await pending).toBeLessThan(500)
      expect(await statusOf(`/_test/rest-page-holds/${hold.id}`, {})).toBe(404)
    }
  )

  it.each([HISTORY_PATH, `/guilds/${GUILD}/members`])(
    'refuses a held %s read once its removed setup loses the guild',
    async (path) => {
      const hold = await arm({ path, after: null })
      const pending = request(path, { headers: HEADERS })
      await waitFor(hold.id, 'holding')
      expect(
        await statusOf(`/users/@me/guilds/${GUILD}`, {
          method: 'DELETE',
          headers: HEADERS,
        })
      ).toBe(204)
      // The takeover restores the same bot user's membership.
      expect(
        await statusOf('/_test/setup', {
          method: 'POST',
          body: JSON.stringify({
            token: 'Bot takeover',
            user: { id: BOT },
            guilds: [{ id: GUILD, name: 'Taken over' }],
          }),
        })
      ).toBe(201)
      for (const response of [
        await pending,
        await request(path, { headers: HEADERS }),
      ]) {
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({
          message: 'Missing Access',
          code: 50_001,
        })
      }
    }
  )

  it.each([
    ['token reset', 200],
    ['global reset', 200],
    ['guild deletion', 404],
    ['setup deletion', 404],
  ])('removes message holds on %s', async (action, expected) => {
    const hold = await arm()
    const pending = statusOf(HISTORY_PATH)
    await waitFor(hold.id, 'holding')
    switch (action) {
      case 'token reset': {
        await statusOf('/_test/reset', {
          method: 'POST',
          body: JSON.stringify({ token: TOKEN }),
        })
        break
      }
      case 'global reset': {
        await statusOf('/_test/reset', { method: 'POST' })
        break
      }
      case 'guild deletion': {
        // Only the owner may delete a guild.
        server.db
          .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
          .run(BOT, GUILD)
        expect(
          await statusOf(`/guilds/${GUILD}`, {
            method: 'DELETE',
            headers: HEADERS,
          })
        ).toBe(204)
        break
      }
      default: {
        await statusOf(`/_test/setup/${encodeURIComponent(TOKEN)}`, {
          method: 'DELETE',
        })
      }
    }
    expect(await pending).toBe(expected)
    expect(await statusOf(`/_test/rest-page-holds/${hold.id}`, {})).toBe(404)
  })
})
