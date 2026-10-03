import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFullTestApp, seedBot, seedGuild } from '../test-helpers'
import type { FullTestContext } from '../test-helpers'
import type { TokenResponse } from '../services/oauth2'

const APPLICATION_ID = '111111111111111111'
const BOT_TOKEN = 'Bot permissions-test'
const SCOPE = 'applications.commands.permissions.update'
const OVERRIDES = [
  { id: '555555555555555555', type: 1, permission: true },
  { id: '666666666666666666', type: 2, permission: false },
]

describe.each(['/api/v10', '/api', ''])(
  'OAuth command permissions under %s',
  (prefix) => {
    let context: FullTestContext
    let commandsUrl: string
    let permissionsUrl: string
    let commandId: string

    /** Issues a real local OAuth token through the existing token route. */
    async function issueToken(
      scope = SCOPE,
      clientId = APPLICATION_ID
    ): Promise<string> {
      const response = await context.app.request(`${prefix}/oauth2/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          scope,
        }),
      })
      expect(response.status).toBe(200)
      const token = (await response.json()) as TokenResponse
      return `Bearer ${token.access_token}`
    }

    /** Calls one of the three permission operations with optional credentials. */
    async function requestPermissions(
      operation: string,
      authorization?: string,
      body = JSON.stringify({ permissions: OVERRIDES })
    ): Promise<Response> {
      return context.app.request(
        operation === 'list' ? `${commandsUrl}/permissions` : permissionsUrl,
        {
          method: operation === 'edit' ? 'PUT' : 'GET',
          headers: {
            ...(authorization && { Authorization: authorization }),
            'Content-Type': 'application/json',
          },
          ...(operation === 'edit' && { body }),
        }
      )
    }

    beforeEach(async () => {
      context = createFullTestApp()
      seedBot(context.db, BOT_TOKEN, APPLICATION_ID)
      const guildId = seedGuild(context.db, BOT_TOKEN)
      commandsUrl = `${prefix}/applications/${APPLICATION_ID}/guilds/${guildId}/commands`
      const response = await context.app.request(commandsUrl, {
        method: 'POST',
        headers: {
          Authorization: BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'ban', description: 'Ban a member' }),
      })
      expect(response.status).toBe(201)
      const command = (await response.json()) as { id: string }
      commandId = command.id
      permissionsUrl = `${commandsUrl}/${commandId}/permissions`
    })

    afterEach(() => {
      context.cleanup()
    })

    it.each(['guild', 'global'])(
      'writes, replaces, reads and clears stored permissions for a %s command',
      async (scope) => {
        if (scope === 'global') {
          const response = await context.app.request(
            `${prefix}/applications/${APPLICATION_ID}/commands`,
            {
              method: 'POST',
              headers: {
                Authorization: BOT_TOKEN,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                name: 'mute',
                description: 'Mute a member',
              }),
            }
          )
          const command = (await response.json()) as { id: string }
          permissionsUrl = `${commandsUrl}/${command.id}/permissions`
        }
        const authorization = await issueToken(`identify ${SCOPE}`)
        for (const permissions of [OVERRIDES, [OVERRIDES[1]], []]) {
          const edited = await requestPermissions(
            'edit',
            authorization,
            JSON.stringify({ permissions })
          )
          expect(edited.status).toBe(200)
          await expect(edited.json()).resolves.toMatchObject({ permissions })
          for (const credential of [authorization, BOT_TOKEN]) {
            const fetched = await requestPermissions('get', credential)
            expect(fetched.status).toBe(200)
            await expect(fetched.json()).resolves.toMatchObject({ permissions })
          }
          const listed = await requestPermissions('list', authorization)
          expect(listed.status).toBe(200)
          await expect(listed.json()).resolves.toMatchObject([{ permissions }])
        }
      }
    )

    it('accepts a token exchanged through the authorization-code flow', async () => {
      const redirectUri = 'http://localhost/callback'
      const authorize = await context.app.request(
        `${prefix}/oauth2/authorize?${new URLSearchParams({
          client_id: APPLICATION_ID,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPE,
        })}`
      )
      expect(authorize.status).toBe(302)
      const code = new URL(
        authorize.headers.get('Location') ?? ''
      ).searchParams.get('code')
      const exchanged = await context.app.request(`${prefix}/oauth2/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code ?? '',
          redirect_uri: redirectUri,
        }),
      })
      expect(exchanged.status).toBe(200)
      const token = (await exchanged.json()) as TokenResponse
      const response = await requestPermissions(
        'edit',
        `Bearer ${token.access_token}`
      )
      expect(response.status).toBe(200)
    })

    describe.each(['list', 'get', 'edit'])('%s authorization', (operation) => {
      it.each([
        undefined,
        'Bearer unknown',
        'Bearer',
        'Basic invalid',
        'Bearer permissions-test',
        'Bearer Bot permissions-test',
      ])(
        'rejects missing, malformed or invalid credentials %s',
        async (authorization) => {
          const response = await requestPermissions(operation, authorization)
          expect(response.status).toBe(401)
          await expect(response.json()).resolves.toMatchObject({ code: 0 })
        }
      )

      it.each(['expired', 'revoked'])('rejects a %s token', async (state) => {
        const authorization = await issueToken()
        const token = authorization.slice(7)
        if (state === 'expired') {
          context.db
            .prepare(
              "UPDATE oauth2_access_tokens SET expires_at = datetime('now', '-1 second') WHERE token = ?"
            )
            .run(token)
        } else {
          await context.app.request(`${prefix}/oauth2/token/revoke`, {
            method: 'POST',
            body: new URLSearchParams({ token }),
          })
        }
        const response = await requestPermissions(operation, authorization)
        expect(response.status).toBe(401)
      })

      it.each([
        '',
        'identify',
        'applications.commands.update',
        `${SCOPE}.extra`,
      ])('rejects insufficient scope %s', async (scope) => {
        const response = await requestPermissions(
          operation,
          await issueToken(scope)
        )
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toMatchObject({ code: 50_001 })
      })

      it('rejects credentials for another application', async () => {
        for (const authorization of [
          await issueToken(SCOPE, '999999999999999999'),
          'Bot other',
        ]) {
          seedBot(context.db, 'Bot other', '999999999999999999')
          const response = await requestPermissions(operation, authorization)
          expect(response.status).toBe(403)
        }
        const readback = await requestPermissions('get', BOT_TOKEN)
        await expect(readback.json()).resolves.toMatchObject({
          permissions: [],
        })
      })

      it('preserves owning Bot access', async () => {
        const response = await requestPermissions(operation, BOT_TOKEN)
        expect(response.status).toBe(200)
      })
    })

    it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])(
      'does not authorize unrelated command CRUD with a permission token (%s)',
      async (method) => {
        const authorization = await issueToken()
        for (const url of [
          `${prefix}/applications/${APPLICATION_ID}/commands`,
          commandsUrl,
        ]) {
          const response = await context.app.request(
            ['PATCH', 'DELETE'].includes(method) ? `${url}/${commandId}` : url,
            { method, headers: { Authorization: authorization } }
          )
          expect(response.status).toBe(403)
        }
      }
    )

    it.each(['get', 'edit'])(
      'returns 404 for an unknown command with %s',
      async (operation) => {
        permissionsUrl = `${commandsUrl}/missing/permissions`
        const response = await requestPermissions(operation, await issueToken())
        expect(response.status).toBe(404)
      }
    )

    it.each(['list', 'get', 'edit'])(
      'returns 404 for an unknown guild with %s',
      async (operation) => {
        commandsUrl = `${prefix}/applications/${APPLICATION_ID}/guilds/missing/commands`
        permissionsUrl = `${commandsUrl}/${commandId}/permissions`
        const response = await requestPermissions(operation, await issueToken())
        expect(response.status).toBe(404)
      }
    )

    it.each([
      'not json',
      '{}',
      '{"permissions":null}',
      '{"permissions":{}}',
      '{"permissions":[null]}',
      '{"permissions":[{"id":"role","type":4,"permission":true}]}',
      '{"permissions":[{"id":"role","type":1,"permission":"true"}]}',
    ])(
      'rejects malformed permission payload %s without mutating stored overrides',
      async (body) => {
        const authorization = await issueToken()
        const edited = await requestPermissions('edit', authorization)
        expect(edited.status).toBe(200)
        const response = await requestPermissions('edit', authorization, body)
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({ code: 50_035 })
        const readback = await requestPermissions('get', authorization)
        await expect(readback.json()).resolves.toMatchObject({
          permissions: OVERRIDES,
        })
      }
    )

    it('accepts 100 overrides and rejects 101 without changing storage', async () => {
      const authorization = await issueToken()
      const permissions = Array.from({ length: 100 }, (_, index) => ({
        id: String(700_000_000_000_000_000n + BigInt(index)),
        type: 3,
        permission: true,
      }))
      const edited = await requestPermissions(
        'edit',
        authorization,
        JSON.stringify({ permissions })
      )
      expect(edited.status).toBe(200)
      const rejected = await requestPermissions(
        'edit',
        authorization,
        JSON.stringify({ permissions: [...permissions, OVERRIDES[0]] })
      )
      expect(rejected.status).toBe(400)
      const readback = await requestPermissions('get', authorization)
      await expect(readback.json()).resolves.toMatchObject({ permissions })
    })
  }
)
