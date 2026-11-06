import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
} from '../test-helpers'
import type { StoredAuditEntry } from '../services/audit-logs'
import type { GatewayPayload } from './protocol'
import { gatewayBus } from './bus'

/** Wire client with all dispatches retained for ordered assertions. */
interface Client {
  ws: WebSocket
  sessionId: string
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Audit log response body fields used by these tests. */
interface AuditPage {
  audit_log_entries: StoredAuditEntry[]
  users: { id: string }[]
}

const TOKEN = 'Bot invite-delete-audit'
const BOT = '111111111111111111'
const INVITER = '700000000000000001'
const JOINER = '700000000000000002'
const GUILD = '222222222222222222'
const CHANNEL = '333333333333333333'
const CREATE = 'GUILD_AUDIT_LOG_ENTRY_CREATE'
const INTENTS =
  GatewayIntentBits.GuildInvites |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildModeration

describe('INVITE_DELETE audit log entries', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  const clients: Client[] = []
  const extraServers: (typeof server)[] = []

  /** Calls the assembled app through the live HTTP server. */
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: {
        ...(token !== undefined && { Authorization: token }),
        'Content-Type': 'application/json',
        ...headers,
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

  /** Deletes an invite as the test bot, optionally with an audit reason. */
  function deleteInvite(code: string, reason?: string): Promise<Response> {
    return request(
      `/invites/${code}`,
      'DELETE',
      {},
      TOKEN,
      reason === undefined ? {} : { 'X-Audit-Log-Reason': reason }
    )
  }

  /** Deletes an invite as the test bot and returns the response status. */
  async function removeInvite(code: string, reason?: string): Promise<number> {
    const response = await deleteInvite(code, reason)
    return response.status
  }

  /** Reads a guild's audit log page as the test bot. */
  async function auditLog(query = '', guild = GUILD): Promise<AuditPage> {
    const response = await request(
      `/api/v10/guilds/${guild}/audit-logs${query}`,
      'GET',
      undefined,
      TOKEN
    )
    expect(response.status).toBe(200)
    return (await response.json()) as AuditPage
  }

  /** Reads a guild's audit log entries as the test bot. */
  async function entries(
    query = '',
    guild = GUILD
  ): Promise<StoredAuditEntry[]> {
    const page = await auditLog(query, guild)
    return page.audit_log_entries
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

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    seedGuild(server.db, TOKEN, GUILD)
    seedChannel(server.db, GUILD, CHANNEL)
    seedMember(server.db, GUILD, INVITER)
    expect(
      await status('/_test/users', 'POST', {
        id: JOINER,
        username: 'joiner',
        discriminator: '1234',
      })
    ).toBe(201)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    for (const extra of extraServers.splice(0)) await extra.close()
    await server.close()
  })

  describe('entry shape and listing', () => {
    it('records a Discord-shaped INVITE_DELETE entry for DELETE /invites/:code', async () => {
      const code = await humanInvite({
        max_age: 3600,
        max_uses: 5,
        temporary: true,
      })
      expect(await status(`/invites/${code}`, 'DELETE', {}, TOKEN)).toBe(200)
      const page = await auditLog()
      expect(page.audit_log_entries).toHaveLength(1)
      const [entry] = page.audit_log_entries
      expect(entry).toEqual({
        id: expect.stringMatching(/^\d{17,20}$/) as string,
        action_type: 42,
        user_id: BOT,
        target_id: null,
        changes: [
          { key: 'code', old_value: code },
          { key: 'channel_id', old_value: CHANNEL },
          { key: 'inviter_id', old_value: INVITER },
          { key: 'uses', old_value: 0 },
          { key: 'max_uses', old_value: 5 },
          { key: 'max_age', old_value: 3600 },
          { key: 'temporary', old_value: true },
        ],
      })
      expect(entry).not.toHaveProperty('reason')
      expect(page.users.map((user) => user.id)).toEqual([BOT, INVITER])
    })

    it('omits inviter_id for an invite without an inviter and keeps real uses', async () => {
      const created = await request(
        `/channels/${CHANNEL}/invites`,
        'POST',
        {},
        TOKEN
      )
      const { code } = (await created.json()) as { code: string }
      server.db.prepare('UPDATE invites SET inviter_id = NULL').run()
      server.db.prepare('UPDATE invites SET uses = 3').run()
      expect(await status(`/invites/${code}`, 'DELETE', {}, TOKEN)).toBe(200)
      const { audit_log_entries: entries } = await auditLog()
      expect(entries[0]).toMatchObject({
        changes: [
          { key: 'code', old_value: code },
          { key: 'channel_id', old_value: CHANNEL },
          { key: 'uses', old_value: 3 },
          { key: 'max_uses', old_value: 0 },
          { key: 'max_age', old_value: 86_400 },
          { key: 'temporary', old_value: false },
        ],
      })
    })

    it('audits a deletion by an OAuth2 token that has no user as the guild bot', async () => {
      const code = await humanInvite()
      server.db
        .prepare(
          "INSERT INTO oauth2_clients (client_id, client_secret) VALUES ('cc1', 'secret')"
        )
        .run()
      server.db
        .prepare(
          `INSERT INTO oauth2_access_tokens
             (token, client_id, user_id, scope, expires_at)
           VALUES ('cctoken', 'cc1', NULL, 'applications.commands.update', datetime('now', '+1 day'))`
        )
        .run()
      const client = await connect()
      expect(
        await status(`/invites/${code}`, 'DELETE', {}, 'Bearer cctoken')
      ).toBe(200)
      expect(await eventTypes(client)).toEqual(['INVITE_DELETE', CREATE])
      expect(await entries()).toMatchObject([{ action_type: 42, user_id: BOT }])
    })

    it('stores the X-Audit-Log-Reason header as reason', async () => {
      const code = await humanInvite()
      expect(await removeInvite(code, 'cleanup')).toBe(200)
      const { audit_log_entries: entries } = await auditLog()
      expect(entries[0]).toMatchObject({ action_type: 42, reason: 'cleanup' })
    })

    it('lists alongside MESSAGE_DELETE entries and filters them', async () => {
      const target = '700000000000000009'
      await status('/_test/users', 'POST', {
        id: target,
        username: 'author',
        discriminator: '1234',
      })
      const seeded = await request(
        `/_test/guilds/${GUILD}/audit-logs`,
        'POST',
        {
          id: '100',
          action_type: 72,
          user_id: BOT,
          target_id: target,
          options: { channel_id: CHANNEL, count: '1' },
        }
      )
      expect(seeded.status).toBe(201)
      const first = await humanInvite()
      const second = await humanInvite()
      await deleteInvite(first)
      await deleteInvite(second, 'again')

      const all = await auditLog()
      expect(all.audit_log_entries.map((entry) => entry.action_type)).toEqual([
        42, 42, 72,
      ])
      const [newest, older] = all.audit_log_entries
      expect(newest).toMatchObject({ reason: 'again' })
      expect(BigInt(newest.id) > BigInt(older.id)).toBe(true)
      expect(
        all.users.map((user) => user.id).toSorted((a, b) => a.localeCompare(b))
      ).toEqual([BOT, INVITER, target].toSorted((a, b) => a.localeCompare(b)))

      const invites = await auditLog('?action_type=42')
      expect(invites.audit_log_entries.map((entry) => entry.id)).toEqual([
        newest.id,
        older.id,
      ])
      expect(invites.users.map((user) => user.id)).toEqual([BOT, INVITER])
      const messages = await auditLog('?action_type=72')
      expect(messages.audit_log_entries.map((entry) => entry.id)).toEqual([
        '100',
      ])
      expect(await entries('?action_type=42&limit=1')).toEqual([newest])
      expect(await entries(`?action_type=42&before=${newest.id}`)).toEqual([
        older,
      ])
      expect(await entries(`?action_type=42&after=${older.id}`)).toEqual([
        newest,
      ])
      expect(await entries(`?action_type=42&user_id=${BOT}`)).toHaveLength(2)
      expect(await entries(`?action_type=42&user_id=${INVITER}`)).toEqual([])
      expect(await entries('?action_type=22')).toEqual([])
    })

    it('keeps each guild audit log isolated', async () => {
      seedBot(server.db, 'Bot other', '121212121212121212')
      seedGuild(server.db, 'Bot other', '222222222222222299')
      const otherChannel = seedChannel(
        server.db,
        '222222222222222299',
        '333333333333333399'
      )
      const created = await request(
        `/channels/${otherChannel}/invites`,
        'POST',
        {},
        'Bot other'
      )
      const { code } = (await created.json()) as { code: string }
      expect(await status(`/invites/${code}`, 'DELETE', {}, 'Bot other')).toBe(
        200
      )
      expect(await entries()).toEqual([])
      const otherResponse = await request(
        '/api/v10/guilds/222222222222222299/audit-logs',
        'GET',
        undefined,
        'Bot other'
      )
      const other = (await otherResponse.json()) as AuditPage
      expect(other.audit_log_entries).toHaveLength(1)
      expect(other.audit_log_entries[0].user_id).toBe('121212121212121212')
    })
  })

  describe('GUILD_AUDIT_LOG_ENTRY_CREATE', () => {
    it('follows INVITE_DELETE with the entry plus guild_id', async () => {
      const code = await humanInvite({ max_uses: 2 })
      const client = await connect()
      const sequence = Number(server.sessionManager.get(client.sessionId)?.seq)
      expect(await removeInvite(code, 'bye')).toBe(200)
      const frames = await drain(client)
      const [entry] = await entries()
      expect(frames.map((frame) => frame.t)).toEqual(['INVITE_DELETE', CREATE])
      expect(frames.map((frame) => frame.s)).toEqual([
        sequence + 1,
        sequence + 2,
      ])
      expect(frames[0].d).toEqual({
        channel_id: CHANNEL,
        guild_id: GUILD,
        code,
      })
      expect(frames[1].d).toEqual({ ...entry, guild_id: GUILD })
      expect(frames[1].d).toMatchObject({
        action_type: 42,
        user_id: BOT,
        target_id: null,
        reason: 'bye',
      })
    })

    it('publishes after the entry is committed, outside any transaction', async () => {
      const code = await humanInvite()
      const observed: { inTransaction: boolean; entries: number }[] = []
      const order: string[] = []
      /** Records INVITE_DELETE publication. */
      const onInvite = (): void => {
        order.push('invite')
      }
      /** Reads SQLite at audit-event publication time. */
      const onAudit = (): void => {
        order.push('audit')
        observed.push({
          inTransaction: server.db.inTransaction,
          entries: (
            server.db
              .prepare('SELECT COUNT(*) AS n FROM guild_audit_log_entries')
              .get() as { n: number }
          ).n,
        })
      }
      gatewayBus.on('invite.delete', onInvite)
      gatewayBus.on('guild.audit.log.entry.create', onAudit)
      try {
        expect(await removeInvite(code)).toBe(200)
      } finally {
        gatewayBus.off('invite.delete', onInvite)
        gatewayBus.off('guild.audit.log.entry.create', onAudit)
      }
      expect(order).toEqual(['invite', 'audit'])
      expect(observed).toEqual([{ inTransaction: false, entries: 1 }])
    })

    it.each(['', '/api', '/api/v10'])(
      'is created through the %j route prefix',
      async (prefix) => {
        const code = await humanInvite()
        const client = await connect()
        expect(
          await status(`${prefix}/invites/${code}`, 'DELETE', {}, TOKEN)
        ).toBe(200)
        expect(await eventTypes(client)).toEqual(['INVITE_DELETE', CREATE])
      }
    )

    it('requires the Guild Moderation intent', async () => {
      const code = await humanInvite()
      const withoutIntent = await connect(
        GatewayIntentBits.GuildInvites | GatewayIntentBits.GuildMembers
      )
      const moderationOnly = await connect(GatewayIntentBits.GuildModeration)
      expect(await removeInvite(code)).toBe(200)
      expect(await eventTypes(withoutIntent)).toEqual(['INVITE_DELETE'])
      expect(await eventTypes(moderationOnly)).toEqual([CREATE])
    })

    it('does not reach other bots, aliases, apps, guilds or a detached bot', async () => {
      const code = await humanInvite()
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
      expect(await removeInvite(code)).toBe(200)
      expect(await eventTypes(owner)).toEqual(['INVITE_DELETE', CREATE])
      for (const client of excluded) {
        expect(await eventTypes(client)).not.toContain(CREATE)
      }

      const second = await humanInvite()
      server.db
        .prepare('UPDATE guilds SET bot_present = 0 WHERE id = ?')
        .run(GUILD)
      expect(await removeInvite(second)).toBe(200)
      expect(await drain(owner)).toEqual([])
    })
  })

  describe('deletions that are not audited', () => {
    it('records and emits nothing for an unknown or already deleted invite', async () => {
      const code = await humanInvite()
      const client = await connect()
      expect(await removeInvite(code)).toBe(200)
      expect(await eventTypes(client)).toEqual(['INVITE_DELETE', CREATE])
      for (const target of [code, 'neverexisted']) {
        const response = await deleteInvite(target, 'nope')
        expect(response.status).toBe(404)
      }
      expect(await drain(client)).toEqual([])
      expect(await entries()).toHaveLength(1)
    })

    it('records and emits nothing when the last use exhausts the invite', async () => {
      const code = await humanInvite({ max_uses: 1 })
      const client = await connect()
      expect(
        await status(`/_test/guilds/${GUILD}/members/${JOINER}`, 'POST', {
          invite_code: code,
        })
      ).toBe(201)
      expect(await eventTypes(client)).toEqual([
        'INVITE_DELETE',
        'GUILD_MEMBER_ADD',
      ])
      expect(await entries()).toEqual([])
    })

    it('records and emits nothing when an invite has expired', async () => {
      const code = await humanInvite({ max_age: 1, max_uses: 1 })
      server.db
        .prepare("UPDATE invites SET created_at = '2000-01-01 00:00:00'")
        .run()
      const client = await connect()
      expect(
        await status(`/_test/guilds/${GUILD}/members/${JOINER}`, 'POST', {
          invite_code: code,
        })
      ).toBe(404)
      expect(await drain(client)).toEqual([])
      expect(await entries()).toEqual([])
    })

    it('keeps seeded fixtures silent', async () => {
      const client = await connect()
      const seeded = await request(
        `/_test/guilds/${GUILD}/audit-logs`,
        'POST',
        {
          action_type: 72,
          user_id: BOT,
          target_id: INVITER,
          options: { channel_id: CHANNEL, count: '1' },
        }
      )
      expect(seeded.status).toBe(201)
      expect(await drain(client)).toEqual([])
      expect(await entries()).toHaveLength(1)
    })
  })

  describe('cleanup', () => {
    it('clears entries on a global reset without emitting', async () => {
      await deleteInvite(await humanInvite())
      const client = await connect()
      expect(await status('/_test/reset', 'POST', {})).toBe(204)
      expect(await entries()).toEqual([])
      expect(await drain(client)).toEqual([])
    })

    it('clears only the target bot entries on a token reset', async () => {
      seedBot(server.db, 'Bot other', '121212121212121212')
      seedGuild(server.db, 'Bot other', '222222222222222299')
      const otherChannel = seedChannel(
        server.db,
        '222222222222222299',
        '333333333333333399'
      )
      await deleteInvite(await humanInvite())
      const created = await request(
        `/channels/${otherChannel}/invites`,
        'POST',
        {},
        'Bot other'
      )
      const { code } = (await created.json()) as { code: string }
      await request(`/invites/${code}`, 'DELETE', {}, 'Bot other')
      expect(await status('/_test/reset', 'POST', { token: TOKEN })).toBe(204)
      expect(await entries()).toEqual([])
      expect(
        server.db
          .prepare(
            'SELECT guild_id FROM guild_audit_log_entries WHERE action_type = 42'
          )
          .all()
      ).toEqual([{ guild_id: '222222222222222299' }])
    })

    it('removes entries with their guild', async () => {
      await deleteInvite(await humanInvite())
      server.db.prepare('DELETE FROM guilds WHERE id = ?').run(GUILD)
      expect(
        server.db.prepare('SELECT * FROM guild_audit_log_entries').all()
      ).toEqual([])
    })
  })
})
