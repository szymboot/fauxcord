import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import {
  createTestGatewayServer,
  seedBot,
  seedGuild,
  seedChannel,
} from '../test-helpers'
import { createCommand } from '../services/application-commands'
import { getOrCreateDmChannel } from '../services/channels'
import { createTestUser } from '../services/test-control'
import { GatewayOp } from './opcodes'

describe('INTERACTION_CREATE locale (integration)', () => {
  let close: (() => Promise<void>) | undefined
  let ws: WebSocket | undefined

  afterEach(async () => {
    ws?.terminate()
    ws = undefined
    await close?.()
    close = undefined
  })

  it.each([
    { locale: undefined, expected: 'en-US', inGuild: true },
    { locale: 'pl', expected: 'pl', inGuild: true },
    { locale: 'en-GB', expected: 'en-GB', inGuild: false },
  ])(
    'sends locale $expected through REST and the native Gateway',
    async ({ locale, expected, inGuild }) => {
      const { db, url, close: cleanup } = await createTestGatewayServer()
      close = cleanup
      const applicationId = '111111111111111111'
      const bot = seedBot(db, 'Bot locale-token', applicationId)
      const guild = seedGuild(db, bot)
      const user = createTestUser(db, { username: 'Caller' })
      const channel = inGuild
        ? seedChannel(db, guild)
        : getOrCreateDmChannel(db, applicationId, user.id).id
      if (inGuild) {
        db.prepare(
          'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
        ).run(guild, user.id)
      }
      createCommand(db, applicationId, inGuild ? guild : null, {
        name: 'rules',
        description: 'Show rules',
      })

      ws = new WebSocket(url)
      await new Promise((resolve) => ws?.once('message', resolve))
      ws.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: { token: bot, intents: 0 },
        })
      )
      await new Promise((resolve) => ws?.once('message', resolve))

      const dispatchPromise = new Promise<Record<string, unknown>>(
        (resolve) => {
          ws?.on('message', (raw: Buffer) => {
            const event = JSON.parse(raw.toString()) as Record<string, unknown>
            if (event.t === 'INTERACTION_CREATE') resolve(event)
          })
        }
      )
      const httpUrl = url.replace('ws://', 'http://')
      const res = await fetch(`${httpUrl}/_test/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: applicationId,
          command_name: 'rules',
          guild_id: inGuild ? guild : undefined,
          channel_id: channel,
          user_id: user.id,
          options: [{ name: 'verbose', type: 5, value: true }],
          locale,
        }),
      })
      expect(res.status).toBe(201)
      const interaction = (await res.json()) as {
        id: string
        token: string
        locale: string
      }
      expect(interaction.locale).toBe(expected)
      const dispatch = await dispatchPromise
      expect(dispatch.op).toBe(GatewayOp.Dispatch)
      expect(dispatch.d).toEqual(interaction)
      expect(dispatch.d).toMatchObject({
        locale: expected,
        data: {
          name: 'rules',
          options: [{ name: 'verbose', type: 5, value: true }],
        },
        ...(inGuild
          ? { member: { user: { id: user.id } } }
          : { user: { id: user.id } }),
      })
      expect(dispatch.d).not.toHaveProperty('data.locale')

      const callback = await fetch(
        `${httpUrl}/api/v10/interactions/${interaction.id}/${interaction.token}/callback?with_response=true`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 4,
            data: { content: 'Rules response' },
          }),
        }
      )
      expect(callback.status).toBe(200)
      expect(await callback.json()).toMatchObject({
        resource: { message: { content: 'Rules response' } },
      })
    }
  )
})
