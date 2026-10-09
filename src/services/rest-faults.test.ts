import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initializeDatabase, closeDatabase } from '../db'
import { seedBot, seedGuild, seedChannel } from '../test-helpers'
import {
  createRestFault,
  consumeRestFault,
  getRestFault,
  getRestFaultRuntime,
  deleteRestFault,
} from './rest-faults'

describe('REST fault selector index migration', () => {
  it('preserves a live delayed request when another connection opens the same database', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rest-live-connection-'))
    const dbPath = path.join(directory, 'faults.db')
    const first = initializeDatabase(dbPath)
    let second: ReturnType<typeof initializeDatabase> | undefined
    try {
      const token = 'Bot same-file'
      seedBot(first, token)
      const guild = seedGuild(first, token)
      const channel = seedChannel(first, guild)
      const selector = `/channels/${channel}/messages`
      const fault = createRestFault(first, {
        method: 'POST',
        path: selector,
        mode: 'delay',
        delay_ms: 60_000,
        timeout_ms: 60_000,
        times: 2,
        status: 504,
        code: 0,
        message: 'Delayed',
      })
      if (typeof fault === 'string') throw new Error(fault)
      const consumed = consumeRestFault(first, 'POST', selector, token)
      if (!consumed) throw new Error('Fault was not consumed')
      const controller = new AbortController()
      const pending = getRestFaultRuntime(first).delay(
        consumed,
        controller.signal
      )
      second = initializeDatabase(dbPath)
      expect(getRestFault(second, fault.id)).toMatchObject({
        consumed: 1,
        state: 'delaying',
        outcomes: { pending: 1, cancelled: 0 },
      })
      closeDatabase(second)
      second = undefined
      expect(getRestFault(first, fault.id)).toMatchObject({
        remaining: 1,
        outcomes: { pending: 1 },
      })
      controller.abort()
      await pending
      expect(getRestFault(first, fault.id)).toMatchObject({
        outcomes: { pending: 0, cancelled: 0, responded: 0, disconnected: 1 },
      })
      const retry = consumeRestFault(first, 'POST', selector, token)
      if (!retry) throw new Error('Remaining attempt was unexpectedly disarmed')
      const retryPending = getRestFaultRuntime(first).delay(
        retry,
        new AbortController().signal
      )
      second = initializeDatabase(dbPath)
      expect(deleteRestFault(second, fault.id)).toBe(true)
      await retryPending
      expect(getRestFault(first, fault.id)).toBeUndefined()
    } finally {
      if (second?.open) closeDatabase(second)
      closeDatabase(first)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('retains bounded configuration and recovers interrupted delays after reopening', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'rest-transport-recovery-')
    )
    const dbPath = path.join(directory, 'faults.db')
    let db = initializeDatabase(dbPath)
    try {
      const token = 'Bot recovered'
      seedBot(db, token)
      const guild = seedGuild(db, token)
      const channel = seedChannel(db, guild)
      const selector = `/channels/${channel}/messages`
      const fault = createRestFault(db, {
        method: 'POST',
        path: selector,
        mode: 'delay',
        delay_ms: 1000,
        timeout_ms: 60_000,
        times: 2,
        status: 504,
        code: 0,
        message: 'Delayed',
      })
      if (typeof fault === 'string') throw new Error(fault)
      consumeRestFault(db, 'POST', selector, token)
      // Persist the evidence left by an interrupted process without a live timer.
      getRestFaultRuntime(db).record(fault.id, { pending: 1, delayed: 1 })
      db.close()
      db = initializeDatabase(dbPath)
      expect(getRestFault(db, fault.id)).toMatchObject({
        expires_at: fault.expires_at,
        mode: 'delay',
        remaining: 1,
        consumed: 1,
        state: 'armed',
        outcomes: { pending: 0, delayed: 1, cancelled: 1 },
      })
      expect(consumeRestFault(db, 'POST', selector, token)).toMatchObject({
        remaining: 0,
        consumed: 2,
        mode: 'delay',
        delay_ms: 1000,
      })
      db.close()
      db = initializeDatabase(dbPath)
      expect(getRestFault(db, fault.id)).toMatchObject({
        outcomes: { cancelled: 1 },
      })
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('caps live delay resources and clears every timer and listener on shutdown', async () => {
    const db = initializeDatabase(':memory:')
    try {
      const token = 'Bot capacity'
      seedBot(db, token)
      const guild = seedGuild(db, token)
      const runtime = getRestFaultRuntime(db)
      const pending: Promise<void>[] = []
      const faults: string[] = []
      for (let group = 0; group < 3; group++) {
        const channel = seedChannel(
          db,
          guild,
          String(333_333_333_333_333_333n + BigInt(group))
        )
        const selector = `/channels/${channel}/messages`
        const fault = createRestFault(db, {
          method: 'POST',
          path: selector,
          mode: 'delay',
          delay_ms: 60_000,
          timeout_ms: 60_000,
          times: 100,
          status: 504,
          code: 0,
          message: 'Delayed',
        })
        if (typeof fault === 'string') throw new Error(fault)
        faults.push(fault.id)
        for (let i = 0; i < (group === 2 ? 57 : 100); i++) {
          const consumed = consumeRestFault(db, 'POST', selector, token)
          if (!consumed) throw new Error('Fault was not consumed')
          pending.push(runtime.delay(consumed, new AbortController().signal))
        }
      }
      expect(getRestFault(db, faults[2])).toMatchObject({
        consumed: 57,
        outcomes: { pending: 56, delayed: 56, cancelled: 1 },
      })
      runtime.shutdown()
      await Promise.all(pending)
      for (const id of faults)
        expect(getRestFault(db, id)).toMatchObject({
          remaining: 0,
          outcomes: { pending: 0 },
        })
      runtime.shutdown()
    } finally {
      db.close()
    }
  })

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
      for (const column of [
        'query',
        'options',
        'outcomes',
        'expires_at',
        'owner_token',
        'pending_owners',
      ])
        db.exec(`ALTER TABLE test_rest_faults DROP COLUMN ${column}`)
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
