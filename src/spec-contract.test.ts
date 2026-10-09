/**
 * @file spec-contract.test.ts
 * @description Contract tests that validate Fauxcord's mock responses against the
 * committed Discord OpenAPI spec snapshot (`spec/openapi.json`).
 *
 * These tests use Ajv (JSON Schema 2020-12 mode) to compile and validate the
 * response schema for every declared success branch in `spec/manifest.ts`.
 *
 * ## How the snapshot update cycle works
 *
 * 1. The weekly GitHub Actions workflow detects a diff in the upstream spec and
 *    opens an issue.
 * 2. A maintainer runs `pnpm spec:update` on a branch to update `spec/openapi.json`.
 * 3. A PR is opened; these tests re-run against the NEW snapshot, surfacing any
 *    mock responses that no longer match the updated spec.
 * 4. The maintainer fixes the mock (or adds a justified skip in `spec/skip.ts`)
 *    until all tests pass, then merges.
 *
 * ## Ajv configuration
 *
 * - Ajv v8 `ajv/dist/2020` — required for OpenAPI 3.1 (JSON Schema 2020-12).
 * - `strict: false` — the Discord spec uses patterns that Ajv strict mode rejects.
 * - `allErrors: true` — report all failures, not just the first.
 * - `validateFormats: true` + ajv-formats — validate date-time, uri, etc.
 * - The entire spec is registered as a single document so `$ref` resolution is
 *   automatic without external dereferencers.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { createRequire } from 'node:module'

// ajv-formats exports a CJS function via module.exports; use createRequire for
// NodeNext-compatible interop without type errors.
const _require = createRequire(import.meta.url)
const addFormats = _require('ajv-formats') as (
  ajv: InstanceType<typeof Ajv2020>
) => void

import {
  createContractFixture,
  createFullTestApp,
  seedBot,
  seedGuild,
  seedChannel,
} from './test-helpers'
import { closeDatabase } from './db'
import { validateAuditLogQuery } from './validators/audit-log'
import { validateMessageEmbeds } from './validators/message'
import { MANIFEST } from '../spec/manifest'
import type { SpecEndpoint, SpecSuccessBranch } from '../spec/manifest'
import '../spec/manifest.test'

// ── Ajv setup ────────────────────────────────────────────────────────────────

/** Full Discord OpenAPI spec (committed snapshot) */
const SPEC_PATH = path.resolve(process.cwd(), 'spec/openapi.json')

/** Parsed OpenAPI spec object */
const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as {
  components: { schemas: Record<string, unknown> }
  paths: Record<string, unknown>
}

/** Ajv instance configured for JSON Schema 2020-12 (OpenAPI 3.1 format) */
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: true,
})
addFormats(ajv)
ajv.addFormat('snowflake', /^(0|[1-9][0-9]*)$/)
ajv.addFormat('nonce', true)

// Register the entire spec document so internal $ref resolution works without
// a separate dereference step. Ajv resolves "#/components/schemas/Foo" automatically.
ajv.addSchema(spec, 'https://discord.com/spec')

describe('Message embed request schema contract', () => {
  const validate = ajv.compile({
    $ref: 'https://discord.com/spec#/components/schemas/RichEmbed',
  })

  it.each([
    [{}, true],
    [
      {
        title: null,
        description: null,
        author: null,
        footer: null,
        fields: null,
      },
      true,
    ],
    [{ author: {}, footer: {} }, true],
    [{ author: { name: null }, footer: { text: null } }, true],
    [{ fields: [{ name: '', value: '', inline: null }] }, true],
    [
      {
        title: '🐝'.repeat(256),
        fields: [{ name: '🐝'.repeat(256), value: '🐝'.repeat(1024) }],
      },
      true,
    ],
    [{ description: '🐝'.repeat(4096) }, true],
    [
      {
        footer: { text: '🐝'.repeat(2048) },
        author: { name: '🐝'.repeat(256) },
      },
      true,
    ],
    [
      { fields: Array.from({ length: 25 }, () => ({ name: '', value: '' })) },
      true,
    ],
    [null, false],
    [[], false],
    [{ title: 123 }, false],
    [{ title: '🐝'.repeat(257) }, false],
    [{ description: '🐝'.repeat(4097) }, false],
    [{ fields: [{ name: 'x'.repeat(257), value: '' }] }, false],
    [{ fields: [{ name: '', value: 'x'.repeat(1025) }] }, false],
    [{ footer: { text: 'x'.repeat(2049) } }, false],
    [{ author: { name: 'x'.repeat(257) } }, false],
    [
      { fields: Array.from({ length: 26 }, () => ({ name: '', value: '' })) },
      false,
    ],
    [{ fields: [{}] }, false],
    [{ fields: [{ name: null, value: '' }] }, false],
    [{ fields: [{ name: '', value: false }] }, false],
    [{ fields: [{ name: '', value: '', inline: 1 }] }, false],
    [{ footer: [] }, false],
    [{ author: { name: {} } }, false],
  ])('matches the official RichEmbed schema (case %#)', (embed, accepted) => {
    expect(validate(embed)).toBe(accepted)
    expect(Object.keys(validateMessageEmbeds([embed])).length === 0).toBe(
      accepted
    )
  })

  it('adds the documented aggregate limit missing from the request schema', () => {
    const embeds = [
      { description: 'x'.repeat(3000) },
      { description: 'x'.repeat(3001) },
    ]
    expect(embeds.every((embed) => validate(embed))).toBe(true)
    expect(validateMessageEmbeds(embeds).embeds._errors[0].code).toBe(
      'EMBED_SIZE_EXCEEDS_MAX'
    )
  })
})

describe('Discord custom schema formats', () => {
  it('matches the schema snowflake representation', () => {
    const validate = ajv.compile({ type: 'string', format: 'snowflake' })

    expect(validate('0')).toBe(true)
    expect(validate('1')).toBe(true)
    expect(validate('01')).toBe(false)
    expect(validate('not-a-snowflake')).toBe(false)
  })
})

describe('Test API audit-log schema contract', () => {
  it('accepts every action filter in the committed query enum', () => {
    const schema = spec.components.schemas.AuditLogActionTypes as {
      oneOf: { const: number }[]
    }
    for (const action of schema.oneOf) {
      expect(
        validateAuditLogQuery({ action_type: String(action.const) })
      ).toEqual({
        action_type: action.const,
      })
    }
  })

  it('returns populated and filtered Discord audit logs from controlled fixtures', async () => {
    const { db, app } = createFullTestApp()
    try {
      const token = seedBot(db)
      const guildId = seedGuild(db, token)
      const channelId = seedChannel(db, guildId)
      const actor = db
        .prepare('SELECT user_id FROM bots WHERE token = ?')
        .get(token) as { user_id: string }
      const registered = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'AuditAuthor' }),
      })
      const author = (await registered.json()) as { id: string }
      const response = await app.request(
        `/_test/guilds/${guildId}/audit-logs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: '100',
            action_type: 72,
            user_id: actor.user_id,
            target_id: author.id,
            options: { channel_id: channelId, count: '2' },
          }),
        }
      )
      expect(response.status).toBe(201)
      const validateEntry = ajv.compile({
        $ref: 'https://discord.com/spec#/components/schemas/AuditLogEntryResponse',
      })
      expect(
        validateEntry(await response.json()),
        JSON.stringify(validateEntry.errors)
      ).toBe(true)
      const validateLog = ajv.compile({
        $ref: 'https://discord.com/spec#/components/schemas/GuildAuditLogResponse',
      })
      for (const query of ['', '?after=0', '?action_type=73']) {
        const log = await app.request(
          `/api/v10/guilds/${guildId}/audit-logs${query}`,
          {
            headers: { Authorization: token },
          }
        )
        expect(log.status).toBe(200)
        const body: unknown = await log.json()
        expect(validateLog(body), JSON.stringify(validateLog.errors)).toBe(true)
      }
    } finally {
      closeDatabase(db)
    }
  })
})

describe('Test API member join schema contract', () => {
  it('returns the Discord GuildMemberResponse schema for a registered human', async () => {
    const { db, app } = createFullTestApp()
    try {
      const guildId = seedGuild(db, seedBot(db))
      const registered = await app.request('/_test/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'SchemaHuman' }),
      })
      expect(registered.status).toBe(201)
      const user = (await registered.json()) as { id: string }
      const response = await app.request(
        `/_test/guilds/${guildId}/members/${user.id}`,
        { method: 'POST' }
      )
      expect(response.status).toBe(201)
      const body: unknown = await response.json()
      const validate = ajv.compile({
        $ref: 'https://discord.com/spec#/components/schemas/GuildMemberResponse',
      })
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })
})

/**
 * Derives the response schema name from the spec for a given path and method.
 * Returns the `responseSchemaOverride` from the manifest entry if set,
 * otherwise extracts the `$ref` name from the operation's 2xx response.
 * @param entry - Manifest entry.
 * @returns Schema name, or null if no schema is found.
 */
function getResponseSchema(
  entry: SpecEndpoint,
  branch: SpecSuccessBranch
): unknown {
  interface OperationType {
    responses?: Record<
      string,
      {
        content?: Record<
          string,
          { schema?: { $ref?: string; items?: { $ref?: string } } }
        >
      }
    >
  }
  const specPaths = spec.paths as Record<
    string,
    Record<string, OperationType> | undefined
  >
  const pathObj = specPaths[entry.specPath]
  if (!pathObj) return null
  const operation = pathObj[entry.method] as OperationType | undefined
  if (!operation) return null

  const schema =
    operation.responses?.[String(branch.status)]?.content?.['application/json']
      ?.schema
  if (!schema) return null
  const escapedPath = entry.specPath.replaceAll('~', '~0').replaceAll('/', '~1')
  return {
    $ref:
      `https://discord.com/spec#/paths/${escapedPath}/${entry.method}` +
      `/responses/${branch.status}/content/application~1json/schema`,
  }
}

// ── Contract tests ────────────────────────────────────────────────────────────

describe('Discord spec contract tests', () => {
  for (const entry of MANIFEST) {
    for (const branch of entry.successBranches) {
      const label = `${entry.method.toUpperCase()} ${entry.specPath} ${branch.status}`

      it(label, async () => {
        const context = createFullTestApp()
        try {
          const fixture = await entry.createFixture({
            create: () => Promise.resolve(createContractFixture(context.db)),
          })
          const { path, init } = branch.request(fixture)
          const headers = new Headers(init?.headers)
          if (entry.authentication === 'bot') {
            headers.set('Authorization', fixture.token)
          } else if (entry.authentication === 'bearer') {
            headers.set('Authorization', `Bearer ${fixture.bearerToken}`)
          }
          const res = await context.app.request(path, { ...init, headers })

          expect(
            res.status,
            `Expected ${branch.status} but got ${res.status} for ${label}`
          ).toBe(branch.status)

          if (branch.body !== 'json') return

          const responseSchema = getResponseSchema(entry, branch)
          expect(
            responseSchema,
            `No response schema found for ${label}.`
          ).toBeTruthy()
          if (!responseSchema) return

          const body: unknown = await res.json()
          const validate = ajv.compile(responseSchema)
          if (!validate(body)) {
            throw new Error(
              `Schema validation failed for ${label}:\n` +
                JSON.stringify(validate.errors, null, 2)
            )
          }
        } finally {
          context.cleanup()
        }
      })
    }
  }
})

describe('manifest coverage for Issue #136 endpoints', () => {
  const newPaths = [
    '/channels/{channel_id}/messages/{message_id}/crosspost',
    '/channels/{channel_id}/followers',
    '/channels/{channel_id}/voice-status',
    '/channels/{channel_id}/recipients/{user_id}',
    '/users/@me/channels',
    '/channels/{channel_id}/polls/{message_id}/answers/{answer_id}',
    '/channels/{channel_id}/polls/{message_id}/expire',
    '/webhooks/{webhook_id}/{webhook_token}/github',
    '/webhooks/{webhook_id}/{webhook_token}/slack',
  ]

  it('has a manifest entry for every new endpoint', () => {
    for (const path of newPaths) {
      const entry = MANIFEST.find((e) => e.specPath === path)
      expect(entry, `missing manifest entry for ${path}`).toBeDefined()
    }
  })
})
