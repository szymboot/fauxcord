import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFullTestApp,
  seedBearerCredential,
  seedGroupDmChannel,
  seedMember,
  seedMessage,
} from '../test-helpers'
import { setupTestEnvironment } from '../services/test-control'
import { addMemberRole } from '../services/guild-members'
import { generateSnowflake } from '../snowflake'
import { gatewayBus } from '../gateway/bus'

const VIEW = 1n << 10n
const MANAGE = 1n << 13n
const ADMIN = 1n << 3n
const BOT = '111111111111111111'
const GUILD = '222222222222222222'
const CHANNEL = '333333333333333333'
const TOKEN = 'Bot bulk-access-test'
const MISSING_ACCESS = { code: 50_001, message: 'Missing Access' }
const MISSING_PERMISSIONS = { code: 50_013, message: 'Missing Permissions' }
/** Tables holding message data that a refused request must leave alone. */
const TABLES = ['messages', 'embeds', 'reactions', 'pins']

describe('bulk-delete permission checks', () => {
  let fixture: ReturnType<typeof createFullTestApp>
  let owner: string
  let ids: string[]
  let dispatched: string[]
  const onBulk = (): void => {
    dispatched.push('bulk')
  }
  const onDelete = (): void => {
    dispatched.push('delete')
  }

  /** Sends a request through the complete application and auth stack. */
  function request(
    path: string,
    method: string,
    body?: unknown,
    token = TOKEN
  ) {
    return fixture.app.request(path, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && {
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    })
  }

  /** Bulk-deletes the seeded messages (or a given body) in a channel. */
  function bulkDelete(
    options: {
      channel?: string
      body?: unknown
      prefix?: string
      token?: string
    } = {}
  ) {
    const {
      channel = CHANNEL,
      body = { messages: ids },
      prefix = '/api/v10',
      token = TOKEN,
    } = options
    return request(
      `${prefix}/channels/${channel}/messages/bulk-delete`,
      'POST',
      body,
      token
    )
  }

  /** Changes the base `@everyone` permissions through Discord REST. */
  async function everyone(permissions: bigint) {
    const response = await request(
      `/api/v10/guilds/${GUILD}/roles/${GUILD}`,
      'PATCH',
      { permissions: String(permissions) }
    )
    expect(response.status).toBe(200)
  }

  /** Creates a role and assigns it to the bot. */
  async function role(permissions: bigint) {
    const response = await request(`/api/v10/guilds/${GUILD}/roles`, 'POST', {
      name: 'moderator',
      permissions: String(permissions),
    })
    const { id } = (await response.json()) as { id: string }
    expect(addMemberRole(fixture.db, GUILD, BOT, id)).toBe(true)
    return id
  }

  /** Adds or replaces a channel overwrite through Discord REST. */
  async function overwrite(id: string, type: number, allow = 0n, deny = 0n) {
    const response = await request(
      `/api/v10/channels/${CHANNEL}/permissions/${id}`,
      'PUT',
      { type, allow: String(allow), deny: String(deny) }
    )
    expect(response.status).toBe(204)
  }

  /** Seeds two recent messages with dependent rows in a channel. */
  function seedTargets(channel: string): string[] {
    return [0, 1].map(() => {
      const id = seedMessage(fixture.db, channel, owner, 'Bot x', 'target')
      fixture.db
        .prepare('INSERT INTO embeds (message_id, data) VALUES (?, ?)')
        .run(id, '{}')
      fixture.db
        .prepare(
          'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
        )
        .run(id, owner, '👍')
      fixture.db
        .prepare('INSERT INTO pins (channel_id, message_id) VALUES (?, ?)')
        .run(channel, id)
      return id
    })
  }

  /** Reads every stored row a bulk delete could remove. */
  function snapshot() {
    return TABLES.map((table) =>
      fixture.db.prepare(`SELECT * FROM ${table}`).all()
    )
  }

  /** Asserts a refusal body, unchanged data and no Gateway publication. */
  async function expectRefused(
    send: () => Response | Promise<Response>,
    body: typeof MISSING_ACCESS
  ) {
    const before = snapshot()
    const response = await send()
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(body)
    expect(snapshot()).toEqual(before)
    expect(dispatched).toEqual([])
  }

  /** Asserts the request removed both targets and published one bulk event. */
  async function expectDeleted(
    send: () => Response | Promise<Response> = () => bulkDelete()
  ) {
    const response = await send()
    expect(response.status).toBe(204)
    for (const id of ids) {
      expect(
        fixture.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)
      ).toBeUndefined()
    }
    expect(dispatched).toEqual(['bulk'])
  }

  beforeEach(() => {
    fixture = createFullTestApp()
    dispatched = []
    gatewayBus.on('message.delete.bulk', onBulk)
    gatewayBus.on('message.delete', onDelete)
    owner = seedMember(
      fixture.db,
      setupTestEnvironment(fixture.db, {
        token: 'Bot owner-fixture',
        guilds: [{ name: 'Owner fixture' }],
      }).guilds[0].id
    )
    setupTestEnvironment(fixture.db, {
      token: TOKEN,
      user: { id: BOT },
      guilds: [
        {
          id: GUILD,
          name: 'Moderated guild',
          owner_id: owner,
          channels: [{ id: CHANNEL, name: 'chat' }],
        },
      ],
    })
    ids = seedTargets(CHANNEL)
  })

  afterEach(() => {
    gatewayBus.off('message.delete.bulk', onBulk)
    gatewayBus.off('message.delete', onDelete)
    fixture.cleanup()
  })

  it.each(['/api/v10', '/api', ''])(
    'refuses a caller that is not a guild member through %s',
    async (prefix) => {
      fixture.db
        .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
        .run(GUILD, BOT)
      await expectRefused(() => bulkDelete({ prefix }), MISSING_ACCESS)
    }
  )

  it.each(['/api/v10', '/api', ''])(
    'refuses a bot without VIEW_CHANNEL through %s',
    async (prefix) => {
      await everyone(MANAGE)
      await expectRefused(() => bulkDelete({ prefix }), MISSING_ACCESS)
    }
  )

  it.each(['/api/v10', '/api', ''])(
    'refuses a bot without MANAGE_MESSAGES through %s',
    async (prefix) => {
      await everyone(VIEW)
      await expectRefused(() => bulkDelete({ prefix }), MISSING_PERMISSIONS)
    }
  )

  it('does not grant MANAGE_MESSAGES with the default @everyone permissions', async () => {
    await expectRefused(() => bulkDelete(), MISSING_PERMISSIONS)
  })

  it('reports VIEW_CHANNEL before MANAGE_MESSAGES', async () => {
    await everyone(0n)
    await expectRefused(() => bulkDelete(), MISSING_ACCESS)
  })

  it.each(['/api/v10', '/api', ''])(
    'deletes with VIEW_CHANNEL and MANAGE_MESSAGES through %s',
    async (prefix) => {
      await everyone(VIEW | MANAGE)
      await expectDeleted(() => bulkDelete({ prefix }))
    }
  )

  it('refuses own messages too without MANAGE_MESSAGES', async () => {
    fixture.db.prepare('UPDATE messages SET author_id = ?').run(BOT)
    await expectRefused(() => bulkDelete(), MISSING_PERMISSIONS)
  })

  it.each([
    ['malformed JSON', 'malformed'],
    ['too few IDs', { messages: ['1'] }],
    ['duplicate IDs', { messages: ['1', '1'] }],
    ['too old IDs', { messages: ['1', '2'] }],
    [
      'only missing IDs',
      { messages: [generateSnowflake(), generateSnowflake()] },
    ],
  ])(
    'refuses before validating or applying a body with %s',
    async (_name, body) => {
      await everyone(VIEW)
      await expectRefused(() => bulkDelete({ body }), MISSING_PERMISSIONS)
      await everyone(MANAGE)
      await expectRefused(() => bulkDelete({ body }), MISSING_ACCESS)
    }
  )

  it('answers an unknown channel before any access check', async () => {
    await everyone(0n)
    fixture.db
      .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
      .run(GUILD, BOT)
    const response = await bulkDelete({
      channel: '999999999999999999',
      body: 'malformed',
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 10_003 })
  })

  it('keeps the channel type error for DM channels', async () => {
    const dm = seedGroupDmChannel(fixture.db)
    const response = await bulkDelete({ channel: dm })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 50_024 })
    expect(dispatched).toEqual([])
  })

  it('does not apply bot permission checks to Bearer callers', async () => {
    await everyone(0n)
    const { bearerToken } = seedBearerCredential(fixture.db)
    await expectDeleted(() => bulkDelete({ token: `Bearer ${bearerToken}` }))
  })

  it('grants MANAGE_MESSAGES through an assigned role', async () => {
    await everyone(VIEW)
    await role(0n)
    await expectRefused(() => bulkDelete(), MISSING_PERMISSIONS)
    await role(MANAGE)
    await expectDeleted()
  })

  it('combines VIEW_CHANNEL and MANAGE_MESSAGES from different roles', async () => {
    await everyone(0n)
    await role(MANAGE)
    await expectRefused(() => bulkDelete(), MISSING_ACCESS)
    await role(VIEW)
    await expectDeleted()
  })

  it('ignores a role the bot does not hold', async () => {
    await everyone(VIEW)
    const response = await request(`/api/v10/guilds/${GUILD}/roles`, 'POST', {
      name: 'unassigned',
      permissions: String(MANAGE),
    })
    const { id } = (await response.json()) as { id: string }
    await overwrite(id, 0, MANAGE, 0n)
    await expectRefused(() => bulkDelete(), MISSING_PERMISSIONS)
  })

  it.each([
    ['@everyone', 0],
    ['role', 0],
    ['member', 1],
  ] as const)(
    'honors a %s overwrite denying MANAGE_MESSAGES that a role allows',
    async (target, type) => {
      await everyone(VIEW)
      const moderator = await role(MANAGE)
      const id = { '@everyone': GUILD, role: moderator, member: BOT }[target]
      await overwrite(id, type, 0n, MANAGE)
      await expectRefused(() => bulkDelete(), MISSING_PERMISSIONS)
    }
  )

  it.each([
    ['@everyone', 0],
    ['role', 0],
    ['member', 1],
  ] as const)(
    'honors a %s overwrite allowing MANAGE_MESSAGES that the roles lack',
    async (target, type) => {
      await everyone(VIEW)
      const plain = await role(0n)
      const id = { '@everyone': GUILD, role: plain, member: BOT }[target]
      await overwrite(id, type, MANAGE, 0n)
      await expectDeleted()
    }
  )

  it.each([
    ['@everyone', 0],
    ['role', 0],
    ['member', 1],
  ] as const)(
    'honors a %s overwrite denying VIEW_CHANNEL',
    async (target, type) => {
      await everyone(VIEW | MANAGE)
      const plain = await role(0n)
      const id = { '@everyone': GUILD, role: plain, member: BOT }[target]
      await overwrite(id, type, 0n, VIEW)
      await expectRefused(() => bulkDelete(), MISSING_ACCESS)
    }
  )

  it('lets a role overwrite allow what the @everyone overwrite denies', async () => {
    await everyone(VIEW | MANAGE)
    await overwrite(GUILD, 0, 0n, MANAGE)
    const id = await role(0n)
    await expectRefused(() => bulkDelete(), MISSING_PERMISSIONS)
    await overwrite(id, 0, MANAGE, 0n)
    await expectDeleted()
  })

  // Overwrites load in role ID order, so both orders are needed to catch a
  // last-write-wins resolution.
  it.each(['older', 'newer'])(
    'applies an allow over a deny across the role overwrites (%s role allows)',
    async (allowing) => {
      await everyone(VIEW)
      const older = await role(0n)
      const newer = await role(0n)
      expect(BigInt(older)).toBeLessThan(BigInt(newer))
      const [allow, deny] =
        allowing === 'older' ? [older, newer] : [newer, older]
      await overwrite(deny, 0, 0n, MANAGE)
      await overwrite(allow, 0, MANAGE, 0n)
      await expectDeleted()
    }
  )

  it('lets a member overwrite deny what a role overwrite allows', async () => {
    await everyone(VIEW)
    await overwrite(await role(0n), 0, MANAGE, 0n)
    await overwrite(BOT, 1, 0n, MANAGE)
    await expectRefused(() => bulkDelete(), MISSING_PERMISSIONS)
  })

  it('lets a member overwrite allow what a role overwrite denies', async () => {
    await everyone(VIEW | MANAGE)
    await overwrite(await role(0n), 0, 0n, MANAGE)
    await expectRefused(() => bulkDelete(), MISSING_PERMISSIONS)
    await overwrite(BOT, 1, MANAGE, 0n)
    await expectDeleted()
  })

  it('exempts the guild owner from permissions and overwrites', async () => {
    await everyone(0n)
    await overwrite(BOT, 1, 0n, VIEW | MANAGE)
    await expectRefused(() => bulkDelete(), MISSING_ACCESS)
    fixture.db
      .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
      .run(BOT, GUILD)
    await expectDeleted()
  })

  it('exempts a guild-level ADMINISTRATOR but not an overwrite ADMINISTRATOR', async () => {
    await everyone(0n)
    await overwrite(BOT, 1, ADMIN, VIEW | MANAGE)
    await expectRefused(() => bulkDelete(), MISSING_ACCESS)
    await role(ADMIN)
    await expectDeleted()
  })

  it.each([10, 11, 12])(
    'resolves a thread of type %i against the parent channel overwrites',
    async (type) => {
      const thread = generateSnowflake()
      fixture.db
        .prepare(
          `INSERT INTO channels (id, guild_id, type, name, parent_id)
           VALUES (?, ?, ?, 'thread', ?)`
        )
        .run(thread, GUILD, type, CHANNEL)
      ids = seedTargets(thread)
      const send = () => bulkDelete({ channel: thread })
      await everyone(VIEW)
      await expectRefused(send, MISSING_PERMISSIONS)
      await overwrite(BOT, 1, MANAGE, VIEW)
      await expectRefused(send, MISSING_ACCESS)
      await everyone(VIEW | MANAGE)
      await overwrite(BOT, 1, 0n, MANAGE)
      await expectRefused(send, MISSING_PERMISSIONS)
      await overwrite(BOT, 1, MANAGE, 0n)
      await expectDeleted(send)
    }
  )

  it('refuses a denied request without reading its body', async () => {
    await everyone(VIEW)
    let read = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true
          controller.close()
        },
      },
      { highWaterMark: 0 }
    )
    await expectRefused(
      () =>
        fixture.app.request(
          `/api/v10/channels/${CHANNEL}/messages/bulk-delete`,
          {
            method: 'POST',
            headers: {
              Authorization: TOKEN,
              'Content-Type': 'application/json',
            },
            body,
            duplex: 'half',
          } as RequestInit
        ),
      MISSING_PERMISSIONS
    )
    expect(read).toBe(false)
  })

  it.each([
    ['MANAGE_MESSAGES', MISSING_PERMISSIONS],
    ['membership', MISSING_ACCESS],
  ] as const)(
    're-checks %s after the body has been read',
    async (revoked, expected) => {
      await everyone(VIEW | MANAGE)
      const encoder = new TextEncoder()
      const reading = Promise.withResolvers<undefined>()
      const gate = Promise.withResolvers<undefined>()
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            // The route asked for the body, so the first check has passed.
            reading.resolve(undefined)
            await gate.promise
            controller.enqueue(
              encoder.encode(JSON.stringify({ messages: ids }))
            )
            controller.close()
          },
        },
        { highWaterMark: 0 }
      )
      const before = snapshot()
      const pending = fixture.app.request(
        `/api/v10/channels/${CHANNEL}/messages/bulk-delete`,
        {
          method: 'POST',
          headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
          body,
          duplex: 'half',
        } as RequestInit
      )
      await reading.promise
      if (revoked === 'membership') {
        fixture.db
          .prepare(
            'DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?'
          )
          .run(GUILD, BOT)
      } else {
        fixture.db
          .prepare('UPDATE roles SET permissions = ? WHERE id = ?')
          .run(String(VIEW), GUILD)
      }
      gate.resolve(undefined)
      const response = await pending
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(expected)
      expect(snapshot()).toEqual(before)
      expect(dispatched).toEqual([])
    }
  )
})
