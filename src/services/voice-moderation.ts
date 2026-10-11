/**
 * Voice moderation applied through Modify Guild Member
 * (`PATCH /guilds/:guildId/members/:userId` with `mute`, `deaf` or
 * `channel_id`).
 */
import { runInTransaction, type Database } from '../db'
import { getChannel, type ChannelObject } from './channels'
import {
  getGuildMember,
  persistGuildMemberUpdate,
  publishGuildMemberUpdate,
  type GuildMemberObject,
  type GuildMemberUpdateParams,
} from './guild-members'
import { PermissionBit, resolveChannelPermissions } from './guild-permissions'
import { publishGuildVoiceStateMutation } from './voice-state-events'
import {
  applyGuildVoiceStatePatch,
  getGuildVoiceState,
  type VoiceStateFixtureMutation,
} from './voice-states'
import type { TestVoiceStatePatch } from '../validators/voice-state'

/** Channel types a member can be connected to or moved into. */
const VOICE_CHANNEL_TYPES = new Set([2, 13])

/** Validated Modify Guild Member fields, including the voice ones. */
export interface ModifyGuildMemberParams extends GuildMemberUpdateParams {
  /** Destination voice/stage channel; null disconnects */
  channel_id?: string | null
}

/** Voice moderation failures detected before any write. */
export type VoiceModerationError =
  | 'NOT_CONNECTED'
  | 'UNKNOWN_CHANNEL'
  | 'INVALID_CHANNEL_TYPE'
  | 'MISSING_PERMISSIONS'

/**
 * Whether the payload requests any voice moderation (null mute/deaf is a no-op).
 * @param payload - Validated member update payload
 * @returns True when mute, deaf or channel_id must be applied
 */
export function hasVoiceChange(payload: ModifyGuildMemberParams): boolean {
  return (
    (payload.mute !== undefined && payload.mute !== null) ||
    (payload.deaf !== undefined && payload.deaf !== null) ||
    payload.channel_id !== undefined
  )
}

/**
 * Checks whether the actor holds every required bit in a voice/stage channel.
 * Missing VIEW_CHANNEL or CONNECT implicitly denies the other channel
 * permissions, per Discord's implicit permission rules.
 */
function hasChannelPermissions(
  db: Database,
  channel: ChannelObject,
  actorId: string,
  required: bigint
): boolean {
  const resolved = resolveChannelPermissions(
    db,
    channel.guild_id ?? '',
    channel.permission_overwrites,
    actorId
  )
  if (!resolved) return false
  if (resolved.privileged) return true
  const permissions = resolved.permissions
  return (
    (permissions & PermissionBit.VIEW_CHANNEL) !== 0n &&
    (permissions & PermissionBit.CONNECT) !== 0n &&
    (permissions & required) === required
  )
}

/**
 * Checks Discord's voice moderation rules for one Modify Guild Member payload
 * without writing anything. The target must currently be connected to a
 * voice/stage channel for any non-null mute/deaf or any channel_id (40032).
 * A destination must be a voice/stage channel in the same guild. The actor
 * needs VIEW_CHANNEL + CONNECT + MUTE_MEMBERS / DEAFEN_MEMBERS / MOVE_MEMBERS
 * in the target's current channel, and VIEW_CHANNEL + CONNECT + MOVE_MEMBERS
 * in a different
 * destination. Owners and guild administrators bypass permission checks.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - Target member user ID
 * @param actorId - Acting bot user ID, or null to skip permission checks
 * @param payload - Validated member update payload
 * @returns The first failure, or null when allowed (including no voice change)
 */
export function checkVoiceModeration(
  db: Database,
  guildId: string,
  userId: string,
  actorId: string | null,
  payload: ModifyGuildMemberParams
): VoiceModerationError | null {
  if (!hasVoiceChange(payload)) return null

  const state = getGuildVoiceState(db, guildId, userId)
  const current =
    state?.channel_id == null ? null : getChannel(db, state.channel_id)
  if (current?.guild_id !== guildId || !VOICE_CHANNEL_TYPES.has(current.type))
    return 'NOT_CONNECTED'

  const destination =
    typeof payload.channel_id === 'string'
      ? getChannel(db, payload.channel_id)
      : null
  if (typeof payload.channel_id === 'string') {
    if (destination?.guild_id !== guildId) return 'UNKNOWN_CHANNEL'
    if (!VOICE_CHANNEL_TYPES.has(destination.type))
      return 'INVALID_CHANNEL_TYPE'
  }

  if (actorId === null) return null

  let required = 0n
  if (payload.mute != null) required |= PermissionBit.MUTE_MEMBERS
  if (payload.deaf != null) required |= PermissionBit.DEAFEN_MEMBERS
  if (payload.channel_id !== undefined) required |= PermissionBit.MOVE_MEMBERS
  const deniedAtDestination =
    destination !== null &&
    destination.id !== current.id &&
    !hasChannelPermissions(
      db,
      destination,
      actorId,
      PermissionBit.CONNECT | PermissionBit.MOVE_MEMBERS
    )
  return deniedAtDestination ||
    !hasChannelPermissions(db, current, actorId, required)
    ? 'MISSING_PERMISSIONS'
    : null
}

/**
 * Builds the voice-state patch for an already checked payload.
 * A move to a different channel keeps the session and self mute/deaf/video,
 * ends Go Live streaming, clears request-to-speak and enters a stage as
 * suppressed audience. A null channel_id uses the fixture disconnect
 * semantics (same session, channel_id null, stream/video/request cleared).
 */
function buildVoicePatch(
  db: Database,
  guildId: string,
  userId: string,
  payload: ModifyGuildMemberParams
): TestVoiceStatePatch {
  const flags: TestVoiceStatePatch = {
    ...(payload.mute != null && { mute: payload.mute }),
    ...(payload.deaf != null && { deaf: payload.deaf }),
  }
  if (payload.channel_id === null) return { ...flags, channel_id: null }
  if (payload.channel_id === undefined) return flags
  const destination = getChannel(db, payload.channel_id)
  const current = getGuildVoiceState(db, guildId, userId)
  return !destination || current?.channel_id === payload.channel_id
    ? flags
    : {
        ...flags,
        channel_id: payload.channel_id,
        self_stream: false,
        request_to_speak_timestamp: null,
        suppress: destination.type === 13,
      }
}

/**
 * Applies a Modify Guild Member payload, including voice moderation, after
 * {@link checkVoiceModeration} succeeded. Member and voice-state writes commit
 * in one transaction; GUILD_MEMBER_UPDATE and then VOICE_STATE_UPDATE (only
 * when the voice state actually changed) are published after commit.
 * @param db - Database
 * @param guildId - Guild ID
 * @param userId - Target member user ID
 * @param payload - Validated and checked payload
 * @returns Updated member, or null when the member does not exist
 */
export function modifyGuildMember(
  db: Database,
  guildId: string,
  userId: string,
  payload: ModifyGuildMemberParams
): GuildMemberObject | null {
  const memberPayload: GuildMemberUpdateParams = {
    nick: payload.nick,
    roles: payload.roles,
    mute: payload.mute,
    deaf: payload.deaf,
    communication_disabled_until: payload.communication_disabled_until,
  }
  const voiceChange = hasVoiceChange(payload)
  const result = runInTransaction(db, () => {
    if (!getGuildMember(db, guildId, userId)) return null
    let mutation: VoiceStateFixtureMutation | null = null
    if (voiceChange) {
      const applied = applyGuildVoiceStatePatch(
        db,
        guildId,
        userId,
        buildVoicePatch(db, guildId, userId, payload)
      )
      // Checked beforehand; a string here means the state changed underneath.
      if (typeof applied === 'string')
        throw new Error(`Voice moderation failed: ${applied}`)
      mutation = applied
    }
    const member = persistGuildMemberUpdate(db, guildId, userId, memberPayload)
    return member ? { member, mutation } : null
  })
  if (!result) return null
  publishGuildMemberUpdate(db, guildId, result.member)
  if (result.mutation) publishGuildVoiceStateMutation(db, result.mutation)
  return result.member
}
