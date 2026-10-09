import { randomUUID } from 'node:crypto'
import type { APIVoiceState } from 'discord-api-types/v10'
import { runInTransaction, type Database } from '../db'
import { validateTestVoiceState } from '../validators/voice-state'
import type { TestVoiceStatePatch } from '../validators/voice-state'

/** Native guild voice state with explicit streaming and guild identity. */
export interface GuildVoiceState extends APIVoiceState {
  guild_id: string
  self_stream: boolean
}

/** SQLite voice-state flags before conversion to native booleans. */
interface VoiceStateRow {
  guild_id: string
  user_id: string
  channel_id: string | null
  session_id: string
  deaf: number
  mute: number
  self_deaf: number
  self_mute: number
  self_stream: number | null
  self_video: number
  suppress: number
  request_to_speak_timestamp: string | null
}

/** Converts a stored row into the reusable native voice-state shape. */
export function toGuildVoiceState(row: VoiceStateRow): GuildVoiceState {
  return {
    guild_id: row.guild_id,
    user_id: row.user_id,
    channel_id: row.channel_id,
    session_id: row.session_id,
    deaf: row.deaf === 1,
    mute: row.mute === 1,
    self_deaf: row.self_deaf === 1,
    self_mute: row.self_mute === 1,
    self_stream: row.self_stream === 1,
    self_video: row.self_video === 1,
    suppress: row.suppress === 1,
    request_to_speak_timestamp: row.request_to_speak_timestamp,
  }
}

/** Reads a stored state, including a retained disconnected state. */
export function getGuildVoiceState(
  db: Database,
  guildId: string,
  userId: string
): GuildVoiceState | null {
  const row = db
    .prepare(
      'SELECT * FROM guild_voice_states WHERE guild_id = ? AND user_id = ?'
    )
    .get(guildId, userId) as VoiceStateRow | undefined
  return row ? toGuildVoiceState(row) : null
}

/** Lists valid connected members in one guild, excluding legacy orphan rows. */
export function getGuildVoiceStates(
  db: Database,
  guildId: string
): GuildVoiceState[] {
  const rows = db
    .prepare(
      `SELECT vs.* FROM guild_voice_states vs
    JOIN guilds g ON g.id = vs.guild_id
    JOIN users u ON u.id = vs.user_id
    JOIN guild_members m ON m.guild_id = vs.guild_id AND m.user_id = vs.user_id
    JOIN channels c ON c.id = vs.channel_id AND c.guild_id = vs.guild_id
    WHERE vs.guild_id = ? AND c.type IN (2, 13)
    ORDER BY vs.user_id`
    )
    .all(guildId) as VoiceStateRow[]
  return rows.map((row) => toGuildVoiceState(row))
}

/** Fixture failures reported before any state is changed. */
export type VoiceStateFixtureError =
  | 'INVALID_INPUT'
  | 'UNKNOWN_GUILD'
  | 'UNKNOWN_USER'
  | 'UNKNOWN_MEMBER'
  | 'UNKNOWN_CHANNEL'

/** Committed fixture state and publication policy for native dispatch callers. */
export interface VoiceStateFixtureMutation {
  state: GuildVoiceState
  previous: GuildVoiceState | null
  changed: boolean
  /** Defaults to true; false requests silent historical preparation. */
  emit: boolean
}

/** Applies a validated patch after checking every referenced entity. */
function applyTestGuildVoiceState(
  db: Database,
  guildId: string,
  userId: string,
  payload: TestVoiceStatePatch
): VoiceStateFixtureMutation | VoiceStateFixtureError {
  return runInTransaction(db, () => {
    if (!db.prepare('SELECT 1 FROM guilds WHERE id = ?').get(guildId))
      return 'UNKNOWN_GUILD'
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId))
      return 'UNKNOWN_USER'
    if (
      !db
        .prepare(
          'SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?'
        )
        .get(guildId, userId)
    )
      return 'UNKNOWN_MEMBER'
    const existing = getGuildVoiceState(db, guildId, userId)
    if (!existing && payload.channel_id === undefined) return 'INVALID_INPUT'
    const channelId =
      payload.channel_id === undefined
        ? (existing?.channel_id ?? null)
        : payload.channel_id
    if (channelId !== null) {
      const channel = db
        .prepare('SELECT guild_id, type FROM channels WHERE id = ?')
        .get(channelId) as { guild_id: string | null; type: number } | undefined
      if (channel?.guild_id !== guildId) return 'UNKNOWN_CHANNEL'
      if (channel.type !== 2 && channel.type !== 13) return 'INVALID_INPUT'
    } else if (
      payload.self_stream === true ||
      payload.self_video === true ||
      payload.request_to_speak_timestamp != null
    ) {
      return 'INVALID_INPUT'
    }
    const state: GuildVoiceState = {
      guild_id: guildId,
      user_id: userId,
      channel_id: channelId,
      session_id:
        existing && (channelId === null || existing.channel_id !== null)
          ? existing.session_id
          : randomUUID(),
      deaf: payload.deaf ?? existing?.deaf ?? false,
      mute: payload.mute ?? existing?.mute ?? false,
      self_deaf: payload.self_deaf ?? existing?.self_deaf ?? false,
      self_mute: payload.self_mute ?? existing?.self_mute ?? false,
      self_stream:
        channelId === null
          ? false
          : (payload.self_stream ?? existing?.self_stream ?? false),
      self_video:
        channelId === null
          ? false
          : (payload.self_video ?? existing?.self_video ?? false),
      suppress: payload.suppress ?? existing?.suppress ?? false,
      request_to_speak_timestamp:
        channelId === null
          ? null
          : payload.request_to_speak_timestamp === undefined
            ? (existing?.request_to_speak_timestamp ?? null)
            : payload.request_to_speak_timestamp,
    }
    db.prepare(
      `INSERT INTO guild_voice_states
      (guild_id, user_id, channel_id, session_id, deaf, mute, self_deaf,
       self_mute, self_stream, self_video, suppress, request_to_speak_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
      channel_id = excluded.channel_id, session_id = excluded.session_id,
      deaf = excluded.deaf, mute = excluded.mute, self_deaf = excluded.self_deaf,
      self_mute = excluded.self_mute, self_stream = excluded.self_stream,
      self_video = excluded.self_video, suppress = excluded.suppress,
      request_to_speak_timestamp = excluded.request_to_speak_timestamp`
    ).run(
      state.guild_id,
      state.user_id,
      state.channel_id,
      state.session_id,
      Number(state.deaf),
      Number(state.mute),
      Number(state.self_deaf),
      Number(state.self_mute),
      Number(state.self_stream),
      Number(state.self_video),
      Number(state.suppress),
      state.request_to_speak_timestamp
    )
    return {
      state,
      previous: existing,
      changed: JSON.stringify(existing) !== JSON.stringify(state),
      emit: payload.emit ?? true,
    }
  })
}

/**
 * Validates and atomically patches one synthetic member's voice state.
 * First creation requires channel_id (null is permitted). Moves and flag
 * updates retain the session; reconnecting after null creates a new session.
 * Disconnect clears streaming, video and request-to-speak. Other omitted
 * flags remain unchanged. emit is reserved for the dispatch integration;
 * this foundation emits no Gateway event, including with active sessions.
 */
export function setTestGuildVoiceState(
  db: Database,
  guildId: string,
  userId: string,
  input: unknown
): VoiceStateFixtureMutation | VoiceStateFixtureError {
  const payload = validateTestVoiceState(input)
  return payload
    ? applyTestGuildVoiceState(db, guildId, userId, payload)
    : 'INVALID_INPUT'
}
