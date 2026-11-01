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
  s?: number
  d: Record<string, unknown>
}

/** Captured-event envelope returned by the capture inspection. */
interface Capture {
  id: string
  events_captured: { id: string; state: string; envelope: Frame }[]
}

describe('INTERACTION_CREATE capture controls', () => {
  let close: (() => Promise<void>) | undefined
  const sockets: WebSocket[] = []
  let httpUrl: string
  let db: Awaited<ReturnType<typeof createTestGatewayServer>>['db']
  let url: string
  let guildId: string
  let channelId: string
  let bot: string
  let caller: string
  let target: string

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await close?.()
    close = undefined
  })

  /** Connects and identifies a bot, collecting its dispatches. */
  async function connect(token: string): Promise<Frame[]> {
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

  /** Waits until the bot has received this many interaction dispatches. */
  async function interactions(
    received: Frame[],
    count: number
  ): Promise<Frame[]> {
    await expect
      .poll(() => received.filter((f) => f.t === 'INTERACTION_CREATE').length)
      .toBe(count)
    return received.filter((frame) => frame.t === 'INTERACTION_CREATE')
  }

  /** Sends JSON over HTTP and returns the response. */
  function send(
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetch(`${httpUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Parses a JSON response body. */
  async function body<T>(response: Response): Promise<T> {
    return (await response.json()) as T
  }

  /** Resolves a pending response to its status. */
  function code(response: Promise<Response>): Promise<number> {
    return response.then((resolved) => resolved.status)
  }

  /** Arms a hold capture for the fixture guild's bot. */
  function arm(options?: Record<string, unknown>): Promise<Response> {
    return send('/_test/gateway-event-controls', 'POST', {
      guild_id: guildId,
      bot_id: applicationId,
      events: ['INTERACTION_CREATE'],
      hold: true,
      ...options,
    })
  }

  /** Arms a hold capture that must succeed and returns its evidence. */
  async function armed(options?: Record<string, unknown>): Promise<Capture> {
    const response = await arm(options)
    expect(response.status).toBe(201)
    return body<Capture>(response)
  }

  /** Reads a capture's current evidence. */
  async function inspect(id: string): Promise<Capture> {
    return body<Capture>(
      await send(`/_test/gateway-event-controls/${id}`, 'GET')
    )
  }

  /** Reads only the events a capture has taken so far. */
  async function captured(id: string): Promise<Capture['events_captured']> {
    const evidence = await inspect(id)
    return evidence.events_captured
  }

  /** Simulates a command interaction, as the harness does. */
  function simulate(userId = caller): Promise<Response> {
    return send('/_test/interactions', 'POST', {
      application_id: applicationId,
      command_name: 'Mute',
      target_id: target,
      guild_id: guildId,
      channel_id: channelId,
      user_id: userId,
    })
  }

  /** Reads the observable callback state of an interaction. */
  async function observe(interaction: {
    id: string
    token: string
  }): Promise<{ responded: boolean; initial_callback_type: number | null }> {
    const response = await send(
      `/_test/interactions/${interaction.id}/callback?application_id=${applicationId}`,
      'GET',
      undefined,
      { 'X-Interaction-Token': interaction.token }
    )
    return body<{
      responded: boolean
      initial_callback_type: number | null
    }>(response)
  }

  /** Sends the bot's callback for an interaction without bot authorization. */
  function callback(
    interaction: { id: string; token: string },
    body: unknown
  ): Promise<Response> {
    return send(
      `/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
      'POST',
      body
    )
  }

  async function setup(): Promise<Frame[]> {
    const server = await createTestGatewayServer()
    close = server.close
    db = server.db
    url = server.url
    httpUrl = url.replace('ws://', 'http://')
    bot = seedBot(db, 'Bot interaction-capture', applicationId)
    guildId = seedGuild(db, bot)
    channelId = seedChannel(db, guildId)
    caller = createTestUser(db, { username: 'Caller' }).id
    target = createTestUser(db, { username: 'Target' }).id
    for (const id of [caller, target])
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, id)
    createCommand(db, applicationId, guildId, { name: 'Mute', type: 2 })
    return connect(bot)
  }

  it('holds an interaction, returns it to the controller, then releases and replays it', async () => {
    const received = await setup()
    const control = await armed()
    const created = await simulate()
    expect(created.status).toBe(201)
    const interaction = await body<{ id: string; token: string }>(created)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received.filter((f) => f.t === 'INTERACTION_CREATE')).toEqual([])
    const held = await inspect(control.id)
    expect(held.events_captured).toHaveLength(1)
    expect(held.events_captured[0]).toMatchObject({
      state: 'held',
      envelope: { t: 'INTERACTION_CREATE', d: { id: interaction.id } },
    })

    const released = await send(
      `/_test/gateway-event-controls/${control.id}/release`,
      'POST',
      { event_ids: [held.events_captured[0].id] }
    )
    expect(released.status).toBe(200)
    const [frame] = await interactions(received, 1)
    expect(frame.d).toEqual(interaction)
    // Held events are released as new dispatches; the held interaction has
    // not been answered meanwhile.
    expect(await observe(interaction)).toMatchObject({ responded: false })

    const replayed = await send(
      `/_test/gateway-event-controls/${control.id}/replay`,
      'POST',
      { event_ids: [held.events_captured[0].id] }
    )
    expect(replayed.status).toBe(200)
    const [first, second] = await interactions(received, 2)
    expect(second.d).toEqual(first.d)
    expect(second.s).toBeGreaterThan(first.s ?? 0)
  })

  it('passes through other guilds, other users and unselected capture states', async () => {
    const received = await setup()
    const control = await armed({ member_id: caller })
    const stranger = createTestUser(db, { username: 'Stranger' }).id
    db.prepare(
      'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
    ).run(guildId, stranger)
    expect(await code(simulate(stranger))).toBe(201)
    await interactions(received, 1)
    expect(await captured(control.id)).toHaveLength(0)

    const otherGuild = seedGuild(db, bot, '666666666666666666')
    const otherChannel = seedChannel(db, otherGuild, '777777777777777777')
    createCommand(db, applicationId, otherGuild, { name: 'Mute', type: 2 })
    expect(
      await code(
        send('/_test/interactions', 'POST', {
          application_id: applicationId,
          command_name: 'Mute',
          target_id: target,
          guild_id: otherGuild,
          channel_id: otherChannel,
        })
      )
    ).toBe(201)
    await interactions(received, 2)
    expect(await captured(control.id)).toHaveLength(0)

    expect(await code(simulate(caller))).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received.filter((f) => f.t === 'INTERACTION_CREATE')).toHaveLength(2)
    expect(await captured(control.id)).toHaveLength(1)
  })

  it('does not capture another bot setup and rejects unknown subjects', async () => {
    const received = await setup()
    const otherBot = seedBot(db, 'Bot other-capture', '444444444444444444')
    const otherGuild = seedGuild(db, otherBot, '555555555555555555')
    const otherChannel = seedChannel(db, otherGuild, '888888888888888888')
    const others = await connect(otherBot)
    createCommand(db, '444444444444444444', otherGuild, {
      name: 'Mute',
      type: 2,
    })
    const control = await armed()
    expect(
      await code(
        send('/_test/interactions', 'POST', {
          application_id: '444444444444444444',
          command_name: 'Mute',
          target_id: target,
          guild_id: otherGuild,
          channel_id: otherChannel,
        })
      )
    ).toBe(201)
    await interactions(others, 1)
    expect(await captured(control.id)).toHaveLength(0)
    expect(received.filter((f) => f.t === 'INTERACTION_CREATE')).toEqual([])
    // member_id on an interaction control needs a current guild member.
    await send(`/_test/gateway-event-controls/${control.id}`, 'DELETE')
    expect(await code(arm({ member_id: '999999999999999999' }))).toBe(404)
    // Interaction scope accepts only user-scoped companions with member_id.
    expect(
      await code(arm({ member_id: caller, events: ['MESSAGE_CREATE'] }))
    ).toBe(400)
  })

  it('arms a callback fault for a held modal submission, then releases it', async () => {
    const received = await setup()
    const created = await simulate()
    const command = await body<{ id: string; token: string }>(created)
    await interactions(received, 1)
    expect(
      await code(
        callback(command, {
          type: 9,
          data: buildMuteModalData(target),
        })
      )
    ).toBe(204)

    // Hold the submission's dispatch before it is sent.
    const control = await armed({ member_id: caller })
    const submitted = await send(
      `/_test/interactions/${command.id}/modal-submit`,
      'POST',
      {
        application_id: applicationId,
        custom_id: `user_mute:${target}`,
        values: { reason: 'Spam', visibility: ['private'] },
      },
      { 'X-Interaction-Token': command.token }
    )
    expect(submitted.status).toBe(201)
    const submission = await body<{ id: string; token: string; type: number }>(
      submitted
    )
    expect(submission.type).toBe(5)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received.filter((f) => f.t === 'INTERACTION_CREATE')).toHaveLength(1)

    // Arm the callback fault by the submission's interaction ID.
    const fault = await send('/_test/rest-faults', 'POST', {
      method: 'POST',
      path: `/interactions/${submission.id}/callback`,
      status: 503,
      code: 0,
      message: 'Callback failed',
    })
    expect(fault.status).toBe(201)
    const faultBody = await body<{ id: string }>(fault)
    const faultId = faultBody.id

    const held = await inspect(control.id)
    await send(`/_test/gateway-event-controls/${control.id}/release`, 'POST', {
      event_ids: [held.events_captured[0].id],
    })
    const [, delivered] = await interactions(received, 2)
    expect(delivered.d).toEqual(submission)

    // The bot's deferred acknowledgement fails and leaves the submission open.
    expect(await code(callback(submission, { type: 5 }))).toBe(503)
    expect(await observe(submission)).toEqual({
      interaction_id: submission.id,
      application_id: applicationId,
      responded: false,
      initial_callback_type: null,
    })
    const spent = await body<{ consumed: number }>(
      await send(`/_test/rest-faults/${faultId}`, 'GET')
    )
    expect(spent.consumed).toBe(1)

    // After the fault is spent the retry behaves natively.
    expect(await code(callback(submission, { type: 5 }))).toBe(204)
    expect(await observe(submission)).toMatchObject({
      responded: true,
      initial_callback_type: 5,
    })
    expect(await code(callback(submission, { type: 5 }))).toBe(400)
  })
})
