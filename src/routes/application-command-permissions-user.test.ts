import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFullTestApp, seedBot, seedGuild } from '../test-helpers'
import type { FullTestContext } from '../test-helpers'
import type { TokenResponse } from '../services/oauth2'

const APP_ID = '111111111111111111'
const BOT_TOKEN = 'Bot user-permissions-test'
const SCOPE = 'applications.commands.permissions.update'
const ADMINISTRATOR = 1n << 3n
const BAN_MEMBERS = 1n << 2n
const MANAGE_GUILD = 1n << 5n
const MANAGE_ROLES = 1n << 28n
const MANAGE_BOTH = MANAGE_GUILD | MANAGE_ROLES

/** Resolves a (possibly synchronous) response to its HTTP status. */
async function statusOf(
  response: Promise<Response> | Response
): Promise<number> {
  const resolved = await response
  return resolved.status
}

describe('POST /_test/oauth2/tokens', () => {
  let context: FullTestContext

  /** Posts a raw body to the token control. */
  function issue(body: unknown, raw = false): Promise<Response> | Response {
    return context.app.request('/_test/oauth2/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    })
  }

  /** Issues a token and parses the response body. */
  async function tokenFor(body: unknown): Promise<TokenResponse> {
    const response = await issue(body)
    return (await response.json()) as TokenResponse
  }

  /** Reads the OAuth2 identity of a Bearer token. */
  function me(accessToken: string): Promise<Response> | Response {
    return context.app.request('/api/v10/oauth2/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  }

  beforeEach(() => {
    context = createFullTestApp()
    seedBot(context.db, BOT_TOKEN, APP_ID)
    context.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES ('555555555555555555', 'Dash', '0', 0)"
      )
      .run()
  })

  afterEach(() => {
    context.cleanup()
  })

  it('issues a standard user-bound token response', async () => {
    const response = await issue({
      client_id: APP_ID,
      user_id: '555555555555555555',
      scope: `identify ${SCOPE}`,
    })
    expect(response.status).toBe(201)
    const token = (await response.json()) as TokenResponse
    expect(token).toMatchObject({
      token_type: 'Bearer',
      expires_in: 604_800,
      scope: `identify ${SCOPE}`,
    })
    expect(token.access_token).toMatch(/^mock_access_token_/)
    expect(token.refresh_token).toMatch(/^mock_refresh_token_/)
    const row = context.db
      .prepare('SELECT user_id, client_id FROM oauth2_access_tokens')
      .get() as { user_id: string; client_id: string }
    expect(row).toEqual({ user_id: '555555555555555555', client_id: APP_ID })
  })

  it('honors a custom expires_in and requires no Authorization header', async () => {
    const response = await issue({
      client_id: APP_ID,
      user_id: '555555555555555555',
      scope: 'identify',
      expires_in: 60,
    })
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ expires_in: 60 })
  })

  it('creates an unknown client and links it to the matching setup', async () => {
    await issue({
      client_id: APP_ID,
      user_id: '555555555555555555',
      scope: 'identify',
    })
    await issue({
      client_id: 'standalone-client',
      user_id: '555555555555555555',
      scope: 'identify',
    })
    const linked = context.db
      .prepare('SELECT bot_token FROM oauth2_clients WHERE client_id = ?')
      .get(APP_ID) as { bot_token: string | null }
    const standalone = context.db
      .prepare('SELECT bot_token FROM oauth2_clients WHERE client_id = ?')
      .get('standalone-client') as { bot_token: string | null }
    expect(linked.bot_token).toBe(BOT_TOKEN)
    expect(standalone.bot_token).toBeNull()
  })

  it.each<[string, unknown]>([
    ['missing client_id', { user_id: '555555555555555555', scope: 'identify' }],
    ['missing user_id', { client_id: APP_ID, scope: 'identify' }],
    ['missing scope', { client_id: APP_ID, user_id: '555555555555555555' }],
    ['empty client_id', { client_id: '', user_id: '5', scope: 'identify' }],
    ['numeric user_id', { client_id: APP_ID, user_id: 5, scope: 'identify' }],
    ...['', ' ', 'a  b', ' a', 'a ', 'a\tb', 'a\nb', 5, null, ['a']].map(
      (scope): [string, unknown] => [
        `bad scope ${JSON.stringify(scope)}`,
        { client_id: APP_ID, user_id: '555555555555555555', scope },
      ]
    ),
    ...[0, -1, 1.5, '60', null, NaN, 2_592_001].map(
      (expiresIn): [string, unknown] => [
        `bad expires_in ${String(expiresIn)}`,
        {
          client_id: APP_ID,
          user_id: '555555555555555555',
          scope: 'identify',
          expires_in: expiresIn,
        },
      ]
    ),
    [
      'unsupported field',
      {
        client_id: APP_ID,
        user_id: '555555555555555555',
        scope: 'identify',
        extra: true,
      },
    ],
  ])('rejects %s with 400 and issues no token', async (_name, body) => {
    const response = await issue(body)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 50_035 })
    expect(
      context.db.prepare('SELECT COUNT(*) AS n FROM oauth2_access_tokens').get()
    ).toEqual({ n: 0 })
  })

  it.each(['not json', '[]', 'null', '"text"'])(
    'rejects the non-object body %s',
    async (body) => {
      const response = await issue(body, true)
      expect(response.status).toBe(400)
    }
  )

  it('accepts the maximum expires_in', async () => {
    const response = await issue({
      client_id: APP_ID,
      user_id: '555555555555555555',
      scope: 'identify',
      expires_in: 2_592_000,
    })
    expect(response.status).toBe(201)
  })

  it('returns 404 / 10013 for an unknown user and creates nothing', async () => {
    const response = await issue({
      client_id: 'new-client',
      user_id: '999999999999999999',
      scope: 'identify',
    })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 10_013 })
    expect(
      context.db.prepare('SELECT COUNT(*) AS n FROM oauth2_clients').get()
    ).toEqual({ n: 0 })
  })

  it('issues a Bearer credential that identifies the user', async () => {
    const token = await tokenFor({
      client_id: APP_ID,
      user_id: '555555555555555555',
      scope: 'identify',
    })
    const response = await me(token.access_token)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      user: { id: '555555555555555555', username: 'Dash' },
      scopes: ['identify'],
    })
  })

  it.each(['access_token', 'refresh_token'] as const)(
    'can be revoked through /oauth2/token/revoke with the %s',
    async (kind) => {
      const token = await tokenFor({
        client_id: APP_ID,
        user_id: '555555555555555555',
        scope: 'identify',
      })
      const revoked = await context.app.request(
        '/api/v10/oauth2/token/revoke',
        {
          method: 'POST',
          body: new URLSearchParams({ token: token[kind] ?? '' }),
        }
      )
      expect(revoked.status).toBe(200)
      expect(await statusOf(me(token.access_token))).toBe(401)
    }
  )

  it('expires with expires_in', async () => {
    const token = await tokenFor({
      client_id: APP_ID,
      user_id: '555555555555555555',
      scope: 'identify',
      expires_in: 1,
    })
    context.db
      .prepare(
        "UPDATE oauth2_access_tokens SET expires_at = datetime('now', '-1 second')"
      )
      .run()
    expect(await statusOf(me(token.access_token))).toBe(401)
  })

  it('dies with its setup', async () => {
    const token = await tokenFor({
      client_id: APP_ID,
      user_id: '555555555555555555',
      scope: 'identify',
    })
    expect(await statusOf(me(token.access_token))).toBe(200)
    const deleted = await context.app.request(
      `/_test/setup/${encodeURIComponent(BOT_TOKEN)}`,
      { method: 'DELETE' }
    )
    expect(deleted.status).toBe(204)
    expect(await statusOf(me(token.access_token))).toBe(401)
  })

  it('leaves existing authorize and client-credentials behavior unchanged', async () => {
    const client = await context.app.request('/api/v10/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        scope: SCOPE,
      }),
    })
    const token = (await client.json()) as TokenResponse
    expect(token.refresh_token).toBeUndefined()
    const row = context.db
      .prepare('SELECT user_id FROM oauth2_access_tokens WHERE token = ?')
      .get(token.access_token) as { user_id: string | null }
    expect(row.user_id).toBeNull()

    const authorize = await context.app.request(
      `/api/v10/oauth2/authorize?${new URLSearchParams({
        client_id: APP_ID,
        redirect_uri: 'http://localhost/cb',
        response_type: 'code',
        scope: SCOPE,
      })}`
    )
    expect(authorize.status).toBe(302)
    const code = context.db
      .prepare('SELECT user_id FROM oauth2_auth_codes')
      .get() as { user_id: string }
    expect(code.user_id).toBe('2222222222222222222')
  })
})

describe('command permission edits by a user-bound token', () => {
  const GUILD = '222222222222222222'
  const OVERRIDES = [{ id: '888888888888888888', type: 2, permission: true }]
  let context: FullTestContext
  let commandId: string
  let permissionsUrl: string
  let nextId = 0

  /** Inserts a role; positions are explicit and IDs ascend per call. */
  function role(position: number, permissions = 0n): string {
    const id = `70000000000000${String(nextId++).padStart(4, '0')}`
    context.db
      .prepare(
        `INSERT INTO roles (id, guild_id, name, position, permissions)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, GUILD, `role-${id}`, position, String(permissions))
    return id
  }

  /** Permissions route of a command in the test guild. */
  function commandUrl(id: string): string {
    return `/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands/${id}/permissions`
  }

  /** Registers a human who joined the guild with the given roles. */
  function member(roles: string[] = []): string {
    const id = `80000000000000${String(nextId++).padStart(4, '0')}`
    context.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'Dash', '0', 0)"
      )
      .run(id)
    context.db
      .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
      .run(GUILD, id)
    for (const roleId of roles)
      context.db
        .prepare(
          'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
        )
        .run(GUILD, id, roleId)
    return id
  }

  /** Registers a human who is not in the guild. */
  function outsider(): string {
    const id = `90000000000000${String(nextId++).padStart(4, '0')}`
    context.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'Out', '0', 0)"
      )
      .run(id)
    return id
  }

  /** Issues a user-bound Bearer credential through the test control. */
  async function bearer(userId: string, scope = SCOPE): Promise<string> {
    const response = await context.app.request('/_test/oauth2/tokens', {
      method: 'POST',
      body: JSON.stringify({ client_id: APP_ID, user_id: userId, scope }),
    })
    expect(response.status).toBe(201)
    return `Bearer ${((await response.json()) as TokenResponse).access_token}`
  }

  /** Creates a command, optionally with default_member_permissions. */
  async function createCommand(
    name: string,
    defaultMemberPermissions?: string,
    scope: 'guild' | 'global' = 'guild'
  ): Promise<string> {
    const response = await context.app.request(
      scope === 'guild'
        ? `/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands`
        : `/api/v10/applications/${APP_ID}/commands`,
      {
        method: 'POST',
        headers: { Authorization: BOT_TOKEN },
        body: JSON.stringify({
          name,
          description: 'd',
          ...(defaultMemberPermissions !== undefined && {
            default_member_permissions: defaultMemberPermissions,
          }),
        }),
      }
    )
    return ((await response.json()) as { id: string }).id
  }

  /** Stores permission overwrites as the owning bot. */
  async function storeOverwrites(
    permissions: { id: string; type: number; permission: boolean }[]
  ): Promise<void> {
    const response = await context.app.request(permissionsUrl, {
      method: 'PUT',
      headers: { Authorization: BOT_TOKEN },
      body: JSON.stringify({ permissions }),
    })
    expect(response.status).toBe(200)
  }

  /** PUTs permissions with the given credentials. */
  function put(
    authorization: string,
    permissions: unknown = OVERRIDES,
    url = permissionsUrl
  ): Promise<Response> | Response {
    return context.app.request(url, {
      method: 'PUT',
      headers: { Authorization: authorization },
      body: JSON.stringify({ permissions }),
    })
  }

  /** Reads stored permissions as the owning bot. */
  async function stored(): Promise<unknown> {
    const response = await context.app.request(permissionsUrl, {
      headers: { Authorization: BOT_TOKEN },
    })
    return ((await response.json()) as { permissions: unknown }).permissions
  }

  /** Asserts a 403 / 50013 response that left the stored overwrites alone. */
  async function expectDenied(
    response: Response,
    before: unknown = []
  ): Promise<void> {
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      message: 'Missing Permissions',
      code: 50_013,
    })
    expect(await stored()).toEqual(before)
  }

  beforeEach(async () => {
    context = createFullTestApp()
    seedBot(context.db, BOT_TOKEN, APP_ID)
    seedGuild(context.db, BOT_TOKEN, GUILD)
    commandId = await createCommand('ban')
    permissionsUrl = commandUrl(commandId)
  })

  afterEach(() => {
    context.cleanup()
  })

  describe('who may edit', () => {
    it('allows the guild owner, even without a member row or role rights', async () => {
      const owner = outsider()
      context.db.prepare('UPDATE guilds SET owner_id = ?').run(owner)
      const response = await put(await bearer(owner))
      expect(response.status).toBe(200)
      expect(await stored()).toEqual(OVERRIDES)
    })

    it('allows an Administrator', async () => {
      const admin = member([role(1, ADMINISTRATOR)])
      expect(await statusOf(put(await bearer(admin)))).toBe(200)
    })

    it('allows MANAGE_GUILD + MANAGE_ROLES who can run the command', async () => {
      const editor = member([role(1, MANAGE_BOTH)])
      expect(await statusOf(put(await bearer(editor)))).toBe(200)
      expect(await stored()).toEqual(OVERRIDES)
    })

    it('combines MANAGE_GUILD and MANAGE_ROLES from different roles', async () => {
      const editor = member([role(1, MANAGE_GUILD), role(2, MANAGE_ROLES)])
      expect(await statusOf(put(await bearer(editor)))).toBe(200)
    })

    it('uses @everyone role permissions as part of the guild permissions', async () => {
      context.db
        .prepare(
          "INSERT INTO roles (id, guild_id, name, position, permissions) VALUES (?, ?, '@everyone', 0, ?)"
        )
        .run(GUILD, GUILD, String(MANAGE_BOTH))
      const editor = member()
      expect(await statusOf(put(await bearer(editor)))).toBe(200)
      // Ranks as @everyone, so any other role entry is not below it.
      const entry = { id: role(1), type: 1, permission: true }
      await expectDenied(await put(await bearer(editor), [entry]), OVERRIDES)
    })

    it.each([
      ['MANAGE_GUILD only', MANAGE_GUILD],
      ['MANAGE_ROLES only', MANAGE_ROLES],
      ['unrelated permissions', BAN_MEMBERS],
      ['no permissions', 0n],
    ])('denies %s', async (_name, permissions) => {
      const editor = member([role(1, permissions)])
      await expectDenied(await put(await bearer(editor)))
    })

    it('denies a user who is not a guild member', async () => {
      await expectDenied(await put(await bearer(outsider())))
    })

    it('denies a user that no longer exists as a member after leaving', async () => {
      const editor = member([role(1, MANAGE_BOTH)])
      const token = await bearer(editor)
      context.db
        .prepare('DELETE FROM guild_members WHERE user_id = ?')
        .run(editor)
      await expectDenied(await put(token))
    })

    it('checks a global command as well', async () => {
      const globalId = await createCommand('mute', undefined, 'global')
      const url = `/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands/${globalId}/permissions`
      const denied = await put(await bearer(outsider()), OVERRIDES, url)
      expect(denied.status).toBe(403)
      const allowed = await put(
        await bearer(member([role(1, MANAGE_BOTH)])),
        OVERRIDES,
        url
      )
      expect(allowed.status).toBe(200)
    })

    it.each(['/api', ''])('applies under the %s prefix', async (prefix) => {
      const url = `${prefix}/applications/${APP_ID}/guilds/${GUILD}/commands/${commandId}/permissions`
      expect(
        await statusOf(put(await bearer(outsider()), OVERRIDES, url))
      ).toBe(403)
      const editor = await bearer(member([role(1, MANAGE_BOTH)]))
      expect(await statusOf(put(editor, OVERRIDES, url))).toBe(200)
    })
  })

  describe('whether the user can run the command', () => {
    it('treats default_member_permissions null as everyone', async () => {
      const editor = member([role(1, MANAGE_BOTH)])
      expect(await statusOf(put(await bearer(editor)))).toBe(200)
    })

    it('denies a "0" default_member_permissions without Administrator', async () => {
      commandId = await createCommand('lock', '0')
      permissionsUrl = commandUrl(commandId)
      const editor = member([role(1, MANAGE_BOTH)])
      await expectDenied(await put(await bearer(editor)))
    })

    it('lets an Administrator and the owner bypass "0"', async () => {
      commandId = await createCommand('lock', '0')
      permissionsUrl = commandUrl(commandId)
      const admin = member([role(1, ADMINISTRATOR)])
      expect(await statusOf(put(await bearer(admin)))).toBe(200)
      const owner = outsider()
      context.db.prepare('UPDATE guilds SET owner_id = ?').run(owner)
      expect(await statusOf(put(await bearer(owner)))).toBe(200)
    })

    it('requires every bit of default_member_permissions', async () => {
      commandId = await createCommand(
        'kick',
        String(BAN_MEMBERS | MANAGE_GUILD)
      )
      permissionsUrl = commandUrl(commandId)
      const without = member([role(1, MANAGE_BOTH)])
      await expectDenied(await put(await bearer(without)))
      const withAll = member([role(2, MANAGE_BOTH | BAN_MEMBERS)])
      expect(await statusOf(put(await bearer(withAll)))).toBe(200)
    })

    it('lets a user allow overwrite override a restrictive default', async () => {
      commandId = await createCommand('lock', '0')
      permissionsUrl = commandUrl(commandId)
      const editor = member([role(1, MANAGE_BOTH)])
      await storeOverwrites([{ id: editor, type: 2, permission: true }])
      expect(await statusOf(put(await bearer(editor), []))).toBe(200)
    })

    it('denies on a user deny overwrite, even with a role allow', async () => {
      const allowRole = role(1, MANAGE_BOTH)
      const editor = member([allowRole])
      const before = [
        { id: editor, type: 2, permission: false },
        { id: allowRole, type: 1, permission: true },
      ]
      await storeOverwrites(before)
      await expectDenied(await put(await bearer(editor), []), before)
    })

    it('denies when only role denies match', async () => {
      const denyRole = role(1, MANAGE_BOTH)
      const editor = member([denyRole])
      const before = [{ id: denyRole, type: 1, permission: false }]
      await storeOverwrites(before)
      await expectDenied(await put(await bearer(editor), []), before)
    })

    it('lets any role allow win over role denies and @everyone deny', async () => {
      const denyRole = role(1, MANAGE_BOTH)
      const allowRole = role(2)
      const editor = member([denyRole, allowRole])
      await storeOverwrites([
        { id: denyRole, type: 1, permission: false },
        { id: allowRole, type: 1, permission: true },
        { id: GUILD, type: 1, permission: false },
      ])
      expect(await statusOf(put(await bearer(editor), []))).toBe(200)
    })

    it('applies an @everyone deny when no user or role overwrite matches', async () => {
      const editor = member([role(1, MANAGE_BOTH)])
      const before = [{ id: GUILD, type: 1, permission: false }]
      await storeOverwrites(before)
      await expectDenied(await put(await bearer(editor), []), before)
    })

    it('lets an @everyone allow beat a restrictive default', async () => {
      commandId = await createCommand('lock', '0')
      permissionsUrl = commandUrl(commandId)
      await storeOverwrites([{ id: GUILD, type: 1, permission: true }])
      const editor = member([role(1, MANAGE_BOTH)])
      expect(await statusOf(put(await bearer(editor), []))).toBe(200)
    })

    it('ignores channel overwrites and overwrites of roles the user lacks', async () => {
      const editor = member([role(1, MANAGE_BOTH)])
      await storeOverwrites([
        { id: GUILD, type: 3, permission: false },
        { id: '333333333333333333', type: 3, permission: false },
        { id: role(2), type: 1, permission: false },
      ])
      expect(await statusOf(put(await bearer(editor), []))).toBe(200)
    })
  })

  describe('role entries in the payload', () => {
    it('allows roles strictly below the highest role', async () => {
      const low = role(1)
      const highest = role(5, MANAGE_BOTH)
      const editor = member([role(2), highest])
      const entries = [{ id: low, type: 1, permission: true }]
      expect(await statusOf(put(await bearer(editor), entries))).toBe(200)
      expect(await stored()).toEqual(entries)
    })

    it('denies the highest role itself', async () => {
      const highest = role(5, MANAGE_BOTH)
      const editor = member([highest])
      await expectDenied(
        await put(await bearer(editor), [
          { id: highest, type: 1, permission: true },
        ])
      )
    })

    it('denies a role above the highest role, even for an Administrator', async () => {
      const admin = member([role(2, ADMINISTRATOR)])
      await expectDenied(
        await put(await bearer(admin), [
          { id: role(3), type: 1, permission: true },
        ])
      )
    })

    it('orders equal positions by ID, lower IDs ranking higher', async () => {
      const older = role(4)
      const newer = role(4, MANAGE_BOTH)
      const editor = member([newer])
      await expectDenied(
        await put(await bearer(editor), [
          { id: older, type: 1, permission: true },
        ])
      )
      const older2 = member([older])
      context.db
        .prepare('UPDATE roles SET permissions = ? WHERE id = ?')
        .run(String(MANAGE_BOTH), older)
      const allowed = await put(await bearer(older2), [
        { id: newer, type: 1, permission: true },
      ])
      expect(allowed.status).toBe(200)
    })

    it('denies an unknown role and a role of another guild', async () => {
      const editor = member([role(5, MANAGE_BOTH)])
      const token = await bearer(editor)
      context.db
        .prepare(
          "INSERT INTO guilds (id, name, owner_id, bot_token) VALUES ('333333333333333330', 'Other', ?, ?)"
        )
        .run(APP_ID, BOT_TOKEN)
      context.db
        .prepare(
          "INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('700000000000009999', '333333333333333330', 'x', 1, '0')"
        )
        .run()
      for (const id of ['700000000000000001', '700000000000009999', 'role']) {
        await expectDenied(
          await put(token, [{ id, type: 1, permission: true }])
        )
      }
    })

    it('exempts the owner from the hierarchy but not from existence', async () => {
      const owner = outsider()
      context.db.prepare('UPDATE guilds SET owner_id = ?').run(owner)
      const token = await bearer(owner)
      const top = role(99)
      expect(
        await statusOf(put(token, [{ id: top, type: 1, permission: true }]))
      ).toBe(200)
      const before = await stored()
      for (const id of ['700000000000000777', 'role'])
        await expectDenied(
          await put(token, [{ id, type: 1, permission: true }]),
          before
        )
    })

    it('does not check the @everyone entry, user entries or channel entries', async () => {
      const editor = member([role(1, MANAGE_BOTH)])
      const entries = [
        { id: GUILD, type: 1, permission: false },
        { id: '999999999999999991', type: 2, permission: true },
        { id: '999999999999999992', type: 3, permission: true },
      ]
      expect(await statusOf(put(await bearer(editor), entries))).toBe(200)
      expect(await stored()).toEqual(entries)
    })

    it('validates the payload before authorization', async () => {
      const response = await put(await bearer(outsider()), [
        { id: 'x', type: 9, permission: true },
      ])
      expect(response.status).toBe(400)
    })

    it('returns 404 for an unknown command before authorization', async () => {
      const response = await put(
        await bearer(outsider()),
        OVERRIDES,
        commandUrl('999999999999999999')
      )
      expect(response.status).toBe(404)
    })
  })

  describe('unchanged credentials', () => {
    /** Entries that a user-bound token would be denied (unknown and top roles). */
    const risky = (): { id: string; type: number; permission: boolean }[] => [
      { id: role(99), type: 1, permission: true },
      { id: '700000000000009998', type: 1, permission: true },
    ]

    it('keeps client-credentials tokens unauthenticated by user', async () => {
      const issued = await context.app.request('/api/v10/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP_ID,
          scope: SCOPE,
        }),
      })
      const token = (await issued.json()) as TokenResponse
      const entries = risky()
      const response = await put(`Bearer ${token.access_token}`, entries)
      expect(response.status).toBe(200)
      expect(await stored()).toEqual(entries)
    })

    it('keeps the owning bot token unchanged', async () => {
      const entries = risky()
      expect(await statusOf(put(BOT_TOKEN, entries))).toBe(200)
      expect(await stored()).toEqual(entries)
    })

    it('keeps the scope and application checks for user-bound tokens', async () => {
      const editor = member([role(1, ADMINISTRATOR)])
      const noScope = await put(await bearer(editor, 'identify'))
      expect(noScope.status).toBe(403)
      await expect(noScope.json()).resolves.toMatchObject({ code: 50_001 })
      const other = await context.app.request('/_test/oauth2/tokens', {
        method: 'POST',
        body: JSON.stringify({
          client_id: '999999999999999999',
          user_id: editor,
          scope: SCOPE,
        }),
      })
      const otherToken = (await other.json()) as TokenResponse
      const response = await put(`Bearer ${otherToken.access_token}`)
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ code: 50_001 })
    })

    it('does not change GET authorization for user-bound tokens', async () => {
      const response = await context.app.request(permissionsUrl, {
        headers: { Authorization: await bearer(outsider()) },
      })
      expect(response.status).toBe(200)
    })
  })
})
