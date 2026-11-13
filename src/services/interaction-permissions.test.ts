import { beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase, type Database } from '../db'
import {
  seedBot,
  seedChannel,
  seedGroupDmChannel,
  seedGuild,
} from '../test-helpers'
import { createCommand } from './application-commands'
import { getOrCreateDmChannel } from './channels'
import { ALL_PERMISSIONS } from './guild-permissions'
import {
  BOT_DM_APP_PERMISSIONS,
  DM_APP_PERMISSIONS,
} from './interaction-permissions'
import type { InteractionObject } from './interactions'
import { createTestInteraction, createTestUser } from './test-control'

const applicationId = '111111111111111111'

/** Discord permission bits used by these scenarios. */
const KICK_MEMBERS = 1n << 1n
const ADMINISTRATOR = 1n << 3n
const VIEW_CHANNEL = 1n << 10n
const SEND_MESSAGES = 1n << 11n
const MANAGE_MESSAGES = 1n << 13n
const READ_MESSAGE_HISTORY = 1n << 16n

/** Permissions of the seeded `@everyone` role. */
const EVERYONE = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY

describe('interaction member.permissions and app_permissions', () => {
  let db: Database
  let guildId: string
  let channelId: string
  let owner: string
  let plain: string
  let moderator: string
  let admin: string
  let modRole: string

  /** Inserts a role with the given permissions. */
  function role(id: string, permissions: bigint, position: number): string {
    db.prepare(
      'INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES (?, ?, ?, 0, 0, ?, ?, 0)'
    ).run(id, guildId, `role-${id}`, position, permissions.toString())
    return id
  }

  /** Adds a guild member with optional roles. */
  function member(userId: string, roles: string[] = []): void {
    db.prepare(
      'INSERT OR IGNORE INTO guild_members (guild_id, user_id) VALUES (?, ?)'
    ).run(guildId, userId)
    for (const roleId of roles)
      db.prepare(
        'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
      ).run(guildId, userId, roleId)
  }

  /** Writes one permission overwrite on the test channel. */
  function overwrite(
    id: string,
    type: 0 | 1,
    allow: bigint,
    deny: bigint
  ): void {
    db.prepare(
      'INSERT INTO channel_overwrites (channel_id, id, type, allow, deny) VALUES (?, ?, ?, ?, ?)'
    ).run(channelId, id, type, allow.toString(), deny.toString())
  }

  /** Invokes `/config` as the user and returns the created interaction. */
  function invoke(
    userId: string,
    scope?: { guild_id?: string; channel_id?: string }
  ): InteractionObject {
    const result = createTestInteraction(db, {
      application_id: applicationId,
      command_name: 'config',
      user_id: userId,
      ...(scope ?? { guild_id: guildId, channel_id: channelId }),
    })
    if (!result.ok) throw new Error(`interaction refused: ${result.reason}`)
    return result.interaction
  }

  /** The invoking member's permissions as sent. */
  function memberPermissions(interaction: InteractionObject): unknown {
    return interaction.member?.permissions
  }

  beforeEach(() => {
    db = initializeDatabase(':memory:')
    const bot = seedBot(db, 'Bot permissions', applicationId)
    guildId = seedGuild(db, bot)
    channelId = seedChannel(db, guildId)
    owner = createTestUser(db, { username: 'Owner' }).id
    plain = createTestUser(db, { username: 'Plain' }).id
    moderator = createTestUser(db, { username: 'Moderator' }).id
    admin = createTestUser(db, { username: 'Admin' }).id
    // A human owns the guild so the bot's own permissions are computed.
    db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(
      owner,
      guildId
    )
    role(guildId, EVERYONE, 0)
    modRole = role('900000000000000001', MANAGE_MESSAGES | KICK_MEMBERS, 1)
    const adminRole = role('900000000000000002', ADMINISTRATOR, 2)
    member(applicationId)
    member(owner)
    member(plain)
    member(moderator, [modRole])
    member(admin, [adminRole])
    createCommand(db, applicationId, guildId, {
      name: 'config',
      description: 'Configure',
    })
  })

  it('uses a value of every documented permission bit for "all permissions"', () => {
    // CREATE_INSTANT_INVITE (1 << 0) through BYPASS_SLOWMODE (1 << 52),
    // except the unassigned bit 47.
    expect(ALL_PERMISSIONS.toString()).toBe('8866461766385663')
    expect(ALL_PERMISSIONS & (1n << 47n)).toBe(0n)
  })

  it('sends a plain member the @everyone permissions as a decimal string', () => {
    const interaction = invoke(plain)
    expect(memberPermissions(interaction)).toBe(EVERYONE.toString())
    expect(interaction.app_permissions).toBe(EVERYONE.toString())
  })

  it('adds the permissions of the member roles', () => {
    expect(memberPermissions(invoke(moderator))).toBe(
      (EVERYONE | MANAGE_MESSAGES | KICK_MEMBERS).toString()
    )
  })

  it('applies an @everyone channel overwrite deny', () => {
    overwrite(guildId, 0, 0n, SEND_MESSAGES)
    expect(memberPermissions(invoke(plain))).toBe(
      (EVERYONE & ~SEND_MESSAGES).toString()
    )
  })

  it('applies a role channel overwrite deny only to that role', () => {
    overwrite(modRole, 0, 0n, MANAGE_MESSAGES | SEND_MESSAGES)
    expect(memberPermissions(invoke(moderator))).toBe(
      ((EVERYONE | KICK_MEMBERS) & ~SEND_MESSAGES).toString()
    )
    expect(memberPermissions(invoke(plain))).toBe(EVERYONE.toString())
  })

  it('lets a member overwrite deny win over a role overwrite allow', () => {
    overwrite(guildId, 0, 0n, SEND_MESSAGES)
    overwrite(modRole, 0, SEND_MESSAGES, 0n)
    overwrite(moderator, 1, 0n, SEND_MESSAGES | READ_MESSAGE_HISTORY)
    expect(memberPermissions(invoke(moderator))).toBe(
      (
        (EVERYONE | MANAGE_MESSAGES | KICK_MEMBERS) &
        ~(SEND_MESSAGES | READ_MESSAGE_HISTORY)
      ).toString()
    )
  })

  it('resolves a thread interaction against its parent channel overwrites', () => {
    const threadId = '900000000000000010'
    db.prepare(
      'INSERT INTO channels (id, guild_id, name, type, parent_id) VALUES (?, ?, ?, 11, ?)'
    ).run(threadId, guildId, 'thread', channelId)
    overwrite(modRole, 0, 0n, MANAGE_MESSAGES)
    overwrite(applicationId, 1, 0n, SEND_MESSAGES)
    const interaction = invoke(moderator, {
      guild_id: guildId,
      channel_id: threadId,
    })
    expect(interaction.channel_id).toBe(threadId)
    expect(memberPermissions(interaction)).toBe(
      (EVERYONE | KICK_MEMBERS).toString()
    )
    expect(interaction.app_permissions).toBe(
      (EVERYONE & ~SEND_MESSAGES).toString()
    )
  })

  it('sends every permission to the guild owner', () => {
    overwrite(owner, 1, 0n, VIEW_CHANNEL | SEND_MESSAGES)
    expect(memberPermissions(invoke(owner))).toBe(ALL_PERMISSIONS.toString())
  })

  it('sends every permission, ADMINISTRATOR included, to a guild-level administrator despite overwrites', () => {
    overwrite(admin, 1, 0n, VIEW_CHANNEL | SEND_MESSAGES)
    const permissions = BigInt(memberPermissions(invoke(admin)) as string)
    expect(permissions).toBe(ALL_PERMISSIONS)
    expect(permissions & ADMINISTRATOR).toBe(ADMINISTRATOR)
  })

  it('does not treat an ADMINISTRATOR overwrite allow as administrator', () => {
    overwrite(plain, 1, ADMINISTRATOR, 0n)
    expect(memberPermissions(invoke(plain))).toBe(
      (EVERYONE | ADMINISTRATOR).toString()
    )
  })

  it('keeps only VIEW_CHANNEL and READ_MESSAGE_HISTORY for a timed-out member', () => {
    const until = new Date(Date.now() + 60_000).toISOString()
    db.prepare(
      'UPDATE guild_members SET communication_disabled_until = ? WHERE user_id IN (?, ?)'
    ).run(until, plain, admin)
    expect(memberPermissions(invoke(plain))).toBe(
      (VIEW_CHANNEL | READ_MESSAGE_HISTORY).toString()
    )
    expect(memberPermissions(invoke(admin))).toBe(ALL_PERMISSIONS.toString())
  })

  it('ignores an expired timeout', () => {
    db.prepare(
      'UPDATE guild_members SET communication_disabled_until = ? WHERE user_id = ?'
    ).run(new Date(Date.now() - 60_000).toISOString(), plain)
    expect(memberPermissions(invoke(plain))).toBe(EVERYONE.toString())
  })

  it('computes app_permissions for a bot with access in the channel', () => {
    const botRole = role('900000000000000003', MANAGE_MESSAGES, 3)
    db.prepare(
      'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
    ).run(guildId, applicationId, botRole)
    expect(invoke(plain).app_permissions).toBe(
      (EVERYONE | MANAGE_MESSAGES).toString()
    )
  })

  it('computes app_permissions for a bot denied access to the channel', () => {
    overwrite(applicationId, 1, 0n, VIEW_CHANNEL | SEND_MESSAGES)
    const interaction = invoke(plain)
    expect(interaction.app_permissions).toBe(
      (EVERYONE & ~(VIEW_CHANNEL | SEND_MESSAGES)).toString()
    )
    // The invoking member is unaffected by the bot's overwrite.
    expect(memberPermissions(interaction)).toBe(EVERYONE.toString())
  })

  it('sends every permission as app_permissions when the bot owns the guild', () => {
    db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(
      applicationId,
      guildId
    )
    expect(invoke(plain).app_permissions).toBe(ALL_PERMISSIONS.toString())
  })

  it('computes guild-level permissions for an interaction without a channel', () => {
    overwrite(guildId, 0, 0n, SEND_MESSAGES)
    const interaction = invoke(plain, { guild_id: guildId })
    expect(memberPermissions(interaction)).toBe(EVERYONE.toString())
    expect(interaction.app_permissions).toBe(EVERYONE.toString())
  })

  it('snapshots the permissions when the interaction is created', () => {
    const before = invoke(plain)
    db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(
      VIEW_CHANNEL.toString(),
      guildId
    )
    const after = invoke(plain)
    expect(memberPermissions(before)).toBe(EVERYONE.toString())
    expect(memberPermissions(after)).toBe(VIEW_CHANNEL.toString())
  })

  it('keeps the existing member fields next to permissions', () => {
    expect(invoke(moderator).member).toMatchObject({
      user: { id: moderator },
      roles: [modRole],
      permissions: expect.any(String) as unknown,
    })
  })

  describe('outside guilds', () => {
    beforeEach(() => {
      createCommand(db, applicationId, null, {
        name: 'config',
        description: 'Configure',
      })
    })

    it('sends no member and the bot DM set in the DM with the app', () => {
      const dm = getOrCreateDmChannel(db, applicationId, plain).id
      const interaction = invoke(plain, { channel_id: dm })
      expect(interaction.member).toBeUndefined()
      expect(interaction.user).toMatchObject({ id: plain })
      expect(interaction.app_permissions).toBe(
        BOT_DM_APP_PERMISSIONS.toString()
      )
      // ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE | USE_EXTERNAL_EMOJIS
      expect(interaction.app_permissions).toBe('442368')
    })

    it('sends the bot DM set for a DM interaction without a channel', () => {
      expect(invoke(plain, {}).app_permissions).toBe('442368')
    })

    it('sends the (G)DM set in a group DM', () => {
      const group = seedGroupDmChannel(db)
      const interaction = invoke(plain, { channel_id: group })
      expect(interaction.member).toBeUndefined()
      expect(interaction.app_permissions).toBe(DM_APP_PERMISSIONS.toString())
      // ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE
      expect(interaction.app_permissions).toBe('180224')
    })
  })
})
