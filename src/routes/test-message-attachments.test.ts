import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../app'
import { initializeDatabase, type Database } from '../db'
import { seedBot, seedChannel, seedGuild } from '../test-helpers'
import { createTestUser } from '../services/test-control'
import type { MessageObject } from '../services/messages'
import { gatewayBus, type GatewayBusEvents } from '../gateway/bus'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, writeFile: vi.fn(original.writeFile) }
})
const actualFs = await vi.importActual<typeof fs>('node:fs/promises')

const BASE_URL = 'http://localhost:3000'
const bytes = Buffer.from([0, 255, 128, 13, 10, 1])
const file = {
  filename: 'zażółć #?.bin',
  content_type: 'image/png',
  data: bytes.toString('base64'),
}

describe('human message attachments', () => {
  let db: Database
  let uploadPath: string
  let app: ReturnType<typeof buildApp>['app']
  let channelId: string
  let humanId: string
  let events: GatewayBusEvents['message.create'][]
  const record = (event: GatewayBusEvents['message.create']): void => {
    events.push(event)
  }

  beforeEach(async () => {
    vi.mocked(fs.writeFile).mockReset().mockImplementation(actualFs.writeFile)
    db = initializeDatabase(':memory:')
    uploadPath = await mkdtemp(path.join(tmpdir(), 'fauxcord-human-files-'))
    app = buildApp(db, {
      baseUrl: BASE_URL,
      uploadPath,
      disableAuth: false,
    }).app
    const token = seedBot(db, 'Bot attachments')
    channelId = seedChannel(db, seedGuild(db, token))
    humanId = createTestUser(db, { username: 'Human' }).id
    events = []
    gatewayBus.on('message.create', record)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    gatewayBus.off('message.create', record)
    db.close()
    await rm(uploadPath, { recursive: true, force: true })
  })

  /** Sends a human fixture through the assembled test-control API. */
  async function inject(payload: Record<string, unknown>): Promise<Response> {
    return app.request(`/_test/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: { id: humanId }, ...payload }),
    })
  }

  it('publishes multiple complete attachments and downloads original bytes', async () => {
    const response = await inject({
      content: 'human text',
      attachments: [
        file,
        { ...file, data: 'YWJj', content_type: 'text/plain' },
      ],
    })
    expect(response.status).toBe(201)
    const message = (await response.json()) as MessageObject
    expect(message.author).toMatchObject({ id: humanId, bot: false })
    expect(message.attachments).toHaveLength(2)
    expect(events).toHaveLength(1)
    expect(events[0].message).toEqual(message)
    expect(message.attachments[0].url).not.toBe(message.attachments[1].url)
    for (const [index, attachment] of message.attachments.entries()) {
      expect(attachment.filename).toBe(file.filename)
      const download = await app.request(attachment.url)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-type')).toBe(attachment.content_type)
      expect(Buffer.from(await download.arrayBuffer())).toEqual(
        index === 0 ? bytes : Buffer.from('abc')
      )
    }
  })

  it('supports attachment-only messages and deletion snapshots until reset', async () => {
    const response = await inject({
      attachments: [file],
      remove_after_create: true,
    })
    expect(response.status).toBe(201)
    const message = (await response.json()) as MessageObject
    expect(message.content).toBe('')
    expect(events[0].message).toEqual(message)
    expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
    const url = message.attachments[0].url
    const download = await app.request(url)
    expect(download.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
    const reset = await app.request('/_test/reset', { method: 'POST' })
    expect(reset.status).toBe(204)
    const missing = await app.request(url)
    expect(missing.status).toBe(404)
    expect(await readdir(uploadPath)).toEqual([])
  })

  it.each([
    { attachments: 'bad' },
    { attachments: [null] },
    { attachments: [{ ...file, data: '!!!!' }] },
    { attachments: [{ ...file, filename: '../escape' }] },
    { attachments: [{ ...file, filename: 'a' }] },
    { attachments: [{ ...file, content_type: 'image/png\r\nX: bad' }] },
    { attachments: Array.from({ length: 11 }, () => file) },
    { content: 'x'.repeat(2001), attachments: [file] },
    { attachments: [] },
    { content: null, attachments: [file] },
  ])(
    'rejects invalid fixture without persistence or events: %j',
    async (payload) => {
      const response = await inject(payload)
      expect(response.status).toBe(400)
      expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
      expect(db.prepare('SELECT * FROM attachments').all()).toEqual([])
      expect(events).toEqual([])
      expect(await readdir(uploadPath)).toEqual([])
    }
  )
  it.each(['disk', 'database'])(
    'rolls back a failure on the second file (%s)',
    async (failure) => {
      if (failure === 'disk') {
        const write = actualFs.writeFile
        let calls = 0
        vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
          await write(...args)
          if (++calls === 2)
            throw new Error('Simulated disk failure after writing')
        })
      } else {
        db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON attachments
        WHEN (SELECT COUNT(*) FROM attachments) = 1
        BEGIN SELECT RAISE(ABORT, 'Simulated database failure'); END`)
      }
      const response = await inject({ attachments: [file, file] })
      expect(response.status).toBe(500)
      expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
      expect(db.prepare('SELECT * FROM attachments').all()).toEqual([])
      expect(db.prepare('SELECT * FROM attachment_files').all()).toEqual([])
      expect(
        db.prepare('SELECT * FROM guild_members WHERE user_id = ?').all(humanId)
      ).toEqual([])
      expect(
        db
          .prepare('SELECT last_message_id FROM channels WHERE id = ?')
          .get(channelId)
      ).toEqual({ last_message_id: null })
      expect(events).toEqual([])
      expect(await readdir(uploadPath)).toEqual([])
    }
  )

  it('returns 404/409 without files or events for missing targets and conflicts', async () => {
    const unknown = await inject({
      author: { id: 'missing' },
      attachments: [file],
    })
    expect(unknown.status).toBe(404)
    const original = await inject({ id: '123', attachments: [file] })
    expect(original.status).toBe(201)
    const snapshot = (await original.json()) as MessageObject
    const conflict = await inject({ id: '123', attachments: [file] })
    expect(conflict.status).toBe(409)
    const missing = await app.request('/_test/channels/missing/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: { id: humanId }, attachments: [file] }),
    })
    expect(missing.status).toBe(404)
    expect(events).toHaveLength(1)
    expect(db.prepare('SELECT * FROM attachment_files').all()).toHaveLength(1)
    const download = await app.request(snapshot.attachments[0].url)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
  })

  it('enforces the size boundary, accepts ten files and preserves empty bytes', async () => {
    const maximum = Buffer.alloc(25 * 1024 * 1024)
    const accepted = await inject({
      attachments: [{ ...file, data: maximum.toString('base64') }],
    })
    expect(accepted.status).toBe(201)
    const snapshot = (await accepted.json()) as MessageObject
    expect(snapshot.attachments[0].size).toBe(maximum.length)
    const rejected = await inject({
      attachments: [
        { ...file, data: Buffer.alloc(maximum.length + 1).toString('base64') },
      ],
    })
    expect(rejected.status).toBe(400)
    const ten = await inject({
      content: '',
      attachments: Array.from({ length: 10 }, () => ({ ...file, data: '' })),
    })
    expect(ten.status).toBe(201)
    const tenMessage = (await ten.json()) as MessageObject
    expect(tenMessage.attachments).toHaveLength(10)
    const download = await app.request(tenMessage.attachments[0].url)
    expect(download.status).toBe(200)
    const empty = await download.arrayBuffer()
    expect(empty.byteLength).toBe(0)
    expect(events).toHaveLength(2)
  })

  it('keeps uploads private while awaiting disk I/O', async () => {
    const write = actualFs.writeFile
    const { promise: gate, resolve: release } =
      Promise.withResolvers<undefined>()
    const { promise: written, resolve: staged } =
      Promise.withResolvers<undefined>()
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args)
      staged(undefined)
      await gate
    })
    const pending = inject({ id: '321', attachments: [file] })
    await written
    expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
    expect(db.prepare('SELECT * FROM attachment_files').all()).toEqual([])
    expect(events).toEqual([])
    const dirs = await readdir(path.join(uploadPath, channelId, '321'))
    const hidden = await app.request(
      `${BASE_URL}/_mock/attachments/${channelId}/321/${dirs[0]}/${encodeURIComponent(file.filename)}`
    )
    expect(hidden.status).toBe(404)
    release(undefined)
    const completed = await pending
    expect(completed.status).toBe(201)
    expect(events).toHaveLength(1)
  })

  it('isolates token reset and clears setup-scoped human uploads', async () => {
    const response = await inject({
      attachments: [file],
      remove_after_create: true,
    })
    const human = (await response.json()) as MessageObject
    const otherToken = seedBot(db, 'Bot other', '987654321')
    const otherChannel = seedChannel(
      db,
      seedGuild(db, otherToken, '123456789'),
      '876543210'
    )
    const urls: string[] = []
    for (const [channel, token] of [
      [channelId, 'Bot attachments'],
      [otherChannel, otherToken],
    ]) {
      const form = new FormData()
      form.set(
        'files[0]',
        new File([bytes], 'proof.bin', { type: 'image/png' })
      )
      const sent = await app.request(`/api/v10/channels/${channel}/messages`, {
        method: 'POST',
        headers: { Authorization: token },
        body: form,
      })
      expect(sent.status).toBe(200)
      const message = (await sent.json()) as MessageObject
      urls.push(message.attachments[0].url)
      const deleted = await app.request(
        `/api/v10/channels/${channel}/messages/${message.id}`,
        { method: 'DELETE', headers: { Authorization: token } }
      )
      expect(deleted.status).toBe(204)
    }
    const reset = await app.request('/_test/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'Bot attachments' }),
    })
    expect(reset.status).toBe(204)
    const own = await app.request(urls[0])
    const other = await app.request(urls[1])
    const retainedHuman = await app.request(human.attachments[0].url)
    expect(own.status).toBe(404)
    expect(other.status).toBe(200)
    expect(retainedHuman.status).toBe(200)
    const deletion = await app.request('/_test/setup/Bot%20attachments', {
      method: 'DELETE',
    })
    expect(deletion.status).toBe(204)
    const removedHuman = await app.request(human.attachments[0].url)
    const isolated = await app.request(urls[1])
    expect(removedHuman.status).toBe(404)
    expect(isolated.status).toBe(200)
    expect(await readdir(uploadPath)).toEqual([otherChannel])
  })
  /** Posts a multipart request through the ordinary bot REST route. */
  async function send(
    form: FormData,
    prefix = '/api/v10',
    token?: string
  ): Promise<Response> {
    return app.request(`${prefix}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: token ? { Authorization: token } : {},
      body: form,
    })
  }

  it.each(['/api/v10', '/api', ''])(
    'supports attachment-only bot uploads under %s',
    async (prefix) => {
      const form = new FormData()
      form.set(
        'files[3]',
        new File([bytes], 'binary.dat', { type: 'image/png' })
      )
      form.set(
        'files[7]',
        new File(['hello'], 'text.txt', { type: 'text/plain' })
      )
      const response = await send(form, prefix, 'Bot attachments')
      expect(response.status).toBe(200)
      const message = (await response.json()) as MessageObject
      expect(message.content).toBe('')
      expect(message.author.bot).toBe(true)
      expect(events).toHaveLength(1)
      expect(events[0].message).toEqual(message)
      expect(message.attachments).toHaveLength(2)
      const first = await app.request(message.attachments[0].url)
      expect(Buffer.from(await first.arrayBuffer())).toEqual(bytes)
    }
  )

  it.each([
    'extra',
    'duplicate',
    'not-a-file',
    'malformed-json',
    'large',
    'unauthorized',
  ])('rejects bad multipart uploads (%s)', async (kind) => {
    const form = new FormData()
    form.set('files[0]', new File([bytes], 'proof.png', { type: 'image/png' }))
    switch (kind) {
      case 'extra': {
        form.set('files[10]', new File(['x'], 'extra.txt'))
        break
      }
      case 'duplicate': {
        form.append('files[0]', new File(['x'], 'other.txt'))
        break
      }
      case 'not-a-file': {
        form.set('files[1]', 'not a file')
        break
      }
      case 'malformed-json': {
        form.set('payload_json', '{')
        break
      }
      case 'large': {
        form.set(
          'files[1]',
          new File([Buffer.alloc(25 * 1024 * 1024 + 1)], 'large.bin')
        )
        break
      }
      // No default
    }
    const response = await send(
      form,
      '/api/v10',
      kind === 'unauthorized' ? undefined : 'Bot attachments'
    )
    expect(response.status).toBe(kind === 'unauthorized' ? 401 : 400)
    expect(events).toEqual([])
    expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
    expect(await readdir(uploadPath)).toEqual([])
  })

  it('rolls back bot multipart messages and embeds when attachment persistence fails', async () => {
    db.exec(`CREATE TRIGGER fail_upload BEFORE INSERT ON attachments
      BEGIN SELECT RAISE(ABORT, 'Upload failure'); END`)
    const form = new FormData()
    form.set(
      'payload_json',
      JSON.stringify({ content: 'log', embeds: [{ title: 'image log' }] })
    )
    form.set('files[0]', new File([bytes], 'proof.png', { type: 'image/png' }))
    const response = await send(form, '/api/v10', 'Bot attachments')
    expect(response.status).toBe(500)
    expect(events).toEqual([])
    for (const table of [
      'messages',
      'embeds',
      'attachments',
      'attachment_files',
    ]) {
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
    }
    expect(await readdir(uploadPath)).toEqual([])
  })
  it('rolls back an immediate-removal failure before any Gateway event', async () => {
    db.exec(`CREATE TRIGGER fail_remove BEFORE DELETE ON messages
      BEGIN SELECT RAISE(ABORT, 'Removal failure'); END`)
    const response = await inject({
      attachments: [file],
      remove_after_create: true,
    })
    expect(response.status).toBe(500)
    expect(events).toEqual([])
    expect(db.prepare('SELECT * FROM messages').all()).toEqual([])
    expect(db.prepare('SELECT * FROM attachment_files').all()).toEqual([])
    expect(await readdir(uploadPath)).toEqual([])
  })
})
