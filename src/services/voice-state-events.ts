import type { Database } from '../db'
import { getGuildMember, type GuildMemberObject } from './guild-members'
import { publishVoiceStateSnapshot } from './voice-state-publisher'
import {
  toDisconnectedVoiceState,
  type GuildVoiceState,
  type VoiceStateFixtureMutation,
} from './voice-states'

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

/**
 * Publishes the voice disconnect Discord sends when a connected member is
 * removed from the guild. The payload matches a fixture disconnect: the voice
 * session is kept, streaming, video and request-to-speak are cleared, server
 * mute/deaf come from the member, and the departing member (read before
 * deletion) is embedded. Disconnected kept
 * states have no live session and publish nothing.
 * @param db - Database
 * @param previous - Voice state read before the member was deleted
 * @param member - Member object read before the member was deleted
 */
export function publishRemovedMemberVoiceDisconnect(
  db: Database,
  previous: GuildVoiceState,
  member: GuildMemberObject
): void {
  publishVoiceStateSnapshot(
    db,
    {
      // Server mute/deaf are owned by the member, as in every other
      // disconnect, even when a legacy stored row diverges.
      state: {
        ...toDisconnectedVoiceState(previous),
        mute: member.mute,
        deaf: member.deaf,
      },
      previous,
      changed: true,
      emit: true,
      displaced: [],
    },
    () => member
  )
}
