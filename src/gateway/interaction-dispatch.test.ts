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

describe('INTERACTION_CREATE (integration)', () => {
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

  it.each([4, 5])(
    'observes callback type %i after native registered-command response completion',
    async (callbackType) => {
      const { db, url, close: cleanup } = await createTestGatewayServer()
      close = cleanup
      const applicationId = '111111111111111111'
      const bot = seedBot(db, 'Bot deferred-gateway-token', applicationId)
      const guildId = seedGuild(db, bot)
      const channelId = seedChannel(db, guildId)
      const user = createTestUser(db, { username: 'RankingCaller' })
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, user.id)
      const httpUrl = url.replace('ws://', 'http://')
      const registered = await fetch(
        `${httpUrl}/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
        {
          method: 'POST',
          headers: { Authorization: bot, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'me', description: 'Show my ranking' }),
        }
      )
      expect(registered.status).toBe(201)

      ws = new WebSocket(url)
      await new Promise((resolve) => ws?.once('message', resolve))
      ws.send(
        JSON.stringify({
          op: GatewayOp.Identify,
          d: { token: bot, intents: 512 },
        })
      )
      await new Promise((resolve) => ws?.once('message', resolve))

      /** Waits for a named native Gateway dispatch and removes its listener. */
      const nextDispatch = (name: string): Promise<Record<string, unknown>> =>
        new Promise((resolve) => {
          const socket = ws
          if (!socket) throw new Error('Gateway socket is missing')
          /** Reads dispatch frames while ignoring unrelated events. */
          const listener = (raw: Buffer): void => {
            const frame = JSON.parse(raw.toString()) as {
              t?: string
              d: Record<string, unknown>
            }
            if (frame.t !== name) {
              return
            }

            socket.off('message', listener)
            resolve(frame.d)
          }
          socket.on('message', listener)
        })
      const interactionDispatch = nextDispatch('INTERACTION_CREATE')
      const injected = await fetch(`${httpUrl}/_test/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: applicationId,
          command_name: 'me',
          guild_id: guildId,
          channel_id: channelId,
          user_id: user.id,
        }),
      })
      expect(injected.status).toBe(201)
      const interaction = (await injected.json()) as {
        id: string
        token: string
      }
      const received = await interactionDispatch
      expect(received).toEqual(interaction)
      // The bot responds using the credentials delivered by INTERACTION_CREATE.
      const callbackUrl = `${httpUrl}/api/v10/interactions/${String(received.id)}/${String(received.token)}/callback`
      const createDispatch = nextDispatch('MESSAGE_CREATE')
      const deferred = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: callbackType,
          data: { content: 'Direct result' },
        }),
      })
      expect(deferred.status).toBe(204)
      const pending = await createDispatch
      expect(pending).toMatchObject({
        flags: callbackType === 5 ? 128 : 0,
        content: callbackType === 5 ? '' : 'Direct result',
        embeds: [],
        application_id: applicationId,
        interaction: { id: interaction.id, name: 'me', user: { id: user.id } },
      })
      const duplicate = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: callbackType === 5 ? 4 : 5,
          data: { embeds: [{ title: 'Ranking' }] },
        }),
      })
      expect(duplicate.status).toBe(400)
      expect(await duplicate.json()).toMatchObject({ code: 40_060 })
      const originalUrl = `${httpUrl}/api/v10/webhooks/${applicationId}/${interaction.token}/messages/@original`
      const updateDispatch = nextDispatch('MESSAGE_UPDATE')
      const embeds = [
        {
          title: 'Your ranking',
          description: 'Position: 1',
          fields: [{ name: 'Points', value: '42' }],
        },
      ]
      const edited = await fetch(originalUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds, content: '' }),
      })
      expect(edited.status).toBe(200)
      const final = (await edited.json()) as { id: string }
      expect(final).toMatchObject({
        id: pending.id,
        channel_id: channelId,
        application_id: applicationId,
        author: { id: applicationId, bot: true },
        interaction: { id: interaction.id, user: { id: user.id } },
        content: '',
        embeds,
        flags: 0,
      })
      expect(await updateDispatch).toMatchObject(final)
      const retrieved = await fetch(originalUrl)
      expect(await retrieved.json()).toEqual(final)
      const observed = await fetch(
        `${httpUrl}/api/v10/channels/${channelId}/messages`,
        { headers: { Authorization: bot } }
      )
      expect(await observed.json()).toEqual([final])
      // Start observation only after the loading flag has been cleared by PATCH.
      const observation = await fetch(
        `${httpUrl}/_test/interactions/${interaction.id}/callback?application_id=${applicationId}`,
        { headers: { 'X-Interaction-Token': interaction.token } }
      )
      expect(observation.status).toBe(200)
      expect(observation.headers.get('cache-control')).toBe('no-store')
      expect(await observation.json()).toEqual({
        interaction_id: interaction.id,
        application_id: applicationId,
        responded: true,
        initial_callback_type: callbackType,
      })
    }
  )
})
