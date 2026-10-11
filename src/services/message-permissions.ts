/** Guild permission checks scoped to creating messages through channel REST. */
import type { Database } from '../db'
import {
  DiscordErrorCode,
  discordError,
  type DiscordErrorResponse,
} from '../errors'
import { getChannel } from './channels'
import { PermissionBit, resolveChannelPermissions } from './guild-permissions'

const { VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS } = PermissionBit

/** A send denial with the HTTP statuses produced by this permission check. */
export interface MessageSendError extends DiscordErrorResponse {
  status: 400 | 403 | 404
}

/** Creates a Discord-compatible send denial. */
function sendError(
  code: number,
  message: string,
  status: MessageSendError['status']
): MessageSendError {
  return { ...discordError(code, message, status), status }
}

/**
 * Resolves current persisted guild permissions with BigInt. Role allows are
 * combined before applying overwrites; member overwrites take precedence.
 * Owner/admin bypass is based on guild permissions, never channel overwrites.
 * DM and webhook sends deliberately have separate behavior. Threads are
 * explicitly unsupported here until their membership/archive lifecycle is
 * modeled; they must not accidentally inherit ordinary SEND_MESSAGES behavior.
 * Call again immediately before persistence after any asynchronous preparation.
 */
export function getMessageSendError(
  db: Database,
  channelId: string,
  userId: string,
  payload: Record<string, unknown> = {}
): MessageSendError | null {
  const channel = getChannel(db, channelId)
  if (!channel)
    return sendError(DiscordErrorCode.UNKNOWN_CHANNEL, 'Unknown Channel', 404)

  if (!channel.guild_id && (channel.type === 1 || channel.type === 3))
    return null

  if (!channel.guild_id || ![0, 2, 5, 13].includes(channel.type))
    return sendError(
      DiscordErrorCode.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE,
      'Cannot execute action on this channel type',
      400
    )

  const resolved = resolveChannelPermissions(
    db,
    channel.guild_id,
    channel.permission_overwrites,
    userId
  )
  if (!resolved)
    return sendError(DiscordErrorCode.MISSING_ACCESS, 'Missing Access', 403)
  if (resolved.privileged) return null
  const { permissions } = resolved

  if (!(permissions & VIEW_CHANNEL))
    return sendError(DiscordErrorCode.MISSING_ACCESS, 'Missing Access', 403)

  const member = db
    .prepare(
      'SELECT communication_disabled_until FROM guild_members WHERE guild_id = ? AND user_id = ?'
    )
    .get(channel.guild_id, userId) as
    { communication_disabled_until: string | null } | undefined
  const timedOut =
    member?.communication_disabled_until != null &&
    Date.parse(member.communication_disabled_until) > Date.now()
  return timedOut ||
    !(permissions & SEND_MESSAGES) ||
    (Array.isArray(payload.embeds) &&
      payload.embeds.length > 0 &&
      !(permissions & EMBED_LINKS))
    ? sendError(
        DiscordErrorCode.MISSING_PERMISSIONS,
        'Missing Permissions',
        403
      )
    : null
}
