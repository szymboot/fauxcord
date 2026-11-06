import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
} from '../test-helpers'
import { getInvite } from '../services/invites'
import type { GatewayPayload } from './protocol'
import { gatewayBus } from './bus'

/** Wire client with all dispatches retained for ordered assertions. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

const TOKEN = 'Bot invite-delete-events'
const BOT = '111111111111111111'
const INVITER = '700000000000000001'
const JOINER = '700000000000000002'
const JOINER_2 = '700000000000000003'
const GUILD = '222222222222222222'
const CHANNEL = '333333333333333333'
const INTENTS = GatewayIntentBits.GuildInvites | GatewayIntentBits.GuildMembers

describe('INVITE_DELETE gateway event', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  const clients: Client[] = []
  const extraServers: (typeof server)[] = []

  /** Calls the assembled app through the live HTTP server. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token?: string
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: {
        ...(token !== undefined && { Authorization: token }),
        'Content-Type': 'application/json',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Returns only the response status. */
  async function status(...args: Parameters<typeof request>): Promise<number> {
    const response = await request(...args)
    return response.status
  }

  /** Creates a human invite through the test control and returns its code. */
  async function humanInvite(
    extra: Record<string, unknown> = {}
  ): Promise<string> {
    const response = await request(
      `/_test/channels/${CHANNEL}/invites`,
      'POST',
      { inviter_id: INVITER, ...extra }
    )
    expect(response.status).toBe(201)
    return ((await response.json()) as { code: string }).code
  }

  /** Joins a registered human through an optional invite. */
  async function join(user: string, code?: string): Promise<number> {
    return status(
      `/_test/guilds/${GUILD}/members/${user}`,
      'POST',
      code === undefined ? {} : { invite_code: code }
    )
  }

  /** Fences preceding Gateway frames with an ordered heartbeat ACK. */
  async function drain(client: Client): Promise<Client['frames']> {
    const ack = new Promise<void>((resolve) => {
      /** Resolves on the ordered heartbeat acknowledgement. */
      const listener = (raw: Buffer): void => {
        if ((JSON.parse(raw.toString()) as GatewayPayload<unknown>).op !== 11)
          return
        client.ws.off('message', listener)
        resolve()
      }
      client.ws.on('message', listener)
    })
    client.ws.send(JSON.stringify({ op: 1, d: null }))
    await ack
    return client.frames.splice(0).filter((frame) => frame.op === 0)
  }

  /** Drains preceding dispatches and returns their event names. */
  async function eventTypes(
    client: Client
  ): Promise<(string | null | undefined)[]> {
    const frames = await drain(client)
    return frames.map((frame) => frame.t)
  }

  /** Identifies a session, retaining every frame. */
  async function connect(
    intents = INTENTS,
    token = TOKEN,
    url = server.url
  ): Promise<Client> {
    const ws = new WebSocket(url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token, intents } }))
    await ready
    const client = {
      ws,
      frames,
      sessionId: String(
        frames.find((frame) => frame.t === 'READY')?.d?.session_id
      ),
    }
    clients.push(client)
    await drain(client)
    return client
  }

  /** Registers a non-member human user through the test control. */
  async function registerUser(id: string): Promise<void> {
    expect(
      await status('/_test/users', 'POST', {
        id,
        username: `user-${id}`,
        discriminator: '1234',
      })
    ).toBe(201)
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    seedGuild(server.db, TOKEN, GUILD)
    seedChannel(server.db, GUILD, CHANNEL)
    seedMember(server.db, GUILD, INVITER)
    await registerUser(JOINER)
    await registerUser(JOINER_2)
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const client of clients.splice(0)) client.ws.terminate()
    for (const extra of extraServers.splice(0)) await extra.close()
    await server.close()
  })

  describe('DELETE /invites/:code', () => {
    it.each(['', '/api', '/api/v10'])(
      'publishes exactly channel_id, guild_id and code through %j',
      async (prefix) => {
        const code = await humanInvite()
        const client = await connect()
        const sequence = server.sessionManager.get(client.sessionId)?.seq
        expect(
          await status(`${prefix}/invites/${code}`, 'DELETE', {}, TOKEN)
        ).toBe(200)
        expect(getInvite(server.db, code)).toBeNull()
        expect(await drain(client)).toEqual([
          {
            op: 0,
            t: 'INVITE_DELETE',
            s: Number(sequence) + 1,
            d: { channel_id: CHANNEL, guild_id: GUILD, code },
          },
        ])
      }
    )

    it('publishes only after the deletion commits', async () => {
      const code = await humanInvite()
      const observed: { inTransaction: boolean; inviteExists: boolean }[] = []
      /** Reads SQLite at publication time, before the route returns. */
      const observe = (): void => {
        observed.push({
          inTransaction: server.db.inTransaction,
          inviteExists: getInvite(server.db, code) !== null,
        })
      }
      gatewayBus.on('invite.delete', observe)
      try {
        expect(await status(`/invites/${code}`, 'DELETE', {}, TOKEN)).toBe(200)
      } finally {
        gatewayBus.off('invite.delete', observe)
      }
      expect(observed).toEqual([{ inTransaction: false, inviteExists: false }])
    })

    it('publishes nothing for an unknown or already deleted invite', async () => {
      const code = await humanInvite()
      const client = await connect()
      expect(await status(`/invites/${code}`, 'DELETE', {}, TOKEN)).toBe(200)
      expect(await eventTypes(client)).toEqual(['INVITE_DELETE'])
      for (const target of [code, 'neverexisted']) {
        const response = await request(
          `/invites/${target}`,
          'DELETE',
          {},
          TOKEN
        )
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({
          message: 'Unknown Invite',
          code: 10_006,
        })
      }
      expect(await drain(client)).toEqual([])
    })

    it('publishes for an invite created through the native route', async () => {
      const created = await request(
        `/channels/${CHANNEL}/invites`,
        'POST',
        {},
        TOKEN
      )
      expect(created.status).toBe(200)
      const { code } = (await created.json()) as { code: string }
      const client = await connect()
      expect(await status(`/invites/${code}`, 'DELETE', {}, TOKEN)).toBe(200)
      const frames = await drain(client)
      expect(frames.map((frame) => frame.d)).toEqual([
        { channel_id: CHANNEL, guild_id: GUILD, code },
      ])
    })
  })

  describe('max_uses exhaustion', () => {
    it('publishes INVITE_DELETE immediately before the single GUILD_MEMBER_ADD', async () => {
      const code = await humanInvite({ max_uses: 1 })
      const client = await connect()
      const sequence = Number(server.sessionManager.get(client.sessionId)?.seq)
      expect(await join(JOINER, code)).toBe(201)
      const frames = await drain(client)
      expect(frames.map((frame) => frame.t)).toEqual([
        'INVITE_DELETE',
        'GUILD_MEMBER_ADD',
      ])
      expect(frames.map((frame) => frame.s)).toEqual([
        sequence + 1,
        sequence + 2,
      ])
      expect(frames[0].d).toEqual({
        channel_id: CHANNEL,
        guild_id: GUILD,
        code,
      })
      expect(frames[1].d).toMatchObject({
        guild_id: GUILD,
        user: { id: JOINER },
      })
      expect(getInvite(server.db, code)).toBeNull()
    })

    it('publishes after the join commits, with the invite already gone', async () => {
      const code = await humanInvite({ max_uses: 1 })
      const order: string[] = []
      const observed: { inTransaction: boolean; inviteExists: boolean }[] = []
      /** Records INVITE_DELETE publication state. */
      const onInvite = (): void => {
        order.push('invite')
        observed.push({
          inTransaction: server.db.inTransaction,
          inviteExists: getInvite(server.db, code) !== null,
        })
      }
      /** Records GUILD_MEMBER_ADD publication. */
      const onMember = (): void => {
        order.push('member')
      }
      gatewayBus.on('invite.delete', onInvite)
      gatewayBus.on('guild.member.add', onMember)
      try {
        expect(await join(JOINER, code)).toBe(201)
      } finally {
        gatewayBus.off('invite.delete', onInvite)
        gatewayBus.off('guild.member.add', onMember)
      }
      expect(order).toEqual(['invite', 'member'])
      expect(observed).toEqual([{ inTransaction: false, inviteExists: false }])
    })

    it.each([
      ['an explicit true', { delete_event_on_exhaustion: true }],
      ['an omitted field', {}],
      ['a null field', { delete_event_on_exhaustion: null }],
    ])('emits with %s', async (_name, extra) => {
      const code = await humanInvite({ max_uses: 1, ...extra })
      const client = await connect()
      expect(await join(JOINER, code)).toBe(201)
      expect(await eventTypes(client)).toEqual([
        'INVITE_DELETE',
        'GUILD_MEMBER_ADD',
      ])
    })

    it('keeps the deletion silent with delete_event_on_exhaustion: false', async () => {
      const code = await humanInvite({
        max_uses: 1,
        delete_event_on_exhaustion: false,
      })
      const client = await connect()
      expect(await join(JOINER, code)).toBe(201)
      expect(getInvite(server.db, code)).toBeNull()
      expect(await eventTypes(client)).toEqual(['GUILD_MEMBER_ADD'])
    })

    it('still emits for an invite created through the production route', async () => {
      const created = await request(
        `/channels/${CHANNEL}/invites`,
        'POST',
        { max_uses: 1, delete_event_on_exhaustion: false },
        TOKEN
      )
      const { code } = (await created.json()) as { code: string }
      const client = await connect()
      expect(await join(JOINER, code)).toBe(201)
      expect(await eventTypes(client)).toEqual([
        'INVITE_DELETE',
        'GUILD_MEMBER_ADD',
      ])
    })

    it('emits nothing extra for a non-exhausting join', async () => {
      const code = await humanInvite({ max_uses: 2 })
      const client = await connect()
      expect(await join(JOINER, code)).toBe(201)
      expect(getInvite(server.db, code)?.uses).toBe(1)
      expect(await eventTypes(client)).toEqual(['GUILD_MEMBER_ADD'])
      // The join that finally exhausts it emits.
      expect(await join(JOINER_2, code)).toBe(201)
      expect(await eventTypes(client)).toEqual([
        'INVITE_DELETE',
        'GUILD_MEMBER_ADD',
      ])
    })

    it('emits nothing for an unlimited invite or a join without invite_code', async () => {
      const code = await humanInvite({ max_uses: 0 })
      const client = await connect()
      expect(await join(JOINER, code)).toBe(201)
      expect(await join(JOINER_2)).toBe(201)
      expect(await eventTypes(client)).toEqual([
        'GUILD_MEMBER_ADD',
        'GUILD_MEMBER_ADD',
      ])
      expect(getInvite(server.db, code)?.uses).toBe(1)
    })

    it('emits nothing for a failed join (unknown, exhausted or already a member)', async () => {
      const code = await humanInvite({ max_uses: 1 })
      expect(await join(JOINER, code)).toBe(201)
      const client = await connect()
      // Exhausted (deleted) and unknown invites are rejected with 404.
      expect(await join(JOINER_2, code)).toBe(404)
      expect(await join(JOINER_2, 'neverexisted')).toBe(404)
      // An already-member 409 never consumes a use or deletes the invite.
      const other = await humanInvite({ max_uses: 1 })
      expect(await join(JOINER, other)).toBe(409)
      expect(getInvite(server.db, other)?.uses).toBe(0)
      expect(await drain(client)).toEqual([])
    })
  })

  describe('interaction with GUILD_MEMBER_ADD captures', () => {
    const ROOT = '/_test/gateway-event-controls'

    /** Arms a capture on the given events for one session. */
    function arm(client: Client, events: string[]): Promise<Response> {
      return request(ROOT, 'POST', {
        guild_id: GUILD,
        bot_id: BOT,
        session_id: client.sessionId,
        events,
        hold: true,
      })
    }

    it('delivers INVITE_DELETE immediately while the join member add is held', async () => {
      const code = await humanInvite({ max_uses: 1 })
      const client = await connect()
      const armed = await arm(client, ['GUILD_MEMBER_ADD'])
      expect(armed.status).toBe(201)
      const { id } = (await armed.json()) as { id: string }
      expect(await join(JOINER, code)).toBe(201)
      expect(await eventTypes(client)).toEqual(['INVITE_DELETE'])

      const observed = await request(`${ROOT}/${id}`)
      const held = (await observed.json()) as {
        events_captured: { id: string; state: string }[]
      }
      expect(held.events_captured.map((event) => event.state)).toEqual(['held'])
      const released = await request(`${ROOT}/${id}/release`, 'POST', {
        event_ids: [held.events_captured[0].id],
      })
      expect(released.status).toBe(200)
      expect(await eventTypes(client)).toEqual(['GUILD_MEMBER_ADD'])
    })

    it('does not support capturing INVITE_DELETE', async () => {
      const client = await connect()
      const response = await arm(client, ['INVITE_DELETE'])
      expect(response.status).toBe(400)
    })
  })

  describe('expiry', () => {
    it('emits no event and does not remove an expired invite', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2031-05-05T10:00:00.000Z'))
      const code = await humanInvite({ max_age: 10, max_uses: 1 })
      const client = await connect()
      vi.setSystemTime(new Date('2031-05-05T10:00:11.000Z'))
      expect(await join(JOINER, code)).toBe(404)
      expect(getInvite(server.db, code)).not.toBeNull()
      expect(await drain(client)).toEqual([])
    })
  })

  describe('delivery scope', () => {
    it('requires the Guild Invites intent', async () => {
      const code = await humanInvite({ max_uses: 1 })
      const withoutIntent = await connect(GatewayIntentBits.GuildMembers)
      const onlyInvites = await connect(GatewayIntentBits.GuildInvites)
      const both = await connect()
      expect(await join(JOINER, code)).toBe(201)
      expect(await eventTypes(withoutIntent)).toEqual(['GUILD_MEMBER_ADD'])
      expect(await eventTypes(onlyInvites)).toEqual(['INVITE_DELETE'])
      expect(await eventTypes(both)).toEqual([
        'INVITE_DELETE',
        'GUILD_MEMBER_ADD',
      ])

      const second = await humanInvite()
      expect(await status(`/invites/${second}`, 'DELETE', {}, TOKEN)).toBe(200)
      expect(await eventTypes(withoutIntent)).toEqual([])
      expect(await eventTypes(onlyInvites)).toEqual(['INVITE_DELETE'])
    })

    it('does not reach other bots, aliases, apps or guilds', async () => {
      const code = await humanInvite({ max_uses: 1 })
      const owner = await connect()
      seedBot(server.db, 'Bot foreign', '121212121212121212')
      seedGuild(server.db, 'Bot foreign', '222222222222222299')
      seedBot(server.db, 'Bot alias', BOT)
      const other = await createTestGatewayServer()
      extraServers.push(other)
      seedBot(other.db, TOKEN, BOT)
      seedGuild(other.db, TOKEN, GUILD)
      const excluded = [
        await connect(INTENTS, 'Bot foreign'),
        await connect(INTENTS, 'Bot alias'),
        await connect(INTENTS, TOKEN, other.url),
      ]
      expect(await join(JOINER, code)).toBe(201)
      expect(await eventTypes(owner)).toEqual([
        'INVITE_DELETE',
        'GUILD_MEMBER_ADD',
      ])
      for (const client of excluded) {
        const types = await eventTypes(client)
        expect(types).not.toContain('INVITE_DELETE')
      }
    })

    it('delivers nothing while the owning bot is detached from the guild', async () => {
      const code = await humanInvite()
      const client = await connect()
      server.db
        .prepare('UPDATE guilds SET bot_present = 0 WHERE id = ?')
        .run(GUILD)
      const sequence = server.sessionManager.get(client.sessionId)?.seq
      expect(await status(`/invites/${code}`, 'DELETE', {}, TOKEN)).toBe(200)
      expect(getInvite(server.db, code)).toBeNull()
      expect(await drain(client)).toEqual([])
      expect(server.sessionManager.get(client.sessionId)?.seq).toBe(sequence)
    })
  })

  describe('delete_event_on_exhaustion validation', () => {
    it.each(['yes', 1, 0, {}, []])('rejects %j', async (value) => {
      const response = await request(
        `/_test/channels/${CHANNEL}/invites`,
        'POST',
        { inviter_id: INVITER, delete_event_on_exhaustion: value }
      )
      expect(response.status).toBe(400)
      const body = (await response.json()) as {
        code: number
        errors: Record<string, unknown>
      }
      expect(body.code).toBe(50_035)
      expect(Object.keys(body.errors)).toEqual(['delete_event_on_exhaustion'])
      expect(
        server.db.prepare('SELECT COUNT(*) AS n FROM invites').get()
      ).toEqual({ n: 0 })
    })
  })
})
