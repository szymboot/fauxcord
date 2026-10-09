import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedMember,
  seedWebhook,
} from '../test-helpers'
import { setupTestEnvironment } from '../services/test-control'
import { addMemberRole } from '../services/guild-members'

const VIEW = 1n << 10n
const SEND = 1n << 11n
const EMBED = 1n << 14n
const ALL = VIEW | SEND | EMBED
const BOT = '111111111111111111'
const GUILD = '222222222222222222'
const CHANNEL = '333333333333333333'
const TOKEN = 'Bot permission-test'

/** Resolves an HTTP request and returns its status for concise assertions. */
async function responseStatus(
  response: Response | Promise<Response>
): Promise<number> {
  const resolved = await response
  return resolved.status
}

describe('guild message-send permissions', () => {
  let fixture: ReturnType<typeof createFullTestApp>

  /** Sends a request through the complete application and authentication stack. */
  function request(
    path: string,
    body?: unknown,
    method = 'POST',
    token = TOKEN
  ) {
    return fixture.app.request(path, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  /** Sends a normal message unless a test supplies another payload or target. */
  function send(
    body?: unknown,
    channel = CHANNEL,
    prefix = '/api/v10',
    token = TOKEN
  ) {
    return request(
      `${prefix}/channels/${channel}/messages`,
      body ?? { content: 'hello' },
      'POST',
      token
    )
  }

  /** Changes the base role through the existing Discord REST endpoint. */
  async function everyone(permissions: bigint) {
    const response = await request(
      `/guilds/${GUILD}/roles/${GUILD}`,
      { permissions: String(permissions) },
      'PATCH'
    )
    expect(response.status).toBe(200)
  }

  /** Creates a role and optionally assigns it through existing member fixtures. */
  async function role(permissions: bigint, assigned = true, guild = GUILD) {
    const response = await request(`/guilds/${guild}/roles`, {
      name: 'sender',
      permissions: String(permissions),
    })
    expect(response.status).toBe(200)
    const { id } = (await response.json()) as { id: string }
    if (assigned) expect(addMemberRole(fixture.db, guild, BOT, id)).toBe(true)
    return id
  }

  /** Adds or replaces an overwrite using the public REST API. */
  async function overwrite(
    id: string,
    type: number,
    allow = 0n,
    deny = 0n,
    channel = CHANNEL
  ) {
    const response = await request(
      `/channels/${channel}/permissions/${id}`,
      { type, allow: String(allow), deny: String(deny) },
      'PUT'
    )
    expect(response.status).toBe(204)
  }

  /** Verifies a Discord denial leaves all message-related state unchanged. */
  async function denied(response: Response, code = 50_013, status = 403) {
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({
      code,
      message:
        code === 50_001
          ? 'Missing Access'
          : code === 50_024
            ? 'Cannot execute action on this channel type'
            : 'Missing Permissions',
    })
    for (const table of ['messages', 'embeds', 'attachments', 'polls']) {
      expect(
        fixture.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
      ).toEqual({ count: 0 })
    }
    expect(
      fixture.db
        .prepare('SELECT last_message_id FROM channels WHERE id = ?')
        .get(CHANNEL)
    ).toEqual({ last_message_id: null })
  }

  beforeEach(() => {
    fixture = createFullTestApp()
    const owner = seedMember(
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
          name: 'Permission guild',
          owner_id: owner,
          channels: [
            { id: CHANNEL, name: 'log' },
            { id: '333333333333333334', name: 'sibling' },
          ],
        },
      ],
    })
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it.each(['/api/v10', '/api', ''])(
    'enforces sends and embeds through %s',
    async (prefix) => {
      await everyone(VIEW)
      await denied(await send(undefined, CHANNEL, prefix))
      await everyone(VIEW | SEND)
      await denied(
        await send(
          { embeds: [{ description: 'nickname changed' }] },
          CHANNEL,
          prefix
        )
      )
      await everyone(ALL)
      const response = await send(
        { embeds: [{ description: 'nickname changed' }] },
        CHANNEL,
        prefix
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        author: { id: BOT },
        embeds: [{ description: 'nickname changed' }],
      })
    }
  )

  it.each([0n, SEND | EMBED, (1n << 60n) | SEND | EMBED])(
    'requires VIEW_CHANNEL with base %s',
    async (permissions) => {
      await everyone(permissions)
      await denied(await send(), 50_001)
    }
  )

  it('requires membership even with assigned roles and member allows', async () => {
    await role(ALL | 8n)
    await overwrite(BOT, 1, ALL)
    fixture.db
      .prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?')
      .run(GUILD, BOT)
    await denied(await send(), 50_001)
  })

  it('combines everyone and assigned role permissions with arbitrary high bits', async () => {
    await everyone(VIEW | (1n << 60n))
    await role(SEND | (1n << 55n))
    await role(EMBED)
    expect(
      await responseStatus(send({ embeds: [{ title: 'combined' }] }))
    ).toBe(200)
  })

  it('does not use unassigned roles or other guild role assignments', async () => {
    await everyone(VIEW)
    await role(ALL | 8n, false)
    const other = setupTestEnvironment(fixture.db, {
      token: 'Bot other',
      user: { id: '111111111111111112' },
      guilds: [{ name: 'Other guild' }],
    }).guilds[0].id
    const foreignRole = await role(ALL | 8n, false, other)
    fixture.db
      .prepare(
        'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
      )
      .run(GUILD, BOT, foreignRole)
    await overwrite(foreignRole, 0, ALL)
    await denied(await send())
  })

  it('applies everyone overwrites before combined role overwrites, regardless of position', async () => {
    await everyone(ALL)
    const allow = await role(0n)
    const deny = await role(0n)
    await overwrite(GUILD, 0, 0n, ALL)
    await overwrite(allow, 0, ALL)
    await overwrite(deny, 0, 0n, ALL)
    expect(
      await responseStatus(send({ embeds: [{ title: 'role allow wins' }] }))
    ).toBe(200)
    await request(`/guilds/${GUILD}/roles/${allow}`, { position: 100 }, 'PATCH')
    expect(await responseStatus(send())).toBe(200)
  })

  it('member denies beat role allows, and member allows beat role denies', async () => {
    await everyone(ALL)
    const assigned = await role(0n)
    await overwrite(assigned, 0, ALL)
    await overwrite(BOT, 1, 0n, SEND)
    await denied(await send())
    await overwrite(assigned, 0, 0n, ALL)
    await overwrite(BOT, 1, ALL)
    expect(
      await responseStatus(send({ embeds: [{ title: 'member wins' }] }))
    ).toBe(200)
  })

  it('applies allow after deny within each overwrite and respects target type', async () => {
    await everyone(0n)
    await overwrite(GUILD, 0, ALL, ALL)
    await overwrite(BOT, 0, 0n, ALL)
    const assigned = await role(0n)
    await overwrite(assigned, 1, 0n, ALL)
    expect(await responseStatus(send())).toBe(200)
  })

  it.each(['everyone', 'role', 'owner'])(
    'bypasses overwrites for %s administrators or owners',
    async (source) => {
      await everyone(source === 'everyone' ? 8n : 0n)
      if (source === 'role') await role(8n)
      else if (source === 'owner')
        fixture.db
          .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
          .run(BOT, GUILD)
      await overwrite(GUILD, 0, 0n, ALL)
      await overwrite(BOT, 1, 0n, ALL)
      expect(
        await responseStatus(send({ embeds: [{ title: 'bypass' }] }))
      ).toBe(200)
    }
  )

  it('does not turn channel-level ADMINISTRATOR into a bypass', async () => {
    await everyone(VIEW)
    await overwrite(BOT, 1, 8n)
    await denied(await send())
  })

  it('recovers immediately after role changes, removal and rejoining', async () => {
    await everyone(VIEW)
    const assigned = await role(SEND | EMBED)
    expect(await responseStatus(send())).toBe(200)
    await request(
      `/guilds/${GUILD}/roles/${assigned}`,
      { permissions: '0' },
      'PATCH'
    )
    expect(await responseStatus(send())).toBe(403)
    await request(
      `/guilds/${GUILD}/roles/${assigned}`,
      { permissions: String(SEND | EMBED) },
      'PATCH'
    )
    expect(await responseStatus(send())).toBe(200)
    await request(
      `/guilds/${GUILD}/members/${BOT}/roles/${assigned}`,
      undefined,
      'DELETE'
    )
    expect(await responseStatus(send())).toBe(403)
    await request(
      `/guilds/${GUILD}/members/${BOT}/roles/${assigned}`,
      undefined,
      'PUT'
    )
    expect(await responseStatus(send())).toBe(200)
    await request(`/guilds/${GUILD}/roles/${assigned}`, undefined, 'DELETE')
    expect(await responseStatus(send())).toBe(403)
    await everyone(ALL)
    await request(`/guilds/${GUILD}/members/${BOT}`, undefined, 'DELETE')
    expect(await responseStatus(send())).toBe(403)
    fixture.db
      .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
      .run(GUILD, BOT)
    expect(await responseStatus(send())).toBe(200)
  })

  it('honors active timeouts, expiration, clearing and administrator exemption', async () => {
    fixture.db
      .prepare(
        'UPDATE guild_members SET communication_disabled_until = ? WHERE guild_id = ? AND user_id = ?'
      )
      .run(new Date(Date.now() + 60_000).toISOString(), GUILD, BOT)
    await denied(await send())
    await role(8n)
    expect(await responseStatus(send())).toBe(200)
    fixture.db
      .prepare('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?')
      .run(GUILD, BOT)
    fixture.db
      .prepare(
        'UPDATE guild_members SET communication_disabled_until = ? WHERE guild_id = ? AND user_id = ?'
      )
      .run(new Date(Date.now() - 1).toISOString(), GUILD, BOT)
    expect(await responseStatus(send())).toBe(200)
    fixture.db
      .prepare(
        'UPDATE guild_members SET communication_disabled_until = NULL WHERE guild_id = ? AND user_id = ?'
      )
      .run(GUILD, BOT)
    expect(await responseStatus(send())).toBe(200)
  })

  it('returns ordinary authentication, channel and validation errors without writes', async () => {
    for (const [channel, token, payload, status, code] of [
      [CHANNEL, '', { content: 'hello' }, 401, 0],
      [CHANNEL, 'Bot unknown', { content: 'hello' }, 401, 0],
      ['unknown', TOKEN, { content: 'hello' }, 404, 10_003],
      [CHANNEL, TOKEN, {}, 400, 50_006],
      [CHANNEL, TOKEN, { content: 'x'.repeat(2001) }, 400, 50_035],
    ] as const) {
      const response = await send(payload, channel, '', token)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ code })
    }
    const malformed = await fixture.app.request(
      `/channels/${CHANNEL}/messages`,
      {
        method: 'POST',
        headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
        body: '{',
      }
    )
    expect(malformed.status).toBe(400)
    expect(
      fixture.db.prepare('SELECT COUNT(*) AS count FROM messages').get()
    ).toEqual({ count: 0 })
  })

  it.each([undefined, null, []])(
    'allows content without embeds for embeds=%s',
    async (embeds) => {
      await everyone(VIEW | SEND)
      expect(
        await responseStatus(send({ content: 'https://example.com', embeds }))
      ).toBe(200)
    }
  )

  it.each([
    { embeds: [{ title: 'embed' }] },
    { content: 'text', embeds: [{ title: 'embed' }] },
    { flags: 4, embeds: [{ title: 'suppressed' }] },
  ])('requires EMBED_LINKS for explicit embeds %j', async (payload) => {
    await everyone(VIEW | SEND)
    await denied(await send(payload))
  })

  it('never substitutes EMBED_LINKS for SEND_MESSAGES', async () => {
    await everyone(VIEW | EMBED)
    await denied(await send({ embeds: [{ title: 'cannot send' }] }))
  })

  it.each([0, 2, 5, 13])(
    'enforces supported guild channel type %s',
    async (type) => {
      fixture.db
        .prepare('UPDATE channels SET type = ? WHERE id = ?')
        .run(type, CHANNEL)
      await overwrite(BOT, 1, 0n, SEND)
      await denied(await send())
      await overwrite(BOT, 1, ALL)
      expect(
        await responseStatus(send({ embeds: [{ title: 'supported' }] }))
      ).toBe(200)
    }
  )

  it.each([4, 10, 11, 12, 14, 15, 16, 99])(
    'explicitly rejects unsupported channel type %s, even for owner',
    async (type) => {
      fixture.db
        .prepare('UPDATE channels SET type = ? WHERE id = ?')
        .run(type, CHANNEL)
      fixture.db
        .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
        .run(BOT, GUILD)
      await denied(await send(), 50_024, 400)
    }
  )

  it('isolates users and channels and sees overwrite deletion immediately', async () => {
    await overwrite(BOT, 1, 0n, SEND)
    await denied(await send())
    const otherToken = seedBot(
      fixture.db,
      'Bot second-sender',
      '111111111111111112'
    )
    fixture.db
      .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
      .run(GUILD, '111111111111111112')
    const responses = await Promise.all([
      send(),
      send(undefined, '333333333333333334'),
      send(undefined, CHANNEL, '', otherToken),
    ])
    expect(responses.map((r) => r.status)).toEqual([403, 200, 200])
    expect(
      await responseStatus(
        request(`/channels/${CHANNEL}/permissions/${BOT}`, undefined, 'DELETE')
      )
    ).toBe(204)
    expect(await responseStatus(send())).toBe(200)
  })

  it('preserves DM, group DM, webhook and human-fixture distinctions', async () => {
    await everyone(0n)
    for (const type of [1, 3]) {
      fixture.db
        .prepare('INSERT INTO channels (id, type) VALUES (?, ?)')
        .run(`dm-${type}`, type)
      expect(
        await responseStatus(send({ embeds: [{ title: 'DM' }] }, `dm-${type}`))
      ).toBe(200)
    }
    const webhook = seedWebhook(fixture.db, CHANNEL, GUILD)
    expect(
      await responseStatus(
        request(
          `/webhooks/${webhook.webhookId}/${webhook.webhookToken}?wait=true`,
          { embeds: [{ title: 'webhook' }] }
        )
      )
    ).toBe(200)
    const human = seedMember(fixture.db, GUILD)
    expect(
      await responseStatus(
        request(`/_test/channels/${CHANNEL}/messages`, {
          author: { id: human },
          content: 'fixture',
        })
      )
    ).toBe(201)
  })
})
