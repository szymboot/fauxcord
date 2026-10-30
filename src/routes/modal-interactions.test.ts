import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMuteModalData,
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
  type FullTestContext,
} from '../test-helpers'
import { createCommand } from '../services/application-commands'
import { createTestUser } from '../services/test-control'

const applicationId = '111111111111111111'

/** Reads a response status. */
async function statusOf(
  response: Response | Promise<Response>
): Promise<number> {
  const resolved = await response
  return resolved.status
}

/** Reads a response body as JSON. */
async function json(response: Response | Promise<Response>): Promise<unknown> {
  const resolved = await response
  return resolved.json()
}

/** A started user-context-command interaction. */
interface Started {
  id: string
  token: string
}

describe('modal callbacks and test-control submissions', () => {
  let context: FullTestContext
  let botToken: string
  let guildId: string
  let channelId: string
  let caller: string
  let target: string
  let started: Started

  /** Starts a user-command interaction as the caller. */
  async function start(locale = 'pl'): Promise<Started> {
    const response = await context.app.request('/_test/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_id: applicationId,
        command_name: 'Mute',
        target_id: target,
        guild_id: guildId,
        channel_id: channelId,
        user_id: caller,
        locale,
      }),
    })
    expect(response.status).toBe(201)
    return (await response.json()) as Started
  }

  beforeEach(async () => {
    context = createFullTestApp()
    const { db } = context
    botToken = seedBot(db, 'Bot modal-bot', applicationId)
    guildId = seedGuild(db, botToken)
    channelId = seedChannel(db, guildId)
    caller = createTestUser(db, { username: 'Caller' }).id
    target = createTestUser(db, { username: 'Target' }).id
    for (const id of [caller, target]) {
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, id)
    }
    createCommand(db, applicationId, guildId, { name: 'Mute', type: 2 })
    started = await start()
  })

  afterEach(() => {
    context.cleanup()
  })

  /** Sends a callback as the bot would. */
  function callback(
    body: unknown,
    interaction = started,
    query = ''
  ): Response | Promise<Response> {
    return context.app.request(
      `/api/v10/interactions/${interaction.id}/${interaction.token}/callback${query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
  }

  /** Shows the mute modal for an interaction. */
  async function showModal(interaction = started): Promise<void> {
    const response = await callback(
      { type: 9, data: buildMuteModalData(target) },
      interaction
    )
    expect(response.status).toBe(204)
  }

  /** Reads callback observation for an interaction. */
  function observe(interaction = started): Response | Promise<Response> {
    return context.app.request(
      `/_test/interactions/${interaction.id}/callback?application_id=${applicationId}`,
      { headers: { 'X-Interaction-Token': interaction.token } }
    )
  }

  /** Submits the modal of an interaction. */
  function submit(
    body: Record<string, unknown>,
    interaction = started,
    headers?: Record<string, string>
  ): Response | Promise<Response> {
    return context.app.request(
      `/_test/interactions/${interaction.id}/modal-submit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(headers ?? { 'X-Interaction-Token': interaction.token }),
        },
        body: JSON.stringify({ application_id: applicationId, ...body }),
      }
    )
  }

  /** Reads the JSON validation errors of a 400 response. */
  async function errorFields(response: Response): Promise<string[]> {
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      code: number
      errors: Record<string, unknown>
    }
    expect(body.code).toBe(50_035)
    return Object.keys(body.errors)
  }

  describe('modal callback observation', () => {
    it('records the normalized modal and exposes it for the exact interaction', async () => {
      await showModal()
      const response = await observe()
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        interaction_id: started.id,
        application_id: applicationId,
        responded: true,
        initial_callback_type: 9,
        modal: {
          custom_id: `user_mute:${target}`,
          title: 'Mute user',
          components: [
            expect.objectContaining({ type: 18, id: 1, label: 'Reason' }),
            expect.objectContaining({
              type: 18,
              id: 3,
              description: 'For example 1h or 7d',
            }),
            expect.objectContaining({ type: 18, id: 5 }),
            expect.objectContaining({ type: 18, id: 7 }),
          ],
        },
      })
    })

    it("accepts DiscordGo's marshalled Label modal response", async () => {
      // Produced by json.Marshal of a discordgo InteractionResponse (v0.29.1
      // pre-release with Label support): zero values such as `tts`, empty
      // `placeholder`/`description`, `disabled: false` and `embeds: null` are
      // always present, `required` is omitted for unset pointers.
      const marshalled = `{"type":9,"data":{"tts":false,"content":"","components":[{"label":"Reason","component":{"custom_id":"reason","style":2,"required":true,"max_length":500,"type":4},"type":18},{"label":"Duration","component":{"custom_id":"duration","style":1,"type":4},"type":18},{"label":"Type","component":{"custom_id":"mute_type","placeholder":"","options":[{"label":"Text","value":"text","description":"","default":true},{"label":"Voice","value":"voice","description":"","default":false}],"disabled":false,"required":true,"type":3},"type":18}],"embeds":null,"flags":32768,"custom_id":"user_mute:1","title":"Mute"}}`
      const response = await context.app.request(
        `/api/v10/interactions/${started.id}/${started.token}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: marshalled,
        }
      )
      expect(response.status).toBe(204)
      const modal = (
        (await json(observe())) as {
          modal: { components: { component: Record<string, unknown> }[] }
        }
      ).modal
      expect(modal.components[1].component).toMatchObject({
        custom_id: 'duration',
        required: true,
      })
      expect(modal.components[2].component).toMatchObject({
        min_values: 1,
        max_values: 1,
      })
    })

    it('keeps the existing observation shape for other callbacks', async () => {
      expect(await json(observe())).toEqual({
        interaction_id: started.id,
        application_id: applicationId,
        responded: false,
        initial_callback_type: null,
      })
      expect(await statusOf(callback({ type: 5 }))).toBe(204)
      expect(await json(observe())).toEqual({
        interaction_id: started.id,
        application_id: applicationId,
        responded: true,
        initial_callback_type: 5,
      })
    })

    it('still accepts a data-less type 9 as an unrecorded acknowledgement', async () => {
      expect(await statusOf(callback({ type: 9 }))).toBe(204)
      expect(await json(observe())).toMatchObject({
        responded: true,
        initial_callback_type: 9,
      })
      expect(await json(observe())).not.toHaveProperty('modal')
      const response = await submit({ custom_id: 'x' })
      expect(await errorFields(response)).toEqual(['interaction_id'])
    })

    it('does not accept a second callback after the modal', async () => {
      await showModal()
      const again = await callback({ type: 4, data: { content: 'late' } })
      expect(again.status).toBe(400)
      expect(await again.json()).toMatchObject({ code: 40_060 })
    })

    it('rejects an invalid modal without acknowledging the interaction', async () => {
      const response = await callback({
        type: 9,
        data: {
          custom_id: 'm',
          title: 'T',
          components: [
            { type: 10, content: 'Hello' },
            {
              type: 18,
              label: 'L',
              component: { type: 5, custom_id: 'user' },
            },
            {
              type: 18,
              label: 'L',
              component: { type: 3, custom_id: 's', options: [] },
            },
          ],
        },
      })
      expect(await errorFields(response)).toEqual([
        'data.components.0.type',
        'data.components.1.component.type',
        'data.components.2.component.options',
      ])
      expect(await json(observe())).toMatchObject({ responded: false })
      await showModal()
    })

    it.each([
      ['non-object data', { type: 9, data: 'x' }, ['data']],
      [
        'missing fields',
        { type: 9, data: {} },
        ['data.custom_id', 'data.title', 'data.components'],
      ],
    ])('rejects %s', async (_name, body, fields) => {
      expect(await errorFields(await callback(body))).toEqual(fields)
    })

    it('refuses a modal as the answer to a modal submission', async () => {
      await showModal()
      const submission = (await json(
        submit({ custom_id: `user_mute:${target}`, values: { reason: 'x' } })
      )) as Started
      const response = await callback(
        { type: 9, data: buildMuteModalData(target) },
        submission
      )
      expect(await errorFields(response)).toEqual(['type'])
      expect(await statusOf(callback({ type: 5 }, submission))).toBe(204)
    })
  })

  describe('POST /_test/interactions/:id/modal-submit', () => {
    const values = {
      reason: 'Spam',
      duration: '7d',
      mute_type: ['voice'],
      visibility: ['private'],
    }

    it('creates a MODAL_SUBMIT interaction for the same user, guild, channel and locale', async () => {
      await showModal()
      const response = await submit({
        custom_id: `user_mute:${target}`,
        values,
      })
      expect(response.status).toBe(201)
      const submission = (await response.json()) as Record<string, unknown>
      expect(submission).toMatchObject({
        type: 5,
        application_id: applicationId,
        locale: 'pl',
        guild_id: guildId,
        channel_id: channelId,
        member: { user: { id: caller } },
        version: 1,
        data: {
          custom_id: `user_mute:${target}`,
          components: [
            {
              type: 18,
              id: 1,
              component: { type: 4, id: 2, custom_id: 'reason', value: 'Spam' },
            },
            {
              type: 18,
              id: 3,
              component: { type: 4, id: 4, custom_id: 'duration', value: '7d' },
            },
            {
              type: 18,
              id: 5,
              component: {
                type: 3,
                id: 6,
                custom_id: 'mute_type',
                values: ['voice'],
              },
            },
            {
              type: 18,
              id: 7,
              component: {
                type: 3,
                id: 8,
                custom_id: 'visibility',
                values: ['private'],
              },
            },
          ],
        },
      })
      expect(submission.id).not.toBe(started.id)
      expect(submission.token).not.toBe(started.token)
      expect(submission.data).not.toHaveProperty('name')
      expect(submission.data).not.toHaveProperty('target_id')
    })

    it('submits defaults for untouched fields', async () => {
      await showModal()
      const response = await submit({
        custom_id: `user_mute:${target}`,
        values: { reason: 'Why' },
      })
      expect(response.status).toBe(201)
      const json = JSON.stringify(await response.json())
      expect(json).toContain('"values":["text"]')
      expect(json).toContain('"values":["public"]')
      expect(json).toContain('"custom_id":"duration","value":""')
    })

    it('allows repeated submissions that create independent interactions', async () => {
      await showModal()
      const first = (await json(
        submit({ custom_id: `user_mute:${target}`, values })
      )) as Started
      const second = (await json(
        submit({ custom_id: `user_mute:${target}`, values })
      )) as Started
      expect(first.id).not.toBe(second.id)
      expect(await statusOf(callback({ type: 5 }, first))).toBe(204)
      expect(
        await statusOf(callback({ type: 4, data: { content: 'hi' } }, second))
      ).toBe(204)
      expect(await json(observe())).toMatchObject({
        initial_callback_type: 9,
      })
    })

    it('rejects missing credentials and malformed bodies with 400', async () => {
      await showModal()
      const noToken = await submit({ custom_id: 'x' }, started, {})
      expect(noToken.status).toBe(400)
      expect(await noToken.json()).toEqual({
        message: '400: Bad Request',
        code: 0,
      })
      const noApp = await context.app.request(
        `/_test/interactions/${started.id}/modal-submit`,
        {
          method: 'POST',
          headers: { 'X-Interaction-Token': started.token },
          body: '{}',
        }
      )
      expect(noApp.status).toBe(400)
      expect(
        await errorFields(await submit({ custom_id: 5, values: [] }))
      ).toEqual(['custom_id', 'values'])
      expect(await errorFields(await submit({}))).toEqual(['custom_id'])
    })

    it.each([
      ['an unknown interaction', { id: '999999999999999999' }, undefined],
      ['a wrong token', {}, { 'X-Interaction-Token': 'wrong' }],
    ])('returns 404 for %s', async (_name, override, headers) => {
      await showModal()
      const response = await submit(
        { custom_id: `user_mute:${target}` },
        { ...started, ...override },
        headers
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        message: '404: Not Found',
        code: 0,
      })
    })

    it('returns 404 for another application', async () => {
      await showModal()
      const response = await submit({
        application_id: '222222222222222229',
        custom_id: `user_mute:${target}`,
      })
      expect(response.status).toBe(404)
    })

    it('rejects an interaction that was never answered with a modal', async () => {
      const pending = await submit({ custom_id: 'x' })
      expect(await errorFields(pending)).toEqual(['interaction_id'])
      await callback({ type: 4, data: { content: 'no modal' } })
      expect(await errorFields(await submit({ custom_id: 'x' }))).toEqual([
        'interaction_id',
      ])
    })

    it('rejects a different modal custom_id', async () => {
      await showModal()
      const response = await submit({ custom_id: 'other', values })
      expect(await errorFields(response)).toEqual(['custom_id'])
    })

    it('reports every invalid value by component custom_id', async () => {
      await showModal()
      const response = await submit({
        custom_id: `user_mute:${target}`,
        values: {
          reason: '',
          missing: 'x',
          mute_type: ['both'],
          visibility: ['public', 'private'],
        },
      })
      expect(await errorFields(response)).toEqual([
        'values.missing',
        'values.reason',
        'values.mute_type',
        'values.visibility',
      ])
      const count = context.db
        .prepare('SELECT COUNT(*) FROM interactions WHERE type = 5')
        .pluck()
        .get()
      expect(count).toBe(0)
    })

    it('returns 404 and creates nothing once the bot left the guild or the channel is gone', async () => {
      await showModal()
      context.db.prepare('DELETE FROM channels WHERE id = ?').run(channelId)
      const noChannel = await submit({
        custom_id: `user_mute:${target}`,
        values,
      })
      expect(noChannel.status).toBe(404)
      expect(await noChannel.json()).toMatchObject({ code: 10_003 })

      seedChannel(context.db, guildId, channelId)
      context.db
        .prepare('UPDATE guilds SET bot_present = 0 WHERE id = ?')
        .run(guildId)
      const removed = await submit({ custom_id: `user_mute:${target}`, values })
      expect(removed.status).toBe(404)
      expect(await removed.json()).toMatchObject({ code: 10_004 })
      expect(
        context.db
          .prepare('SELECT COUNT(*) FROM interactions WHERE type = 5')
          .pluck()
          .get()
      ).toBe(0)
    })
  })

  describe('answering a modal submission', () => {
    /** Shows the modal and submits it with defaults. */
    async function submitted(): Promise<Started> {
      await showModal()
      const response = await submit({
        custom_id: `user_mute:${target}`,
        values: { reason: 'Because' },
      })
      return (await response.json()) as Started
    }

    it('supports an ephemeral direct response and observation', async () => {
      const submission = await submitted()
      const response = await callback(
        { type: 4, data: { content: 'Muted', flags: 64 } },
        submission,
        '?with_response=true'
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        interaction: { type: 5, response_message_ephemeral: true },
        resource: { message: { type: 0, content: 'Muted', flags: 64 } },
      })
      expect(await json(observe(submission))).toEqual({
        interaction_id: submission.id,
        application_id: applicationId,
        responded: true,
        initial_callback_type: 4,
      })
      const channel = await context.app.request(
        `/api/v10/channels/${channelId}/messages`,
        { headers: { Authorization: botToken } }
      )
      expect(await channel.json()).toEqual([])
    })

    it('supports a deferred response completed by edit and followup', async () => {
      const submission = await submitted()
      expect(await statusOf(callback({ type: 5 }, submission))).toBe(204)
      expect(await json(observe(submission))).toMatchObject({
        initial_callback_type: 5,
      })
      const base = `/api/v10/webhooks/${applicationId}/${submission.token}`
      const edited = await context.app.request(`${base}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Done' }),
      })
      expect(edited.status).toBe(200)
      expect(await edited.json()).toMatchObject({ content: 'Done', flags: 0 })
      const followup = await context.app.request(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Followup' }),
      })
      expect([200, 204]).toContain(followup.status)
      const channel = await context.app.request(
        `/api/v10/channels/${channelId}/messages`,
        { headers: { Authorization: botToken } }
      )
      const contents = ((await channel.json()) as { content: string }[]).map(
        (message) => message.content
      )
      expect(contents.toSorted((a, b) => a.localeCompare(b))).toEqual([
        'Done',
        'Followup',
      ])
    })
  })
})
