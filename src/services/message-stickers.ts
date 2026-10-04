import type { APIStickerItem } from 'discord-api-types/v10'
import type { Database } from '../db'
import { getCatalogSticker } from './catalog'
import { getGuildSticker } from './guild-advanced'

/** Reads sent sticker snapshots in their original request order. */
export function getMessageStickerItems(
  db: Database,
  messageId: string
): APIStickerItem[] {
  return db
    .prepare(
      'SELECT id, name, format_type FROM message_stickers WHERE message_id = ? ORDER BY position'
    )
    .all(messageId) as APIStickerItem[]
}

/** Resolves existing catalog identities into immutable Discord sticker items.
 * Guild stickers must be available and belong to the channel's guild.
 * Human fixtures may also use standard pack stickers, without Nitro simulation.
 */
export function resolveMessageStickers(
  db: Database,
  channelId: string,
  stickerIds: string[],
  allowStandard = false
): APIStickerItem[] | null {
  const channel = db
    .prepare('SELECT guild_id FROM channels WHERE id = ?')
    .get(channelId) as { guild_id: string | null } | undefined
  const items: APIStickerItem[] = []
  for (const id of stickerIds) {
    const sticker = channel?.guild_id
      ? getGuildSticker(db, channel.guild_id, id)
      : null
    const standard = allowStandard ? getCatalogSticker(db, id) : undefined
    const resolved =
      sticker?.type === 2 && sticker.available === true
        ? sticker
        : standard?.type === 1
          ? standard
          : null
    if (
      !resolved ||
      typeof resolved.name !== 'string' ||
      ![1, 2, 3, 4].includes(Number(resolved.format_type))
    )
      return null
    items.push({
      id,
      name: resolved.name,
      format_type: resolved.format_type as APIStickerItem['format_type'],
    })
  }
  return items
}
