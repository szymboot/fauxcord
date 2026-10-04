/**
 * File attachment service
 *
 * Handles saving and serving attachments.
 */

import { mkdir, writeFile, readFile, access, rm, open } from 'node:fs/promises'
import { rmSync, rmdirSync } from 'node:fs'
import { generateSnowflake } from '../snowflake'
import {
  MAX_FILE_SIZE,
  isAttachmentFilename,
  isAttachmentContentType,
} from '../validators/attachment'
import path from 'node:path'
import { constants } from 'node:fs'
import type { Database } from '../db'

export { MAX_FILE_SIZE } from '../validators/attachment'

/** Attachment information type */
export interface AttachmentInfo {
  id: string
  filename: string
  size: number
  contentType: string
  url: string
  proxyUrl: string
}

/** In-memory file input shared by human fixtures and multipart sends. */
export interface AttachmentInput {
  filename: string
  contentType: string
  data: ArrayBuffer | Uint8Array
}

/** Download metadata retained independently of the message row. */
interface RetainedAttachment {
  id: string
  channel_id: string
  message_id: string
  author_token: string
  filename: string
  content_type: string
  file_path: string
}

/** Removes empty parent directories without disturbing other uploads. */
function pruneEmptyParents(uploadPath: string, filePath: string): void {
  let dir = path.dirname(filePath)
  while (dir !== path.resolve(uploadPath)) {
    try {
      rmdirSync(dir)
    } catch (error) {
      if (
        ['ENOTEMPTY', 'ENOENT'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      )
        return
      throw error
    }
    dir = path.dirname(dir)
  }
}

/**
 * Writes private files before a synchronous message transaction publishes them.
 * The callback must call persist inside its transaction. On failure, only this
 * request's unpublished files are removed; no transaction spans an await.
 */
export async function withMessageAttachments<T>(
  db: Database,
  uploadPath: string,
  channelId: string,
  messageId: string,
  authorToken: string,
  files: AttachmentInput[],
  create: (persist: () => void) => T
): Promise<T> {
  if (!isAttachmentFilename(channelId) || !isAttachmentFilename(messageId))
    throw new Error('Invalid attachment scope')
  const prepared: (RetainedAttachment & { size: number })[] = []
  try {
    for (const file of files) {
      if (
        !isAttachmentFilename(file.filename) ||
        !isAttachmentContentType(file.contentType)
      )
        throw new Error('Invalid attachment metadata')
      const buffer =
        file.data instanceof Uint8Array
          ? Buffer.from(file.data)
          : Buffer.from(new Uint8Array(file.data))
      if (buffer.length > MAX_FILE_SIZE) throw new Error('File too large')
      const id = generateSnowflake()
      const filePath = path.join(channelId, messageId, id, file.filename)
      const record = {
        id,
        channel_id: channelId,
        message_id: messageId,
        author_token: authorToken,
        filename: file.filename,
        content_type: file.contentType,
        file_path: filePath,
        size: buffer.length,
      }
      prepared.push(record)
      const absolute = path.resolve(uploadPath, filePath)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, buffer, { flag: 'wx' })
    }
    return create(() => {
      for (const file of prepared) {
        db.prepare(
          `INSERT INTO attachments
          (id, message_id, filename, size, content_type, file_path)
          VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          file.id,
          messageId,
          file.filename,
          file.size,
          file.content_type,
          file.file_path
        )
        db.prepare(
          `INSERT INTO attachment_files
          (id, channel_id, message_id, author_token, filename, content_type, file_path)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          file.id,
          channelId,
          messageId,
          authorToken,
          file.filename,
          file.content_type,
          file.file_path
        )
      }
    })
  } finally {
    for (const file of prepared) {
      if (
        db.prepare('SELECT id FROM attachment_files WHERE id = ?').get(file.id)
      ) {
        continue
      }

      const absolute = path.resolve(uploadPath, file.file_path)
      await rm(absolute, { force: true })
      pruneEmptyParents(uploadPath, absolute)
    }
  }
}

/** Clears retained files for a reset token or a specific setup's channels. */
export function cleanupAttachmentFiles(
  db: Database,
  uploadPath: string,
  scope: { token?: string; setupToken?: string } = {}
): void {
  const records = db
    .prepare(
      `SELECT * FROM attachment_files${
        scope.setupToken
          ? ` WHERE channel_id IN (SELECT c.id FROM channels c
              JOIN guilds g ON g.id = c.guild_id WHERE g.bot_token = ?)`
          : scope.token
            ? ' WHERE author_token = ?'
            : ''
      }`
    )
    .all(
      ...(scope.setupToken
        ? [scope.setupToken]
        : scope.token
          ? [scope.token]
          : [])
    ) as RetainedAttachment[]
  for (const file of records) {
    const absolute = path.resolve(uploadPath, file.file_path)
    rmSync(absolute, { force: true })
    pruneEmptyParents(uploadPath, absolute)
    db.prepare('DELETE FROM attachment_files WHERE id = ?').run(file.id)
  }
}

/** Resolves published metadata for a scoped URL, including deleted messages. */
export function findAttachmentFile(
  db: Database,
  channelId: string,
  messageId: string,
  filename: string,
  attachmentId?: string
): RetainedAttachment | undefined {
  return db
    .prepare(
      `SELECT * FROM attachment_files
    WHERE channel_id = ? AND message_id = ? AND filename = ?${attachmentId ? ' AND id = ?' : ''}`
    )
    .get(
      channelId,
      messageId,
      filename,
      ...(attachmentId ? [attachmentId] : [])
    ) as RetainedAttachment | undefined
}

/**
 * Saves a file and records the attachment information in the DB.
 * @param db - Database
 * @param uploadPath - Upload base directory
 * @param baseUrl - Base URL
 * @param channelId - Channel ID
 * @param messageId - Message ID
 * @param attachmentId - Attachment ID
 * @param filename - File name
 * @param contentType - Content-Type
 * @param data - File data
 * @returns Attachment information
 */
export async function saveAttachment(
  db: Database,
  uploadPath: string,
  baseUrl: string,
  channelId: string,
  messageId: string,
  attachmentId: string,
  filename: string,
  contentType: string,
  data: ArrayBuffer | Uint8Array
): Promise<AttachmentInfo> {
  if (
    ![channelId, messageId, filename].every(isAttachmentFilename) ||
    !isAttachmentContentType(contentType)
  )
    throw new Error('Invalid attachment metadata')
  const buffer =
    data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(new Uint8Array(data))
  if (buffer.length > MAX_FILE_SIZE) throw new Error('File too large')
  const message = db
    .prepare(
      'SELECT author_token FROM messages WHERE id = ? AND channel_id = ?'
    )
    .get(messageId, channelId) as { author_token: string | null } | undefined
  if (!message) throw new Error('Unknown Message')
  const dir = path.join(uploadPath, channelId, messageId)
  await mkdir(dir, { recursive: true })
  const filePath = path.resolve(dir, filename)
  const size = buffer.byteLength
  const relativePath = path.join(channelId, messageId, filename)
  const handle = await open(filePath, 'wx')
  try {
    try {
      await handle.writeFile(buffer)
    } finally {
      await handle.close()
    }
    db.transaction(() => {
      db.prepare(
        `INSERT INTO attachments
        (id, message_id, filename, size, content_type, file_path)
        VALUES (?, ?, ?, ?, ?, ?)`
      ).run(attachmentId, messageId, filename, size, contentType, relativePath)
      db.prepare(
        `INSERT INTO attachment_files
        (id, channel_id, message_id, author_token, filename, content_type, file_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        attachmentId,
        channelId,
        messageId,
        message.author_token ?? '',
        filename,
        contentType,
        relativePath
      )
    })()
  } catch (error) {
    await rm(filePath, { force: true })
    pruneEmptyParents(uploadPath, filePath)
    throw error
  }

  const url = `${baseUrl}/_mock/attachments/${channelId}/${messageId}/${encodeURIComponent(filename)}`

  return {
    id: attachmentId,
    filename,
    size,
    contentType,
    url,
    proxyUrl: url,
  }
}

/**
 * Reads an attachment file.
 * @param uploadPath - Upload base directory
 * @param channelId - Channel ID
 * @param messageId - Message ID
 * @param filename - File name
 * @returns File data, or null if it does not exist
 */
export async function getAttachment(
  uploadPath: string,
  channelId: string,
  messageId: string,
  filename: string
): Promise<Buffer | null> {
  if (![channelId, messageId, filename].every(isAttachmentFilename)) return null
  const filePath = path.join(uploadPath, channelId, messageId, filename)
  try {
    await access(filePath, constants.R_OK)
    return await readFile(filePath)
  } catch {
    return null
  }
}

/**
 * Guesses the Content-Type from a file name.
 * @param filename - File name
 * @returns Content-Type string
 */
export function guessContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    pdf: 'application/pdf',
    txt: 'text/plain',
    json: 'application/json',
    zip: 'application/zip',
  }
  return types[ext ?? ''] ?? 'application/octet-stream'
}
