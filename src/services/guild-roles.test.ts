import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, initializeDatabase, type Database } from '../db'
import { gatewayBus, type GatewayBusEvents } from '../gateway/bus'
import { seedBot, seedGuild } from '../test-helpers'
import {
  createRole,
  createTestRole,
  getGuildRoles,
  getRole,
  updateRole,
} from './guild-roles'

describe('Guild role creation service', () => {
  let db: Database
  let guildId: string

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    guildId = seedGuild(db, seedBot(db))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase(db)
  })

  it('stores managed before publishing create and preserves it on update', () => {
    const listener = vi.fn((event: GatewayBusEvents['guild.role.create']) => {
      expect(getRole(db, guildId, String(event.role.id))).toMatchObject({
        managed: true,
      })
    })
    gatewayBus.on('guild.role.create', listener)
    try {
      const role = createTestRole(db, {
        guildId,
        roleId: '444444444444444444',
        name: 'Managed',
        managed: true,
      })
      expect(role.managed).toBe(true)
      expect(listener).toHaveBeenCalledExactlyOnceWith({ guildId, role })
      expect(
        db.prepare('SELECT managed FROM roles WHERE id = ?').get(role.id)
      ).toEqual({ managed: 1 })
      expect(getGuildRoles(db, guildId)).toContainEqual(role)
      const emit = vi.spyOn(gatewayBus, 'emit')
      const updated = updateRole(db, guildId, role.id, { name: 'Renamed' })
      expect(updated).toMatchObject({ managed: true, name: 'Renamed' })
      expect(emit).toHaveBeenCalledExactlyOnceWith('guild.role.update', {
        guildId,
        role: updated,
      })
    } finally {
      gatewayBus.off('guild.role.create', listener)
    }
  })

  it('ignores a managed flag supplied to ordinary creation at runtime', () => {
    const params = {
      guildId,
      roleId: '444444444444444444',
      managed: true,
    }
    expect(createRole(db, params).managed).toBe(false)
    expect(
      createTestRole(db, { guildId, roleId: '555555555555555555' })
    ).toMatchObject({
      managed: false,
      position: 2,
    })
  })

  it('emits no event when persistence fails', () => {
    const emit = vi.spyOn(gatewayBus, 'emit')
    expect(() =>
      createTestRole(db, {
        guildId: '999999999999999999',
        roleId: '444444444444444444',
        managed: true,
      })
    ).toThrow()
    expect(emit).not.toHaveBeenCalled()
  })
})
