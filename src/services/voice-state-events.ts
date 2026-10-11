import type { Database } from '../db'
import { getGuildMember } from './guild-members'
import { publishVoiceStateSnapshot } from './voice-state-publisher'
import type { VoiceStateFixtureMutation } from './voice-states'

/**
 * Publishes a committed voice transition with its member and setup scope.
 * Cross-guild disconnects caused by the same write are published first, so
 * every observer sees the old guild's leave before the new guild's join.
 */
export function publishGuildVoiceStateMutation(
  db: Database,
  mutation: VoiceStateFixtureMutation
): void {
  publishVoiceStateSnapshot(db, mutation, (guildId, userId) =>
    getGuildMember(db, guildId, userId)
  )
}
