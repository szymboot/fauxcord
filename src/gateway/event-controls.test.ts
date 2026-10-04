import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
  seedMessage,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'
import { sendDispatch } from './dispatch'

/** Wire client and all frames observed on its one connection. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Capture observation returned by the test API. */
interface Observation {
  id: string
  skipped: number
  operations: number
  events_captured: {
    id: string
    envelope: GatewayPayload<Record<string, unknown>>
    state: string
    deliveries: number
    last_sequence: number | null
  }[]
}

const BOT_ID = '111111111111111111'
const TOKEN = 'Bot controls'
const ROOT = '/_test/gateway-event-controls'

describe('scoped Gateway event controls over real WebSockets', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let guild: string
  let channel: string
  let client: Client
  const clients: Client[] = []

  /** Sends JSON to either a test control or an authenticated native route. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token = TOKEN
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Uses a protocol round trip as a frame fence, without fixed sleeps. */
  async function fence(target = client): Promise<void> {
    const ack = new Promise<void>((resolve) => {
      /** Resolves after all preceding frames on this socket have arrived. */
      const listener = (raw: Buffer): void => {
        if ((JSON.parse(raw.toString()) as GatewayPayload<unknown>).op !== 11) {
          return
        }

        target.ws.off('message', listener)
        resolve()
      }
      target.ws.on('message', listener)
    })
    target.ws.send(JSON.stringify({ op: 1, d: null }))
    await ack
  }

  /** Connects and waits for READY before any capture can be armed. */
  async function connect(
    token = TOKEN,
    intents = GatewayIntentBits.GuildMessages |
      GatewayIntentBits.GuildMessageReactions
  ): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token, intents } }))
    await ready
    const result = {
      ws,
      frames,
      sessionId: String(
        frames.find((frame) => frame.t === 'READY')?.d?.session_id
      ),
    }
    clients.push(result)
    return result
  }

  /** Arms an exact-scope control and returns its ID. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT_ID,
      session_id: client.sessionId,
      events: [
        'MESSAGE_DELETE',
        'MESSAGE_REACTION_ADD',
        'MESSAGE_REACTION_REMOVE',
      ],
      hold: true,
      ...extra,
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  /** Reads a snapshot of captured native envelopes. */
  async function observe(id: string): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }

  /** Seeds a retained message without generating an unrelated dispatch. */
  function message(): string {
    return seedMessage(server.db, channel, BOT_ID, TOKEN)
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN)
    guild = seedGuild(server.db, TOKEN)
    channel = seedChannel(server.db, guild)
    client = await connect()
  })
  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  it('holds native deletion, releases and duplicates it without repeating mutations', async () => {
    const id = await arm()
    const mid = message()
    const result0 = await request(
      `/api/v10/channels/${channel}/messages/${mid}`,
      'DELETE'
    )
    expect(result0.status).toBe(204)
    const result1 = await request(
      `/channels/${channel}/messages/${mid}`,
      'DELETE'
    )
    expect(result1.status).toBe(404)
    await fence()
    expect(
      client.frames.filter((frame) => frame.t === 'MESSAGE_DELETE')
    ).toHaveLength(0)
    const result2 = await observe(id)
    const captured = result2.events_captured
    expect(captured).toHaveLength(1)
    expect(
      server.sessionManager
        .get(client.sessionId)
        ?.replayBuffer.some((entry) => entry.event.t === 'MESSAGE_DELETE')
    ).toBe(false)
    const eventIds = captured.map((event) => event.id)
    const result3 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: eventIds,
    })
    expect(result3.status).toBe(409)
    const result4 = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: eventIds,
    })
    expect(result4.status).toBe(200)
    const result5 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: eventIds,
    })
    expect(result5.status).toBe(200)
    await fence()
    const deletes = client.frames.filter(
      (frame) => frame.t === 'MESSAGE_DELETE'
    )
    expect(deletes).toHaveLength(2)
    expect(deletes[0]?.d).toEqual({
      id: mid,
      channel_id: channel,
      guild_id: guild,
    })
    expect(deletes[1]?.d).toEqual(deletes[0]?.d)
    expect(deletes[1]?.s).toBe((deletes[0]?.s ?? 0) + 1)
    expect(
      server.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(mid)
    ).toBeUndefined()
    const result6 = await observe(id)
    expect(result6.events_captured[0]).toMatchObject({
      state: 'released',
      deliveries: 2,
    })
    const result7 = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: eventIds,
    })
    expect(result7.status).toBe(409)
  })

  it('reorders captured reactions after message removal with monotonic new sequences', async () => {
    const id = await arm()
    const mid = message()
    const path = `/channels/${channel}/messages/${mid}`
    const result8 = await request(`${path}/reactions/x/@me`, 'PUT')
    expect(result8.status).toBe(204)
    const result9 = await request(`${path}/reactions/x/@me`, 'DELETE')
    expect(result9.status).toBe(204)
    const result10 = await request(path, 'DELETE')
    expect(result10.status).toBe(204)
    const result11 = await observe(id)
    const events = result11.events_captured
    expect(events.map((event) => event.envelope.t)).toEqual([
      'MESSAGE_REACTION_ADD',
      'MESSAGE_REACTION_REMOVE',
      'MESSAGE_DELETE',
    ])
    const result12 = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: events.toReversed().map((event) => event.id),
    })
    expect(result12.status).toBe(200)
    await fence()
    const delivered = client.frames.filter((frame) =>
      frame.t?.startsWith('MESSAGE_')
    )
    expect(delivered.map((frame) => frame.t)).toEqual([
      'MESSAGE_DELETE',
      'MESSAGE_REACTION_REMOVE',
      'MESSAGE_REACTION_ADD',
    ])
    expect(delivered.map((frame) => frame.s)).toEqual([5, 6, 7])
    expect(delivered[2]?.d).toMatchObject({
      message_id: mid,
      emoji: { id: null, name: 'x' },
    })
    expect(server.db.prepare('SELECT 1 FROM reactions').get()).toBeUndefined()
  })

  it('requires opt-in for original envelopes and keeps them out of resume history', async () => {
    const id = await arm({ hold: false })
    const mid = message()
    await request(`/channels/${channel}/messages/${mid}`, 'DELETE')
    const result13 = await observe(id)
    const event = result13.events_captured[0]
    const result14 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: [event.id],
      sequence: 'original',
    })
    expect(result14.status).toBe(409)
    await request(`${ROOT}/${id}`, 'DELETE')
    const originalId = await arm({ allow_original_sequence: true })
    const mid2 = message()
    await request(`/channels/${channel}/messages/${mid2}`, 'DELETE')
    const result15 = await observe(originalId)
    const original = result15.events_captured[0]
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    const seq = session.seq
    const history = session.replayBuffer.length
    await request(`${ROOT}/${originalId}/release`, 'POST', {
      event_ids: [original.id],
      sequence: 'original',
    })
    await request(`${ROOT}/${originalId}/replay`, 'POST', {
      event_ids: [original.id],
      sequence: 'original',
    })
    await fence()
    const frames = client.frames.filter((frame) => frame.d?.id === mid2)
    expect(frames).toEqual([original.envelope, original.envelope])
    expect(session.seq).toBe(seq)
    expect(session.replayBuffer).toHaveLength(history)
  })

  it('leaves other guilds, bots, sessions and intent-filtered traffic unaffected', async () => {
    const otherSession = await connect()
    seedBot(server.db, 'Bot other', '444444444444444444')
    const otherGuild = seedGuild(server.db, 'Bot other', '555555555555555555')
    const otherChannel = seedChannel(
      server.db,
      otherGuild,
      '666666666666666666'
    )
    const otherBot = await connect('Bot other')
    const noIntent = await connect(TOKEN, 0)
    const id = await arm()
    const mid = message()
    await request(`/channels/${channel}/messages/${mid}`, 'DELETE')
    const unrelated = seedMessage(
      server.db,
      otherChannel,
      '444444444444444444',
      'Bot other'
    )
    await request(
      `/channels/${otherChannel}/messages/${unrelated}`,
      'DELETE',
      undefined,
      'Bot other'
    )
    await request(`/channels/${channel}/messages`, 'POST', {
      content: 'ordinary',
    })
    for (const target of clients) await fence(target)
    const result16 = await observe(id)
    expect(result16.events_captured).toHaveLength(1)
    expect(client.frames.some((frame) => frame.d?.id === unrelated)).toBe(true)
    expect(client.frames.some((frame) => frame.t === 'MESSAGE_CREATE')).toBe(
      true
    )
    for (const target of [otherSession, otherBot])
      expect(target.frames.some((frame) => frame.d?.id === mid)).toBe(true)
    expect(
      noIntent.frames.some((frame) => frame.t?.startsWith('MESSAGE_'))
    ).toBe(false)
    const result17 = await request(ROOT, 'POST', {
      guild_id: otherGuild,
      bot_id: BOT_ID,
      session_id: client.sessionId,
      events: ['MESSAGE_DELETE'],
    })
    expect(result17.status).toBe(404)
  })

  it('validates malformed policies, scopes and atomic release selections', async () => {
    const policy = {
      guild_id: guild,
      bot_id: BOT_ID,
      session_id: client.sessionId,
      events: ['MESSAGE_DELETE'],
    }
    for (const extra of [
      { guild_id: '*' },
      { bot_id: 1 },
      { session_id: 'invalid' },
      { events: ['READY'] },
      { events: [] },
      { events: ['MESSAGE_DELETE', 'MESSAGE_DELETE'] },
      { limit: 101 },
      { ttl_ms: 60_001 },
      { hold: null },
    ]) {
      const result18 = await request(ROOT, 'POST', { ...policy, ...extra })
      expect(result18.status).toBe(400)
    }
    const result19 = await request(ROOT, 'POST', {
      ...policy,
      session_id: 'a'.repeat(32),
    })
    expect(result19.status).toBe(404)
    const id = await arm()
    const result20 = await request(ROOT, 'POST', policy)
    expect(result20.status).toBe(409)
    const mid = message()
    await request(`/channels/${channel}/messages/${mid}`, 'DELETE')
    const result21 = await observe(id)
    const event = result21.events_captured[0]
    const result22 = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: [event.id, 'a'.repeat(36)],
    })
    expect(result22.status).toBe(404)
    const result23 = await observe(id)
    expect(result23.events_captured[0]?.state).toBe('held')
    for (const body of [
      { event_ids: [] },
      { event_ids: [event.id, event.id] },
      { event_ids: [event.id], sequence: 'bad' },
      null,
    ]) {
      const result24 = await request(`${ROOT}/${id}/release`, 'POST', body)
      expect(result24.status).toBe(400)
    }
  })

  it('bounds capture count and delivery operations, failing open on overflow', async () => {
    const id = await arm({ limit: 1, hold: false })
    for (let i = 0; i < 2; i += 1)
      await request(`/channels/${channel}/messages/${message()}`, 'DELETE')
    await fence()
    expect(
      client.frames.filter((frame) => frame.t === 'MESSAGE_DELETE')
    ).toHaveLength(2)
    const observation = await observe(id)
    expect(observation.skipped).toBe(1)
    const eventIds = [observation.events_captured[0].id]
    for (let i = 0; i < 100; i += 1) {
      const result25 = await request(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: eventIds,
      })
      expect(result25.status).toBe(200)
    }
    const result26 = await request(`${ROOT}/${id}/replay`, 'POST', {
      event_ids: eventIds,
    })
    expect(result26.status).toBe(429)
    const result27 = await observe(id)
    expect(result27.operations).toBe(100)
  })

  it('supports native bulk/clear dispatches when provided and bounds payload memory', async () => {
    const id = await arm({
      events: [
        'MESSAGE_DELETE_BULK',
        'MESSAGE_REACTION_REMOVE_ALL',
        'MESSAGE_REACTION_REMOVE_EMOJI',
      ],
    })
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    // No bulk/clear producer is implemented by this feature; exercise the shared native dispatch boundary.
    sendDispatch(server.sessionManager, session, 'MESSAGE_DELETE_BULK', {
      guild_id: guild,
      channel_id: channel,
      ids: ['123', '456'],
    })
    sendDispatch(
      server.sessionManager,
      session,
      'MESSAGE_REACTION_REMOVE_ALL',
      { guild_id: guild, channel_id: channel, message_id: '123' }
    )
    sendDispatch(
      server.sessionManager,
      session,
      'MESSAGE_REACTION_REMOVE_EMOJI',
      {
        guild_id: guild,
        channel_id: channel,
        message_id: '123',
        emoji: { name: 'x', id: null },
      }
    )
    sendDispatch(server.sessionManager, session, 'MESSAGE_DELETE_BULK', {
      guild_id: guild,
      ids: ['x'.repeat(262_144)],
    })
    const result28 = await observe(id)
    expect(result28.events_captured).toHaveLength(3)
    const result29 = await observe(id)
    expect(result29.skipped).toBe(1)
    const result30 = await observe(id)
    await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: result30.events_captured.map((event) => event.id),
    })
    await fence()
    expect(
      client.frames.find(
        (frame) =>
          frame.t === 'MESSAGE_DELETE_BULK' &&
          Array.isArray(frame.d?.ids) &&
          frame.d.ids.length === 2
      )?.d?.ids
    ).toEqual(['123', '456'])
  })

  it('cleans up on cancellation, disconnect, replacement, removal and expiry', async () => {
    const canceled = await arm()
    await request(`/channels/${channel}/messages/${message()}`, 'DELETE')
    const result31 = await request(`${ROOT}/${canceled}`, 'DELETE')
    expect(result31.status).toBe(204)
    const result32 = await request(`${ROOT}/${canceled}/release`, 'POST', {
      event_ids: ['a'.repeat(36)],
    })
    expect(result32.status).toBe(404)
    await fence()
    expect(client.frames.some((frame) => frame.t === 'MESSAGE_DELETE')).toBe(
      false
    )
    const expired = await arm({ ttl_ms: 10 })
    await expect
      .poll(async () => {
        const response = await request(`${ROOT}/${expired}`)
        return response.status
      })
      .toBe(404)
    const replaced = await arm()
    client.ws.send(
      JSON.stringify({
        op: 2,
        d: { token: TOKEN, intents: GatewayIntentBits.GuildMessages },
      })
    )
    await once(client.ws, 'message')
    const result34 = await request(`${ROOT}/${replaced}`)
    expect(result34.status).toBe(404)
    client.sessionId = String(
      client.frames.findLast((frame) => frame.t === 'READY')?.d?.session_id
    )
    const removed = await arm()
    server.sessionManager.remove(client.sessionId)
    const result35 = await request(`${ROOT}/${removed}`)
    expect(result35.status).toBe(404)
    client = await connect()
    const disconnected = await arm()
    client.ws.close()
    await once(client.ws, 'close')
    const result36 = await request(`${ROOT}/${disconnected}`)
    expect(result36.status).toBe(404)
  })

  it('clears only the reset setup controls and discards data on setup deletion', async () => {
    const id = await arm()
    seedBot(server.db, 'Bot other', '444444444444444444')
    const otherGuild = seedGuild(server.db, 'Bot other', '555555555555555555')
    const other = await connect('Bot other')
    const response = await request(ROOT, 'POST', {
      guild_id: otherGuild,
      bot_id: '444444444444444444',
      session_id: other.sessionId,
      events: ['MESSAGE_DELETE'],
    })
    const otherId = ((await response.json()) as { id: string }).id
    await request('/_test/reset', 'POST', { token: TOKEN })
    const result37 = await request(`${ROOT}/${id}`)
    expect(result37.status).toBe(404)
    const result38 = await request(`${ROOT}/${otherId}`)
    expect(result38.status).toBe(200)
    const deleted = await arm()
    await request('/_test/setup/Bot%20controls', 'DELETE')
    const result39 = await request(`${ROOT}/${deleted}`)
    expect(result39.status).toBe(404)
    await request('/_test/reset', 'POST', {})
    const result40 = await request(`${ROOT}/${otherId}`)
    expect(result40.status).toBe(404)
  })
  it('bounds total controls and releases capacity and connection listeners on cancellation', async () => {
    const ids: string[] = []
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    const baseline = session.ws.listenerCount('close')
    for (let i = 0; i < 32; i += 1) {
      const scopedGuild = seedGuild(server.db, TOKEN, String(7000 + i))
      ids.push(await arm({ guild_id: scopedGuild, events: ['MESSAGE_DELETE'] }))
    }
    expect(session.ws.listenerCount('close')).toBe(baseline + 1)
    const response = await request(ROOT, 'POST', {
      guild_id: guild,
      bot_id: BOT_ID,
      session_id: client.sessionId,
      events: ['MESSAGE_DELETE'],
    })
    expect(response.status).toBe(429)
    for (const id of ids) await request(`${ROOT}/${id}`, 'DELETE')
    expect(session.ws.listenerCount('close')).toBe(baseline)
    await arm()
  })

  it('does not transfer held captures to a resumed connection', async () => {
    const id = await arm()
    const mid = message()
    await request(`/channels/${channel}/messages/${mid}`, 'DELETE')
    const capture = await observe(id)
    const session = server.sessionManager.get(client.sessionId)
    assert.ok(session)
    const seq = session.seq
    client.ws.close()
    await once(client.ws, 'close')
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const resumed = once(ws, 'message')
    ws.send(
      JSON.stringify({
        op: 6,
        d: { token: TOKEN, session_id: client.sessionId, seq },
      })
    )
    await resumed
    const target = { ws, frames, sessionId: client.sessionId }
    clients.push(target)
    await fence(target)
    expect(frames.some((frame) => frame.t === 'RESUMED')).toBe(true)
    expect(frames.some((frame) => frame.t === 'MESSAGE_DELETE')).toBe(false)
    const stale = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: capture.events_captured.map((event) => event.id),
    })
    expect(stale.status).toBe(404)
  })
  it('binds guild scope to the exact setup token even when bot user IDs are shared', async () => {
    seedBot(server.db, 'Bot alias', BOT_ID)
    const aliasGuild = seedGuild(server.db, 'Bot alias', '777777777777777777')
    const response = await request(ROOT, 'POST', {
      guild_id: aliasGuild,
      bot_id: BOT_ID,
      session_id: client.sessionId,
      events: ['MESSAGE_DELETE'],
    })
    expect(response.status).toBe(404)
    const id = await arm()
    server.db
      .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
      .run('Bot alias', guild)
    const stale = await request(`${ROOT}/${id}`)
    expect(stale.status).toBe(404)
  })

  it('discards all held captures when reset uses an empty token', async () => {
    const id = await arm()
    await request(`/channels/${channel}/messages/${message()}`, 'DELETE')
    const reset = await request('/_test/reset', 'POST', { token: '' })
    expect(reset.status).toBe(204)
    const stale = await request(`${ROOT}/${id}`)
    expect(stale.status).toBe(404)
    await fence()
    expect(client.frames.some((frame) => frame.t === 'MESSAGE_DELETE')).toBe(
      false
    )
  })
  it('preserves controls when setup deletion has an empty or unknown token', async () => {
    const id = await arm()
    for (const path of ['/_test/setup/', '/_test/setup/Bot%20missing']) {
      const response = await request(path, 'DELETE')
      expect(response.status).toBe(404)
      const observation = await request(`${ROOT}/${id}`)
      expect(observation.status).toBe(200)
    }
  })
})
