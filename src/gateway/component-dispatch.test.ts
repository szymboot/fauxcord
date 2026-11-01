import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  buildMuteModalData,
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'
import { createTestUser } from '../services/test-control'
import { GatewayOp } from './opcodes'

const applicationId = '111111111111111111'

/** Gateway dispatch frame as received by a bot. */
interface Frame {
  t?: string
  d: Record<string, unknown>
}

describe('button click → modal → modal submit over the Gateway', () => {
  let close: (() => Promise<void>) | undefined
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await close?.()
    close = undefined
  })

  /** Connects and identifies a bot, collecting its dispatches. */
  async function connect(url: string, token: string): Promise<Frame[]> {
    const ws = new WebSocket(url)
    sockets.push(ws)
    await new Promise((resolve) => ws.once('message', resolve))
    ws.send(
      JSON.stringify({ op: GatewayOp.Identify, d: { token, intents: 0 } })
    )
    await new Promise((resolve) => ws.once('message', resolve))
    const received: Frame[] = []
    ws.on('message', (raw: Buffer) => {
      received.push(JSON.parse(raw.toString()) as Frame)
    })
    return received
  }

  /** Waits until the named dispatch count is reached. */
  async function dispatches(
    received: Frame[],
    name: string,
    count: number
  ): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = received.filter((frame) => frame.t === name)
      if (found.length >= count) return found.map((frame) => frame.d)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for ${name}`)
  }

  it('dispatches native payloads only to the owning application', async () => {
    const { db, url, close: cleanup } = await createTestGatewayServer()
    close = cleanup
    const httpUrl = url.replace('ws://', 'http://')
    const bot = seedBot(db, 'Bot component-gateway', applicationId)
    const guildId = seedGuild(db, bot)
    const channelId = seedChannel(db, guildId)
    const clicker = createTestUser(db, { username: 'Clicker' }).id
    const target = createTestUser(db, { username: 'Target' }).id
    db.prepare(
      'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
    ).run(guildId, clicker)
    const session = await connect(url, bot)
    const otherBot = seedBot(db, 'Bot other-component', '444444444444444444')
    seedGuild(db, otherBot, '555555555555555555')
    const other = await connect(url, otherBot)

    const sent = await fetch(
      `${httpUrl}/api/v10/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bot component-gateway',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'Moderate',
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 1, label: 'Mute', custom_id: 'mute' },
              ],
            },
          ],
        }),
      }
    )
    const message = (await sent.json()) as { id: string }
    const post = (path: string, body: unknown, headers = {}) =>
      fetch(`${httpUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })

    const clicked = await post('/_test/interactions', {
      application_id: applicationId,
      type: 3,
      channel_id: channelId,
      message_id: message.id,
      custom_id: 'mute',
      user_id: clicker,
      locale: 'en-GB',
    })
    expect(clicked.status).toBe(201)
    const [click] = await dispatches(session, 'INTERACTION_CREATE', 1)
    expect(click).toEqual(await clicked.json())
    expect(click).toMatchObject({
      type: 3,
      locale: 'en-GB',
      guild_id: guildId,
      channel_id: channelId,
      member: { user: { id: clicker } },
      data: { custom_id: 'mute', component_type: 2 },
      message: {
        id: message.id,
        content: 'Moderate',
        components: [{ type: 1, components: [{ custom_id: 'mute' }] }],
      },
    })

    const modal = await post(
      `/api/v10/interactions/${String(click.id)}/${String(click.token)}/callback`,
      { type: 9, data: buildMuteModalData(target) }
    )
    expect(modal.status).toBe(204)
    const submitted = await post(
      `/_test/interactions/${String(click.id)}/modal-submit`,
      {
        application_id: applicationId,
        custom_id: `user_mute:${target}`,
        values: { reason: 'Spam' },
      },
      { 'X-Interaction-Token': String(click.token) }
    )
    expect(submitted.status).toBe(201)
    const [, submission] = await dispatches(session, 'INTERACTION_CREATE', 2)
    expect(submission).toEqual(await submitted.json())
    expect(submission).toMatchObject({
      type: 5,
      member: { user: { id: clicker } },
      message: { id: message.id, content: 'Moderate' },
    })

    expect(other.filter((frame) => frame.t === 'INTERACTION_CREATE')).toEqual(
      []
    )
  })
})
