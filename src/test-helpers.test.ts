import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import {
  createTestGatewayServer,
  createFullTestApp,
  seedBot,
  seedGuild,
  seedMember,
} from './test-helpers'

describe('createFullTestApp', () => {
  it('applies configured failures before ordinary member mutation', async () => {
    const { db, app, cleanup } = createFullTestApp()
    try {
      const token = seedBot(db, 'Bot helper-fault')
      const guild = seedGuild(db, token)
      const user = seedMember(db, guild)
      const path = `/guilds/${guild}/members/${user}`
      const armed = await app.request('/_test/rest-faults', {
        method: 'POST',
        body: JSON.stringify({
          path,
          method: 'PATCH',
          status: 403,
          code: 50_013,
          message: 'Missing Permissions',
        }),
      })
      expect(armed.status).toBe(201)
      const failed = await app.request(`/api/v10${path}`, {
        method: 'PATCH',
        headers: { Authorization: token },
        body: JSON.stringify({ mute: true }),
      })
      expect(failed.status).toBe(403)
      const member = await app.request(path, {
        headers: { Authorization: token },
      })
      await expect(member.json()).resolves.toMatchObject({ mute: false })
      const retried = await app.request(path, {
        method: 'PATCH',
        headers: { Authorization: token },
        body: JSON.stringify({ mute: true }),
      })
      expect(retried.status).toBe(200)
    } finally {
      cleanup()
    }
  })
})

describe('createTestGatewayServer', () => {
  let close: (() => Promise<void>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('starts a real server that accepts a WebSocket connection', async () => {
    const server = await createTestGatewayServer()
    close = server.close
    const ws = new WebSocket(server.url)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})
