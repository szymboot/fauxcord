import type { GatewayVoiceStateUpdateDispatchData } from 'discord-api-types/v10'
import type { Database } from '../db'
import { gatewayBus } from '../gateway/bus'
import { getGuildMember } from './guild-members'
import type { VoiceStateFixtureMutation } from './voice-states'

/** Publishes a committed voice transition with its member and setup scope. */
export function publishGuildVoiceStateMutation(
  db: Database,
  mutation: VoiceStateFixtureMutation
): void {
  const { state, previous, changed, emit } = mutation
  if (!changed || !emit) return
  // A disconnected fixture has no live voice session to update. Disconnect
  // itself still publishes the old session with channel_id: null.
  if (state.channel_id === null && previous?.channel_id == null) return
  const owner = db
    .prepare(
      'SELECT b.user_id AS botId, b.token FROM guilds g JOIN bots b ON b.token = g.bot_token WHERE g.id = ?'
    )
    .get(state.guild_id) as { botId: string; token: string } | undefined
  const member = getGuildMember(db, state.guild_id, state.user_id)
  if (!owner || !member) return
  const data: GatewayVoiceStateUpdateDispatchData = {
    ...state,
    member: {
      ...member,
      user: { ...member.user, primary_guild: null },
    },
  }
  gatewayBus.emit('voice.state.update', {
    state: data,
    scope: { db, ...owner },
  })
}
