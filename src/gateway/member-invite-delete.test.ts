import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import {
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
  seedInvite,
  seedMember,
  seedRole,
} from '../test-helpers'
import { getInvite } from '../services/invites'
import type { StoredAuditEntry } from '../services/audit-logs'
import type { GatewayPayload } from './protocol'

/** Wire client with all dispatches retained for ordered assertions. */
interface Client {
  ws: WebSocket
  frames: GatewayPayload<Record<string, unknown> | null>[]
}

/** Audit log response body fields used by these tests. */
interface AuditPage {
  audit_log_entries: StoredAuditEntry[]
  users: { id: string }[]
}

const TOKEN = 'Bot member-invite-delete'
const BOT = '111111111111111111'
const INVITER = '700000000000000001'
const MOD = '700000000000000010'
const GUILD = '222222222222222222'
const CHANNEL = '333333333333333333'
const OTHER_CHANNEL = '333333333333333334'
const MANAGE_CHANNELS = 1n << 4n
const MANAGE_GUILD = 1n << 5n
const ADMINISTRATOR = 1n << 3n
const INTENTS =
  GatewayIntentBits.GuildInvites | GatewayIntentBits.GuildModeration

describe('POST /_test/invites/:code/delete', () => {
  let server: Awaited<ReturnType<typeof createTestGatewayServer>>
  let base: string
  const clients: Client[] = []

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
      ...(body !== undefined && {
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    })
  }

  /** Creates a human invite through the test control and returns its code. */
  async function humanInvite(
    extra: Record<string, unknown> = {},
    channel = CHANNEL
  ): Promise<string> {
    const response = await request(
      `/_test/channels/${channel}/invites`,
      'POST',
      { inviter_id: INVITER, ...extra }
    )
    expect(response.status).toBe(201)
    return ((await response.json()) as { code: string }).code
  }

  /** Deletes an invite through the control. */
  function control(code: string, body: unknown): Promise<Response> {
    return request(`/_test/invites/${code}/delete`, 'POST', body)
  }

  /** Gives a member a new role holding the given permission bits. */
  function grantRole(userId: string, permissions: bigint): void {
    const roleId = seedRole(server.db, GUILD)
    server.db
      .prepare('UPDATE roles SET permissions = ? WHERE id = ?')
      .run(String(permissions), roleId)
    server.db
      .prepare(
        'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
      )
      .run(GUILD, userId, roleId)
  }

  /** Adds a channel permission overwrite. */
  function overwrite(
    channel: string,
    id: string,
    type: 0 | 1,
    allow: bigint,
    deny = 0n
  ): void {
    server.db
      .prepare(
        'INSERT INTO channel_overwrites (channel_id, id, type, allow, deny) VALUES (?, ?, ?, ?, ?)'
      )
      .run(channel, id, type, String(allow), String(deny))
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

  /** Identifies a session, retaining every frame. */
  async function connect(): Promise<Client> {
    const ws = new WebSocket(server.url)
    const frames: Client['frames'] = []
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as Client['frames'][number])
    })
    await once(ws, 'message')
    const ready = once(ws, 'message')
    ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: INTENTS } }))
    await ready
    const client = { ws, frames }
    clients.push(client)
    await drain(client)
    return client
  }

  /** Resolves with only the control's HTTP status. */
  async function controlStatus(
    code: string,
    payload: unknown
  ): Promise<number> {
    const response = await control(code, payload)
    return response.status
  }

  /** Parses a JSON response body. */
  async function readJson(response: Response): Promise<unknown> {
    return response.json()
  }

  /** Reads the guild audit log through the bot-authenticated route. */
  async function auditLog(query = ''): Promise<AuditPage> {
    const response = await request(
      `/api/v10/guilds/${GUILD}/audit-logs${query}`,
      'GET',
      undefined,
      TOKEN
    )
    expect(response.status).toBe(200)
    return (await response.json()) as AuditPage
  }

  /** Lists the guild's audit log entries. */
  async function auditEntries(): Promise<StoredAuditEntry[]> {
    const page = await auditLog()
    return page.audit_log_entries
  }

  /** Asserts that nothing was deleted, recorded or dispatched. */
  async function expectUntouched(client: Client, code: string): Promise<void> {
    expect(getInvite(server.db, code)).not.toBeNull()
    expect(await auditEntries()).toEqual([])
    expect(await drain(client)).toEqual([])
  }

  beforeEach(async () => {
    server = await createTestGatewayServer()
    base = server.url.replace('ws://', 'http://')
    seedBot(server.db, TOKEN, BOT)
    seedGuild(server.db, TOKEN, GUILD)
    seedChannel(server.db, GUILD, CHANNEL)
    seedChannel(server.db, GUILD, OTHER_CHANNEL)
    seedMember(server.db, GUILD, INVITER)
    seedMember(server.db, GUILD, MOD)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate()
    await server.close()
  })

  describe('success', () => {
    it('deletes the invite, then dispatches INVITE_DELETE and the audit entry in order', async () => {
      grantRole(MOD, MANAGE_GUILD)
      const code = await humanInvite({ max_uses: 5, max_age: 3600 })
      const client = await connect()
      const before = await request(`/invites/${code}`, 'GET', undefined, TOKEN)
      const invite = (await before.json()) as Record<string, unknown>

      const response = await control(code, { actor_id: MOD, reason: 'cleanup' })

      expect(response.status).toBe(200)
      expect(await readJson(response)).toEqual(invite)
      expect(getInvite(server.db, code)).toBeNull()
      const frames = await drain(client)
      expect(frames.map((frame) => frame.t)).toEqual([
        'INVITE_DELETE',
        'GUILD_AUDIT_LOG_ENTRY_CREATE',
      ])
      expect(frames[1].s).toBe((frames[0].s ?? 0) + 1)
      expect(frames[0].d).toEqual({
        channel_id: CHANNEL,
        guild_id: GUILD,
        code,
      })
      const { audit_log_entries: entries, users } = await auditLog()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        action_type: 42,
        user_id: MOD,
        target_id: null,
        reason: 'cleanup',
      })
      expect(frames[1].d).toEqual({ ...entries[0], guild_id: GUILD })
      expect(
        users.map((user) => user.id).toSorted((a, b) => a.localeCompare(b))
      ).toEqual([INVITER, MOD].toSorted((a, b) => a.localeCompare(b)))
      const listed = await auditLog(`?action_type=42&user_id=${MOD}`)
      expect(listed.audit_log_entries.map((entry) => entry.id)).toEqual([
        entries[0].id,
      ])
    })

    it('omits the reason when absent, null or empty', async () => {
      grantRole(MOD, MANAGE_GUILD)
      for (const extra of [{}, { reason: null }, { reason: '' }]) {
        const code = await humanInvite()
        expect(await controlStatus(code, { actor_id: MOD, ...extra })).toBe(200)
      }
      const { audit_log_entries: entries } = await auditLog()
      expect(entries).toHaveLength(3)
      for (const entry of entries) expect(entry).not.toHaveProperty('reason')
    })

    it('answers a repeated deletion with Unknown Invite and no further events', async () => {
      grantRole(MOD, MANAGE_GUILD)
      const code = await humanInvite()
      const client = await connect()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(200)
      const first = await drain(client)
      expect(first.map((frame) => frame.t)).toEqual([
        'INVITE_DELETE',
        'GUILD_AUDIT_LOG_ENTRY_CREATE',
      ])
      const again = await control(code, { actor_id: MOD })
      expect(again.status).toBe(404)
      expect(await readJson(again)).toEqual({
        message: 'Unknown Invite',
        code: 10_006,
      })
      expect(await drain(client)).toEqual([])
      expect(await auditEntries()).toHaveLength(1)
    })

    it('deletes an invite created through the native route', async () => {
      grantRole(MOD, MANAGE_GUILD)
      const created = await request(
        `/channels/${CHANNEL}/invites`,
        'POST',
        {},
        TOKEN
      )
      const { code } = (await created.json()) as { code: string }
      expect(await controlStatus(code, { actor_id: MOD })).toBe(200)
      expect(getInvite(server.db, code)).toBeNull()
    })
  })

  describe('permissions', () => {
    it('allows MANAGE_CHANNELS granted by a role', async () => {
      grantRole(MOD, MANAGE_CHANNELS)
      const code = await humanInvite()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(200)
      expect(getInvite(server.db, code)).toBeNull()
    })

    it('allows MANAGE_CHANNELS granted by an overwrite on the invite channel', async () => {
      overwrite(CHANNEL, MOD, 1, MANAGE_CHANNELS)
      const code = await humanInvite()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(200)
      expect(getInvite(server.db, code)).toBeNull()
    })

    it('rejects MANAGE_CHANNELS granted only on another channel', async () => {
      overwrite(OTHER_CHANNEL, MOD, 1, MANAGE_CHANNELS)
      const code = await humanInvite()
      const client = await connect()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(403)
      await expectUntouched(client, code)
    })

    it('rejects a role MANAGE_CHANNELS denied by an overwrite on the channel', async () => {
      grantRole(MOD, MANAGE_CHANNELS)
      overwrite(CHANNEL, MOD, 1, 0n, MANAGE_CHANNELS)
      const code = await humanInvite()
      const client = await connect()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(403)
      await expectUntouched(client, code)
    })

    it('allows MANAGE_GUILD', async () => {
      grantRole(MOD, MANAGE_GUILD)
      const code = await humanInvite()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(200)
      expect(getInvite(server.db, code)).toBeNull()
    })

    it('allows MANAGE_GUILD even when the channel overwrite denies MANAGE_CHANNELS', async () => {
      grantRole(MOD, MANAGE_GUILD)
      overwrite(CHANNEL, MOD, 1, 0n, MANAGE_CHANNELS)
      const code = await humanInvite()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(200)
    })

    it('allows ADMINISTRATOR', async () => {
      grantRole(MOD, ADMINISTRATOR)
      const code = await humanInvite()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(200)
      expect(getInvite(server.db, code)).toBeNull()
    })

    it('allows the guild owner without any role', async () => {
      server.db
        .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
        .run(MOD, GUILD)
      const code = await humanInvite()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(200)
      expect(getInvite(server.db, code)).toBeNull()
    })

    it('rejects a member without the permission, with 403 / 50013', async () => {
      grantRole(MOD, 1n << 10n)
      const code = await humanInvite()
      const client = await connect()
      const response = await control(code, { actor_id: MOD, reason: 'nope' })
      expect(response.status).toBe(403)
      expect(await readJson(response)).toEqual({
        message: 'Missing Permissions',
        code: 50_013,
      })
      await expectUntouched(client, code)
    })

    it('leaves unrelated expired invites in place when it refuses', async () => {
      const code = await humanInvite()
      await humanInvite({
        max_age: 60,
        created_at: new Date(Date.now() - 120_000).toISOString(),
      })
      const count = (): unknown =>
        server.db.prepare('SELECT COUNT(*) AS n FROM invites').get()
      expect(count()).toEqual({ n: 2 })
      expect(await controlStatus(code, { actor_id: MOD })).toBe(403)
      expect(await controlStatus('neverexisted', { actor_id: MOD })).toBe(404)
      // Raw SQL: getInvite() would purge the expired row itself.
      expect(count()).toEqual({ n: 2 })
    })

    it('rejects the invite creator who lacks the permission', async () => {
      const code = await humanInvite()
      const client = await connect()
      expect(await controlStatus(code, { actor_id: INVITER })).toBe(403)
      await expectUntouched(client, code)
    })
  })

  describe('actor and invite errors', () => {
    it('rejects a registered user who is not a guild member with 403 / 50013', async () => {
      const outsider = '700000000000000020'
      const registered = await request('/_test/users', 'POST', {
        id: outsider,
        username: 'outsider',
        discriminator: '1234',
      })
      expect(registered.status).toBe(201)
      const code = await humanInvite()
      const client = await connect()
      const response = await control(code, { actor_id: outsider })
      expect(response.status).toBe(403)
      expect(await readJson(response)).toMatchObject({ code: 50_013 })
      await expectUntouched(client, code)
    })

    it('rejects a user who left the guild', async () => {
      grantRole(MOD, MANAGE_GUILD)
      const code = await humanInvite()
      server.db
        .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
        .run(GUILD, MOD)
      const client = await connect()
      expect(await controlStatus(code, { actor_id: MOD })).toBe(403)
      await expectUntouched(client, code)
    })

    it('rejects an unknown actor with 404 / 10013', async () => {
      const code = await humanInvite()
      const client = await connect()
      const response = await control(code, { actor_id: '700000000000000099' })
      expect(response.status).toBe(404)
      expect(await readJson(response)).toMatchObject({ code: 10_013 })
      await expectUntouched(client, code)
    })

    it('rejects a bot actor, even the guild owner bot', async () => {
      const code = await humanInvite()
      const client = await connect()
      const response = await control(code, { actor_id: BOT })
      expect(response.status).toBe(400)
      expect(await readJson(response)).toEqual({
        message: 'User must not be a bot',
        code: 0,
      })
      await expectUntouched(client, code)
    })

    it('answers an unknown invite with 404 / 10006', async () => {
      grantRole(MOD, MANAGE_GUILD)
      const client = await connect()
      const response = await control('neverexisted', { actor_id: MOD })
      expect(response.status).toBe(404)
      expect(await readJson(response)).toEqual({
        message: 'Unknown Invite',
        code: 10_006,
      })
      expect(await drain(client)).toEqual([])
      expect(await auditEntries()).toEqual([])
    })

    it('answers an unknown invite before judging an unknown actor', async () => {
      const response = await control('neverexisted', { actor_id: '1' })
      expect(response.status).toBe(404)
      expect(await readJson(response)).toMatchObject({ code: 10_006 })
    })

    it('answers an expired invite with 404 / 10006, no event and no entry', async () => {
      grantRole(MOD, MANAGE_GUILD)
      const code = await humanInvite({
        max_age: 60,
        created_at: new Date(Date.now() - 120_000).toISOString(),
      })
      const client = await connect()
      const response = await control(code, { actor_id: MOD })
      expect(response.status).toBe(404)
      expect(await readJson(response)).toMatchObject({ code: 10_006 })
      // Raw SQL: the rejected call leaves the expired row for the next read.
      expect(
        server.db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code)
      ).toBeDefined()
      expect(getInvite(server.db, code)).toBeNull()
      expect(await drain(client)).toEqual([])
      expect(await auditEntries()).toEqual([])
    })

    it('answers an invite row without a guild with 404 / 10006', async () => {
      grantRole(MOD, MANAGE_GUILD)
      seedInvite(server.db, CHANNEL, null, INVITER, 'noguild')
      const response = await control('noguild', { actor_id: MOD })
      expect(response.status).toBe(404)
      expect(await readJson(response)).toMatchObject({ code: 10_006 })
      expect(
        server.db.prepare('SELECT 1 FROM invites WHERE code = ?').get('noguild')
      ).toBeDefined()
    })
  })

  describe('validation', () => {
    it.each([
      ['a missing actor_id', {}, 'actor_id'],
      ['a null actor_id', { actor_id: null }, 'actor_id'],
      ['a numeric actor_id', { actor_id: 7_000_000_000 }, 'actor_id'],
      ['an empty actor_id', { actor_id: '' }, 'actor_id'],
      ['a non-string reason', { actor_id: MOD, reason: 5 }, 'reason'],
      [
        'a reason over 512 characters',
        { actor_id: MOD, reason: 'x'.repeat(513) },
        'reason',
      ],
    ])('answers 400 / 50035 for %s', async (_name, body, field) => {
      grantRole(MOD, MANAGE_GUILD)
      const code = await humanInvite()
      const client = await connect()
      const response = await control(code, body)
      expect(response.status).toBe(400)
      const json = (await response.json()) as {
        code: number
        errors: Record<string, unknown>
      }
      expect(json.code).toBe(50_035)
      expect(Object.keys(json.errors)).toEqual([field])
      await expectUntouched(client, code)
    })

    it('accepts a reason of exactly 512 characters', async () => {
      grantRole(MOD, MANAGE_GUILD)
      const code = await humanInvite()
      const reason = 'x'.repeat(512)
      expect(await controlStatus(code, { actor_id: MOD, reason })).toBe(200)
      const entries = await auditEntries()
      expect(entries[0]).toMatchObject({ reason })
    })

    it.each([['[]'], ['"text"'], ['null'], ['42'], ['{not json']])(
      'answers 400 / 0 for the body %s',
      async (body) => {
        grantRole(MOD, MANAGE_GUILD)
        const code = await humanInvite()
        const client = await connect()
        const response = await control(code, body)
        expect(response.status).toBe(400)
        expect(await readJson(response)).toEqual({
          message: '400: Bad Request',
          code: 0,
        })
        await expectUntouched(client, code)
      }
    )

    it('validates the body before looking up the invite', async () => {
      const response = await control('neverexisted', {})
      expect(response.status).toBe(400)
      expect(await readJson(response)).toMatchObject({ code: 50_035 })
    })
  })
})
