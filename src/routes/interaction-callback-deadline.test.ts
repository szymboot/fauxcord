import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildMuteModalData,
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
  seedInteraction,
  type FullTestContext,
} from '../test-helpers'
import { createCommand } from '../services/application-commands'
import { createTestUser } from '../services/test-control'
import { gatewayBus } from '../gateway/bus'

const applicationId = '111111111111111111'
const botAuth = 'Bot deadline-bot'
const otherApplicationId = '333333333333333330'
const otherBotAuth = 'Bot other-deadline-bot'
const GUILD = '222222222222222222'
const OTHER_GUILD = '222222222222222223'
const FOREIGN_GUILD = '222222222222222224'
const UNKNOWN_INTERACTION = { message: 'Unknown interaction', code: 10_062 }

/** Reads a response status. */
async function status(response: Response | Promise<Response>): Promise<number> {
  const resolved = await response
  return resolved.status
}

/** A started interaction. */
interface Started {
  id: string
  token: string
  application_id: string
}

/** A created deadline control. */
interface Control {
  id: string
  guild_id: string
  bot_id: string
  deadline_ms: number
  created_at: string
}

describe('interaction callback deadline control', () => {
  let context: FullTestContext
  let botToken: string
  let channelId: string
  let otherChannelId: string
  let foreignChannelId: string
  let user: string
  let messageId: string

  /** JSON request helper. */
  function send(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {}
  ): Response | Promise<Response> {
    return context.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Arms a deadline for a guild. */
  async function arm(guildId = GUILD, deadlineMs?: number): Promise<Control> {
    const response = await send(
      '/_test/interaction-callback-deadlines',
      'POST',
      {
        guild_id: guildId,
        ...(deadlineMs !== undefined && { deadline_ms: deadlineMs }),
      }
    )
    expect(response.status).toBe(201)
    return (await response.json()) as Control
  }

  /** Starts an interaction through `POST /_test/interactions`. */
  async function start(
    extra: Record<string, unknown> = {},
    channel = channelId,
    guild = GUILD
  ): Promise<Started> {
    const response = await send('/_test/interactions', 'POST', {
      application_id:
        guild === FOREIGN_GUILD ? otherApplicationId : applicationId,
      command_name: 'ranking',
      guild_id: guild,
      channel_id: channel,
      user_id: user,
      ...extra,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as Started
  }

  /** Sends the initial callback as the bot would. */
  function callback(
    interaction: Started,
    body?: unknown
  ): Response | Promise<Response> {
    return send(
      `/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
      'POST',
      body ?? { type: 4, data: { content: 'hello' } }
    )
  }

  /** Reads the callback observation. */
  async function observe(
    interaction: Started
  ): Promise<Record<string, unknown>> {
    const response = await send(
      `/_test/interactions/${interaction.id}/callback?application_id=${interaction.application_id}`,
      'GET',
      undefined,
      { 'X-Interaction-Token': interaction.token }
    )
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }

  /** Counts stored messages. */
  function messageCount(): number {
    return (
      context.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as {
        n: number
      }
    ).n
  }

  /** Moves the fake clock forward. */
  function advance(ms: number): void {
    vi.setSystemTime(Date.now() + ms)
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    context = createFullTestApp()
    const { db } = context
    botToken = seedBot(db, botAuth, applicationId)
    seedGuild(db, botToken, GUILD)
    seedGuild(db, botToken, OTHER_GUILD)
    channelId = seedChannel(db, GUILD)
    otherChannelId = seedChannel(db, OTHER_GUILD, '333333333333333331')
    const otherToken = seedBot(db, otherBotAuth, otherApplicationId)
    seedGuild(db, otherToken, FOREIGN_GUILD)
    foreignChannelId = seedChannel(db, FOREIGN_GUILD, '333333333333333332')
    user = createTestUser(db, { username: 'Caller' }).id
    for (const guild of [GUILD, OTHER_GUILD, FOREIGN_GUILD]) {
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guild, user)
    }
    createCommand(db, applicationId, GUILD, { name: 'ranking', type: 1 })
    createCommand(db, applicationId, GUILD, { name: 'search', type: 1 })
    createCommand(db, applicationId, GUILD, { name: 'Mute', type: 2 })
    createCommand(db, applicationId, OTHER_GUILD, { name: 'ranking', type: 1 })
    createCommand(db, otherApplicationId, FOREIGN_GUILD, {
      name: 'ranking',
      type: 1,
    })
    const posted = await send(
      `/api/v10/channels/${channelId}/messages`,
      'POST',
      {
        content: 'Rules',
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 1, label: 'Accept', custom_id: 'accept_rules' },
            ],
          },
        ],
      },
      { Authorization: botAuth }
    )
    messageId = ((await posted.json()) as { id: string }).id
  })

  afterEach(() => {
    vi.useRealTimers()
    context.cleanup()
  })

  describe('control routes', () => {
    it('arms with the default 3000 ms deadline', async () => {
      const response = await send(
        '/_test/interaction-callback-deadlines',
        'POST',
        { guild_id: GUILD }
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({
        id: expect.any(String),
        guild_id: GUILD,
        bot_id: applicationId,
        deadline_ms: 3000,
        created_at: new Date().toISOString(),
      })
    })

    it('accepts a custom deadline within bounds', async () => {
      const shortest = await arm(GUILD, 1)
      const longest = await arm(OTHER_GUILD, 60_000)
      expect([shortest.deadline_ms, longest.deadline_ms]).toEqual([1, 60_000])
    })

    it('reads and removes a control', async () => {
      const control = await arm()
      const path = `/_test/interaction-callback-deadlines/${control.id}`
      const read = await send(path)
      expect(read.status).toBe(200)
      expect(read.headers.get('cache-control')).toBe('no-store')
      expect(await read.json()).toEqual(control)
      expect(await status(send(path, 'DELETE'))).toBe(204)
      expect(await status(send(path))).toBe(404)
      const missing = await send(path, 'DELETE')
      expect(await missing.json()).toEqual({
        message: '404: Not Found',
        code: 0,
      })
    })

    it('returns 404 for an unknown control', async () => {
      const path = '/_test/interaction-callback-deadlines/unknown'
      expect(await status(send(path))).toBe(404)
      expect(await status(send(path, 'DELETE'))).toBe(404)
    })

    it.each([
      ['a missing guild_id', {}, 'guild_id'],
      ['a non-string guild_id', { guild_id: 5 }, 'guild_id'],
      ['a zero-padded guild_id', { guild_id: '0123' }, 'guild_id'],
      ['a zero deadline', { guild_id: GUILD, deadline_ms: 0 }, 'deadline_ms'],
      [
        'a too long deadline',
        { guild_id: GUILD, deadline_ms: 60_001 },
        'deadline_ms',
      ],
      [
        'a fractional deadline',
        { guild_id: GUILD, deadline_ms: 1.5 },
        'deadline_ms',
      ],
      [
        'a string deadline',
        { guild_id: GUILD, deadline_ms: '3000' },
        'deadline_ms',
      ],
      ['an unknown field', { guild_id: GUILD, extra: true }, 'body'],
      ['a non-object body', [], 'body'],
    ])('rejects %s with a validation error', async (_, body, field) => {
      const response = await send(
        '/_test/interaction-callback-deadlines',
        'POST',
        body
      )
      expect(response.status).toBe(400)
      const parsed = (await response.json()) as {
        code: number
        errors: Record<string, unknown>
      }
      expect(parsed.code).toBe(50_035)
      expect(Object.keys(parsed.errors)).toEqual([field])
    })

    it('rejects malformed JSON', async () => {
      const response = await context.app.request(
        '/_test/interaction-callback-deadlines',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }
      )
      expect(response.status).toBe(400)
    })

    it('rejects an unknown guild with 404', async () => {
      const response = await send(
        '/_test/interaction-callback-deadlines',
        'POST',
        { guild_id: '999999999999999999' }
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 10_004 })
    })

    it('rejects a duplicate active control for a guild with 409', async () => {
      const control = await arm()
      const duplicate = await send(
        '/_test/interaction-callback-deadlines',
        'POST',
        { guild_id: GUILD, deadline_ms: 100 }
      )
      expect(duplicate.status).toBe(409)
      expect(await duplicate.json()).toEqual({
        message: '409: Conflict',
        code: 0,
      })
      // The original control is untouched and the guild can be re-armed once
      // it is removed.
      await send(
        `/_test/interaction-callback-deadlines/${control.id}`,
        'DELETE'
      )
      const rearmed = await arm(GUILD, 100)
      expect(rearmed.deadline_ms).toBe(100)
    })
  })

  describe('within the deadline', () => {
    it('accepts a message callback', async () => {
      await arm()
      const interaction = await start()
      advance(2999)
      const response = await callback(interaction)
      expect(response.status).toBe(204)
      expect(await observe(interaction)).toMatchObject({
        responded: true,
        initial_callback_type: 4,
      })
      expect(messageCount()).toBe(2)
    })

    it('accepts a callback exactly at the deadline', async () => {
      await arm()
      const interaction = await start()
      advance(3000)
      expect(await status(callback(interaction))).toBe(204)
    })

    it('accepts a deferred callback and keeps the 15-minute rules for followups and @original', async () => {
      await arm()
      const interaction = await start()
      advance(2000)
      expect(await status(callback(interaction, { type: 5 }))).toBe(204)
      // Long after the 3-second deadline, the token still works for 15 minutes.
      advance(10 * 60 * 1000)
      const hook = `/webhooks/${applicationId}/${interaction.token}`
      const edit = await send(`${hook}/messages/@original`, 'PATCH', {
        content: 'done',
      })
      expect(edit.status).toBe(200)
      const followup = await send(`${hook}?wait=true`, 'POST', {
        content: 'followup',
      })
      expect(followup.status).toBe(200)
      advance(6 * 60 * 1000)
      const expired = await send(`${hook}/messages/@original`)
      expect(expired.status).toBe(401)
    })

    it('accepts a modal callback', async () => {
      await arm()
      const interaction = await start()
      advance(1500)
      const response = await callback(interaction, {
        type: 9,
        data: buildMuteModalData(user),
      })
      expect(response.status).toBe(204)
      expect(await observe(interaction)).toMatchObject({
        responded: true,
        initial_callback_type: 9,
        modal: expect.any(Object),
      })
    })

    it('does not add a rejection field to an accepted callback', async () => {
      await arm()
      const interaction = await start()
      expect(await status(callback(interaction))).toBe(204)
      const observation = await observe(interaction)
      expect(observation).not.toHaveProperty('rejected_reason')
      expect(observation).not.toHaveProperty('rejected_at')
    })
  })

  describe('after the deadline', () => {
    /** Collects `message.create` dispatches. */
    function collectMessages(): { count: () => number; stop: () => void } {
      let count = 0
      const listener = (): void => {
        count++
      }
      gatewayBus.on('message.create', listener)
      return {
        count: () => count,
        stop: () => gatewayBus.off('message.create', listener),
      }
    }

    it('rejects a late message callback with 10062 and stores nothing', async () => {
      await arm()
      const interaction = await start()
      const before = messageCount()
      const dispatched = collectMessages()
      const created: string[] = []
      const track = (): void => {
        created.push('interaction.create')
      }
      gatewayBus.on('interaction.create', track)
      advance(3001)
      const response = await callback(interaction)
      dispatched.stop()
      gatewayBus.off('interaction.create', track)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual(UNKNOWN_INTERACTION)
      expect(messageCount()).toBe(before)
      expect(dispatched.count()).toBe(0)
      expect(created).toEqual([])
      expect(await observe(interaction)).toMatchObject({
        responded: false,
        initial_callback_type: null,
      })
      const row = context.db
        .prepare(
          'SELECT initial_response_message_id AS id, responded FROM interactions WHERE id = ?'
        )
        .get(interaction.id)
      expect(row).toEqual({ id: null, responded: 0 })
    })

    it('rejects a late deferred callback without storing a loading message', async () => {
      await arm()
      const interaction = await start()
      const before = messageCount()
      advance(3001)
      const response = await callback(interaction, { type: 5 })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual(UNKNOWN_INTERACTION)
      expect(messageCount()).toBe(before)
      expect(await observe(interaction)).toMatchObject({ responded: false })
      const original = await send(
        `/webhooks/${applicationId}/${interaction.token}/messages/@original`
      )
      expect(original.status).toBe(404)
    })

    it('rejects a late modal callback without storing a modal', async () => {
      await arm()
      const interaction = await start({ command_name: 'Mute', target_id: user })
      advance(3001)
      const response = await callback(interaction, {
        type: 9,
        data: buildMuteModalData(user),
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual(UNKNOWN_INTERACTION)
      const observation = await observe(interaction)
      expect(observation).toMatchObject({ responded: false })
      expect(observation).not.toHaveProperty('modal')
      const submit = await send(
        `/_test/interactions/${interaction.id}/modal-submit`,
        'POST',
        {
          application_id: applicationId,
          custom_id: `user_mute:${user}`,
          values: {},
        },
        { 'X-Interaction-Token': interaction.token }
      )
      expect(submit.status).toBe(400)
    })

    it('refuses before checking the callback type and records no type refusal', async () => {
      await arm()
      const interaction = await start({
        command_name: 'search',
        type: 4,
        options: [{ name: 'query', type: 3, value: 'a', focused: true }],
      })
      advance(3001)
      const response = await callback(interaction, { type: 4 })
      expect(response.status).toBe(404)
      const observation = await observe(interaction)
      expect(observation).not.toHaveProperty('rejected_callback_type')
      expect(observation).toMatchObject({ rejected_reason: 'deadline' })
    })

    it('keeps answering already acknowledged interactions with 40060', async () => {
      await arm()
      const interaction = await start()
      expect(await status(callback(interaction))).toBe(204)
      advance(10_000)
      const again = await callback(interaction)
      expect(again.status).toBe(400)
      expect(await again.json()).toMatchObject({ code: 40_060 })
    })

    it('does not change unknown or wrong-token callbacks', async () => {
      await arm()
      const interaction = await start()
      advance(3001)
      const wrong = await callback({ ...interaction, token: 'wrong' })
      expect(wrong.status).toBe(404)
      expect(await wrong.json()).toMatchObject({ code: 10_062 })
      expect(await observe(interaction)).not.toHaveProperty('rejected_reason')
    })

    it('still validates the callback body first', async () => {
      await arm()
      const interaction = await start()
      advance(3001)
      const response = await callback(interaction, { type: 'bad' })
      expect(response.status).toBe(400)
      expect(await observe(interaction)).not.toHaveProperty('rejected_reason')
    })

    it('honors a short custom deadline', async () => {
      await arm(GUILD, 50)
      const early = await start()
      advance(40)
      expect(await status(callback(early))).toBe(204)
      const late = await start()
      advance(51)
      expect(await status(callback(late))).toBe(404)
    })

    it('measures each interaction from its own creation', async () => {
      await arm()
      const first = await start()
      advance(2000)
      const second = await start()
      advance(2000)
      expect(await status(callback(first))).toBe(404)
      expect(await status(callback(second))).toBe(204)
    })
  })

  describe('observation', () => {
    it('reports the deadline rejection with a timestamp', async () => {
      await arm()
      const interaction = await start()
      advance(4000)
      await callback(interaction)
      expect(await observe(interaction)).toEqual({
        interaction_id: interaction.id,
        application_id: applicationId,
        responded: false,
        initial_callback_type: null,
        rejected_reason: 'deadline',
        rejected_at: new Date().toISOString(),
      })
    })

    it('records the latest rejection instant', async () => {
      await arm()
      const interaction = await start()
      advance(4000)
      await callback(interaction)
      advance(1000)
      await callback(interaction)
      expect(await observe(interaction)).toMatchObject({
        rejected_at: new Date().toISOString(),
      })
    })

    it('stays readable after the control is removed', async () => {
      const control = await arm()
      const interaction = await start()
      advance(4000)
      await callback(interaction)
      await send(
        `/_test/interaction-callback-deadlines/${control.id}`,
        'DELETE'
      )
      expect(await observe(interaction)).toMatchObject({
        rejected_reason: 'deadline',
      })
    })
  })

  describe('scope', () => {
    it('does not affect a guild without an armed control', async () => {
      await arm(GUILD)
      const interaction = await start({}, otherChannelId, OTHER_GUILD)
      advance(60_000)
      expect(await status(callback(interaction))).toBe(204)
    })

    it('does not affect another bot setup', async () => {
      await arm(GUILD)
      const interaction = await start({}, foreignChannelId, FOREIGN_GUILD)
      advance(60_000)
      expect(await status(callback(interaction))).toBe(204)
    })

    it('does not affect interactions created before arming', async () => {
      // Same millisecond: arming must not reach back to an existing interaction.
      const interaction = await start()
      await arm()
      advance(60_000)
      expect(await status(callback(interaction))).toBe(204)
    })

    it('stops applying once the control is removed', async () => {
      const control = await arm()
      const interaction = await start()
      advance(4000)
      await send(
        `/_test/interaction-callback-deadlines/${control.id}`,
        'DELETE'
      )
      expect(await status(callback(interaction))).toBe(204)
    })

    it('applies to interactions with no guild_id in the channel guild', async () => {
      await arm()
      const { interactionId, interactionToken } = seedInteraction(
        context.db,
        applicationId,
        channelId,
        user
      )
      advance(3001)
      const late = await callback({
        id: interactionId,
        token: interactionToken,
        application_id: applicationId,
      })
      expect(late.status).toBe(404)
    })

    it('applies to every interaction kind', async () => {
      await arm()
      const button = await start({
        type: 3,
        message_id: messageId,
        custom_id: 'accept_rules',
        command_name: undefined,
      })
      const autocomplete = await start({
        command_name: 'search',
        type: 4,
        options: [{ name: 'query', type: 3, value: 'a', focused: true }],
      })
      const modalOpener = await start({ command_name: 'Mute', target_id: user })
      // A modal submission is created from an accepted modal callback.
      const shown = await callback(modalOpener, {
        type: 9,
        data: buildMuteModalData(user),
      })
      expect(shown.status).toBe(204)
      const submission = await send(
        `/_test/interactions/${modalOpener.id}/modal-submit`,
        'POST',
        {
          application_id: applicationId,
          custom_id: `user_mute:${user}`,
          values: { reason: 'x' },
        },
        { 'X-Interaction-Token': modalOpener.token }
      )
      expect(submission.status).toBe(201)
      const submitted = (await submission.json()) as Started
      advance(3001)
      expect(await status(callback(button))).toBe(404)
      expect(
        await status(callback(autocomplete, { type: 8, data: { choices: [] } }))
      ).toBe(404)
      expect(await status(callback(submitted))).toBe(404)
    })
  })

  describe('cleanup', () => {
    /** Reads a control status. */
    async function controlStatus(control: Control): Promise<number> {
      return status(send(`/_test/interaction-callback-deadlines/${control.id}`))
    }

    it('is removed by an unscoped reset', async () => {
      const control = await arm()
      await send('/_test/reset', 'POST')
      expect(await controlStatus(control)).toBe(404)
      const interaction = await start()
      advance(60_000)
      expect(await status(callback(interaction))).toBe(204)
    })

    it('is removed by a reset scoped to the owning token only', async () => {
      const mine = await arm(GUILD)
      const otherToken = seedBot(context.db, 'Bot third', '444444444444444440')
      seedGuild(context.db, otherToken, '222222222222222229')
      const theirs = await arm('222222222222222229')
      await send('/_test/reset', 'POST', { token: otherToken })
      expect(await controlStatus(theirs)).toBe(404)
      expect(await controlStatus(mine)).toBe(200)
      await send('/_test/reset', 'POST', { token: botToken })
      expect(await controlStatus(mine)).toBe(404)
    })

    it('is removed when the guild is deleted', async () => {
      const control = await arm()
      context.db.prepare('DELETE FROM guilds WHERE id = ?').run(GUILD)
      expect(await controlStatus(control)).toBe(404)
      expect(
        context.db
          .prepare(
            'SELECT COUNT(*) AS n FROM test_interaction_callback_deadlines'
          )
          .get()
      ).toEqual({ n: 0 })
    })

    it('is removed with the setup', async () => {
      const control = await arm()
      const response = await send(
        `/_test/setup/${encodeURIComponent(botToken)}`,
        'DELETE'
      )
      expect(response.status).toBe(204)
      expect(await controlStatus(control)).toBe(404)
    })

    it('is retired when the guild moves to another setup', async () => {
      const control = await arm()
      const otherToken = seedBot(context.db, 'Bot mover', '555555555555555550')
      context.db
        .prepare('UPDATE guilds SET bot_token = ? WHERE id = ?')
        .run(otherToken, GUILD)
      expect(await controlStatus(control)).toBe(404)
    })
  })

  describe('ordering with other controls', () => {
    it('runs an armed callback fault before the deadline check', async () => {
      await arm()
      const interaction = await start()
      const armed = await send('/_test/rest-faults', 'POST', {
        method: 'POST',
        path: `/interactions/${interaction.id}/callback`,
        status: 503,
        code: 0,
        message: 'Injected failure',
      })
      expect(armed.status).toBe(201)
      advance(4000)
      const faulted = await callback(interaction)
      expect(faulted.status).toBe(503)
      // The faulted request never reached the route, so nothing was recorded.
      expect(await observe(interaction)).not.toHaveProperty('rejected_reason')
      // Once the fault is exhausted the native deadline response applies.
      const native = await callback(interaction)
      expect(native.status).toBe(404)
      expect(await native.json()).toEqual(UNKNOWN_INTERACTION)
    })

    it('is independent of expire-token', async () => {
      await arm()
      const interaction = await start()
      const expire = await send(
        `/_test/interactions/${interaction.id}/expire-token`,
        'POST',
        { application_id: applicationId },
        { 'X-Interaction-Token': interaction.token }
      )
      expect(expire.status).toBe(200)
      // Within the deadline the callback is still accepted after expiry.
      expect(await status(callback(interaction))).toBe(204)
      const late = await start()
      advance(3001)
      expect(await status(callback(late))).toBe(404)
      // The deadline does not touch the 15-minute token: it is still usable
      // for webhook routes (here: an unacknowledged interaction has no
      // original yet).
      const original = await send(
        `/webhooks/${applicationId}/${late.token}/messages/@original`
      )
      expect(original.status).toBe(404)
      expect(await original.json()).not.toMatchObject({ code: 50_027 })
    })
  })
})
