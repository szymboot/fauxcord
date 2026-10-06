import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../db'
import { seedBot, seedGuild } from '../test-helpers'
import {
  createAuditLogResponse,
  consumeAuditLogResponse,
  deleteAuditLogResponseByKey,
  getAuditLogResponse,
  getAuditLogResponseByKey,
} from './audit-log-responses'
import type { AuditLogResponseRequest } from '../validators/audit-log-response'

const TOKEN = 'Bot persisted-owner'
const BOT = '111111111111111111'
const GUILD = '222222222222222222'
const scope = { ownership_key: 'persisted-key', bot_id: BOT, guild_id: GUILD }
const payload: AuditLogResponseRequest = {
  ...scope,
  entries: [{ id: null, action_type: 999 }],
  query: {},
  ttl_ms: 60_000,
  times: 2,
}

describe('durable audit response ownership', () => {
  it('recovers evidence after restart and retains cleanup closure after another restart', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fauxcord-ownership-'))
    const file = path.join(directory, 'test.sqlite')
    let db = initializeDatabase(file)
    try {
      seedBot(db, TOKEN, BOT)
      seedGuild(db, TOKEN, GUILD)
      const original = createAuditLogResponse(db, payload)
      expect(original).toMatchObject({ remaining: 2, consumed: 0 })
      consumeAuditLogResponse(db, GUILD, TOKEN, new URLSearchParams())
      const evidence = getAuditLogResponseByKey(db, scope)
      db.close()
      db = initializeDatabase(file)
      expect(getAuditLogResponseByKey(db, scope)).toEqual(evidence)
      expect(createAuditLogResponse(db, payload)).toEqual(evidence)
      expect(deleteAuditLogResponseByKey(db, scope)).toBe(true)
      expect(
        db.prepare('SELECT * FROM test_audit_log_responses').all()
      ).toEqual([])
      expect(
        db.prepare('SELECT * FROM test_audit_log_response_owners').all()
      ).toEqual([
        {
          ...scope,
          token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          response_id: null,
        },
      ])
      db.close()
      db = initializeDatabase(file)
      expect(getAuditLogResponseByKey(db, scope)).toBeUndefined()
      expect(deleteAuditLogResponseByKey(db, scope)).toBe(true)
      expect(createAuditLogResponse(db, payload)).toBe('CONFLICT')
      expect(
        createAuditLogResponse(db, { ...payload, ownership_key: 'fresh-key' })
      ).toMatchObject({ state: 'armed' })
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('adds reservations to a pre-ownership database without altering legacy evidence', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'fauxcord-ownership-upgrade-')
    )
    const file = path.join(directory, 'test.sqlite')
    let db = initializeDatabase(file)
    try {
      db.exec('DROP TABLE test_audit_log_response_owners')
      seedBot(db, TOKEN, BOT)
      seedGuild(db, TOKEN, GUILD)
      const id = '333333333333333333'
      db.prepare(
        `INSERT INTO test_audit_log_responses
        (id, bot_id, guild_id, query, entries, times, ttl_ms, remaining, consumed, expires_at, consumed_at)
        VALUES (?, ?, ?, '{}', '[]', 2, 60000, 1, 1, ?, ?)`
      ).run(
        id,
        BOT,
        GUILD,
        '2000-01-01T00:00:00.000Z',
        '1999-12-31T23:59:59.000Z'
      )
      db.close()
      db = initializeDatabase(file)
      expect(getAuditLogResponse(db, id)).toEqual({
        id,
        bot_id: BOT,
        guild_id: GUILD,
        query: {},
        entries: [],
        times: 2,
        ttl_ms: 60_000,
        remaining: 1,
        consumed: 1,
        expires_at: '2000-01-01T00:00:00.000Z',
        consumed_at: '1999-12-31T23:59:59.000Z',
        state: 'expired',
      })
      expect(createAuditLogResponse(db, payload)).toMatchObject({
        ownership_key: scope.ownership_key,
        state: 'armed',
      })
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
