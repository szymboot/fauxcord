/**
 * OAuth2 API routing
 *
 * Implements the /oauth2/* endpoints.
 */

import { Hono } from 'hono'
import type { Database } from '../db'
import {
  authenticateClient,
  createAuthCode,
  exchangeAuthCode,
  createClientCredentialsToken,
  revokeToken,
  getOAuth2Me,
  getOpenIdUserInfo,
  getPublicKeys,
  refreshAccessToken,
} from '../services/oauth2'

/** Client credentials presented to the token endpoint. */
interface ClientCredentials {
  clientId: string
  clientSecret: string
  /** True when the credentials came from an `Authorization: Basic` header. */
  basic: boolean
}

/**
 * Tells whether an Authorization header uses the Basic scheme.
 * @param authorization - Authorization header value
 * @returns True for a Basic credential
 */
function isBasicAuthorization(authorization: string | undefined): boolean {
  return authorization?.toLowerCase().startsWith('basic ') ?? false
}

/**
 * Decodes a Basic-auth credential component (form-urlencoded per RFC 6749).
 * @param value - Raw component
 * @returns Decoded component, or null when it is malformed
 */
function decodeBasicComponent(value: string): string | null {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '))
  } catch {
    return null
  }
}

/**
 * Extracts the client credentials of a token request, from the
 * `Authorization: Basic` header (client_secret_basic) or the form body
 * (client_secret_post). The header wins when it is present.
 * @param authorization - Authorization header value
 * @param params - Parsed form body
 * @returns The credentials, or null when missing or malformed
 */
function readClientCredentials(
  authorization: string | undefined,
  params: URLSearchParams
): ClientCredentials | null {
  if (authorization && isBasicAuthorization(authorization)) {
    const decoded = Buffer.from(
      authorization.slice(6).trim(),
      'base64'
    ).toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator === -1) return null
    const clientId = decodeBasicComponent(decoded.slice(0, separator))
    const clientSecret = decodeBasicComponent(decoded.slice(separator + 1))
    if (!clientId || clientSecret === null) return null
    const bodyClientId = params.get('client_id')
    return bodyClientId && bodyClientId !== clientId
      ? null
      : { clientId, clientSecret, basic: true }
  }
  const clientId = params.get('client_id')
  const clientSecret = params.get('client_secret')
  return !clientId || clientSecret === null
    ? null
    : { clientId, clientSecret, basic: false }
}

/**
 * Creates the OAuth2 API routes.
 * @param db - Database
 * @returns Hono router instance
 */
export function createOAuth2Routes(db: Database): Hono {
  const app = new Hono()

  // GET /oauth2/keys — Public JSON Web Key discovery
  app.get('/oauth2/keys', (c) => c.json(getPublicKeys()))

  // GET /oauth2/userinfo — OpenID identity for a local Bearer credential
  app.get('/oauth2/userinfo', (c) => {
    const authorization = c.req.header('Authorization')
    if (!authorization?.startsWith('Bearer ')) {
      return c.json({ message: '401: Unauthorized', code: 0 }, 401)
    }
    const userInfo = getOpenIdUserInfo(db, authorization.slice(7))
    return userInfo
      ? c.json(userInfo)
      : c.json({ message: '401: Unauthorized', code: 0 }, 401)
  })

  // GET /oauth2/@me — Retrieve OAuth2 access token information
  app.get('/oauth2/@me', (c) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ message: '401: Unauthorized', code: 0 }, 401)
    }
    const token = authHeader.slice(7)
    const me = getOAuth2Me(db, token)
    return me
      ? c.json(me)
      : c.json({ message: '401: Unauthorized', code: 0 }, 401)
  })

  // GET /oauth2/authorize — Redirect for the OAuth2 authorization code flow
  app.get('/oauth2/authorize', (c) => {
    const clientId = c.req.query('client_id')
    const redirectUri = c.req.query('redirect_uri')
    const responseType = c.req.query('response_type')
    const scope = c.req.query('scope') ?? ''
    const state = c.req.query('state')

    if (!clientId || !redirectUri || responseType !== 'code') {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }

    // oauth2_auth_codes references oauth2_clients (FK) and users (not an FK, but referenced by getOAuth2Me),
    // so ensure the client and the default user exist first
    db.prepare(
      'INSERT OR IGNORE INTO oauth2_clients (client_id, client_secret) VALUES (?, ?)'
    ).run(clientId, 'mock_secret')
    const defaultUserId = '2222222222222222222'
    db.prepare(
      'INSERT OR IGNORE INTO users (id, username, discriminator, bot) VALUES (?, ?, ?, 0)'
    ).run(defaultUserId, 'MockUser', '0')

    // The mock redirects immediately without showing an authorization page
    const code = createAuthCode(db, clientId, defaultUserId, scope, redirectUri)

    const redirectUrl = new URL(redirectUri)
    redirectUrl.searchParams.set('code', code)
    if (state) redirectUrl.searchParams.set('state', state)

    return c.redirect(redirectUrl.href)
  })

  // POST /oauth2/token — Issue an OAuth2 token (authorization_code,
  // client_credentials, refresh_token)
  app.post('/oauth2/token', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    let params: URLSearchParams

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const body = await c.req.text()
      params = new URLSearchParams(body)
    } else {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }

    const grantType = params.get('grant_type')

    if (grantType === 'authorization_code') {
      const code = params.get('code')
      const redirectUri = params.get('redirect_uri')

      if (!code || !redirectUri) {
        return c.json({ message: '400: Bad Request', code: 0 }, 400)
      }

      const tokenResponse = exchangeAuthCode(db, code, redirectUri)
      return tokenResponse
        ? c.json(tokenResponse)
        : c.json({ message: '401: Unauthorized', code: 0 }, 401)
    }

    if (grantType === 'client_credentials') {
      const scope = params.get('scope') ?? 'identify'
      const clientId = params.get('client_id') ?? 'mock_client'

      // oauth2_access_tokens has an FK reference to oauth2_clients,
      // so the client must exist before issuing a token
      const existing = db
        .prepare('SELECT client_id FROM oauth2_clients WHERE client_id = ?')
        .get(clientId)
      if (!existing) {
        db.prepare(
          'INSERT OR IGNORE INTO oauth2_clients (client_id, client_secret) VALUES (?, ?)'
        ).run(clientId, 'mock_secret')
      }

      const tokenResponse = createClientCredentialsToken(db, clientId, scope)
      return c.json(tokenResponse)
    }

    if (grantType === 'refresh_token') {
      const credentials = readClientCredentials(
        c.req.header('Authorization'),
        params
      )
      if (
        !credentials ||
        !authenticateClient(db, credentials.clientId, credentials.clientSecret)
      ) {
        if (
          credentials?.basic ??
          isBasicAuthorization(c.req.header('Authorization'))
        ) {
          c.header('WWW-Authenticate', 'Basic')
        }
        return c.json({ error: 'invalid_client' }, 401)
      }

      const refreshToken = params.get('refresh_token')
      if (!refreshToken) return c.json({ error: 'invalid_request' }, 400)

      const tokenResponse = refreshAccessToken(
        db,
        credentials.clientId,
        refreshToken
      )
      return tokenResponse
        ? c.json(tokenResponse)
        : c.json({ error: 'invalid_grant' }, 400)
    }

    return c.json({ message: '400: Bad Request', code: 0 }, 400)
  })

  // POST /oauth2/token/revoke — Revoke an OAuth2 token
  app.post('/oauth2/token/revoke', async (c) => {
    const body = await c.req.text()
    const params = new URLSearchParams(body)
    const token = params.get('token')

    if (!token) {
      return c.json({ message: '400: Bad Request', code: 0 }, 400)
    }

    revokeToken(db, token)
    return c.json({})
  })

  return app
}
