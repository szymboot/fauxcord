import type { AttachmentInput } from '../services/attachments'

/** Maximum supported file size, matching Fauxcord multipart sends (25 MiB). */
export const MAX_FILE_SIZE = 25 * 1024 * 1024
import { MESSAGE_LIMITS } from './message'

/** Returns whether a storage path component cannot escape its directory. */
export function isAttachmentFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 255 &&
    value !== '.' &&
    value !== '..' &&
    value.isWellFormed() &&
    !/[\\/\p{Cc}]/u.test(value)
  )
}

/** Validates a MIME type suitable for a download response header. */
export function isAttachmentContentType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[\x20-\x7E]*)?$/.test(value)
  )
}

/** Decodes strict canonical base64 fixtures after checking count and size. */
export function decodeTestAttachments(
  value: unknown
): AttachmentInput[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MESSAGE_LIMITS.ATTACHMENTS_MAX)
    return null
  const files: AttachmentInput[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      return null
    const file = item as Record<string, unknown>
    if (
      !isAttachmentFilename(file.filename) ||
      !isAttachmentContentType(file.content_type) ||
      typeof file.data !== 'string' ||
      file.data.length > 4 * Math.ceil(MAX_FILE_SIZE / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
    )
      return null
    const data = Buffer.from(file.data, 'base64')
    if (
      data.byteLength > MAX_FILE_SIZE ||
      data.toString('base64') !== file.data
    )
      return null
    files.push({
      filename: file.filename,
      contentType: file.content_type,
      data,
    })
  }
  return files
}
