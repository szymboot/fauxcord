/**
 * Channel operations service
 *
 * Provides CRUD operations for channels.
 */

import { getRestFaultRuntime } from './rest-faults'
import { disconnectGuildVoiceChannelMembers } from './voice-states'
import { publishGuildVoiceStateMutation } from './voice-state-events'
import { runInTransaction, type Database } from '../db'
// Used for compile-time type drift detection.
import type {
  APIGuildTextChannel,
  APIGuildVoiceChannel,
  APIOverwrite,
} from 'discord-api-types/v10'
import type { ChannelType } from 'discord-api-types/v10'
import { generateSnowflake } from '../snowflake'
import { gatewayBus } from '../gateway/bus'
import {
  defaultUserLimit,
  VOICE_CHANNEL_LIMITS,
  type VoiceChannelSettings,
} from '../validators/channel'

/**
 * Compile-time guard: ensures the safe-field subset of ChannelObject is
 * structurally compatible with APIGuildTextChannel.
 * Fails to compile when discord-api-types renames or retypes these fields.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ChannelCompatGuard =
  Pick<
    APIGuildTextChannel<ChannelType.GuildText>,
    'id' | 'guild_id' | 'position' | 'name' | 'flags'
  > extends Pick<
    ChannelObject,
    'id' | 'guild_id' | 'position' | 'name' | 'flags'
  >
    ? true
    : never

/**
 * Compile-time guard: ensures the voice settings on ChannelObject stay
 * structurally compatible with APIGuildVoiceChannel (API ⟶ local direction;
 * `video_quality_mode` is widened to `number` as stored in the DB).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _VoiceChannelCompatGuard =
  Pick<
    APIGuildVoiceChannel,
    'bitrate' | 'user_limit' | 'rtc_region' | 'video_quality_mode'
  > extends Pick<
    ChannelObject,
    'bitrate' | 'user_limit' | 'rtc_region' | 'video_quality_mode'
  >
    ? true
    : never

/**
 * Compile-time guard: detects upstream drift in APIOverwrite (API ⟶ local
 * direction), failing to compile when discord-api-types renames or retypes
 * these fields. This is intentionally one-directional, matching
 * `_ChannelCompatGuard` above: `ChannelOverwriteObject.type` is deliberately
 * widened to `number` (the DB stores an integer) rather than the narrower
 * `OverwriteType` enum, so a bidirectional check would fail by design.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _OverwriteCompatGuard =
  Pick<APIOverwrite, 'id' | 'type' | 'allow' | 'deny'> extends Pick<
    ChannelOverwriteObject,
    'id' | 'type' | 'allow' | 'deny'
  >
    ? true
    : never

/**
 * Whether a channel type carries voice connections (voice 2 or stage 13).
 * @param type - Channel type
 * @returns true for voice-capable channel types
 */
export function isVoiceCapableChannelType(type: number): boolean {
  return type === 2 || type === 13
}

/** Channel record type retrieved from the DB */
interface ChannelRow {
  id: string
  guild_id: string | null
  type: number
  name: string | null
  topic: string | null
  nsfw: number
  position: number
  rate_limit_per_user: number
  parent_id: string | null
  last_message_id: string | null
  voice_status: string | null
  owner_id: string | null
  bitrate: number | null
  user_limit: number | null
  rtc_region: string | null
  video_quality_mode: number | null
}

/** Channel permission overwrite object for API responses */
export interface ChannelOverwriteObject {
  /** Role or user ID (the overwrite_id) */
  id: string
  /** Overwrite target type: 0 = role, 1 = member */
  type: number
  /** Allowed permission bitfield, as a string */
  allow: string
  /** Denied permission bitfield, as a string */
  deny: string
}

/** Channel object for API responses */
export interface ChannelObject {
  id: string
  type: number
  /** Channel flags bitset (always 0 in the mock) */
  flags: number
  guild_id: string | null
  position: number
  name: string | null
  topic: string | null
  nsfw: boolean
  last_message_id: string | null
  rate_limit_per_user: number
  parent_id: string | null
  permission_overwrites: ChannelOverwriteObject[]
  voice_status?: string | null
  /** Voice/stage only: bitrate in bits per second (default 64000). */
  bitrate?: number
  /** Voice/stage only: user limit, 0 meaning unlimited. */
  user_limit?: number
  /** Voice/stage only: voice region ID, null meaning automatic. */
  rtc_region?: string | null
  /** Voice/stage only, present once set: 1 = auto, 2 = full (720p). */
  video_quality_mode?: number
  recipients?: ChannelRecipientUser[]
  icon?: string | null
  owner_id?: string
}

/** Recipient user object embedded in a DM/group-DM channel response */
export interface ChannelRecipientUser {
  id: string
  username: string
  discriminator: string
  avatar: string | null
  bot: boolean
  public_flags: number
  flags: number
  global_name: string | null
  primary_guild: null
}

/** DB record type for a channel recipient's joined user row */
interface ChannelRecipientRow {
  id: string
  username: string
  discriminator: string
  avatar: string | null
  bot: number
  global_name: string | null
}

/**
 * Retrieves the recipient users of a DM or group-DM channel.
 * @param db - Database
 * @param channelId - Channel ID
 * @returns Array of recipient user objects
 */
export function getChannelRecipientUsers(
  db: Database,
  channelId: string
): ChannelRecipientUser[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.discriminator, u.avatar, u.bot, u.global_name
       FROM channel_recipients cr
       JOIN users u ON u.id = cr.user_id
       WHERE cr.channel_id = ?`
    )
    .all(channelId) as ChannelRecipientRow[]
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    discriminator: row.discriminator,
    avatar: row.avatar,
    bot: row.bot === 1,
    public_flags: 0,
    flags: 0,
    global_name: row.global_name ?? null,
    primary_guild: null,
  }))
}

/**
 * Adds a user as a recipient of a group-DM channel (idempotent).
 * @param db - Database
 * @param channelId - Channel ID
 * @param userId - User ID to add
 */
export function addChannelRecipient(
  db: Database,
  channelId: string,
  userId: string
): void {
  db.prepare(
    'INSERT OR IGNORE INTO channel_recipients (channel_id, user_id) VALUES (?, ?)'
  ).run(channelId, userId)
}

/**
 * Removes a user from a group-DM channel's recipients (idempotent).
 * @param db - Database
 * @param channelId - Channel ID
 * @param userId - User ID to remove
 */
export function removeChannelRecipient(
  db: Database,
  channelId: string,
  userId: string
): void {
  db.prepare(
    'DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?'
  ).run(channelId, userId)
}

/** DB record type for a channel permission overwrite */
interface ChannelOverwriteRow {
  id: string
  type: number
  allow: string
  deny: string
}

/**
 * Retrieves all permission overwrites for a channel.
 * @param db - Database
 * @param channelId - Channel ID
 * @returns Array of overwrite objects (empty if none)
 */
export function getChannelOverwrites(
  db: Database,
  channelId: string
): ChannelOverwriteObject[] {
  const rows = db
    .prepare(
      'SELECT id, type, allow, deny FROM channel_overwrites WHERE channel_id = ? ORDER BY id'
    )
    .all(channelId) as ChannelOverwriteRow[]
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    allow: row.allow,
    deny: row.deny,
  }))
}

/**
 * Retrieves permission overwrites for multiple channels in a single query,
 * grouped by channel ID. Used to avoid an N+1 query pattern when building a
 * channel list.
 * @param db - Database
 * @param channelIds - Channel IDs to load overwrites for
 * @returns Map from channel ID to its overwrite objects (channels with no
 * overwrites are absent from the map)
 */
export function getChannelOverwritesForChannels(
  db: Database,
  channelIds: string[]
): Map<string, ChannelOverwriteObject[]> {
  const result = new Map<string, ChannelOverwriteObject[]>()
  if (channelIds.length === 0) return result

  const placeholders = channelIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT channel_id, id, type, allow, deny FROM channel_overwrites
       WHERE channel_id IN (${placeholders}) ORDER BY id`
    )
    .all(...channelIds) as (ChannelOverwriteRow & { channel_id: string })[]

  for (const row of rows) {
    const list = result.get(row.channel_id) ?? []
    list.push({ id: row.id, type: row.type, allow: row.allow, deny: row.deny })
    result.set(row.channel_id, list)
  }
  return result
}

/**
 * Converts a DB channel record into the API response format.
 * @param row - DB record
 * @param overwrites - The channel's permission overwrites (empty if none)
 * @returns Object for API responses
 */
function toChannelObject(
  row: ChannelRow,
  overwrites: ChannelOverwriteObject[],
  recipients: ChannelRecipientUser[] = []
): ChannelObject {
  const obj: ChannelObject = {
    id: row.id,
    type: row.type,
    flags: 0,
    guild_id: row.guild_id,
    position: row.position,
    name: row.name,
    topic: row.topic,
    nsfw: row.nsfw === 1,
    last_message_id: row.last_message_id,
    rate_limit_per_user: row.rate_limit_per_user,
    parent_id: row.parent_id,
    permission_overwrites: overwrites,
    ...(row.voice_status !== null && { voice_status: row.voice_status }),
    // Discord sends bitrate/user_limit/rtc_region on every voice and stage
    // channel, and video_quality_mode only once it has been set ("1 when not
    // present").
    ...(isVoiceCapableChannelType(row.type) && {
      bitrate: row.bitrate ?? VOICE_CHANNEL_LIMITS.DEFAULT_BITRATE,
      user_limit: row.user_limit ?? defaultUserLimit(row.type),
      rtc_region: row.rtc_region,
      ...(row.video_quality_mode !== null && {
        video_quality_mode: row.video_quality_mode,
      }),
    }),
    ...((row.type === 1 || row.type === 3) && { recipients }),
    ...(row.type === 3 && {
      icon: null,
      owner_id: row.owner_id ?? recipients.at(0)?.id ?? row.id,
    }),
  }

  return obj
}

/**
 * Retrieves a channel by ID.
 * @param db - Database
 * @param channelId - Channel ID
 * @returns Channel object, or null if it does not exist
 */
export function getChannel(
  db: Database,
  channelId: string
): ChannelObject | null {
  const row = db
    .prepare('SELECT * FROM channels WHERE id = ?')
    .get(channelId) as ChannelRow | undefined
  if (!row) return null
  const recipients =
    row.type === 1 || row.type === 3 ? getChannelRecipientUsers(db, row.id) : []
  return toChannelObject(row, getChannelOverwrites(db, row.id), recipients)
}

/** Publishes the persisted guild channel to its registered bot's sessions. */
function emitOverwriteChannelUpdate(db: Database, channelId: string): void {
  const channel = getChannel(db, channelId)
  if (!channel?.guild_id) return
  const owner = db
    .prepare(
      'SELECT bots.user_id, bots.token FROM guilds JOIN bots ON bots.token = guilds.bot_token WHERE guilds.id = ?'
    )
    .get(channel.guild_id) as { user_id: string; token: string } | undefined
  if (!owner) return

  gatewayBus.emit('channel.update', {
    channel: channel as unknown as Record<string, unknown>,
    scope: { db, botId: owner.user_id, token: owner.token },
  })
}

/**
 * Creates or updates a permission overwrite for a channel (upsert).
 * @param db - Database
 * @param channelId - Channel ID
 * @param overwriteId - Role or user ID
 * @param params - Overwrite type and permission bitfields
 */
export function putChannelOverwrite(
  db: Database,
  channelId: string,
  overwriteId: string,
  params: { type: number; allow: string; deny: string }
): void {
  db.prepare(
    `INSERT INTO channel_overwrites (channel_id, id, type, allow, deny)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, id) DO UPDATE SET
       type = excluded.type,
       allow = excluded.allow,
       deny = excluded.deny`
  ).run(channelId, overwriteId, params.type, params.allow, params.deny)
  emitOverwriteChannelUpdate(db, channelId)
}

/**
 * Deletes a permission overwrite from a channel. No-op if it does not exist.
 * @param db - Database
 * @param channelId - Channel ID
 * @param overwriteId - Role or user ID
 */
export function deleteChannelOverwrite(
  db: Database,
  channelId: string,
  overwriteId: string
): void {
  const result = db
    .prepare('DELETE FROM channel_overwrites WHERE channel_id = ? AND id = ?')
    .run(channelId, overwriteId)
  if (result.changes > 0) emitOverwriteChannelUpdate(db, channelId)
}

/**
 * Sets a voice/stage channel's status text.
 * @param db - Database
 * @param channelId - Channel ID
 * @param status - Status text, or null to clear it
 * @returns Updated channel object, or null if the channel does not exist
 */
export function setVoiceStatus(
  db: Database,
  channelId: string,
  status: string | null
): ChannelObject | null {
  const row = db
    .prepare('SELECT * FROM channels WHERE id = ?')
    .get(channelId) as ChannelRow | undefined
  if (!row) return null

  db.prepare('UPDATE channels SET voice_status = ? WHERE id = ?').run(
    status,
    channelId
  )

  const updated = db
    .prepare('SELECT * FROM channels WHERE id = ?')
    .get(channelId) as ChannelRow
  return toChannelObject(updated, getChannelOverwrites(db, updated.id))
}

/**
 * Maps provided voice settings to their DB columns (null = type default).
 * @param settings - Validated voice settings
 * @returns Column/value pairs for the provided settings
 */
function voiceSettingColumns(
  settings: VoiceChannelSettings
): Record<string, unknown> {
  return {
    ...(settings.bitrate !== undefined && { bitrate: settings.bitrate }),
    ...(settings.user_limit !== undefined && {
      user_limit: settings.user_limit,
    }),
    ...(settings.rtc_region !== undefined && {
      rtc_region: settings.rtc_region,
    }),
    ...(settings.video_quality_mode !== undefined && {
      video_quality_mode: settings.video_quality_mode,
    }),
  }
}

/** Channel update request type (voice settings apply to voice/stage only) */
export interface ChannelUpdatePayload extends VoiceChannelSettings {
  /** Accepted only when unchanged; see validateChannelTypeChange. */
  type?: number
  name?: string
  topic?: string | null
  nsfw?: boolean
  rate_limit_per_user?: number
  position?: number
}

/**
 * Updates channel information.
 * @param db - Database
 * @param channelId - Channel ID
 * @param payload - Update payload
 * @returns Updated channel object, or null if it does not exist
 */
export function updateChannel(
  db: Database,
  channelId: string,
  payload: ChannelUpdatePayload
): ChannelObject | null {
  const current = db
    .prepare('SELECT * FROM channels WHERE id = ?')
    .get(channelId) as ChannelRow | undefined
  if (!current) return null

  const updates: Record<string, unknown> = {
    ...(payload.name !== undefined && { name: payload.name }),
    ...(payload.topic !== undefined && { topic: payload.topic }),
    ...(payload.nsfw !== undefined && { nsfw: payload.nsfw ? 1 : 0 }),
    ...(payload.rate_limit_per_user !== undefined && {
      rate_limit_per_user: payload.rate_limit_per_user,
    }),
    ...(payload.position !== undefined && { position: payload.position }),
    ...(isVoiceCapableChannelType(current.type) &&
      voiceSettingColumns(payload)),
  }

  if (Object.keys(updates).length > 0) {
    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(', ')
    db.prepare(`UPDATE channels SET ${setClauses} WHERE id = ?`).run(
      ...Object.values(updates),
      channelId
    )
  }

  const updated = db
    .prepare('SELECT * FROM channels WHERE id = ?')
    .get(channelId) as ChannelRow
  const result = toChannelObject(updated, getChannelOverwrites(db, updated.id))

  gatewayBus.emit('channel.update', {
    channel: result as unknown as Record<string, unknown>,
  })

  return result
}

/**
 * Deletes a channel. Deleting a guild category clears its direct children's
 * parent IDs without deleting them or disconnecting their voice members.
 * Updated child snapshots and the category deletion are published only after
 * the transaction succeeds. Child updates precede the category deletion in
 * Fauxcord; Discord documents the events but does not guarantee their order.
 * Members connected to a deleted voice or stage channel are
 * disconnected first: their states are retained with `channel_id: null` and
 * one `VOICE_STATE_UPDATE` per member (numeric user ID order) is published
 * before `CHANNEL_DELETE`, so clients can still resolve the old channel from
 * their cache while handling the disconnects.
 * @param db - Database
 * @param channelId - Channel ID
 * @returns Deleted channel object, or null if it does not exist
 */
export function deleteChannel(
  db: Database,
  channelId: string
): ChannelObject | null {
  const deleted = runInTransaction(db, () => {
    const row = db
      .prepare('SELECT * FROM channels WHERE id = ?')
      .get(channelId) as ChannelRow | undefined
    if (!row) return null

    // Build the response before deleting: the DELETE cascades to
    // channel_overwrites, so overwrites must be read first.
    const channel = toChannelObject(row, getChannelOverwrites(db, row.id))
    const children: ChannelObject[] = []
    if (row.type === 4 && row.guild_id !== null) {
      const childRows = db
        .prepare(
          'SELECT * FROM channels WHERE parent_id = ? AND guild_id = ? ORDER BY position, id'
        )
        .all(channelId, row.guild_id) as ChannelRow[]
      db.prepare(
        'UPDATE channels SET parent_id = NULL WHERE parent_id = ? AND guild_id = ?'
      ).run(channelId, row.guild_id)
      const overwrites = getChannelOverwritesForChannels(
        db,
        childRows.map((child) => child.id)
      )
      for (const child of childRows) {
        children.push(
          toChannelObject(
            { ...child, parent_id: null },
            overwrites.get(child.id) ?? []
          )
        )
      }
    }
    // Disconnect before deleting: the FK cascade would otherwise silently
    // drop the voice states referencing this channel.
    const disconnects = disconnectGuildVoiceChannelMembers(db, channelId)
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId)
    return { channel, children, disconnects }
  })
  if (!deleted) return null
  const { channel: result, children, disconnects } = deleted
  getRestFaultRuntime(db).prune()

  for (const mutation of disconnects)
    publishGuildVoiceStateMutation(db, mutation)
  for (const child of children) {
    gatewayBus.emit('channel.update', {
      channel: child as unknown as Record<string, unknown>,
    })
  }
  gatewayBus.emit('channel.delete', {
    channel: result as unknown as Record<string, unknown>,
  })

  return result
}

/**
 * Retrieves the list of channels in a guild.
 * @param db - Database
 * @param guildId - Guild ID
 * @returns Array of channel objects
 */
export function getGuildChannels(
  db: Database,
  guildId: string
): ChannelObject[] {
  // Exclude thread types (10/11/12): like the real Discord API, threads are
  // not returned by GET /guilds/{guild_id}/channels.
  const rows = db
    .prepare(
      'SELECT * FROM channels WHERE guild_id = ? AND type NOT IN (10, 11, 12) ORDER BY position, id'
    )
    .all(guildId) as ChannelRow[]
  // Bulk-load overwrites for all channels in one query to avoid N+1.
  const overwritesByChannel = getChannelOverwritesForChannels(
    db,
    rows.map((row) => row.id)
  )
  return rows.map((row) =>
    toChannelObject(row, overwritesByChannel.get(row.id) ?? [])
  )
}

/** Guild channel creation parameters */
export interface GuildChannelCreateParams extends VoiceChannelSettings {
  guildId: string
  name: string
  type?: number
  topic?: string | null
  nsfw?: boolean
  parentId?: string | null
  position: number
}

/**
 * Creates a channel within a guild.
 * @param db - Database
 * @param params - Channel creation parameters
 * @returns Created channel object
 */
export function createGuildChannel(
  db: Database,
  params: GuildChannelCreateParams
): ChannelObject {
  const channelId = generateSnowflake()
  const type = params.type ?? 0
  const voice = isVoiceCapableChannelType(type)
  db.prepare(
    `INSERT INTO channels (id, guild_id, name, type, topic, nsfw, position, parent_id,
       bitrate, user_limit, rtc_region, video_quality_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    channelId,
    params.guildId,
    params.name,
    type,
    params.topic ?? null,
    params.nsfw ? 1 : 0,
    params.position,
    params.parentId ?? null,
    voice ? (params.bitrate ?? null) : null,
    voice ? (params.user_limit ?? null) : null,
    voice ? (params.rtc_region ?? null) : null,
    voice ? (params.video_quality_mode ?? null) : null
  )

  const row = db
    .prepare('SELECT * FROM channels WHERE id = ?')
    .get(channelId) as ChannelRow
  // A newly created channel never has permission overwrites yet.
  const result = toChannelObject(row, [])

  gatewayBus.emit('channel.create', {
    channel: result as unknown as Record<string, unknown>,
  })

  return result
}

/**
 * Finds or creates a 1:1 DM channel between the bot and a recipient user.
 * Reuses an existing DM channel with the same recipient (matching real
 * Discord's `POST /users/@me/channels` idempotency), scoping the lookup to
 * channels with exactly the bot and the recipient as recipients — both the
 * calling bot and the target recipient are required, so a DM previously
 * created between the same recipient and a *different* bot is never reused
 * across bots, and a stale group-DM containing the same user is also not
 * confused with a 1:1 DM.
 * @param db - Database
 * @param botUserId - Bot's own user ID (also stored as a recipient row so
 * `getChannelRecipientUsers` reflects both parties)
 * @param recipientId - Recipient user ID
 * @returns The existing or newly created DM channel object
 */
export function getOrCreateDmChannel(
  db: Database,
  botUserId: string,
  recipientId: string
): ChannelObject {
  const existing = db
    .prepare(
      `SELECT c.id FROM channels c
       WHERE c.type = 1
         AND c.guild_id IS NULL
         AND EXISTS (
           SELECT 1 FROM channel_recipients cr
           WHERE cr.channel_id = c.id AND cr.user_id = ?
         )
         AND EXISTS (
           SELECT 1 FROM channel_recipients cr3
           WHERE cr3.channel_id = c.id AND cr3.user_id = ?
         )
         AND (
           SELECT COUNT(*) FROM channel_recipients cr2
           WHERE cr2.channel_id = c.id
         ) = 2`
    )
    .get(recipientId, botUserId) as { id: string } | undefined

  if (existing) {
    const channel = getChannel(db, existing.id)
    if (channel) return channel
  }

  const channelId = generateSnowflake()
  db.prepare(
    'INSERT INTO channels (id, guild_id, type) VALUES (?, NULL, 1)'
  ).run(channelId)
  addChannelRecipient(db, channelId, botUserId)
  addChannelRecipient(db, channelId, recipientId)

  const channel = getChannel(db, channelId)
  if (!channel) throw new Error('Failed to create DM channel')
  return channel
}

/**
 * Creates a group-DM channel. `access_tokens` in the real API resolve to
 * distinct OAuth2 users; the mock does not perform token resolution, so
 * the created channel's only recipient is the calling bot itself (see
 * spec Issue #136 for this deliberate scope limitation).
 * @param db - Database
 * @param botUserId - Bot's own user ID, added as the sole recipient
 * @returns The newly created group-DM channel object
 */
export function createGroupDmChannel(
  db: Database,
  botUserId: string
): ChannelObject {
  const channelId = generateSnowflake()
  db.prepare(
    'INSERT INTO channels (id, guild_id, type) VALUES (?, NULL, 3)'
  ).run(channelId)
  addChannelRecipient(db, channelId, botUserId)

  const channel = getChannel(db, channelId)
  if (!channel) throw new Error('Failed to create group DM channel')
  return channel
}
