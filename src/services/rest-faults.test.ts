import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initializeDatabase } from '../db'
import { seedBot, seedGuild } from '../test-helpers'
import { createRestFault, consumeRestFault, getRestFault } from './rest-faults'

describe('REST fault selector index migration', () => {
  it('preserves legacy controls and counters while admitting independent GET owners', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rest-fault-migration-'))
    const dbPath = path.join(directory, 'faults.db')
    const token = 'Bot legacy'
    let db = initializeDatabase(dbPath)
    try {
      seedBot(db, token)
      const guild = seedGuild(db, token)
      const otherToken = 'Bot other'
      seedBot(db, otherToken, '111111111111111112')
      const otherGuild = seedGuild(db, otherToken, '222222222222222223')
      db.exec(`
        DROP INDEX idx_active_rest_fault;
        DROP INDEX idx_active_rest_get_fault;
        CREATE UNIQUE INDEX idx_active_rest_fault
          ON test_rest_faults(method, path) WHERE remaining > 0;
      `)
      const legacyPath = `/guilds/${guild}/members/123`
      const configuration = {
        status: 403,
        code: 50_013,
        message: 'Missing Permissions',
        times: 2,
      }
      const legacy = createRestFault(db, {
        method: 'PATCH',
        path: legacyPath,
        ...configuration,
      })
      expect(legacy).toMatchObject({ remaining: 2, consumed: 0 })
      if (typeof legacy === 'string') throw new Error(legacy)
      consumeRestFault(db, 'PATCH', legacyPath)
      db.exec('ALTER TABLE test_rest_faults DROP COLUMN query')
      db.close()
      db = initializeDatabase(dbPath)
      expect(getRestFault(db, legacy.id)).toMatchObject({
        remaining: 1,
        consumed: 1,
      })
      expect(
        createRestFault(db, {
          method: 'PATCH',
          path: legacyPath,
          ...configuration,
        })
      ).toBe('CONFLICT')
      const userPath = '/users/123'
      const own = createRestFault(db, {
        method: 'GET',
        path: userPath,
        guild_id: guild,
        ...configuration,
      })
      const other = createRestFault(db, {
        method: 'GET',
        path: userPath,
        guild_id: otherGuild,
        ...configuration,
      })
      expect(own).toMatchObject({ guild_id: guild })
      expect(other).toMatchObject({ guild_id: otherGuild })
      if (typeof own === 'string' || typeof other === 'string')
        throw new Error('Unexpected scope conflict')
      const pagePath = `/guilds/${guild}/members`
      const pageQuery = { limit: 2, after: '555555555555555555' }
      const page = createRestFault(db, {
        method: 'GET',
        path: pagePath,
        query: pageQuery,
        ...configuration,
      })
      if (typeof page === 'string') throw new Error(page)
      consumeRestFault(
        db,
        'GET',
        pagePath,
        token,
        new URLSearchParams('after=555555555555555555&limit=2')
      )
      db.close()
      db = initializeDatabase(dbPath)
      expect(getRestFault(db, page.id)).toMatchObject({
        query: pageQuery,
        remaining: 1,
        consumed: 1,
      })
      expect(
        createRestFault(db, {
          method: 'GET',
          path: pagePath,
          query: pageQuery,
          ...configuration,
        })
      ).toBe('CONFLICT')
      expect(consumeRestFault(db, 'GET', userPath, otherToken)).toMatchObject({
        id: other.id,
        remaining: 1,
        consumed: 1,
      })
      expect(getRestFault(db, own.id)).toMatchObject({
        remaining: 2,
        consumed: 0,
      })
      expect(
        consumeRestFault(db, 'PATCH', legacyPath, otherToken)
      ).toMatchObject({ id: legacy.id, remaining: 0, consumed: 2 })
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
