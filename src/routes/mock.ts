/**
 * Infrastructure API routing
 *
 * Implements the /_mock/* infrastructure endpoints.
 */

import { Hono } from 'hono'
import type { Database } from '../db'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'hono'
import {
  findAttachmentFile,
  getAttachment,
  guessContentType,
} from '../services/attachments'

/** Server start time */
const START_TIME = Date.now()

/**
 * Creates the infrastructure API routes.
 * @param db - Database
 * @param uploadPath - Attachment storage directory
 * @returns Hono router instance
 */
export function createMockRoutes(db: Database, uploadPath: string): Hono {
  const app = new Hono()

  // GET /_mock/health — Health check
  app.get('/_mock/health', (c) => {
    let dbStatus = 'ok'
    try {
      db.prepare('SELECT 1').get()
    } catch {
      dbStatus = 'error'
    }

    return dbStatus === 'error'
      ? c.json(
          {
            status: 'error',
            version: '1.0.0',
            db: 'error',
            uptime: Math.floor((Date.now() - START_TIME) / 1000),
          },
          503
        )
      : c.json({
          status: 'ok',
          version: '1.0.0',
          db: 'ok',
          uptime: Math.floor((Date.now() - START_TIME) / 1000),
        })
  })

  /** Serves only committed metadata, including retained deleted-message uploads. */
  async function serveAttachment(c: Context): Promise<Response> {
    const { channelId, messageId, filename, attachmentId } = c.req.param()
    const attachment = findAttachmentFile(
      db,
      channelId,
      messageId,
      filename,
      attachmentId
    )
    // Application assets and older unindexed uploads use the original path.
    const data = attachment
      ? await readFile(path.join(uploadPath, attachment.file_path)).catch(
          () => null
        )
      : attachmentId
        ? null
        : await getAttachment(uploadPath, channelId, messageId, filename)
    if (!data) return c.json({ message: '404: Not Found', code: 0 }, 404)
    c.header(
      'Content-Type',
      attachment?.content_type ?? guessContentType(filename)
    )
    c.header('Content-Length', String(data.length))
    return c.body(new Uint8Array(data))
  }
  app.get(
    '/_mock/attachments/:channelId/:messageId/:attachmentId/:filename',
    serveAttachment
  )
  // Preserve the original three-component download URLs for existing uploads.
  app.get('/_mock/attachments/:channelId/:messageId/:filename', serveAttachment)

  return app
}
