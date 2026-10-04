/**
 * Test control service
 *
 * Handles test environment setup and reset.
 */

import { randomBytes } from 'node:crypto'
import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import { toDiscordTimestamp } from '../timestamp'
import { gatewayBus } from '../gateway/bus'
import { buildGuildCreatePayload } from './guilds'
import { getGuildMember, type GuildMemberObject } from './guild-members'
import { getChannel } from './channels'
import { resetRestFaults } from './rest-faults'
import {
  createMessage,
  deleteMessage,
  getMessage,
  updateMessage,
  getGuildIdForChannel,
  type MessageObject,
} from './messages'
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
  /** Registered non-bot owner; defaults to the setup bot when omitted. */
  owner_id?: string
  channels?: SetupChannelRequest[]
}

/** Channel information type for test setup */
export interface SetupChannelRequest {
  id?: string
  name: string
  type?: number
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
 * Sets up the test environment.
 * @param db - Database
 * @param request - Setup request
 * @returns Setup result
 * @throws Error with CONFLICT for duplicate tokens, INVALID_OWNER_ID for
 * malformed owner IDs, UNKNOWN_USER for missing owners, or BOT_OWNER for bots
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
        `INSERT INTO guilds (id, name, owner_id, bot_token) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           owner_id = excluded.owner_id,
           bot_token = excluded.bot_token`
      ).run(guildId, guildReq.name, ownerId, request.token)

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
        const channelId = channelReq.id ?? generateSnowflake()
        const channelType = channelReq.type ?? 0

        // Create the channel (if the same ID still exists, overwrite its contents and reuse it = idempotent)
        db.prepare(
          `INSERT INTO channels (id, guild_id, name, type) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             guild_id = excluded.guild_id,
             name = excluded.name,
             type = excluded.type`
        ).run(channelId, guildId, channelReq.name, channelType)

        channelsResponse.push({
          id: channelId,
          name: channelReq.name,
          type: channelType,
        })
      }

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
  db.prepare('DELETE FROM bots WHERE token = ?').run(token)
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
  resetRestFaults(db, token)
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
}[] {
  return db
    .prepare(
      'SELECT id, content, author_token, created_at FROM messages WHERE channel_id = ? ORDER BY id'
    )
    .all(channelId) as {
    id: string
    content: string
    author_token: string | null
    created_at: string
  }[]
}

/** Request payload for registering a non-bot test user */
export interface CreateTestUserRequest {
  id?: string
  username: string
  global_name?: string | null
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
    'INSERT INTO users (id, username, discriminator, global_name, bot) VALUES (?, ?, ?, ?, 0)'
  ).run(id, request.username, discriminator, request.global_name ?? null)

  return { id, username: request.username, discriminator }
}

/** Result of joining a registered non-bot user to an existing guild. */
export type JoinTestGuildMemberResult =
  GuildMemberObject | 'UNKNOWN_GUILD' | 'UNKNOWN_USER' | 'BOT_USER' | 'CONFLICT'

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
  author: { id: string }
  /** Delete synchronously after the ordinary native create event is queued. */
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
): MessageObject | 'UNKNOWN_CHANNEL' | 'UNKNOWN_USER' | 'CONFLICT' {
  const channel = getChannel(db, channelId)
  if (!channel) return 'UNKNOWN_CHANNEL'

  const author = db
    .prepare('SELECT id FROM users WHERE id = ?')
    .get(request.author.id)
  if (!author) return 'UNKNOWN_USER'

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
  | { ok: false; reason: 'unknown_command' }

/** Minimal row shape needed to resolve a command by name */
interface CommandIdRow {
  id: string
}

/**
 * Simulates an interaction against a registered command, without a real
 * Discord client. Prefers a guild-scoped command match (when `guild_id` is
 * given) and falls back to a global command of the same name; a request
 * with no `guild_id` only ever matches a global command.
 * @param db - Database
 * @param request - Test interaction request body
 * @returns The created interaction, or unknown_command if no match exists
 */
export function createTestInteraction(
  db: Database,
  request: TestInteractionRequest
): CreateTestInteractionResult {
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
    guildId: request.guild_id,
    channelId: request.channel_id,
    commandId: command.id,
    data: { options: request.options ?? [] },
    userId,
  })

  return { ok: true, interaction }
}
