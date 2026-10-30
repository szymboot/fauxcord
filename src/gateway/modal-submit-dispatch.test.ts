import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  buildMuteModalData,
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'
import { createCommand } from '../services/application-commands'
import { createTestUser } from '../services/test-control'
import { GatewayOp } from './opcodes'

const applicationId = '111111111111111111'

/** Gateway dispatch frame as received by a bot. */
interface Frame {
  t?: string
  d: Record<string, unknown>
}

describe('user command → modal → modal submit over the Gateway', () => {
  let close: (() => Promise<void>) | undefined
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await close?.()
    close = undefined
  })

  /** Connects and identifies a bot, returning a dispatch waiter. */
  async function connect(url: string, token: string) {
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
    return {
      /** Waits for the next dispatch of the named event. */
      next: (name: string, skip = 0): Promise<Record<string, unknown>> =>
        new Promise((resolve) => {
          let seen = 0
          const check = (): void => {
            for (const frame of received) {
              if (frame.t === name && seen++ >= skip) {
                ws.off('message', check)
                resolve(frame.d)
                return
              }
            }
            seen = 0
          }
          ws.on('message', check)
          check()
        }),
      received,
    }
  }

  /** Sends JSON over HTTP and returns the response. */
  function post(
    httpUrl: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetch(`${httpUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('dispatches each step natively and lets the bot answer the submission', async () => {
    const { db, url, close: cleanup } = await createTestGatewayServer()
    close = cleanup
    const httpUrl = url.replace('ws://', 'http://')
    const bot = seedBot(db, 'Bot modal-gateway', applicationId)
    const guildId = seedGuild(db, bot)
    const channelId = seedChannel(db, guildId)
    const caller = createTestUser(db, { username: 'Caller' }).id
    const target = createTestUser(db, { username: 'Target' }).id
    for (const id of [caller, target]) {
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, id)
    }
    createCommand(db, applicationId, guildId, { name: 'Mute', type: 2 })
    const session = await connect(url, bot)
    const otherBot = seedBot(db, 'Bot other-gateway', '444444444444444444')
    seedGuild(db, otherBot, '555555555555555555')
    const other = await connect(url, otherBot)

    const created = await post(httpUrl, '/_test/interactions', {
      application_id: applicationId,
      command_name: 'Mute',
      target_id: target,
      guild_id: guildId,
      channel_id: channelId,
      user_id: caller,
      locale: 'en-GB',
    })
    expect(created.status).toBe(201)
    const command = await session.next('INTERACTION_CREATE')
    expect(command).toEqual(await created.json())
    expect(command).toMatchObject({
      type: 2,
      data: {
        type: 2,
        target_id: target,
        resolved: {
          users: { [target]: { username: 'Target' } },
          members: { [target]: { roles: [] } },
        },
      },
    })

    const modal = await post(
      httpUrl,
      `/api/v10/interactions/${String(command.id)}/${String(command.token)}/callback`,
      { type: 9, data: buildMuteModalData(target) }
    )
    expect(modal.status).toBe(204)
    const observed = await fetch(
      `${httpUrl}/_test/interactions/${String(command.id)}/callback?application_id=${applicationId}`,
      { headers: { 'X-Interaction-Token': String(command.token) } }
    )
    expect(await observed.json()).toMatchObject({
      initial_callback_type: 9,
      modal: { custom_id: `user_mute:${target}`, title: 'Mute user' },
    })

    const submitted = await post(
      httpUrl,
      `/_test/interactions/${String(command.id)}/modal-submit`,
      {
        application_id: applicationId,
        custom_id: `user_mute:${target}`,
        values: { reason: 'Spam', visibility: ['private'] },
      },
      { 'X-Interaction-Token': String(command.token) }
    )
    expect(submitted.status).toBe(201)
    const submission = await session.next('INTERACTION_CREATE', 1)
    expect(submission).toEqual(await submitted.json())
    expect(submission).toMatchObject({
      type: 5,
      locale: 'en-GB',
      guild_id: guildId,
      channel_id: channelId,
      member: { user: { id: caller } },
      data: { custom_id: `user_mute:${target}` },
    })

    const answer = await post(
      httpUrl,
      `/api/v10/interactions/${String(submission.id)}/${String(submission.token)}/callback`,
      { type: 4, data: { content: 'Muted', flags: 64 } }
    )
    expect(answer.status).toBe(204)
    const answered = await fetch(
      `${httpUrl}/_test/interactions/${String(submission.id)}/callback?application_id=${applicationId}`,
      { headers: { 'X-Interaction-Token': String(submission.token) } }
    )
    expect(await answered.json()).toMatchObject({
      responded: true,
      initial_callback_type: 4,
    })
    expect(
      other.received.filter((frame) => frame.t === 'INTERACTION_CREATE')
    ).toEqual([])
  })

  it('dispatches nothing when the bot has left the guild since the modal was shown', async () => {
    const { db, url, close: cleanup } = await createTestGatewayServer()
    close = cleanup
    const httpUrl = url.replace('ws://', 'http://')
    const bot = seedBot(db, 'Bot modal-removed', applicationId)
    const guildId = seedGuild(db, bot)
    const channelId = seedChannel(db, guildId)
    const target = createTestUser(db, { username: 'Target' }).id
    createCommand(db, applicationId, guildId, { name: 'Mute', type: 2 })
    const session = await connect(url, bot)
    const created = await post(httpUrl, '/_test/interactions', {
      application_id: applicationId,
      command_name: 'Mute',
      target_id: target,
      guild_id: guildId,
      channel_id: channelId,
    })
    const command = (await created.json()) as { id: string; token: string }
    await session.next('INTERACTION_CREATE')
    await post(
      httpUrl,
      `/api/v10/interactions/${command.id}/${command.token}/callback`,
      { type: 9, data: buildMuteModalData(target) }
    )
    db.prepare('UPDATE guilds SET bot_present = 0 WHERE id = ?').run(guildId)
    const submitted = await post(
      httpUrl,
      `/_test/interactions/${command.id}/modal-submit`,
      {
        application_id: applicationId,
        custom_id: `user_mute:${target}`,
        values: { reason: 'x' },
      },
      { 'X-Interaction-Token': command.token }
    )
    expect(submitted.status).toBe(404)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      session.received.filter((frame) => frame.t === 'INTERACTION_CREATE')
    ).toHaveLength(1)
  })
})
