import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
} from '../test-helpers'
import type { GatewayPayload } from './protocol'
import { gatewayBus } from './bus'
import { inviteScopedCode } from './event-controls'

/** Wire client retaining every observed frame. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}
/** Public delivery observation, independent from application execution. */
interface Delivery {
  id: string
  sequence: number
  source: string
  transport: string
  application: string
  ack_token?: string
}
/** One captured event as exposed by the public observation. */
interface Captured {
  id: string
  envelope: GatewayPayload<Record<string, unknown>>
  state: string
  deliveries: number
  last_sequence: number | null
  delivery_records: Delivery[]
}
/** Public capture contract exercised over HTTP. */
interface Observation {
  id: string
  invite_code?: string
  skipped: number
  operations: number
  events_captured: Captured[]
}

const TOKEN = 'Bot invite-event-controls'
const BOT = '111111111111111111'
const GUILD = '222222222222222222'
const CHANNEL = '333333333333333333'
const INVITER = '700000000000000001'
const JOINER = '700000000000000002'
const JOINER_2 = '700000000000000003'
const BYSTANDER = '700000000000000004'
const ROOT = '/_test/gateway-event-controls'
const INVITE_DELETE = 'INVITE_DELETE'
const AUDIT = 'GUILD_AUDIT_LOG_ENTRY_CREATE'
const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildInvites |
  GatewayIntentBits.GuildModeration

describe('native INVITE_DELETE and GUILD_AUDIT_LOG_ENTRY_CREATE capture controls', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  let client: Client
  const clients: Client[] = []

  /** Performs a real HTTP request against the assembled server. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    origin = base
  ): Promise<Response> {
    return fetch(origin + path, {
      method,
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }
  /** Fences socket frames only; this is never an application completion signal. */
  async function fence(target = client): Promise<void> {
    const ack = new Promise<void>((resolve) => {
      /** Waits for this socket's heartbeat response. */
      const listener = (raw: Buffer): void => {
        if ((JSON.parse(raw.toString()) as GatewayPayload<unknown>).op !== 11)
          return
        target.ws.off('message', listener)
        resolve()
      }
      target.ws.on('message', listener)
    })
    target.ws.send(JSON.stringify({ op: 1, d: null }))
    await ack
  }
  /** Opens a wire client against any assembled server and identifies. */
  async function connectTo(
    url: string,
    intents = INTENTS,
    track = true
  ): Promise<Client> {
    const ws = new WebSocket(url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents } }))
    await ready
    const target = {
      ws,
      frames,
      sessionId: String(
        frames.find((frame) => frame.t === 'READY')?.d?.session_id
      ),
    }
    if (track) clients.push(target)
    await fence(target)
    return target
  }
  /** Opens a wire client on the main server. */
  function connect(intents = INTENTS): Promise<Client> {
    return connectTo(server.url, intents)
  }
  /** Sends a capture creation request for the main client by default. */
  function armRequest(extra: Record<string, unknown>): Promise<Response> {
    return request(ROOT, 'POST', {
      guild_id: GUILD,
      bot_id: BOT,
      session_id: client.sessionId,
      events: [INVITE_DELETE],
      hold: true,
      ...extra,
    })
  }
  /** Arms one capture and returns its ID. */
  async function arm(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await armRequest(extra)
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }
  /** Attempts to arm a capture and returns only the HTTP status. */
  async function armStatus(extra: Record<string, unknown>): Promise<number> {
    const response = await armRequest(extra)
    return response.status
  }
  /** Reads a copy of the public observation. */
  async function observe(id: string, origin = base): Promise<Observation> {
    const response = await request(`${ROOT}/${id}`, 'GET', undefined, origin)
    expect(response.status).toBe(200)
    return (await response.json()) as Observation
  }
  /** Returns only the status of a request. */
  async function statusOf(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<number> {
    const response = await request(path, method, body)
    return response.status
  }
  /** Reads only the captured events of a capture. */
  async function captured(id: string, origin = base): Promise<Captured[]> {
    const observation = await observe(id, origin)
    return observation.events_captured
  }
  /** Releases the given captured events in the requested order. */
  async function release(id: string, ...events: Captured[]): Promise<void> {
    const response = await request(`${ROOT}/${id}/release`, 'POST', {
      event_ids: events.map((event) => event.id),
    })
    expect(response.status).toBe(200)
  }
  /** Creates a human invite for the seeded channel and returns its code. */
  async function invite(
    extra: Record<string, unknown> = {},
    origin = base
  ): Promise<string> {
    const response = await request(
      `/_test/channels/${CHANNEL}/invites`,
      'POST',
      { inviter_id: INVITER, ...extra },
      origin
    )
    expect(response.status).toBe(201)
    return ((await response.json()) as { code: string }).code
  }
  /** Deletes an invite through the production route and returns the status. */
  async function deleteInvite(code: string, origin = base): Promise<number> {
    const response = await request(`/invites/${code}`, 'DELETE', {}, origin)
    return response.status
  }
  /** Joins a registered human, optionally through an invite. */
  async function join(user: string, code?: string): Promise<void> {
    const response = await request(
      `/_test/guilds/${GUILD}/members/${user}`,
      'POST',
      code === undefined ? {} : { invite_code: code }
    )
    expect(response.status).toBe(201)
  }
  /** Registers a human user without joining it to the guild. */
  async function register(id: string, origin = base): Promise<void> {
    const response = await request(
      '/_test/users',
      'POST',
      { id, username: `user-${id}` },
      origin
    )
    expect(response.status).toBe(201)
  }
  /** Names the dispatches a client observed, in wire order. */
  function dispatches(target = client): (string | null | undefined)[] {
    return target.frames.filter((frame) => frame.op === 0).map((f) => f.t)
  }
  /** Selects dispatches of one type from the wire. */
  function frames(type: string, target = client): Client['frames'] {
    return target.frames.filter((frame) => frame.t === type)
  }
  /** Returns the `code` change of an audit entry payload, if any. */
  function auditCode(data: Record<string, unknown> | null): unknown {
    return inviteScopedCode(AUDIT, data)
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws:', 'http:')
    seedBot(server.db, TOKEN, BOT)
    seedGuild(server.db, TOKEN, GUILD)
    seedChannel(server.db, GUILD, CHANNEL)
    seedMember(server.db, GUILD, INVITER)
    for (const user of [JOINER, JOINER_2, BYSTANDER]) await register(user)
    client = await connect()
  })
  afterEach(async () => {
    for (const target of clients.splice(0)) target.ws.terminate()
    for (const session of server.sessionManager.getAll())
      server.sessionManager.remove(session.sessionId)
    await server.close()
  })

  describe('INVITE_DELETE', () => {
    it('holds a deletion until another event is processed, then releases it', async () => {
      const code = await invite()
      const id = await arm({ invite_code: code, allow_original_sequence: true })
      client.frames.length = 0

      expect(await deleteInvite(code)).toBe(200)
      // The deletion committed and is readable, but the bot was told nothing.
      expect(await statusOf(`/invites/${code}`)).toBe(404)
      await fence()
      expect(frames(INVITE_DELETE)).toHaveLength(0)

      const held = await observe(id)
      expect(held.invite_code).toBe(code)
      expect(held.skipped).toBe(0)
      expect(held.events_captured).toHaveLength(1)
      const [event] = held.events_captured
      expect(event.state).toBe('held')
      expect(event.delivery_records).toEqual([])
      expect(event.envelope.t).toBe(INVITE_DELETE)
      expect(event.envelope.d).toEqual({
        channel_id: CHANNEL,
        guild_id: GUILD,
        code,
      })

      // Another event reached the bot first (the audit event is not armed).
      expect(dispatches()).toEqual([AUDIT])
      const auditSequence = Number(frames(AUDIT)[0].s)

      await release(id, event)
      await fence()
      expect(dispatches()).toEqual([AUDIT, INVITE_DELETE])
      expect(frames(INVITE_DELETE)[0].d).toEqual(event.envelope.d)
      expect(Number(frames(INVITE_DELETE)[0].s)).toBeGreaterThan(auditSequence)

      const after = await observe(id)
      expect(after.events_captured[0].state).toBe('released')
      expect(after.events_captured[0].deliveries).toBe(1)
      expect(after.events_captured[0].delivery_records).toMatchObject([
        { source: 'release', transport: 'sent', application: 'not_requested' },
      ])
      // Releasing neither recreates nor re-deletes the invite.
      expect(await statusOf(`/invites/${code}`)).toBe(404)
    })

    it('replays a released snapshot with new and original sequences and honors acknowledgements', async () => {
      const code = await invite()
      const id = await arm({
        invite_code: code,
        hold: false,
        application_ack: true,
        allow_original_sequence: true,
      })
      expect(await deleteInvite(code)).toBe(200)
      await fence()
      expect(frames(INVITE_DELETE)).toHaveLength(1)
      const observed = await observe(id)
      const [event] = observed.events_captured
      expect(event.state).toBe('delivered')
      expect(event.deliveries).toBe(1)
      expect(event.delivery_records).toMatchObject([
        { source: 'native', transport: 'sent', application: 'pending' },
      ])

      for (const sequence of ['new', 'original']) {
        const replayed = await request(`${ROOT}/${id}/replay`, 'POST', {
          event_ids: [event.id],
          sequence,
        })
        expect(replayed.status).toBe(200)
      }
      await fence()
      expect(frames(INVITE_DELETE).map((frame) => frame.d)).toEqual([
        event.envelope.d,
        event.envelope.d,
        event.envelope.d,
      ])
      expect(Number(frames(INVITE_DELETE)[1].s)).toBeGreaterThan(
        Number(frames(INVITE_DELETE)[0].s)
      )
      expect(frames(INVITE_DELETE)[2].s).toBe(event.envelope.s)

      const replayed = await observe(id)
      expect(
        replayed.events_captured[0].delivery_records.map(
          (entry) => entry.source
        )
      ).toEqual(['native', 'replay', 'replay'])
      const delivery = replayed.events_captured[0].delivery_records[0]
      const acknowledged = await request(`${ROOT}/${id}/ack`, 'POST', {
        delivery_id: delivery.id,
        ack_token: delivery.ack_token,
      })
      expect(acknowledged.status).toBe(200)
      const final = await observe(id)
      expect(
        final.events_captured[0].delivery_records.map(
          (entry) => entry.application
        )
      ).toEqual(['acknowledged', 'pending', 'pending'])
    })

    it('refuses to replay a held deletion', async () => {
      const code = await invite()
      const id = await arm({ invite_code: code })
      await deleteInvite(code)
      const [event] = await captured(id)
      const replay = await request(`${ROOT}/${id}/replay`, 'POST', {
        event_ids: [event.id],
      })
      expect(replay.status).toBe(409)
    })

    it('keeps other sessions of the bot on their ordinary dispatch', async () => {
      const peer = await connect()
      const code = await invite()
      const id = await arm({ invite_code: code })
      await deleteInvite(code)
      await fence(peer)
      await fence()
      expect(frames(INVITE_DELETE, peer)).toHaveLength(1)
      expect(frames(INVITE_DELETE)).toHaveLength(0)
      const [event] = await captured(id)
      await release(id, event)
      await fence()
      expect(frames(INVITE_DELETE)).toHaveLength(1)
      expect(frames(INVITE_DELETE, peer)).toHaveLength(1)
    })

    it('captures every invite of the guild without invite_code, up to the limit', async () => {
      const first = await invite()
      const second = await invite()
      const third = await invite()
      const id = await arm({ limit: 2 })
      for (const code of [first, second, third]) await deleteInvite(code)
      await fence()
      const captured = await observe(id)
      expect(
        captured.events_captured.map((event) => event.envelope.d.code)
      ).toEqual([first, second])
      expect(captured.skipped).toBe(1)
      // The over-limit deletion passes through at once.
      expect(frames(INVITE_DELETE).map((frame) => frame.d?.code)).toEqual([
        third,
      ])
    })

    it('captures nothing for an unknown or already deleted invite', async () => {
      const code = await invite()
      await deleteInvite(code)
      const id = await arm()
      client.frames.length = 0
      expect(await deleteInvite(code)).toBe(404)
      expect(await deleteInvite('doesnotexist')).toBe(404)
      await fence()
      expect(await captured(id)).toEqual([])
      expect(dispatches()).not.toContain(INVITE_DELETE)
    })
  })

  describe('GUILD_AUDIT_LOG_ENTRY_CREATE', () => {
    it('holds, releases and replays the audit entry of an invite deletion', async () => {
      const code = await invite({ max_uses: 3 })
      const id = await arm({
        events: [AUDIT],
        invite_code: code,
        allow_original_sequence: true,
      })
      client.frames.length = 0

      expect(await deleteInvite(code)).toBe(200)
      await fence()
      // INVITE_DELETE is not armed, so it is delivered at once; the entry is held.
      expect(dispatches()).toEqual([INVITE_DELETE])

      // The entry is already readable through the audit log REST endpoint.
      const log = await request(`/api/v10/guilds/${GUILD}/audit-logs`)
      const page = (await log.json()) as {
        audit_log_entries: { id: string; action_type: number }[]
      }
      expect(page.audit_log_entries).toHaveLength(1)

      const held = await observe(id)
      expect(held.invite_code).toBe(code)
      expect(held.events_captured).toHaveLength(1)
      const [event] = held.events_captured
      expect(event.state).toBe('held')
      expect(event.envelope.t).toBe(AUDIT)
      expect(event.envelope.d).toMatchObject({
        id: page.audit_log_entries[0].id,
        action_type: 42,
        user_id: BOT,
        guild_id: GUILD,
      })
      expect(auditCode(event.envelope.d)).toBe(code)

      await release(id, event)
      await fence()
      expect(dispatches()).toEqual([INVITE_DELETE, AUDIT])
      expect(frames(AUDIT)[0].d).toEqual(event.envelope.d)

      for (const sequence of ['new', 'original']) {
        const replayed = await request(`${ROOT}/${id}/replay`, 'POST', {
          event_ids: [event.id],
          sequence,
        })
        expect(replayed.status).toBe(200)
      }
      await fence()
      expect(frames(AUDIT)).toHaveLength(3)
      expect(frames(AUDIT)[2].s).toBe(event.envelope.s)
      const after = await observe(id)
      expect(
        after.events_captured[0].delivery_records.map((entry) => entry.source)
      ).toEqual(['release', 'replay', 'replay'])
    })

    it('captures the audit entry of every invite deletion without invite_code', async () => {
      const first = await invite()
      const second = await invite()
      const id = await arm({ events: [AUDIT] })
      await deleteInvite(first)
      await deleteInvite(second)
      const captured = await observe(id)
      expect(
        captured.events_captured.map((event) => auditCode(event.envelope.d))
      ).toEqual([first, second])
    })

    it('matches only action 42 entries that carry a code change', () => {
      const ids = (code: string): { key: string; old_value: string }[] => [
        { key: 'code', old_value: code },
      ]
      expect(
        inviteScopedCode(AUDIT, { action_type: 42, changes: ids('a') })
      ).toBe('a')
      expect(
        inviteScopedCode(AUDIT, { action_type: 22, changes: ids('a') })
      ).toBeUndefined()
      expect(
        inviteScopedCode(AUDIT, {
          action_type: 42,
          changes: [{ key: 'uses', old_value: 1 }],
        })
      ).toBeUndefined()
      expect(inviteScopedCode(AUDIT, { action_type: 42 })).toBeUndefined()
      expect(inviteScopedCode(AUDIT, null)).toBeUndefined()
      expect(inviteScopedCode(INVITE_DELETE, { code: 'b' })).toBe('b')
      expect(inviteScopedCode('GUILD_BAN_ADD', { code: 'b' })).toBeUndefined()
    })

    it('does not match other audit entries with invite_code, but captures them without it', async () => {
      const scoped = await arm({ events: [AUDIT], invite_code: 'abc12345' })
      const unscoped = await armStatus({ events: [AUDIT] })
      // An unscoped control overlaps the scoped one for the same event type.
      expect(unscoped).toBe(409)
      const scope = { db: server.db, botId: BOT, token: TOKEN }
      gatewayBus.emit('guild.audit.log.entry.create', {
        guildId: GUILD,
        entry: {
          id: '999999999999999999',
          action_type: 22,
          user_id: BOT,
          target_id: JOINER,
          changes: [{ key: 'code', old_value: 'abc12345' }],
        } as never,
        scope,
      })
      gatewayBus.emit('guild.audit.log.entry.create', {
        guildId: GUILD,
        entry: {
          id: '999999999999999998',
          action_type: 42,
          user_id: BOT,
          target_id: null,
          changes: [{ key: 'code', old_value: 'abc12345' }],
        } as never,
        scope,
      })
      await fence()
      const captured = await observe(scoped)
      expect(captured.events_captured.map((e) => e.envelope.d.id)).toEqual([
        '999999999999999998',
      ])
      // The other action's entry is delivered at once and spends no budget.
      expect(frames(AUDIT).map((frame) => frame.d?.id)).toEqual([
        '999999999999999999',
      ])
      expect(captured.skipped).toBe(0)
    })
  })

  describe('invite_code selector', () => {
    it('holds only the selected invite and delivers other invites at once', async () => {
      const wanted = await invite()
      const other = await invite()
      const id = await arm({
        events: [INVITE_DELETE, AUDIT],
        invite_code: wanted,
      })
      client.frames.length = 0

      await deleteInvite(other)
      await fence()
      // Another invite's events are not held and spend no capture budget.
      expect(dispatches()).toEqual([INVITE_DELETE, AUDIT])
      expect(frames(INVITE_DELETE)[0].d?.code).toBe(other)
      const untouched = await observe(id)
      expect(untouched.events_captured).toEqual([])
      expect(untouched.skipped).toBe(0)

      client.frames.length = 0
      await deleteInvite(wanted)
      await fence()
      expect(dispatches()).toEqual([])
      const held = await observe(id)
      expect(held.events_captured.map((event) => event.envelope.t)).toEqual([
        INVITE_DELETE,
        AUDIT,
      ])
      expect(held.events_captured[0].envelope.d.code).toBe(wanted)
      expect(auditCode(held.events_captured[1].envelope.d)).toBe(wanted)
      // Both belong to one control, so the native order is preserved on release.
      expect(Number(held.events_captured[0].envelope.s)).toBeLessThan(
        Number(held.events_captured[1].envelope.s)
      )
      await release(id, ...held.events_captured)
      await fence()
      expect(dispatches()).toEqual([INVITE_DELETE, AUDIT])
    })

    it('releases an invite deletion and its audit entry in the requested order', async () => {
      const code = await invite()
      const id = await arm({
        events: [INVITE_DELETE, AUDIT],
        invite_code: code,
      })
      await deleteInvite(code)
      const held = await observe(id)
      await release(id, ...held.events_captured.toReversed())
      await fence()
      expect(dispatches().slice(-2)).toEqual([AUDIT, INVITE_DELETE])
    })

    it('arms for an invite that does not exist, was deleted or is created later', async () => {
      const deleted = await invite()
      await deleteInvite(deleted)
      expect(await armStatus({ invite_code: deleted })).toBe(201)
      expect(await armStatus({ invite_code: 'neverexisted' })).toBe(201)
      expect(
        await armStatus({ events: [AUDIT], invite_code: 'neverexisted' })
      ).toBe(201)
      // An invite created after arming can still be armed and held by its code.
      const created = await invite()
      const id = await arm({ invite_code: created })
      await deleteInvite(created)
      expect(await captured(id)).toHaveLength(1)
    })

    it('returns invite_code from inspection and includes it in the ownership policy', async () => {
      const key = 'invite-event-key-0001'
      const create = (inviteCode: string): Promise<Response> =>
        armRequest({ ownership_key: key, invite_code: inviteCode })
      const createStatus = async (inviteCode: string): Promise<number> => {
        const response = await create(inviteCode)
        return response.status
      }
      const first = await create('KeyedCode1')
      expect(first.status).toBe(201)
      expect(await first.json()).toMatchObject({ invite_code: 'KeyedCode1' })
      const retry = await create('KeyedCode1')
      expect(retry.status).toBe(201)
      expect(await retry.json()).toMatchObject({ invite_code: 'KeyedCode1' })
      expect(await createStatus('KeyedCode2')).toBe(409)
      const byKey = await request(
        `${ROOT}/by-key/${key}?bot_id=${BOT}&guild_id=${GUILD}&session_id=${client.sessionId}`
      )
      expect(byKey.status).toBe(200)
      expect(await byKey.json()).toMatchObject({ invite_code: 'KeyedCode1' })
    })

    it('applies the selector overlap rules', async () => {
      await arm({ invite_code: 'aaaa1111' })
      // Different codes coexist; the same code or an all-invite control conflict.
      await arm({ invite_code: 'bbbb2222' })
      expect(await armStatus({ invite_code: 'aaaa1111' })).toBe(409)
      expect(await armStatus({})).toBe(409)
      // Events that are not shared never overlap.
      expect(
        await armStatus({ events: [AUDIT], invite_code: 'aaaa1111' })
      ).toBe(201)
      expect(await armStatus({ events: [AUDIT] })).toBe(409)
      expect(await armStatus({ events: ['GUILD_MEMBER_ADD'] })).toBe(201)
      // A new code never overlaps, but an all-invite control overlaps them all.
      expect(
        await armStatus({ events: [INVITE_DELETE, AUDIT], invite_code: 'cc33' })
      ).toBe(201)
      expect(await armStatus({ events: [INVITE_DELETE, AUDIT] })).toBe(409)
    })

    it('rejects invite_code combined with any other event', async () => {
      const message =
        'invite_code requires every event to be one of INVITE_DELETE, GUILD_AUDIT_LOG_ENTRY_CREATE'
      for (const events of [
        ['MESSAGE_CREATE'],
        ['GUILD_MEMBER_ADD'],
        ['GUILD_ROLE_UPDATE'],
        ['GUILD_BAN_ADD'],
        [INVITE_DELETE, 'GUILD_MEMBER_ADD'],
        [AUDIT, 'MESSAGE_DELETE'],
      ]) {
        const response = await armRequest({ events, invite_code: 'abc12345' })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ message, code: 0 })
      }
      // The other selectors stay reserved for their own events.
      expect(await armStatus({ member_id: JOINER })).toBe(400)
      expect(await armStatus({ role_id: '999999999999999999' })).toBe(400)
      expect(
        await armStatus({ invite_code: 'abc12345', member_id: JOINER })
      ).toBe(400)
      expect(
        await armStatus({
          invite_code: 'abc12345',
          role_id: '999999999999999999',
        })
      ).toBe(400)
    })

    it('rejects malformed invite_code values', async () => {
      for (const inviteCode of [
        '',
        null,
        42,
        ['abc'],
        'has space',
        'slash/code',
        'x'.repeat(65),
      ]) {
        expect(await armStatus({ invite_code: inviteCode })).toBe(400)
      }
    })
  })

  describe('exhausting join', () => {
    it.each([
      ['INVITE_DELETE first', false],
      ['GUILD_MEMBER_ADD first', true],
    ])(
      'holds GUILD_MEMBER_ADD and INVITE_DELETE in two captures and releases them (%s)',
      async (_name, memberFirst) => {
        const code = await invite({ max_uses: 1 })
        const memberCapture = await arm({
          events: ['GUILD_MEMBER_ADD'],
          member_id: JOINER,
        })
        const inviteCapture = await arm({
          events: [INVITE_DELETE],
          invite_code: code,
        })
        client.frames.length = 0

        await join(JOINER, code)
        await fence()
        // Both dispatches of the join are held; the bot hears nothing.
        expect(dispatches()).toEqual([])
        const member = await captured(memberCapture)
        const deleted = await captured(inviteCapture)
        expect(member).toHaveLength(1)
        expect(deleted).toHaveLength(1)
        expect(member[0].state).toBe('held')
        expect(deleted[0].state).toBe('held')
        expect(deleted[0].envelope.d).toEqual({
          channel_id: CHANNEL,
          guild_id: GUILD,
          code,
        })
        // Native order: INVITE_DELETE immediately precedes GUILD_MEMBER_ADD.
        expect(Number(deleted[0].envelope.s)).toBeLessThan(
          Number(member[0].envelope.s)
        )

        const order = memberFirst
          ? [
              [memberCapture, member[0]],
              [inviteCapture, deleted[0]],
            ]
          : [
              [inviteCapture, deleted[0]],
              [memberCapture, member[0]],
            ]
        for (const [id, event] of order) {
          await release(id as string, event as Captured)
          await fence()
        }
        expect(dispatches()).toEqual(
          memberFirst
            ? ['GUILD_MEMBER_ADD', INVITE_DELETE]
            : [INVITE_DELETE, 'GUILD_MEMBER_ADD']
        )
        const sequences = client.frames
          .filter((frame) => frame.op === 0)
          .map((frame) => Number(frame.s))
        expect(sequences[1]).toBeGreaterThan(sequences[0])
      }
    )

    it('holds only the join while INVITE_DELETE of another invite is delivered', async () => {
      const wanted = await invite({ max_uses: 1 })
      const other = await invite({ max_uses: 1 })
      const inviteCapture = await arm({ invite_code: wanted })
      client.frames.length = 0
      await join(JOINER_2, other)
      await fence()
      expect(dispatches()).toEqual([INVITE_DELETE, 'GUILD_MEMBER_ADD'])
      expect(await captured(inviteCapture)).toEqual([])
    })

    it('captures nothing for an exhaustion that the invite switch keeps silent', async () => {
      const silent = await invite({
        max_uses: 1,
        delete_event_on_exhaustion: false,
      })
      const id = await arm({ invite_code: silent })
      client.frames.length = 0
      await join(JOINER, silent)
      await fence()
      expect(await captured(id)).toEqual([])
      expect(dispatches()).toEqual(['GUILD_MEMBER_ADD'])
    })

    it('captures no audit entry for an exhaustion', async () => {
      const code = await invite({ max_uses: 1 })
      const id = await arm({ events: [AUDIT], invite_code: code })
      await join(JOINER, code)
      await fence()
      expect(await captured(id)).toEqual([])
    })
  })

  describe('intents', () => {
    it('captures nothing without the Guild Invites intent', async () => {
      const noInvites = await connect(INTENTS & ~GatewayIntentBits.GuildInvites)
      const code = await invite()
      const id = await arm({
        session_id: noInvites.sessionId,
        invite_code: code,
      })
      await deleteInvite(code)
      await fence(noInvites)
      await fence()
      expect(frames(INVITE_DELETE, noInvites)).toHaveLength(0)
      expect(await captured(id)).toEqual([])
      // The session holding the intent keeps its ordinary dispatch.
      expect(frames(INVITE_DELETE)).toHaveLength(1)
    })

    it('captures nothing without the Guild Moderation intent', async () => {
      const noModeration = await connect(
        INTENTS & ~GatewayIntentBits.GuildModeration
      )
      const code = await invite()
      const inviteId = await arm({
        session_id: noModeration.sessionId,
        events: [INVITE_DELETE, AUDIT],
        invite_code: code,
      })
      await deleteInvite(code)
      await fence(noModeration)
      await fence()
      // Only the intent-holding event is captured; the entry is never seen.
      const captured = await observe(inviteId)
      expect(captured.events_captured.map((e) => e.envelope.t)).toEqual([
        INVITE_DELETE,
      ])
      expect(frames(AUDIT, noModeration)).toHaveLength(0)
      expect(frames(AUDIT)).toHaveLength(1)
    })
  })

  describe('isolation', () => {
    it('ignores other guilds, bots and sessions', async () => {
      const code = await invite()
      const otherGuild = seedGuild(server.db, TOKEN, '444444444444444444')
      const otherChannel = seedChannel(
        server.db,
        otherGuild,
        '555555555555555555'
      )
      seedMember(server.db, otherGuild, INVITER)
      const foreign = await request(
        `/_test/channels/${otherChannel}/invites`,
        'POST',
        { inviter_id: INVITER }
      )
      expect(foreign.status).toBe(201)
      const foreignCode = ((await foreign.json()) as { code: string }).code
      const id = await arm({ events: [INVITE_DELETE, AUDIT] })
      await deleteInvite(foreignCode)
      await fence()
      // The other guild's events are neither captured nor counted.
      expect(await captured(id)).toEqual([])
      expect(frames(INVITE_DELETE).map((frame) => frame.d?.guild_id)).toEqual([
        otherGuild,
      ])
      await deleteInvite(code)
      const guilds = await captured(id)
      expect(guilds.map((e) => e.envelope.d.guild_id)).toEqual([GUILD, GUILD])
    })

    it('ignores events produced by another app database that shares the same IDs and codes', async () => {
      const other = await createTestGatewayServer()
      try {
        const otherBase = other.url.replace('ws:', 'http:')
        seedBot(other.db, TOKEN, BOT)
        seedGuild(other.db, TOKEN, GUILD)
        seedChannel(other.db, GUILD, CHANNEL)
        seedMember(other.db, GUILD, INVITER)
        const otherClient = await connectTo(other.url, INTENTS, false)
        const foreignControl = await request(
          ROOT,
          'POST',
          {
            guild_id: GUILD,
            bot_id: BOT,
            session_id: otherClient.sessionId,
            events: [INVITE_DELETE, AUDIT],
            hold: true,
          },
          otherBase
        )
        expect(foreignControl.status).toBe(201)
        const foreignId = ((await foreignControl.json()) as { id: string }).id

        const code = await invite()
        // Force the other app's invite to use this app's code.
        const foreignInvite = await invite({}, otherBase)
        other.db
          .prepare('UPDATE invites SET code = ? WHERE code = ?')
          .run(code, foreignInvite)

        const id = await arm({
          events: [INVITE_DELETE, AUDIT],
          invite_code: code,
          limit: 1,
        })
        // The other app's deletion is neither captured here nor spends budget.
        expect(await deleteInvite(code, otherBase)).toBe(200)
        const untouched = await observe(id)
        expect(untouched.events_captured).toEqual([])
        expect(untouched.skipped).toBe(0)
        const foreignHeld = await observe(foreignId, otherBase)
        expect(
          foreignHeld.events_captured.map((event) => event.envelope.t)
        ).toEqual([INVITE_DELETE, AUDIT])

        // This app's own deletion is still held and never reaches the other.
        expect(await deleteInvite(code)).toBe(200)
        const own = await captured(id)
        expect(own.map((event) => event.envelope.t)).toEqual([INVITE_DELETE])
        expect(await captured(foreignId, otherBase)).toHaveLength(2)
        otherClient.ws.terminate()
        for (const session of other.sessionManager.getAll())
          other.sessionManager.remove(session.sessionId)
      } finally {
        await other.close()
      }
    })

    it('cancels held events when the capture is deleted', async () => {
      const code = await invite()
      const id = await arm({ invite_code: code })
      await deleteInvite(code)
      expect(await statusOf(`${ROOT}/${id}`, 'DELETE')).toBe(204)
      await fence()
      expect(frames(INVITE_DELETE)).toHaveLength(0)
    })
  })
})
