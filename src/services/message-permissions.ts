/** Guild permission checks scoped to creating messages through channel REST. */
import type { Database } from '../db'
import {
  DiscordErrorCode,
  discordError,
  type DiscordErrorResponse,
} from '../errors'
import { getChannel } from './channels'

const ADMINISTRATOR = 1n << 3n
const VIEW_CHANNEL = 1n << 10n
const SEND_MESSAGES = 1n << 11n
const EMBED_LINKS = 1n << 14n

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

  const guildId = channel.guild_id
  const guild = db
    .prepare('SELECT owner_id FROM guilds WHERE id = ?')
    .get(guildId) as { owner_id: string } | undefined
  // seedGuild intentionally uses the fixture bot as owner. Owners inherently
  // have access even in the minimal helper fixture without a member row.
  if (guild?.owner_id === userId) return null

  const member = db
    .prepare(
      'SELECT communication_disabled_until FROM guild_members WHERE guild_id = ? AND user_id = ?'
    )
    .get(guildId, userId) as
    { communication_disabled_until: string | null } | undefined
  if (!member)
    return sendError(DiscordErrorCode.MISSING_ACCESS, 'Missing Access', 403)

  const roles = db
    .prepare(
      `SELECT id, permissions FROM roles
       WHERE guild_id = ? AND (id = ? OR id IN (
         SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?
       ))`
    )
    .all(guildId, guildId, guildId, userId) as {
    id: string
    permissions: string
  }[]
  let permissions = 0n
  const roleIds = new Set<string>()
  for (const role of roles) {
    permissions |= BigInt(role.permissions)
    if (role.id !== guildId) roleIds.add(role.id)
  }
  if (permissions & ADMINISTRATOR) return null

  const everyone = channel.permission_overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === guildId
  )
  if (everyone)
    permissions =
      (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow)

  let allow = 0n
  let deny = 0n
  for (const overwrite of channel.permission_overwrites) {
    if (overwrite.type !== 0 || !roleIds.has(overwrite.id)) continue
    allow |= BigInt(overwrite.allow)
    deny |= BigInt(overwrite.deny)
  }
  permissions = (permissions & ~deny) | allow

  const personal = channel.permission_overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === userId
  )
  if (personal)
    permissions =
      (permissions & ~BigInt(personal.deny)) | BigInt(personal.allow)

  if (!(permissions & VIEW_CHANNEL))
    return sendError(DiscordErrorCode.MISSING_ACCESS, 'Missing Access', 403)

  const timedOut =
    member.communication_disabled_until !== null &&
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
