/**
 * Test control service
 *
 * Handles test environment setup and reset.
 */

import { getRestFaultRuntime, pruneRestFaults } from './rest-faults'
import { getRestPageHolds } from './rest-page-holds'
import { randomBytes } from 'node:crypto'
import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import { toDiscordTimestamp } from '../timestamp'
import { gatewayBus } from '../gateway/bus'
import { buildGuildCreatePayload, isValidAfkChannel } from './guilds'
import { listVoiceRegions } from './catalog'
import {
  isStageBitrateTooHigh,
  normalizeVoiceChannelSettings,
  pickVoiceChannelSettings,
  validateVoiceChannelSettings,
  VOICE_CHANNEL_LIMITS,
  type VoiceChannelSettings,
} from '../validators/channel'
import { validateGuildAfk } from '../validators/guild'
import type { ValidationErrors } from '../validators/common'
import { getGuildMember, type GuildMemberObject } from './guild-members'
import { getChannel, isVoiceCapableChannelType } from './channels'
import { getUser, type UserObject } from './users'
import { resetAuditLogResponses } from './audit-log-responses'
import { resetRestFaults } from './rest-faults'
import {
  resolveMessageStickers,
  getMessageStickerItems,
} from './message-stickers'
import type { APIStickerItem } from 'discord-api-types/v10'
import {
  createMessage,
  deleteMessage,
  getMessage,
  updateMessage,
  getGuildIdForChannel,
  type MessageObject,
} from './messages'
import { addReaction, removeReaction, type ReactionBurst } from './reactions'
import { findGuildEmoji, parseReactionEmoji } from './reaction-emoji'
import { createInteraction } from './interactions'
import type { InteractionObject } from './interactions'

/** Test setup request type */
export interface SetupRequest {
  token: string
  user?: {
    id?: string
    username?: string
    discriminator?: string
    global_name?: string | null
  }
  guilds?: SetupGuildRequest[]
}

/** Guild information type for test setup */
export interface SetupGuildRequest {
  id?: string
  name: string
  /** Opaque icon hash; null clears it and omission preserves an existing icon. */
  icon?: string | null
  /** Registered non-bot owner; defaults to the setup bot when omitted. */
  owner_id?: string
  /** Boost tier from 0 to 3; omission preserves an existing tier. */
  premium_tier?: 0 | 1 | 2 | 3
  /** Voice channel (type 2) of this guild; omission preserves, null clears. */
  afk_channel_id?: string | null
  /** 60, 300, 900, 1800 or 3600 seconds; omission preserves (default 300). */
  afk_timeout?: number
  channels?: SetupChannelRequest[]
}

/** Channel information type for test setup */
export interface SetupChannelRequest {
  id?: string
  name: string
  /** Channel type; omission or null keeps a reused channel's stored type. */
  type?: number | null
  /** Voice/stage only; omission preserves, null restores 64000. */
  bitrate?: unknown
  /** Voice/stage only; omission preserves, null restores 0 (unlimited). */
  user_limit?: unknown
  /** Voice/stage only; omission preserves, null means automatic. */
  rtc_region?: unknown
  /** Voice/stage only; omission preserves, null unsets (auto). */
  video_quality_mode?: unknown
}

/** Setup failure carrying Discord-style field errors. */
export class SetupValidationError extends Error {
  /**
   * @param code - Setup error code (e.g. INVALID_CHANNEL_SETTINGS)
   * @param errors - Field-keyed validation errors
   */
  constructor(
    code: string,
    readonly errors: ValidationErrors
  ) {
    super(code)
  }
}

/**
 * Rejects a stage channel bitrate above 64000 (Discord error 30052),
 * reported as a setup field error.
 * @param bitrate - Validated bitrate
 * @param channelType - Channel type
 * @throws SetupValidationError with INVALID_CHANNEL_SETTINGS
 */
function assertStageBitrate(bitrate: unknown, channelType: number): void {
  if (!isStageBitrateTooHigh(bitrate, channelType)) return
  throw new SetupValidationError('INVALID_CHANNEL_SETTINGS', {
    bitrate: {
      _errors: [
        {
          code: 'BITRATE_TOO_HIGH',
          message: 'Bitrate is too high for channel of this type',
        },
      ],
    },
  })
}

/**
 * Validates a setup channel's voice settings against its (preserved or
 * requested) type and the guild's stored boost tier.
 * @param db - Database
 * @param guildId - Guild the channel belongs to
 * @param channelReq - Setup channel definition
 * @param channelType - Effective channel type
 * @returns The provided settings, typed
 * @throws SetupValidationError with INVALID_CHANNEL_SETTINGS
 */
function validateSetupVoiceSettings(
  db: Database,
  guildId: string,
  channelReq: SetupChannelRequest,
  channelType: number
): VoiceChannelSettings {
  const settings = pickVoiceChannelSettings(channelReq)
  if (Object.keys(settings).length === 0) return settings
  if (!isVoiceCapableChannelType(channelType)) {
    throw new SetupValidationError(
      'INVALID_CHANNEL_SETTINGS',
      Object.fromEntries(
        Object.keys(settings).map((field) => [
          field,
          {
            _errors: [
              {
                code: 'CHANNEL_TYPE_INVALID',
                message:
                  'Only voice (2) and stage (13) channels accept this field.',
              },
            ],
          },
        ])
      )
    )
  }
  const tier = (
    db.prepare('SELECT premium_tier FROM guilds WHERE id = ?').get(guildId) as {
      premium_tier: number
    }
  ).premium_tier
  const errors = validateVoiceChannelSettings(
    channelReq,
    channelType,
    tier,
    listVoiceRegions().map((region) => region.id)
  )
  if (Object.keys(errors).length > 0)
    throw new SetupValidationError('INVALID_CHANNEL_SETTINGS', errors)
  assertStageBitrate(settings.bitrate, channelType)
  return normalizeVoiceChannelSettings(settings, channelType)
}

/**
 * Applies a setup guild's AFK settings after its channels exist, so the AFK
 * channel may be one defined in the same request. Omission preserves the
 * stored value; `afk_channel_id: null` clears it.
 * @param db - Database
 * @param guildId - Guild ID
 * @param guildReq - Setup guild definition
 * @throws SetupValidationError with INVALID_GUILD_AFK
 */
function applySetupGuildAfk(
  db: Database,
  guildId: string,
  guildReq: SetupGuildRequest
): void {
  const errors = validateGuildAfk(guildReq, (channelId) =>
    isValidAfkChannel(db, guildId, channelId)
  )
  if (Object.keys(errors).length > 0)
    throw new SetupValidationError('INVALID_GUILD_AFK', errors)
  if (guildReq.afk_channel_id !== undefined) {
    db.prepare('UPDATE guilds SET afk_channel_id = ? WHERE id = ?').run(
      guildReq.afk_channel_id,
      guildId
    )
  }
  if (guildReq.afk_timeout !== undefined) {
    db.prepare('UPDATE guilds SET afk_timeout = ? WHERE id = ?').run(
      guildReq.afk_timeout,
      guildId
    )
  }
}

/**
 * Re-validates a guild's stored voice state after setup wrote it: a voice
 * <-> stage switch must not leave stored settings outside the ranges Discord
 * enforces for the final type, and the stored AFK channel must still be a
 * voice channel. Values that are now out of range must be replaced in the
 * same setup request. A lower `premium_tier` keeps higher stored bitrates,
 * as Discord does when a guild loses boosts.
 * @param db - Database
 * @param guildId - Guild ID
 * @throws SetupValidationError with INVALID_CHANNEL_SETTINGS or
 * INVALID_GUILD_AFK
 */
function assertStoredGuildVoiceSettings(db: Database, guildId: string): void {
  const guild = db
    .prepare('SELECT premium_tier, afk_channel_id FROM guilds WHERE id = ?')
    .get(guildId) as { premium_tier: number; afk_channel_id: string | null }
  if (
    guild.afk_channel_id !== null &&
    !isValidAfkChannel(db, guildId, guild.afk_channel_id)
  ) {
    throw new SetupValidationError('INVALID_GUILD_AFK', {
      afk_channel_id: {
        _errors: [
          {
            code: 'CHANNEL_TYPE_INVALID',
            message: 'Must be a voice channel in this guild.',
          },
        ],
      },
    })
  }
  const channels = db
    .prepare(
      `SELECT type, bitrate, user_limit, rtc_region, video_quality_mode
       FROM channels WHERE guild_id = ? AND type IN (2, 13)`
    )
    .all(guildId) as (VoiceChannelSettings & { type: number })[]
  const regionIds = listVoiceRegions().map((region) => region.id)
  for (const { type, ...stored } of channels) {
    // Discord keeps a stored bitrate when a guild loses boosts, so only the
    // highest tier's ceiling applies to retained values.
    const errors = validateVoiceChannelSettings(
      stored,
      type,
      VOICE_CHANNEL_LIMITS.VOICE_BITRATE_MAX_BY_TIER.length - 1,
      regionIds
    )
    if (Object.keys(errors).length > 0)
      throw new SetupValidationError('INVALID_CHANNEL_SETTINGS', errors)
    assertStageBitrate(stored.bitrate, type)
  }
}

/** Test setup response type */
export interface SetupResponse {
  token: string
  user: { id: string; username: string }
  guilds: {
    id: string
    name: string
    channels: { id: string; name: string; type: number }[]
  }[]
}

/**
 * Rejects setup reuse of a channel ID that would change what Discord treats
 * as immutable: voice-capable channels (voice 2, stage 13) cannot become
 * other types or vice versa (Discord only converts text <-> announcement),
 * and voice-capable channels cannot move to another guild. Either change
 * would orphan stored voice states and AFK channel references.
 * @param existing - Stored guild and type of the reused channel
 * @param guildId - Guild the setup request places the channel in
 * @param type - Requested (or preserved) channel type
 * @throws Error with INVALID_CHANNEL_TYPE_CHANGE or VOICE_CHANNEL_GUILD_CHANGE
 */
function assertStableChannelIdentity(
  existing: { guild_id: string | null; type: number },
  guildId: string,
  type: number
): void {
  if (
    isVoiceCapableChannelType(existing.type) !== isVoiceCapableChannelType(type)
  )
    throw new Error('INVALID_CHANNEL_TYPE_CHANGE')
  if (isVoiceCapableChannelType(existing.type) && existing.guild_id !== guildId)
    throw new Error('VOICE_CHANNEL_GUILD_CHANGE')
}

/**
 * Sets up the test environment.
 * @param db - Database
 * @param request - Setup request
 * @returns Setup result
 * @throws Error with CONFLICT for duplicate tokens, INVALID_OWNER_ID for
 * malformed owner IDs, INVALID_GUILD_ICON for malformed icon hashes,
 * INVALID_GUILD_PREMIUM_TIER for invalid boost tiers, UNKNOWN_USER for
 * missing owners, BOT_OWNER for bots, INVALID_CHANNEL_TYPE for non-integer
 * channel types, INVALID_CHANNEL_TYPE_CHANGE for
 * voice-capable <-> other type changes, or VOICE_CHANNEL_GUILD_CHANGE for
 * cross-guild moves of voice-capable channels
 */
export function setupTestEnvironment(
  db: Database,
  request: SetupRequest
): SetupResponse {
  // Duplicate token check
  const existing = db
    .prepare('SELECT token FROM bots WHERE token = ?')
    .get(request.token)
  if (existing) {
    throw new Error('CONFLICT')
  }

  const userId = request.user?.id ?? generateSnowflake()
  const username = request.user?.username ?? 'MockBot'
  const discriminator = request.user?.discriminator ?? '0'

  // Gateway events to broadcast once the transaction below commits. Collecting
  // them here (instead of emitting inline) avoids broadcasting state that a
  // later statement in the same transaction could still roll back.
  const pendingEvents: (() => void)[] = []

  // Run inside a transaction so that a partial setup state
  // (e.g. only the Bot registered) is not left behind if an error occurs midway
  const setup = db.transaction((): SetupResponse => {
    const guildRequests = request.guilds ?? []
    // Validate before registering the bot so a human owner cannot be promoted
    // to a bot when its ID is also used as the setup account.
    for (const guildReq of guildRequests) {
      if (
        guildReq.premium_tier !== undefined &&
        (typeof guildReq.premium_tier !== 'number' ||
          !Number.isSafeInteger(guildReq.premium_tier) ||
          guildReq.premium_tier < 0 ||
          guildReq.premium_tier > 3)
      ) {
        throw new Error('INVALID_GUILD_PREMIUM_TIER')
      }
      if (
        guildReq.icon !== undefined &&
        guildReq.icon !== null &&
        (typeof guildReq.icon !== 'string' ||
          guildReq.icon.trim().length === 0 ||
          guildReq.icon.trim() !== guildReq.icon)
      ) {
        throw new Error('INVALID_GUILD_ICON')
      }
      if (guildReq.owner_id === undefined) continue
      if (
        typeof guildReq.owner_id !== 'string' ||
        guildReq.owner_id.trim().length === 0 ||
        guildReq.owner_id.trim() !== guildReq.owner_id
      ) {
        throw new Error('INVALID_OWNER_ID')
      }
      const owner = db
        .prepare('SELECT bot FROM users WHERE id = ?')
        .get(guildReq.owner_id) as { bot: number } | undefined
      if (!owner) throw new Error('UNKNOWN_USER')
      if (owner.bot === 1 || guildReq.owner_id === userId) {
        throw new Error('BOT_OWNER')
      }
    }

    // An existing human owner must keep its identity across separate setups.
    const humanOwner = db
      .prepare(
        `SELECT users.id FROM users JOIN guilds ON guilds.owner_id = users.id
         WHERE users.id = ? AND users.bot = 0 LIMIT 1`
      )
      .get(userId)
    if (humanOwner) throw new Error('BOT_OWNER')

    // Create the user. ON CONFLICT forces bot=1 rather than leaving the
    // existing row untouched -- POST /_test/users can register this same id
    // beforehand as a non-bot user (bot=0), and this row is now the bot's
    // own account, so it must win regardless of what existed before.
    // Preserve the existing global name unless the fixture explicitly sets it.
    db.prepare(
      `INSERT INTO users (id, username, discriminator, global_name, bot) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET bot = 1,
         global_name = CASE WHEN ? THEN excluded.global_name ELSE users.global_name END`
    ).run(
      userId,
      username,
      discriminator,
      request.user?.global_name ?? null,
      request.user?.global_name === undefined ? 0 : 1
    )

    // Create the bot
    db.prepare(
      'INSERT INTO bots (token, user_id, username, discriminator) VALUES (?, ?, ?, ?)'
    ).run(request.token, userId, username, discriminator)

    const guildsResponse: SetupResponse['guilds'] = []

    for (const guildReq of guildRequests) {
      const guildId = guildReq.id ?? generateSnowflake()
      const ownerId = guildReq.owner_id ?? userId

      // Create the guild (if the same ID still exists, overwrite its contents and reuse it = idempotent)
      db.prepare(
        `INSERT INTO guilds (id, name, icon, premium_tier, owner_id, bot_token) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           icon = CASE WHEN ? THEN excluded.icon ELSE guilds.icon END,
           premium_tier = CASE WHEN ? THEN excluded.premium_tier ELSE guilds.premium_tier END,
           owner_id = excluded.owner_id,
           bot_token = excluded.bot_token,
           bot_present = 1`
      ).run(
        guildId,
        guildReq.name,
        guildReq.icon ?? null,
        guildReq.premium_tier ?? 0,
        ownerId,
        request.token,
        guildReq.icon === undefined ? 0 : 1,
        guildReq.premium_tier === undefined ? 0 : 1
      )

      pendingEvents.push(() => {
        // The guild row was just inserted/updated above within this same
        // transaction, so `buildGuildCreatePayload` should never actually
        // return null here -- but it's still guarded explicitly (rather than
        // cast past the type checker) so a future refactor that breaks that
        // invariant fails loudly instead of broadcasting a null payload.
        const guild = buildGuildCreatePayload(db, guildId)
        if (!guild) return
        gatewayBus.emit('guild.create', {
          guild: guild as unknown as Record<string, unknown>,
        })
      })

      // Auto-create the @everyone role (Discord API spec: every guild always has @everyone)
      // The @everyone role ID is identical to the guild ID
      db.prepare(
        `INSERT OR IGNORE INTO roles (id, guild_id, name, permissions, position, color, hoist, mentionable)
         VALUES (?, ?, '@everyone', '1071698660929', 0, 0, 0, 0)`
      ).run(guildId, guildId)

      // Register the bot as a member of the guild. On real Discord, a
      // bot present in a guild always shows up in that guild's member list;
      // without this row, GET/PATCH/PUT/DELETE /guilds/{id}/members/{bot_id}*
      // 404 for the bot itself, breaking any client library flow that
      // manages the bot's own guild member (e.g. self role assignment).
      db.prepare(
        'INSERT OR IGNORE INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, userId)
      // A rejoining setup sees its guild again.
      db.prepare(
        'DELETE FROM guild_bot_removals WHERE guild_id = ? AND bot_token = ?'
      ).run(guildId, request.token)
      // Re-listing a guild whose bot was banned re-adds the bot (rejoin), so
      // the stale ban must not remain.
      db.prepare(
        'DELETE FROM guild_bans WHERE guild_id = ? AND user_id = ?'
      ).run(guildId, userId)

      pendingEvents.push(() => {
        gatewayBus.emit('guild.member.add', {
          guildId,
          member: getGuildMember(db, guildId, userId) as unknown as Record<
            string,
            unknown
          >,
        })
      })

      if (ownerId !== userId) {
        db.prepare(
          'INSERT OR IGNORE INTO guild_members (guild_id, user_id) VALUES (?, ?)'
        ).run(guildId, ownerId)
        pendingEvents.push(() => {
          gatewayBus.emit('guild.member.add', {
            guildId,
            member: getGuildMember(db, guildId, ownerId) as unknown as Record<
              string,
              unknown
            >,
          })
        })
      }

      const channelsResponse: { id: string; name: string; type: number }[] = []

      const channelRequests = guildReq.channels ?? []
      for (const channelReq of channelRequests) {
        // null behaves like omission (preserve the stored type, else text).
        if (
          channelReq.type !== undefined &&
          channelReq.type !== null &&
          (typeof channelReq.type !== 'number' ||
            !Number.isSafeInteger(channelReq.type) ||
            channelReq.type < 0)
        )
          throw new Error('INVALID_CHANNEL_TYPE')
        const channelId = channelReq.id ?? generateSnowflake()
        const existingChannel = db
          .prepare('SELECT guild_id, type FROM channels WHERE id = ?')
          .get(channelId) as
          { guild_id: string | null; type: number } | undefined
        // A reused channel keeps its stored type unless one is given.
        const channelType = channelReq.type ?? existingChannel?.type ?? 0
        if (existingChannel) {
          assertStableChannelIdentity(existingChannel, guildId, channelType)
        }

        const settings = validateSetupVoiceSettings(
          db,
          guildId,
          channelReq,
          channelType
        )
        const provided = (field: keyof VoiceChannelSettings) =>
          settings[field] === undefined ? 0 : 1

        // Create the channel (if the same ID still exists, overwrite its contents and reuse it = idempotent).
        // Omitted voice settings keep their stored values; null restores the default.
        db.prepare(
          `INSERT INTO channels (id, guild_id, name, type, bitrate, user_limit, rtc_region, video_quality_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             guild_id = excluded.guild_id,
             name = excluded.name,
             type = excluded.type,
             bitrate = CASE WHEN ? THEN excluded.bitrate ELSE channels.bitrate END,
             user_limit = CASE WHEN ? THEN excluded.user_limit ELSE channels.user_limit END,
             rtc_region = CASE WHEN ? THEN excluded.rtc_region ELSE channels.rtc_region END,
             video_quality_mode = CASE WHEN ? THEN excluded.video_quality_mode ELSE channels.video_quality_mode END`
        ).run(
          channelId,
          guildId,
          channelReq.name,
          channelType,
          settings.bitrate ?? null,
          settings.user_limit ?? null,
          settings.rtc_region ?? null,
          settings.video_quality_mode ?? null,
          provided('bitrate'),
          provided('user_limit'),
          provided('rtc_region'),
          provided('video_quality_mode')
        )

        channelsResponse.push({
          id: channelId,
          name: channelReq.name,
          type: channelType,
        })
      }

      applySetupGuildAfk(db, guildId, guildReq)
      assertStoredGuildVoiceSettings(db, guildId)

      guildsResponse.push({
        id: guildId,
        name: guildReq.name,
        channels: channelsResponse,
      })
    }

    return {
      token: request.token,
      user: { id: userId, username },
      guilds: guildsResponse,
    }
  })

  const result = setup()
  pruneRestFaults(db)
  // Emit only after the transaction has committed successfully.
  for (const emit of pendingEvents) emit()
  return result
}

/**
 * Deletes a bot token and all of its related data.
 * @param db - Database
 * @param token - Bot token to delete
 * @returns true on successful deletion
 */
export function deleteTestSetup(db: Database, token: string): boolean {
  const bot = db
    .prepare('SELECT user_id FROM bots WHERE token = ?')
    .get(token) as { user_id: string } | undefined
  if (!bot) return false

  // Related Guilds/Channels/Messages, plus guild-scoped
  // application_commands/application_command_permissions rows, are also
  // deleted via cascade delete (guilds.bot_token -> bots ON DELETE CASCADE,
  // application_commands.guild_id -> guilds ON DELETE CASCADE). Global-scope
  // application_commands and every interactions row have no FK to bots
  // (there is no applications table), so they are cleaned up explicitly.
  // OAuth2 access tokens (with their refresh tokens) and outstanding
  // authorization codes of the setup's clients die with it, so a deleted
  // setup's credentials cannot outlive the bot they were linked to.
  for (const table of ['oauth2_access_tokens', 'oauth2_auth_codes'])
    db.prepare(
      `DELETE FROM ${table} WHERE client_id IN (
         SELECT client_id FROM oauth2_clients WHERE bot_token = ?
       )`
    ).run(token)
  db.prepare('DELETE FROM bots WHERE token = ?').run(token)
  getRestPageHolds(db).reset(token)
  getRestFaultRuntime(db).prune()
  db.prepare(
    'DELETE FROM application_commands WHERE application_id = ? AND guild_id IS NULL'
  ).run(bot.user_id)
  db.prepare('DELETE FROM interactions WHERE application_id = ?').run(
    bot.user_id
  )
  return true
}

/**
 * Resets test data (tokens, guilds, and channels are kept).
 * @param db - Database
 * @param token - Bot token to reset (all tokens if omitted)
 */
export function resetTestData(db: Database, token?: string): void {
  getRestPageHolds(db).reset(token)
  resetRestFaults(db, token)
  resetAuditLogResponses(db, token)
  if (token) {
    db.prepare(
      `DELETE FROM guild_voice_states WHERE guild_id IN (
         SELECT id FROM guilds WHERE bot_token = ?
       )`
    ).run(token)
  } else {
    db.exec('DELETE FROM guild_voice_states')
  }
  if (token) {
    db.prepare(
      `DELETE FROM guild_audit_log_entries WHERE guild_id IN (
         SELECT id FROM guilds WHERE bot_token = ?
       )`
    ).run(token)
  } else {
    db.exec('DELETE FROM guild_audit_log_entries')
  }
  if (token) {
    const bot = db
      .prepare('SELECT user_id FROM bots WHERE token = ?')
      .get(token) as { user_id: string } | undefined

    // Reset only the messages and webhooks of the specified token
    db.prepare('DELETE FROM messages WHERE author_token = ?').run(token)
    db.prepare(
      `DELETE FROM webhooks WHERE channel_id IN (
         SELECT c.id FROM channels c
         JOIN guilds g ON g.id = c.guild_id
         WHERE g.bot_token = ?
       )`
    ).run(token)
    db.prepare(
      `DELETE FROM invites WHERE channel_id IN (
         SELECT c.id FROM channels c
         JOIN guilds g ON g.id = c.guild_id
         WHERE g.bot_token = ?
       )`
    ).run(token)
    // application_commands/application_command_permissions are persistent
    // registration data and are deliberately NOT reset here.
    if (bot) {
      db.prepare('DELETE FROM interactions WHERE application_id = ?').run(
        bot.user_id
      )
    }
  } else {
    // Reset all data (the tables themselves are kept)
    db.exec('DELETE FROM messages')
    db.exec('DELETE FROM webhooks')
    db.exec('DELETE FROM invites')
    db.exec('DELETE FROM reactions')
    db.exec('DELETE FROM pins')
    db.exec('DELETE FROM embeds')
    db.exec('DELETE FROM attachments')
    db.exec('DELETE FROM interactions')
  }
}

/**
 * Retrieves all messages in a channel in the test format.
 * @param db - Database
 * @param channelId - Channel ID
 * @returns List of messages
 */
export function getTestMessages(
  db: Database,
  channelId: string
): {
  id: string
  content: string
  author_token: string | null
  created_at: string
  sticker_items?: APIStickerItem[]
}[] {
  const messages = db
    .prepare(
      'SELECT id, content, author_token, created_at FROM messages WHERE channel_id = ? ORDER BY id'
    )
    .all(channelId) as {
    id: string
    content: string
    author_token: string | null
    created_at: string
  }[]
  return messages.map((message) => {
    const items = getMessageStickerItems(db, message.id)
    return { ...message, ...(items.length > 0 && { sticker_items: items }) }
  })
}

/** Request payload for registering a non-bot test user */
export interface CreateTestUserRequest {
  id?: string
  username: string
  global_name?: string | null
  /** User avatar hash, or null for the default avatar. */
  avatar?: string | null
  discriminator?: string
}

/** Response for a newly registered non-bot test user */
export interface CreateTestUserResponse {
  id: string
  username: string
  discriminator: string
}

/**
 * Registers a non-bot user for testing (e.g. to later author an injected
 * message via injectTestMessage). Unlike POST /_test/setup, an explicit ID
 * collision is a hard error -- this endpoint never silently reuses an
 * existing row, since callers are expected to track the users they create.
 * @param db - Database
 * @param request - User creation request
 * @returns Created user info
 * @throws Error with message 'CONFLICT' if the explicit ID already exists
 */
export function createTestUser(
  db: Database,
  request: CreateTestUserRequest
): CreateTestUserResponse {
  const id = request.id ?? generateSnowflake()
  const discriminator = request.discriminator ?? '0'

  if (request.id) {
    const existing = db
      .prepare('SELECT id FROM users WHERE id = ?')
      .get(request.id)
    if (existing) {
      throw new Error('CONFLICT')
    }
  }

  db.prepare(
    'INSERT INTO users (id, username, discriminator, global_name, avatar, bot) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(
    id,
    request.username,
    discriminator,
    request.global_name ?? null,
    request.avatar ?? null
  )

  return { id, username: request.username, discriminator }
}

/** Validated global-name-only fixture for an existing human. */
export interface TestUserGlobalNameRequest {
  /** Omission preserves; null clears; strings are stored exactly as supplied. */
  global_name?: string | null
}

/**
 * Silently prepares an existing human's global name without changing identity.
 * @param db - Database containing the global user profile
 * @param userId - Existing non-bot user ID
 * @param request - Validated narrow fixture
 * @returns Native user object or an explicit target error, without creation
 */
export function prepareTestUserGlobalName(
  db: Database,
  userId: string,
  request: TestUserGlobalNameRequest
): UserObject | 'UNKNOWN_USER' | 'BOT_USER' {
  const user = getUser(db, userId)
  if (!user) return 'UNKNOWN_USER'
  if (user.bot) return 'BOT_USER'
  if (request.global_name === undefined) return user
  db.prepare('UPDATE users SET global_name = ? WHERE id = ?').run(
    request.global_name,
    userId
  )
  return { ...user, global_name: request.global_name }
}

/** Result of joining a registered non-bot user to an existing guild. */
export type JoinTestGuildMemberResult =
  GuildMemberObject | 'UNKNOWN_GUILD' | 'UNKNOWN_USER' | 'BOT_USER' | 'CONFLICT'

/** Validated member-date fixture input for an existing membership. */
export interface MemberDateFixtureRequest {
  joined_at?: string
  premium_since?: string | null
}

/**
 * Atomically prepares existing member dates without emitting Gateway events.
 * @param db - Database
 * @param guildId - Existing guild ID
 * @param userId - Existing member's user ID
 * @param request - Validated fixture; omission preserves, premium_since null clears
 * @returns Stored member or an error reason, without creating resources
 */
export function prepareMemberDateFixture(
  db: Database,
  guildId: string,
  userId: string,
  request: MemberDateFixtureRequest
): GuildMemberObject | 'UNKNOWN_GUILD' | 'UNKNOWN_MEMBER' {
  // Normalize every supplied date before starting any write.
  const joinedAt =
    request.joined_at === undefined
      ? null
      : toDiscordTimestamp(new Date(request.joined_at))
  const premiumSince =
    request.premium_since == null
      ? null
      : toDiscordTimestamp(new Date(request.premium_since))
  return db.transaction(
    (): GuildMemberObject | 'UNKNOWN_GUILD' | 'UNKNOWN_MEMBER' => {
      if (!db.prepare('SELECT id FROM guilds WHERE id = ?').get(guildId)) {
        return 'UNKNOWN_GUILD'
      }
      const member = getGuildMember(db, guildId, userId)
      if (!member) return 'UNKNOWN_MEMBER'
      if (
        request.joined_at === undefined &&
        request.premium_since === undefined
      ) {
        return member
      }
      db.prepare(
        `UPDATE guild_members SET joined_at = COALESCE(?, joined_at),
       premium_since = CASE WHEN ? THEN ? ELSE premium_since END
       WHERE guild_id = ? AND user_id = ?`
      ).run(
        joinedAt,
        request.premium_since === undefined ? 0 : 1,
        premiumSince,
        guildId,
        userId
      )
      const prepared = getGuildMember(db, guildId, userId)
      if (!prepared) throw new Error('Prepared member could not be retrieved')
      return prepared
    }
  )()
}

/**
 * Adds an existing non-bot user without modifying its profile or guild setup.
 * Emits the stored member through the Gateway bus only after commit.
 * @param db - Database
 * @param guildId - Existing guild ID
 * @param userId - Registered non-bot user ID
 * @param nick - Guild nickname (null by default)
 * @returns Stored member, or an error reason with no mutation or emission
 */
export function joinTestGuildMember(
  db: Database,
  guildId: string,
  userId: string,
  nick: string | null = null
): JoinTestGuildMemberResult {
  const join = db.transaction((): JoinTestGuildMemberResult => {
    if (!db.prepare('SELECT id FROM guilds WHERE id = ?').get(guildId)) {
      return 'UNKNOWN_GUILD'
    }
    const user = db
      .prepare('SELECT bot FROM users WHERE id = ?')
      .get(userId) as { bot: number } | undefined
    if (!user) return 'UNKNOWN_USER'
    if (getGuildMember(db, guildId, userId)) return 'CONFLICT'
    if (user.bot === 1) return 'BOT_USER'

    // Keep an explicit UTC offset so member serialization is timezone independent.
    db.prepare(
      'INSERT INTO guild_members (guild_id, user_id, nick, joined_at) VALUES (?, ?, ?, ?)'
    ).run(guildId, userId, nick, toDiscordTimestamp(new Date()))
    const member = getGuildMember(db, guildId, userId)
    if (!member) throw new Error('Joined member could not be retrieved')
    return member
  })

  const result = join()
  if (typeof result !== 'string') {
    gatewayBus.emit('guild.member.add', {
      guildId,
      member: result as unknown as Record<string, unknown>,
    })
  }
  return result
}

/** Request payload for injecting a message authored by a pre-registered user */
export interface InjectTestMessageRequest {
  /** Optional unique Message ID, allowing exact DELETE faults to be prearmed. */
  id?: string
  content?: string
  /** Validated IDs from the existing guild or standard sticker catalog. */
  sticker_ids?: string[] | null
  author: { id: string }
  /** Remove atomically, then queue the captured create and delete snapshots. */
  remove_after_create?: boolean
}

/**
 * Injects a message into a channel, authored by a pre-registered user
 * (typically a non-bot user created via createTestUser), letting a caller
 * pick an arbitrary non-bot author -- unlike the bot/webhook message paths,
 * which always resolve the author to a bot/webhook account.
 *
 * If the channel belongs to a guild, the author is also registered as a
 * guild member (INSERT OR IGNORE), matching how a real Discord member
 * would already be present before posting.
 * @param db - Database
 * @param channelId - Target channel ID
 * @param request - Message injection request
 * @param baseUrl - Base URL (for attachment URL generation)
 * @returns Created message object, or an error code when the channel or
 * author is unknown, or CONFLICT when the explicit Message ID already exists.
 * With remove_after_create, returns the create snapshot after actual deletion.
 * @param persistAttachments - Synchronous attachment writes in the creation transaction
 */
export function injectTestMessage(
  db: Database,
  channelId: string,
  request: InjectTestMessageRequest,
  baseUrl: string,
  persistAttachments?: () => void
):
  | MessageObject
  | 'UNKNOWN_CHANNEL'
  | 'UNKNOWN_USER'
  | 'CONFLICT'
  | 'INVALID_STICKERS' {
  const channel = getChannel(db, channelId)
  if (!channel) return 'UNKNOWN_CHANNEL'

  const author = db
    .prepare('SELECT id FROM users WHERE id = ?')
    .get(request.author.id)
  if (!author) return 'UNKNOWN_USER'

  const stickerItems = resolveMessageStickers(
    db,
    channelId,
    request.sticker_ids ?? [],
    true
  )
  if (!stickerItems) return 'INVALID_STICKERS'

  if (
    request.id &&
    db.prepare('SELECT id FROM messages WHERE id = ?').get(request.id)
  ) {
    return 'CONFLICT'
  }

  const guildId = getGuildIdForChannel(db, channelId)
  const pendingEvents: (() => void)[] = []
  const message = db.transaction(() => {
    const snapshot = createMessage(
      db,
      {
        channelId,
        authorId: request.author.id,
        // A plain human author, rather than a bot token or webhook sentinel.
        authorToken: '',
        messageId: request.id ?? generateSnowflake(),
        content: request.content,
        stickerItems,
      },
      baseUrl,
      () => {
        if (guildId) {
          db.prepare(
            'INSERT OR IGNORE INTO guild_members (guild_id, user_id) VALUES (?, ?)'
          ).run(guildId, request.author.id)
        }
        persistAttachments?.()
      },
      pendingEvents
    )
    if (request.remove_after_create) {
      deleteMessage(db, snapshot.id, channelId, pendingEvents)
    }
    return snapshot
  })()
  // Queue the create snapshot before its optional delete, only after commit.
  for (const emit of pendingEvents) emit()
  return message
}

/**
 * Edits only the content of an existing message authored by a registered human.
 * The channel and author checks run before any mutation. The ordinary message
 * service persists the edit and emits the native message.update Gateway event.
 * @param db - Database
 * @param channelId - Channel the message must belong to
 * @param messageId - Existing message ID
 * @param content - Validated replacement content, including an empty string
 * @param baseUrl - Base URL for attachment URLs in the returned message
 * @returns Updated message, or a target/author error without mutations or events
 */
export function editTestMessage(
  db: Database,
  channelId: string,
  messageId: string,
  content: string,
  baseUrl: string
): MessageObject | 'UNKNOWN_CHANNEL' | 'UNKNOWN_MESSAGE' | 'BOT_AUTHOR' {
  if (!getChannel(db, channelId)) return 'UNKNOWN_CHANNEL'
  const message = getMessage(db, messageId, baseUrl)
  if (message?.channel_id !== channelId) return 'UNKNOWN_MESSAGE'
  return message.author.bot || message.webhook_id
    ? 'BOT_AUTHOR'
    : (updateMessage(db, messageId, { content }, baseUrl) ?? 'UNKNOWN_MESSAGE')
}

/** Rejections shared by the human reaction add and removal controls. */
export type TestReactionTargetError =
  | 'UNKNOWN_CHANNEL'
  | 'UNKNOWN_MESSAGE'
  | 'UNKNOWN_USER'
  | 'UNKNOWN_MEMBER'
  | 'BOT_USER'
  | 'UNSUPPORTED_SCOPE'

/** Resolved human reaction target: delivery scope, author and member. */
interface TestReactionTarget {
  scope: { db: Database; botId: string; token: string }
  messageAuthorId: string
  member: Record<string, unknown>
}

/**
 * Resolves a human reaction target in the documented order: channel and
 * supported guild/setup scope, message, user, bot flag, then membership.
 * Membership is required and never created or modified.
 * @param db - Database
 * @param channelId - Existing guild text or announcement channel
 * @param messageId - Existing public message in that channel
 * @param userId - Registered non-bot member of the channel's guild
 * @returns The resolved target, or a scoped error
 */
function resolveTestReactionTarget(
  db: Database,
  channelId: string,
  messageId: string,
  userId: string
): TestReactionTarget | TestReactionTargetError {
  const channel = getChannel(db, channelId)
  if (!channel) return 'UNKNOWN_CHANNEL'
  if (!channel.guild_id || ![0, 5].includes(channel.type)) {
    return 'UNSUPPORTED_SCOPE'
  }
  const scope = db
    .prepare(
      'SELECT b.user_id AS botId, g.bot_token AS token FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ?'
    )
    .get(channel.guild_id) as { botId: string; token: string } | undefined
  if (!scope) return 'UNSUPPORTED_SCOPE'
  const message = db
    .prepare(
      'SELECT channel_id, author_id FROM messages WHERE id = ? AND (flags & 64) = 0'
    )
    .get(messageId) as { channel_id: string; author_id: string } | undefined
  if (message?.channel_id !== channelId) return 'UNKNOWN_MESSAGE'
  const actor = db.prepare('SELECT bot FROM users WHERE id = ?').get(userId) as
    { bot: number } | undefined
  if (!actor) return 'UNKNOWN_USER'
  if (actor.bot !== 0) return 'BOT_USER'
  const member = getGuildMember(db, channel.guild_id, userId)
  return member
    ? {
        scope: { ...scope, db },
        messageAuthorId: message.author_id,
        member: { ...member },
      }
    : 'UNKNOWN_MEMBER'
}

/**
 * Adds a normal or burst (super) reaction as an existing human guild member.
 * Validates all targets before using the ordinary persistence and reaction
 * dispatch path. Normal and burst memberships are independent, so a human may
 * hold both for one emoji.
 * @param db - Database
 * @param channelId - Existing guild text or announcement channel
 * @param messageId - Existing public message in that channel
 * @param userId - Registered non-bot member of the channel's guild
 * @param emoji - Validated Unicode emoji sequence, or custom `name:id` /
 * `a:name:id` emoji that must belong to the channel's guild
 * @param kind - Burst flag and validated colors; omitted means normal
 * @returns Success or a scoped error without writes or events on rejection
 */
export function injectTestReaction(
  db: Database,
  channelId: string,
  messageId: string,
  userId: string,
  emoji: string,
  kind?: ReactionBurst
): 'OK' | TestReactionTargetError | 'UNKNOWN_EMOJI' | 'WRITE_FAILED' {
  const target = resolveTestReactionTarget(db, channelId, messageId, userId)
  if (typeof target === 'string') return target
  const customId = parseReactionEmoji(emoji).id
  if (
    customId !== null &&
    findGuildEmoji(db, customId)?.guild_id !==
      getChannel(db, channelId)?.guild_id
  ) {
    return 'UNKNOWN_EMOJI'
  }
  return addReaction(db, messageId, userId, emoji, target, kind)
    ? 'OK'
    : 'WRITE_FAILED'
}

/**
 * Removes a human's normal or burst reaction membership, emitting a scoped
 * native MESSAGE_REACTION_REMOVE when a row was removed. Discord documents no
 * way to remove only one user's burst reaction (clears remove both types), so
 * this control is the fixture's way to end one. Target rules match
 * {@link injectTestReaction}, except that a custom emoji need not still exist:
 * a reaction can be removed after its guild emoji was deleted.
 * @param db - Database
 * @param channelId - Existing guild text or announcement channel
 * @param messageId - Existing public message in that channel
 * @param userId - Registered non-bot member of the channel's guild
 * @param emoji - Validated Unicode emoji sequence, or custom `name:id` /
 * `a:name:id` emoji
 * @param burst - Remove the burst membership instead of the normal one
 * @returns Success (including when nothing was held) or a scoped error
 */
export function removeTestReaction(
  db: Database,
  channelId: string,
  messageId: string,
  userId: string,
  emoji: string,
  burst: boolean
): 'OK' | TestReactionTargetError {
  const target = resolveTestReactionTarget(db, channelId, messageId, userId)
  if (typeof target === 'string') return target
  removeReaction(db, messageId, userId, emoji, burst, target.scope)
  return 'OK'
}

/** Request body accepted by POST /_test/interactions */
export interface TestInteractionRequest {
  application_id: string
  type?: number
  /** Invoking user's Discord locale; defaults to en-US. */
  locale?: string
  command_name: string
  guild_id?: string
  channel_id?: string
  user_id?: string
  options?: Record<string, unknown>[]
}

/** Result of a test-interaction creation attempt */
export type CreateTestInteractionResult =
  | { ok: true; interaction: InteractionObject }
  | {
      ok: false
      reason: 'unknown_command' | 'unknown_guild' | 'unknown_channel'
    }

/** Minimal row shape needed to resolve a command by name */
interface CommandIdRow {
  id: string
}

/**
 * Simulates an interaction against a registered command, without a real
 * Discord client. Prefers a guild-scoped command match (when `guild_id` is
 * given) and falls back to a global command of the same name; a request
 * with no `guild_id` only ever matches a global command.
 *
 * A `guild_id` must name an existing guild the application's bot is still in
 * and a `channel_id` an existing channel (of that guild, when given) outside
 * guilds the bot left or lost, so that no interaction is created for them. A
 * request with only a guild `channel_id` is created in that channel's guild.
 * @param db - Database
 * @param request - Test interaction request body
 * @returns The created interaction, or why no interaction was created
 */
export function createTestInteraction(
  db: Database,
  request: TestInteractionRequest
): CreateTestInteractionResult {
  /** Whether the application's bot is still in a guild of its setup. */
  const botInGuild = (guildId: string): boolean =>
    db
      .prepare(
        'SELECT 1 FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ? AND g.bot_present = 1 AND b.user_id = ?'
      )
      .get(guildId, request.application_id) !== undefined
  if (request.guild_id !== undefined && !botInGuild(request.guild_id))
    return { ok: false, reason: 'unknown_guild' }
  // A channel-only request still happens in the channel's guild, which the
  // interaction must carry so removed setups never receive it.
  let interactionGuildId = request.guild_id
  if (request.channel_id !== undefined) {
    const channel = db
      .prepare(
        `SELECT c.guild_id FROM channels c
         LEFT JOIN guilds g ON g.id = c.guild_id
         WHERE c.id = ? AND COALESCE(g.bot_present, 1) = 1`
      )
      .get(request.channel_id) as { guild_id: string | null } | undefined
    if (
      !channel ||
      (request.guild_id !== undefined && channel.guild_id !== request.guild_id)
    )
      return { ok: false, reason: 'unknown_channel' }
    if (channel.guild_id !== null) {
      if (!botInGuild(channel.guild_id))
        return { ok: false, reason: 'unknown_channel' }
      interactionGuildId = channel.guild_id
    }
  }
  const guildCommand = request.guild_id
    ? (db
        .prepare(
          'SELECT id FROM application_commands WHERE application_id = ? AND guild_id = ? AND name = ?'
        )
        .get(request.application_id, request.guild_id, request.command_name) as
        CommandIdRow | undefined)
    : undefined

  const globalCommand = guildCommand
    ? undefined
    : (db
        .prepare(
          'SELECT id FROM application_commands WHERE application_id = ? AND guild_id IS NULL AND name = ?'
        )
        .get(request.application_id, request.command_name) as
        CommandIdRow | undefined)

  const command = guildCommand ?? globalCommand
  if (!command) return { ok: false, reason: 'unknown_command' }

  const userId = request.user_id ?? generateSnowflake()
  const interactionId = generateSnowflake()
  // Interaction tokens authorize the callback/followup endpoints on their
  // own (no bot-token auth), so use a CSPRNG rather than a predictable
  // Snowflake-derived value, matching webhook token generation.
  const interactionToken = randomBytes(48).toString('base64url')

  const interaction = createInteraction(db, {
    interactionId,
    applicationId: request.application_id,
    token: interactionToken,
    type: request.type ?? 2,
    locale: request.locale,
    guildId: interactionGuildId,
    channelId: request.channel_id,
    commandId: command.id,
    data: { options: request.options ?? [] },
    userId,
  })

  return { ok: true, interaction }
}
