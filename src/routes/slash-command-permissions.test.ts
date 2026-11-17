import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, initializeDatabase, type Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import {
  createCommand,
  setCommandPermissions,
} from '../services/application-commands'
import { PermissionBit } from '../services/guild-permissions'
import {
  seedBot,
  seedChannel,
  seedGuild,
  seedMember,
  seedRole,
} from '../test-helpers'
import { createTestRoutes } from './test'

describe('POST /_test/interactions with slash-command permissions', () => {
  const applicationId = '111111111111111111'
  let db: Database
  let app: Hono
  let guildId: string
  let channelId: string
  let userId: string
  const dispatch = vi.fn()

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    app = new Hono().route('/', createTestRoutes(db, 'http://localhost:3000'))
    guildId = seedGuild(db, seedBot(db, 'Bot testtoken', applicationId))
    channelId = seedChannel(db, guildId)
    userId = seedMember(db, guildId)
    db.prepare(
      "INSERT INTO roles (permissions, guild_id, id, name) VALUES (?, ?, ?, '@everyone')"
    ).run(
      (
        PermissionBit.VIEW_CHANNEL | PermissionBit.USE_APPLICATION_COMMANDS
      ).toString(),
      guildId,
      guildId
    )
    dispatch.mockClear()
    gatewayBus.on('interaction.create', dispatch)
  })

  afterEach(() => {
    gatewayBus.off('interaction.create', dispatch)
    closeDatabase(db)
  })

  /** Registers a slash command and returns its ID. */
  function registerCommand(
    scope: string | null = guildId,
    defaultPermissions: string | null = null
  ): string {
    const result = createCommand(db, applicationId, scope, {
      name: 'ping',
      description: 'Ping',
      default_member_permissions: defaultPermissions,
    })
    if (!result.ok) throw new Error('Could not register ping')
    return result.command.id
  }

  /** Sends an invocation as the fixture member. */
  function invoke(overrides: Record<string, unknown> = {}) {
    return app.request('/_test/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_id: applicationId,
        command_name: 'ping',
        guild_id: guildId,
        channel_id: channelId,
        user_id: userId,
        enforce_command_permissions: true,
        ...overrides,
      }),
    })
  }

  /** Leaves an explicitly authorized user blocked in the fixture channel. */
  function blockChannel(commandId: string) {
    setCommandPermissions(db, applicationId, guildId, commandId, [
      { id: userId, type: 2, permission: true },
      { id: channelId, type: 3, permission: false },
    ])
  }

  /** Checks that no interaction was persisted or dispatched. */
  function expectNoInteraction() {
    expect(db.prepare('SELECT COUNT(*) FROM interactions').pluck().get()).toBe(
      0
    )
    expect(dispatch).not.toHaveBeenCalled()
  }

  /** Checks the permission refusal and the absence of side effects. */
  async function expectRefused(response: Response) {
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      code: 50_013,
      message: 'Missing Permissions',
    })
    expectNoInteraction()
  }

  /** Checks that the interaction was persisted and sent to the Gateway. */
  async function expectDispatched(response: Response, commandId: string) {
    expect(response.status).toBe(201)
    const interaction = (await response.json()) as { id: string }
    expect(interaction).toMatchObject({ data: { id: commandId } })
    expect(db.prepare('SELECT id FROM interactions').pluck().all()).toEqual([
      interaction.id,
    ])
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ interaction })
    )
  }

  it('blocks an authorized member in a channel with a command deny', async () => {
    blockChannel(registerCommand())
    await expectRefused(await invoke())
  })

  it('allows the same member to use the command in another channel', async () => {
    const commandId = registerCommand()
    blockChannel(commandId)
    const otherChannel = seedChannel(db, guildId, '444444444444444444')
    await expectDispatched(
      await invoke({ channel_id: otherChannel }),
      commandId
    )
  })

  it.each([undefined, false])(
    'forces dispatch with the flag %s',
    async (flag) => {
      const commandId = registerCommand()
      blockChannel(commandId)
      await expectDispatched(
        await invoke({ enforce_command_permissions: flag }),
        commandId
      )
    }
  )

  it('applies app-wide All Channels rules to a global command in a channel-only request', async () => {
    registerCommand(null)
    setCommandPermissions(db, applicationId, guildId, applicationId, [
      { id: (BigInt(guildId) - 1n).toString(), type: 3, permission: false },
    ])
    await expectRefused(await invoke({ guild_id: undefined }))
  })

  it('uses an explicit per-command channel allow over All Channels', async () => {
    const commandId = registerCommand()
    setCommandPermissions(db, applicationId, guildId, applicationId, [
      { id: (BigInt(guildId) - 1n).toString(), type: 3, permission: false },
    ])
    setCommandPermissions(db, applicationId, guildId, commandId, [
      { id: channelId, type: 3, permission: true },
    ])
    await expectDispatched(await invoke(), commandId)
  })

  it('inherits an app-wide channel deny alongside a command-level user allow', async () => {
    const commandId = registerCommand(null)
    setCommandPermissions(db, applicationId, guildId, applicationId, [
      { id: channelId, type: 3, permission: false },
    ])
    setCommandPermissions(db, applicationId, guildId, commandId, [
      { id: userId, type: 2, permission: true },
    ])
    await expectRefused(await invoke())
  })

  it('overrides the app-wide rule for the same channel', async () => {
    const commandId = registerCommand()
    setCommandPermissions(db, applicationId, guildId, applicationId, [
      { id: channelId, type: 3, permission: false },
    ])
    setCommandPermissions(db, applicationId, guildId, commandId, [
      { id: channelId, type: 3, permission: true },
    ])
    await expectDispatched(await invoke(), commandId)
  })

  it('enforces a command-level All Channels deny', async () => {
    const commandId = registerCommand()
    setCommandPermissions(db, applicationId, guildId, commandId, [
      { id: (BigInt(guildId) - 1n).toString(), type: 3, permission: false },
    ])
    await expectRefused(await invoke())
  })

  it('uses a thread parent’s command permissions', async () => {
    blockChannel(registerCommand())
    const threadId = '444444444444444444'
    db.prepare(
      'INSERT INTO channels (id, guild_id, type, parent_id) VALUES (?, ?, 11, ?)'
    ).run(threadId, guildId, channelId)
    await expectRefused(await invoke({ channel_id: threadId }))
  })

  it('checks command defaults when there is no matching member overwrite', async () => {
    registerCommand(guildId, PermissionBit.MANAGE_GUILD.toString())
    await expectRefused(await invoke())
  })

  it('applies command defaults to an app-wide role allow and lets a command role allow override them', async () => {
    const commandId = registerCommand(guildId, '0')
    const roleId = seedRole(db, guildId)
    db.prepare(
      'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
    ).run(guildId, userId, roleId)
    setCommandPermissions(db, applicationId, guildId, applicationId, [
      { id: guildId, type: 1, permission: false },
      { id: roleId, type: 1, permission: true },
    ])
    await expectRefused(await invoke())

    setCommandPermissions(db, applicationId, guildId, commandId, [
      { id: roleId, type: 1, permission: true },
    ])
    await expectDispatched(await invoke(), commandId)
  })

  it('allows an inherited role grant above an app-wide everyone deny', async () => {
    const commandId = registerCommand()
    const roleId = seedRole(db, guildId)
    setCommandPermissions(db, applicationId, guildId, applicationId, [
      { id: guildId, type: 1, permission: false },
      { id: roleId, type: 1, permission: true },
    ])
    await expectRefused(await invoke())

    db.prepare(
      'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
    ).run(guildId, userId, roleId)
    await expectDispatched(await invoke(), commandId)
  })

  it('requires Use Application Commands even with an explicit command allow', async () => {
    const commandId = registerCommand()
    setCommandPermissions(db, applicationId, guildId, commandId, [
      { id: userId, type: 2, permission: true },
    ])
    db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(
      PermissionBit.VIEW_CHANNEL.toString(),
      guildId
    )
    await expectRefused(await invoke())
  })

  it('allows a guild administrator despite a command deny', async () => {
    const commandId = registerCommand(guildId, '0')
    blockChannel(commandId)
    db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(
      PermissionBit.ADMINISTRATOR.toString(),
      guildId
    )
    await expectDispatched(await invoke(), commandId)
  })

  it('allows the guild owner despite a command deny', async () => {
    const commandId = registerCommand(guildId, '0')
    blockChannel(commandId)
    db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(
      userId,
      guildId
    )
    await expectDispatched(await invoke(), commandId)
  })

  it('refuses a timed-out member', async () => {
    registerCommand()
    db.prepare(
      'UPDATE guild_members SET communication_disabled_until = ? WHERE guild_id = ? AND user_id = ?'
    ).run(new Date(Date.now() + 60_000).toISOString(), guildId, userId)
    await expectRefused(await invoke())
  })

  it.each([
    { userId: undefined, code: 'BASE_TYPE_REQUIRED' },
    { userId: false, code: 'BASE_TYPE_BAD_TYPE' },
  ])(
    'reports a caller fixture error for user_id=$userId',
    async ({ userId, code }) => {
      registerCommand()
      const response = await invoke({ user_id: userId })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 50_035,
        errors: { user_id: { _errors: [{ code }] } },
      })
      expectNoInteraction()
    }
  )

  it('returns Unknown Member for a registered user outside the guild', async () => {
    registerCommand()
    const otherGuild = seedGuild(db, 'Bot testtoken', '444444444444444444')
    const nonMember = seedMember(db, otherGuild)
    const response = await invoke({ user_id: nonMember })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      code: 10_007,
      message: 'Unknown Member',
    })
    expectNoInteraction()
  })

  it.each([
    {
      label: 'autocomplete',
      fields: {
        type: 4,
        options: [{ name: 'query', type: 3, value: '', focused: true }],
      },
    },
    {
      label: 'user command',
      fields: { command_type: 2, target_id: applicationId },
    },
    {
      label: 'component click',
      fields: {
        type: 3,
        custom_id: 'button',
        message_id: '555555555555555555',
        command_name: undefined,
      },
    },
  ])('rejects permission opt-in on a $label', async ({ fields }) => {
    const response = await invoke(fields)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 50_035,
      errors: {
        enforce_command_permissions: {
          _errors: [{ code: 'BASE_TYPE_BAD_VALUE' }],
        },
      },
    })
    expectNoInteraction()
  })

  it('rejects a non-boolean flag', async () => {
    registerCommand()
    const response = await invoke({ enforce_command_permissions: 'true' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 50_035,
      errors: { enforce_command_permissions: { _errors: expect.any(Array) } },
    })
    expectNoInteraction()
  })
})
