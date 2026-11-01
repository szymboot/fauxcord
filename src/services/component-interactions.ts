/**
 * Component interaction service
 *
 * Simulates a user clicking a button on a bot message, dispatching a native
 * MESSAGE_COMPONENT (type 3) INTERACTION_CREATE.
 */

import { randomBytes } from 'node:crypto'
import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import { createInteraction, type InteractionObject } from './interactions'
import { getGuildMember } from './guild-members'
import { hydrateMessageRow, MESSAGE_FLAGS, type MessageRow } from './messages'
import { getUser } from './users'
import { resolveInteractionScope } from './interaction-scope'

/** Request body accepted by POST /_test/interactions with `type: 3` */
export interface TestComponentInteractionRequest {
  application_id: string
  type: 3
  channel_id: string
  message_id: string
  /** `custom_id` of a clickable button on the message. */
  custom_id: string
  /** Clicking user; must be a guild member in guilds, a user in DMs. */
  user_id: string
  guild_id?: string
  /** Invoking user's Discord locale; defaults to en-US. */
  locale?: string
}

/** Result of a component interaction creation attempt */
export type CreateTestComponentInteractionResult =
  | { ok: true; interaction: InteractionObject }
  | {
      ok: false
      reason:
        | 'unknown_guild'
        | 'unknown_channel'
        | 'unknown_message'
        | 'foreign_message'
        | 'unknown_component'
        | 'link_button'
        | 'disabled_component'
        | 'unknown_member'
        | 'unknown_user'
    }

/**
 * Simulates a user clicking a button, as a Discord client allows it: the
 * message must exist in the channel (an ephemeral one only for the user it was
 * sent to) and have been sent by the application's bot, and carry a non-link, enabled button with exactly that `custom_id`.
 * The guild and channel gating of every simulated interaction applies, and
 * the clicking user must exist (as a guild member in guilds, as a recipient
 * in DM channels). The dispatched
 * interaction carries the message as REST returns it at click time.
 * @param db - Database
 * @param request - Validated component interaction request body
 * @param baseUrl - Base URL (for message attachment URLs)
 * @returns The created interaction, or why no interaction was created
 */
export function createTestComponentInteraction(
  db: Database,
  request: TestComponentInteractionRequest,
  baseUrl: string
): CreateTestComponentInteractionResult {
  const scope = resolveInteractionScope(
    db,
    request.application_id,
    request.guild_id,
    request.channel_id
  )
  if (!scope.ok) return scope

  const row = db
    .prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?')
    .get(request.message_id, request.channel_id) as MessageRow | undefined
  const message = row ? hydrateMessageRow(db, row, baseUrl) : null
  if (!message) return { ok: false, reason: 'unknown_message' }
  if (message.author.id !== request.application_id) {
    return { ok: false, reason: 'foreign_message' }
  }
  if (message.flags & MESSAGE_FLAGS.EPHEMERAL) {
    // An ephemeral response is only visible to the user who invoked it.
    const recipient = db
      .prepare(
        'SELECT user_id FROM interactions WHERE initial_response_message_id = ?'
      )
      .get(message.id) as { user_id: string } | undefined
    if (recipient?.user_id !== request.user_id) {
      return { ok: false, reason: 'unknown_message' }
    }
  }

  const buttons = message.components.flatMap((actionRow) =>
    actionRow.components.map((button) => button as unknown as ButtonShape)
  )
  const button = buttons.find((b) => b.custom_id === request.custom_id)
  if (!button) {
    const isLink = buttons.some((b) => b.url === request.custom_id)
    return { ok: false, reason: isLink ? 'link_button' : 'unknown_component' }
  }
  if (button.disabled === true) {
    return { ok: false, reason: 'disabled_component' }
  }

  if (scope.guildId) {
    if (!getGuildMember(db, scope.guildId, request.user_id)) {
      return { ok: false, reason: 'unknown_member' }
    }
  } else if (
    !getUser(db, request.user_id) ||
    !db
      .prepare(
        'SELECT 1 FROM channel_recipients WHERE channel_id = ? AND user_id = ?'
      )
      .get(request.channel_id, request.user_id)
  ) {
    // Only a recipient of a DM can see, and so click, its messages.
    return { ok: false, reason: 'unknown_user' }
  }

  const interaction = createInteraction(db, {
    interactionId: generateSnowflake(),
    applicationId: request.application_id,
    // Interaction tokens authorize the callback endpoints on their own, so
    // use a CSPRNG like every other simulated interaction.
    token: randomBytes(48).toString('base64url'),
    type: 3,
    locale: request.locale,
    guildId: scope.guildId,
    channelId: request.channel_id,
    data: { custom_id: request.custom_id, component_type: 2 },
    message: message as unknown as Record<string, unknown>,
    userId: request.user_id,
  })
  return { ok: true, interaction }
}

/** The button fields a click is checked against. */
interface ButtonShape {
  custom_id?: string
  url?: string
  disabled?: boolean
}
