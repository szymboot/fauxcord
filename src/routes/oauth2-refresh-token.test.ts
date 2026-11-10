import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFullTestApp, seedBot, seedGuild } from '../test-helpers'
import type { FullTestContext } from '../test-helpers'
import type { TokenResponse } from '../services/oauth2'

const APP_ID = '111111111111111111'
const USER_ID = '555555555555555555'
const BOT_TOKEN = 'Bot refresh-grant-test'
const SECRET = 'registered-secret'
const SCOPE = 'identify applications.commands.permissions.update'

/** Awaits a (possibly synchronous) response and parses its token body. */
async function tokenBody(
  response: Promise<Response> | Response
): Promise<TokenResponse> {
  const resolved = await response
  return (await resolved.json()) as TokenResponse
}

/** Awaits a (possibly synchronous) response and returns its status. */
async function statusOf(
  response: Promise<Response> | Response
): Promise<number> {
  const resolved = await response
  return resolved.status
}

describe('POST /oauth2/token (refresh_token)', () => {
  let context: FullTestContext

  /** Registers a user-bound token for the test client. */
  async function issue(
    extra: Record<string, unknown> = {}
  ): Promise<TokenResponse> {
    const response = await context.app.request('/_test/oauth2/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: APP_ID,
        user_id: USER_ID,
        scope: SCOPE,
        client_secret: SECRET,
        ...extra,
      }),
    })
    expect(response.status).toBe(201)
    return (await response.json()) as TokenResponse
  }

  /** Posts a form to the token endpoint. */
  function post(
    form: Record<string, string>,
    headers: Record<string, string> = {},
    prefix = '/api/v10'
  ): Promise<Response> | Response {
    return context.app.request(`${prefix}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: new URLSearchParams(form),
    })
  }

  /** Refreshes with client_secret_post credentials. */
  function refreshWithBody(
    refreshToken: string,
    secret = SECRET,
    clientId = APP_ID
  ): Promise<Response> | Response {
    return post({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: secret,
    })
  }

  /** Builds a client_secret_basic Authorization header. */
  function basic(clientId: string, secret: string): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
    }
  }

  /** Reads the Bearer identity endpoint. */
  function me(accessToken: string): Promise<Response> | Response {
    return context.app.request('/api/v10/oauth2/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  }

  /** Counts stored access tokens. */
  function tokenCount(): number {
    return (
      context.db
        .prepare('SELECT COUNT(*) AS n FROM oauth2_access_tokens')
        .get() as { n: number }
    ).n
  }

  beforeEach(() => {
    context = createFullTestApp()
    seedBot(context.db, BOT_TOKEN, APP_ID)
    context.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'Dash', '0', 0)"
      )
      .run(USER_ID)
  })

  afterEach(() => {
    context.cleanup()
  })

  it('refreshes with client credentials in the form body', async () => {
    const original = await issue()
    const response = await refreshWithBody(original.refresh_token ?? '')
    expect(response.status).toBe(200)
    const refreshed = (await response.json()) as TokenResponse
    expect(refreshed).toMatchObject({
      token_type: 'Bearer',
      expires_in: 604_800,
      scope: SCOPE,
    })
    expect(refreshed.access_token).toMatch(/^mock_access_token_/)
    expect(refreshed.refresh_token).toMatch(/^mock_refresh_token_/)
    expect(refreshed.access_token).not.toBe(original.access_token)
    expect(refreshed.refresh_token).not.toBe(original.refresh_token)
  })

  it.each(['/api/v10', '/api', ''])(
    'refreshes under the %j route prefix',
    async (prefix) => {
      const original = await issue()
      const response = await post(
        {
          grant_type: 'refresh_token',
          refresh_token: original.refresh_token ?? '',
          client_id: APP_ID,
          client_secret: SECRET,
        },
        {},
        prefix
      )
      expect(response.status).toBe(200)
    }
  )

  it('refreshes with Authorization: Basic credentials', async () => {
    const original = await issue()
    const response = await post(
      {
        grant_type: 'refresh_token',
        refresh_token: original.refresh_token ?? '',
      },
      basic(APP_ID, SECRET)
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ scope: SCOPE })
  })

  it('decodes form-urlencoded Basic credentials containing colons', async () => {
    const secret = 'a:b c/é'
    const original = await issue({ client_secret: secret })
    const encoded = `${encodeURIComponent(APP_ID)}:${encodeURIComponent(secret)}`
    const response = await post(
      {
        grant_type: 'refresh_token',
        refresh_token: original.refresh_token ?? '',
      },
      {
        Authorization: `Basic ${Buffer.from(encoded).toString('base64')}`,
      }
    )
    expect(response.status).toBe(200)
  })

  it('rejects a wrong secret with 401 invalid_client and keeps the token', async () => {
    const original = await issue()
    for (const response of [
      await refreshWithBody(original.refresh_token ?? '', 'wrong'),
      await post(
        {
          grant_type: 'refresh_token',
          refresh_token: original.refresh_token ?? '',
        },
        basic(APP_ID, 'wrong')
      ),
    ]) {
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: 'invalid_client',
      })
    }
    expect(await statusOf(refreshWithBody(original.refresh_token ?? ''))).toBe(
      200
    )
  })

  it('rejects an unknown client and missing credentials with 401', async () => {
    const original = await issue()
    const refreshToken = original.refresh_token ?? ''
    const responses = [
      await refreshWithBody(refreshToken, SECRET, 'unknown-client'),
      await post({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      await post(
        { grant_type: 'refresh_token', refresh_token: refreshToken },
        { Authorization: 'Basic !!!not-base64-with-colon' }
      ),
      await post(
        {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: 'other',
        },
        basic(APP_ID, SECRET)
      ),
    ]
    for (const response of responses) {
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: 'invalid_client',
      })
    }
  })

  it('rejects a missing refresh_token with 400 invalid_request', async () => {
    await issue()
    const response = await post({
      grant_type: 'refresh_token',
      client_id: APP_ID,
      client_secret: SECRET,
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
    })
  })

  it('rejects an unknown refresh token with 400 invalid_grant', async () => {
    await issue()
    const response = await refreshWithBody('mock_refresh_token_unknown')
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' })
  })

  it('rejects a revoked refresh token with 400 invalid_grant', async () => {
    const original = await issue()
    await context.app.request('/api/v10/oauth2/token/revoke', {
      method: 'POST',
      body: new URLSearchParams({ token: original.refresh_token ?? '' }),
    })
    const response = await refreshWithBody(original.refresh_token ?? '')
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' })
  })

  it('rejects a refresh token whose access token was revoked', async () => {
    const original = await issue()
    await context.app.request('/api/v10/oauth2/token/revoke', {
      method: 'POST',
      body: new URLSearchParams({ token: original.access_token }),
    })
    const response = await refreshWithBody(original.refresh_token ?? '')
    expect(response.status).toBe(400)
  })

  it('treats a refresh token as single-use', async () => {
    const original = await issue()
    const first = await refreshWithBody(original.refresh_token ?? '')
    expect(first.status).toBe(200)
    const reused = await refreshWithBody(original.refresh_token ?? '')
    expect(reused.status).toBe(400)
    await expect(reused.json()).resolves.toEqual({ error: 'invalid_grant' })
    // The newer refresh token is untouched by the failed reuse.
    const refreshed = (await first.json()) as TokenResponse
    expect(await statusOf(refreshWithBody(refreshed.refresh_token ?? ''))).toBe(
      200
    )
  })

  it("rejects another client's refresh token and keeps it usable", async () => {
    const original = await issue()
    await issue({ client_id: 'other-client', client_secret: 'other-secret' })
    const response = await refreshWithBody(
      original.refresh_token ?? '',
      'other-secret',
      'other-client'
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' })
    expect(await statusOf(refreshWithBody(original.refresh_token ?? ''))).toBe(
      200
    )
  })

  it('refreshes an expired access token', async () => {
    const original = await issue({ expires_in: 1 })
    context.db
      .prepare(
        "UPDATE oauth2_access_tokens SET expires_at = datetime('now', '-1 hour')"
      )
      .run()
    expect(await statusOf(me(original.access_token))).toBe(401)
    const response = await refreshWithBody(original.refresh_token ?? '')
    expect(response.status).toBe(200)
    const refreshed = (await response.json()) as TokenResponse
    expect(await statusOf(me(refreshed.access_token))).toBe(200)
  })

  it('invalidates the old access token and replaces the stored pair', async () => {
    const original = await issue()
    expect(await statusOf(me(original.access_token))).toBe(200)
    const refreshed = await tokenBody(
      refreshWithBody(original.refresh_token ?? '')
    )
    expect(await statusOf(me(original.access_token))).toBe(401)
    expect(await statusOf(me(refreshed.access_token))).toBe(200)
    expect(tokenCount()).toBe(1)
  })

  it('authorizes the refreshed token like the original for @me', async () => {
    const original = await issue()
    const refreshed = await tokenBody(
      refreshWithBody(original.refresh_token ?? '')
    )
    const response = await me(refreshed.access_token)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      user: { id: USER_ID, username: 'Dash' },
      scopes: SCOPE.split(' '),
    })
  })

  it('refreshes a token from the authorization_code flow', async () => {
    const authorize = await context.app.request(
      `/api/v10/oauth2/authorize?${new URLSearchParams({
        client_id: 'code-client',
        redirect_uri: 'http://localhost/cb',
        response_type: 'code',
        scope: 'identify',
      })}`
    )
    const code = new URL(
      authorize.headers.get('location') ?? ''
    ).searchParams.get('code')
    const exchanged = await tokenBody(
      post({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: 'http://localhost/cb',
      })
    )
    const response = await refreshWithBody(
      exchanged.refresh_token ?? '',
      'mock_secret',
      'code-client'
    )
    expect(response.status).toBe(200)
  })

  it('does not hand out refresh tokens for client_credentials', async () => {
    const response = await post({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      scope: 'identify',
    })
    const token = (await response.json()) as TokenResponse
    expect(token.refresh_token).toBeUndefined()
    expect(
      await statusOf(refreshWithBody(token.access_token, 'mock_secret'))
    ).toBe(400)
  })

  it('removes the refreshed token with its setup', async () => {
    const original = await issue()
    const refreshed = await tokenBody(
      refreshWithBody(original.refresh_token ?? '')
    )
    expect(await statusOf(me(refreshed.access_token))).toBe(200)
    const deleted = await context.app.request(
      `/_test/setup/${encodeURIComponent(BOT_TOKEN)}`,
      { method: 'DELETE' }
    )
    expect(deleted.status).toBe(204)
    expect(await statusOf(me(refreshed.access_token))).toBe(401)
    expect(tokenCount()).toBe(0)
    expect(await statusOf(refreshWithBody(refreshed.refresh_token ?? ''))).toBe(
      400
    )
  })
})

describe('refreshed user-bound command permission edits', () => {
  const GUILD_OWNER = USER_ID
  let context: FullTestContext

  beforeEach(() => {
    context = createFullTestApp()
    seedBot(context.db, BOT_TOKEN, APP_ID)
    context.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'Dash', '0', 0)"
      )
      .run(GUILD_OWNER)
  })

  afterEach(() => {
    context.cleanup()
  })

  it('keeps authorizing a command permission edit after a refresh', async () => {
    const guildId = seedGuild(context.db, BOT_TOKEN)
    context.db
      .prepare('UPDATE guilds SET owner_id = ? WHERE id = ?')
      .run(GUILD_OWNER, guildId)
    context.db
      .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
      .run(guildId, GUILD_OWNER)
    const created = await context.app.request(
      `/api/v10/applications/${APP_ID}/guilds/${guildId}/commands`,
      {
        method: 'POST',
        headers: {
          Authorization: BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'ping', description: 'Ping' }),
      }
    )
    expect(created.status).toBe(201)
    const { id: commandId } = (await created.json()) as { id: string }

    const issued = await tokenBody(
      context.app.request('/_test/oauth2/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: APP_ID,
          user_id: GUILD_OWNER,
          scope: 'applications.commands.permissions.update',
          client_secret: SECRET,
        }),
      })
    )
    const refreshed = await tokenBody(
      context.app.request('/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token ?? '',
          client_id: APP_ID,
          client_secret: SECRET,
        }),
      })
    )

    const url = `/api/v10/applications/${APP_ID}/guilds/${guildId}/commands/${commandId}/permissions`
    const overrides = [{ id: '888888888888888888', type: 2, permission: true }]
    const stale = await context.app.request(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${issued.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permissions: overrides }),
    })
    expect(stale.status).toBe(401)

    const edit = await context.app.request(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${refreshed.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permissions: overrides }),
    })
    expect(edit.status).toBe(200)
  })
})

describe('POST /_test/oauth2/tokens client_secret', () => {
  let context: FullTestContext

  /** Posts a token fixture request. */
  function issue(body: unknown): Promise<Response> | Response {
    return context.app.request('/_test/oauth2/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** Reads a stored client secret. */
  function storedSecret(clientId: string): string | undefined {
    return (
      context.db
        .prepare('SELECT client_secret FROM oauth2_clients WHERE client_id = ?')
        .get(clientId) as { client_secret: string } | undefined
    )?.client_secret
  }

  const base = { client_id: APP_ID, user_id: USER_ID, scope: 'identify' }

  beforeEach(() => {
    context = createFullTestApp()
    seedBot(context.db, BOT_TOKEN, APP_ID)
    context.db
      .prepare(
        "INSERT INTO users (id, username, discriminator, bot) VALUES (?, 'Dash', '0', 0)"
      )
      .run(USER_ID)
  })

  afterEach(() => {
    context.cleanup()
  })

  it('creates a new client with the given secret', async () => {
    expect(await statusOf(issue({ ...base, client_secret: 'fresh' }))).toBe(201)
    expect(storedSecret(APP_ID)).toBe('fresh')
  })

  it('updates the secret of an existing client', async () => {
    await issue(base)
    expect(storedSecret(APP_ID)).toBe('mock_secret')
    expect(await statusOf(issue({ ...base, client_secret: 'rotated' }))).toBe(
      201
    )
    expect(storedSecret(APP_ID)).toBe('rotated')
  })

  it('keeps the stored secret when client_secret is omitted', async () => {
    await issue({ ...base, client_secret: 'kept' })
    await issue(base)
    expect(storedSecret(APP_ID)).toBe('kept')
  })

  it('defaults a new client to mock_secret when omitted', async () => {
    await issue({ ...base, client_id: 'plain-client' })
    expect(storedSecret('plain-client')).toBe('mock_secret')
  })

  it.each<[string, unknown]>([
    ['empty', ''],
    ['numeric', 5],
    ['null', null],
    ['array', ['a']],
    ['too long', 'x'.repeat(201)],
  ])('rejects a %s client_secret with 400 / 50035', async (_name, secret) => {
    const response = await issue({ ...base, client_secret: secret })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 50_035,
      errors: { client_secret: { _errors: [{}] } },
    })
    expect(storedSecret(APP_ID)).toBeUndefined()
  })

  it('does not change an existing secret when the request is rejected', async () => {
    await issue({ ...base, client_secret: 'kept' })
    await issue({ ...base, client_secret: 'rotated', scope: '' })
    await issue({
      ...base,
      client_secret: 'rotated',
      user_id: '999999999999999999',
    })
    expect(storedSecret(APP_ID)).toBe('kept')
  })
})
