import type { GatewayVoiceStateUpdateDispatchData } from 'discord-api-types/v10'
import type { Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import type { GuildMemberObject } from './guild-members'
import type { VoiceStateFixtureMutation } from './voice-states'

/** Database and bot setup that owns a guild's scoped native dispatches. */
export interface GuildDispatchScope {
  db: Database
  botId: string
  token: string
}

/**
 * Resolves the bot setup owning a guild, used to scope native dispatches.
 * @param db - Database
 * @param guildId - Guild ID
 * @returns Owning scope, or null when the guild has no registered bot
 */
export function getGuildDispatchScope(
  db: Database,
  guildId: string
): GuildDispatchScope | null {
  const owner = db
    .prepare(
      'SELECT b.user_id AS botId, b.token FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ?'
    )
    .get(guildId) as { botId: string; token: string } | undefined
  return owner ? { db, ...owner } : null
}

/** Loads the current member snapshot embedded in a voice dispatch. */
export type VoiceStateMemberLoader = (
  guildId: string,
  userId: string
) => GuildMemberObject | null

/**
 * Publishes a committed voice transition with its member and setup scope.
 * Cross-guild disconnects caused by the same write are published first, so
 * every observer sees the old guild's leave before the new guild's join.
 * Unchanged, silent and already-disconnected transitions publish nothing.
 * The member loader is injected so member services can publish without an
 * import cycle.
 * @param db - Database the transition was committed to
 * @param mutation - Committed voice-state mutation
 * @param loadMember - Reads the member snapshot for a guild and user
 */
export function publishVoiceStateSnapshot(
  db: Database,
  mutation: VoiceStateFixtureMutation,
  loadMember: VoiceStateMemberLoader
): void {
  for (const displaced of mutation.displaced)
    publishVoiceStateSnapshot(db, displaced, loadMember)
  const { state, previous, changed, emit } = mutation
  if (!changed || !emit) return
  // A disconnected fixture has no live voice session to update. Disconnect
  // itself still publishes the old session with channel_id: null.
  if (state.channel_id === null && previous?.channel_id == null) return
  const scope = getGuildDispatchScope(db, state.guild_id)
  const member = loadMember(state.guild_id, state.user_id)
  if (!scope || !member) return
  const data: GatewayVoiceStateUpdateDispatchData = {
    ...state,
    member: {
      ...member,
      user: { ...member.user, primary_guild: null },
    },
  }
  gatewayBus.emit('voice.state.update', { state: data, scope })
}
