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

/** Identity of a simulated interaction. */
interface Interaction {
  id: string
  token: string
  type: number
}

describe('INTERACTION_CREATE capture controls', () => {
  const closers: (() => Promise<void>)[] = []
  const sockets: WebSocket[] = []
  let httpUrl: string
  let db: Awaited<ReturnType<typeof createTestGatewayServer>>['db']
  let url: string
  let guildId: string
  let channelId: string
  let bot: string
  let caller: string
  let target: string
  let barrier: string

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    for (const close of closers.splice(0)) await close()
  })

  /**
   * Connects and identifies a bot, collecting its dispatches. `onFrame` lets
   * the bot react the instant a dispatch arrives, like a real consumer.
   */
  async function connect(
    server: string,
    token: string,
    onFrame?: (frame: Frame) => void
  ): Promise<Frame[]> {
    const ws = new WebSocket(server)
    sockets.push(ws)
    await new Promise((resolve) => ws.once('message', resolve))
    ws.send(
      JSON.stringify({ op: GatewayOp.Identify, d: { token, intents: 0 } })
    )
    await new Promise((resolve) => ws.once('message', resolve))
    const received: Frame[] = []
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Frame
      received.push(frame)
      onFrame?.(frame)
    })
    return received
  }

  /** The interaction dispatches a bot has received so far. */
  function dispatched(received: Frame[]): Frame[] {
    return received.filter((frame) => frame.t === 'INTERACTION_CREATE')
  }

  /** Waits until the bot has received this many interaction dispatches. */
  async function interactions(
    received: Frame[],
    count: number
  ): Promise<Frame[]> {
    await expect.poll(() => dispatched(received).length).toBe(count)
    return dispatched(received)
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

  /**
   * Orders earlier dispatches before a marker: an uncaptured interaction of
   * another member travels the same socket, so once it arrives anything that
   * had been sent before it has arrived too.
   */
  async function flush(received: Frame[]): Promise<void> {
    const marker = await body<Interaction>(await simulate(barrier))
    await expect
      .poll(() =>
        dispatched(received).some((frame) => frame.d.id === marker.id)
      )
      .toBe(true)
  }

  /** Reads the observable callback state of an interaction. */
  async function observe(
    interaction: Interaction
  ): Promise<{ responded: boolean; initial_callback_type: number | null }> {
    return body(
      await send(
        `/_test/interactions/${interaction.id}/callback?application_id=${applicationId}`,
        'GET',
        undefined,
        { 'X-Interaction-Token': interaction.token }
      )
    )
  }

  /** Sends the bot's callback for an interaction without bot authorization. */
  function callback(
    interaction: { id: string; token: string },
    payload: unknown
  ): Promise<Response> {
    return send(
      `/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
      'POST',
      payload
    )
  }

  /** Starts a server with a connected bot and members of one guild. */
  async function setup(onFrame?: (frame: Frame) => void): Promise<Frame[]> {
    const server = await createTestGatewayServer()
    closers.push(server.close)
    db = server.db
    url = server.url
    httpUrl = url.replace('ws://', 'http://')
    bot = seedBot(db, 'Bot interaction-capture', applicationId)
    guildId = seedGuild(db, bot)
    channelId = seedChannel(db, guildId)
    caller = createTestUser(db, { username: 'Caller' }).id
    target = createTestUser(db, { username: 'Target' }).id
    barrier = createTestUser(db, { username: 'Barrier' }).id
    for (const id of [caller, target, barrier])
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, id)
    createCommand(db, applicationId, guildId, { name: 'Mute', type: 2 })
    return connect(url, bot, onFrame)
  }

  it('holds an interaction, returns it to the controller, then releases and replays it', async () => {
    const received = await setup()
    const control = await armed({ member_id: caller })
    const created = await simulate()
    expect(created.status).toBe(201)
    const interaction = await body<Interaction>(created)
    await flush(received)
    expect(dispatched(received).map((frame) => frame.d.id)).not.toContain(
      interaction.id
    )
    const held = await captured(control.id)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      state: 'held',
      envelope: { t: 'INTERACTION_CREATE', d: { id: interaction.id } },
    })

    const released = await send(
      `/_test/gateway-event-controls/${control.id}/release`,
      'POST',
      { event_ids: [held[0].id] }
    )
    expect(released.status).toBe(200)
    const afterRelease = await interactions(received, 2)
    const frame = afterRelease.find((entry) => entry.d.id === interaction.id)
    expect(frame?.d).toEqual(interaction)
    // The held interaction was never answered.
    expect(await observe(interaction)).toMatchObject({ responded: false })

    const replayed = await send(
      `/_test/gateway-event-controls/${control.id}/replay`,
      'POST',
      { event_ids: [held[0].id] }
    )
    expect(replayed.status).toBe(200)
    const afterReplay = await interactions(received, 3)
    const copies = afterReplay.filter((entry) => entry.d.id === interaction.id)
    expect(copies).toHaveLength(2)
    expect(copies[1].d).toEqual(copies[0].d)
    expect(copies[1].s).toBeGreaterThan(copies[0].s ?? 0)
  })

  it('passes through other guilds and other users', async () => {
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
    await flush(received)
    expect(dispatched(received)).toHaveLength(3)
    expect(await captured(control.id)).toHaveLength(1)
  })

  it('does not capture another bot setup and validates member selectors', async () => {
    const received = await setup()
    const otherBot = seedBot(db, 'Bot other-capture', '444444444444444444')
    const otherGuild = seedGuild(db, otherBot, '555555555555555555')
    const otherChannel = seedChannel(db, otherGuild, '888888888888888888')
    const others = await connect(url, otherBot)
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
    expect(dispatched(received)).toEqual([])
    // member_id on an interaction control needs a current guild member.
    await send(`/_test/gateway-event-controls/${control.id}`, 'DELETE')
    expect(await code(arm({ member_id: '999999999999999999' }))).toBe(404)
    // A member selector cannot narrow events without a subject user.
    expect(
      await code(arm({ member_id: caller, events: ['MESSAGE_CREATE'] }))
    ).toBe(400)
  })

  it('keeps interactions of another app sharing the process and IDs out of a capture', async () => {
    const received = await setup()
    const control = await armed()
    const second = await createTestGatewayServer()
    closers.push(second.close)
    seedBot(second.db, 'Bot interaction-capture', applicationId)
    seedGuild(second.db, 'Bot interaction-capture', guildId)
    seedChannel(second.db, guildId, channelId)
    createCommand(second.db, applicationId, guildId, { name: 'mute' })
    const secondBot = await connect(second.url, 'Bot interaction-capture')
    const created = await fetch(
      `${second.url.replace('ws://', 'http://')}/_test/interactions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: applicationId,
          command_name: 'mute',
          guild_id: guildId,
          channel_id: channelId,
        }),
      }
    )
    expect(created.status).toBe(201)
    await interactions(secondBot, 1)
    // Capture runs synchronously inside the dispatch, so it is already final.
    expect(await captured(control.id)).toHaveLength(0)
    expect(dispatched(received)).toEqual([])
  })

  it('arms a callback fault for a held modal submission that the bot answers instantly', async () => {
    const answers: Promise<Response>[] = []
    let answerSubmissions = false
    const received = await setup((frame) => {
      // Like a real bot, defer every modal submission the moment it arrives.
      if (
        answerSubmissions &&
        frame.t === 'INTERACTION_CREATE' &&
        frame.d.type === 5
      ) {
        answers.push(callback(frame.d as unknown as Interaction, { type: 5 }))
      }
    })
    const created = await simulate()
    const command = await body<Interaction>(created)
    await interactions(received, 1)
    expect(
      await code(
        callback(command, { type: 9, data: buildMuteModalData(target) })
      )
    ).toBe(204)

    // Hold the submission's dispatch before it is sent.
    const control = await armed({ member_id: caller })
    answerSubmissions = true
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
    const submission = await body<Interaction>(submitted)
    expect(submission.type).toBe(5)
    await flush(received)
    // Nothing reached the bot, so it has not answered yet.
    expect(answers).toHaveLength(0)
    expect(await observe(submission)).toMatchObject({ responded: false })

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

    const held = await captured(control.id)
    await send(`/_test/gateway-event-controls/${control.id}/release`, 'POST', {
      event_ids: [held[0].id],
    })

    // The bot's immediate deferred acknowledgement fails and leaves the
    // submission open.
    await expect.poll(() => answers.length).toBe(1)
    const answered = await answers[0]
    expect(answered.status).toBe(503)
    expect(await observe(submission)).toEqual({
      interaction_id: submission.id,
      application_id: applicationId,
      responded: false,
      initial_callback_type: null,
    })
    const spent = await body<{ consumed: number }>(
      await send(`/_test/rest-faults/${faultBody.id}`, 'GET')
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
