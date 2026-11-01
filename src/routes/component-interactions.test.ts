import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMuteModalData,
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
  seedMessage,
  type FullTestContext,
} from '../test-helpers'
import { createCommand } from '../services/application-commands'
import { getOrCreateDmChannel } from '../services/channels'
import { createTestUser } from '../services/test-control'

const applicationId = '111111111111111111'
const botAuth = 'Bot component-bot'

/** A started component interaction. */
interface Started {
  id: string
  token: string
}

describe('POST /_test/interactions for MESSAGE_COMPONENT clicks', () => {
  let context: FullTestContext
  let guildId: string
  let channelId: string
  let user: string
  let messageId: string

  /** Sends a bot message carrying appeal-style buttons. */
  async function sendBotMessage(channel: string): Promise<string> {
    const response = await context.app.request(
      `/api/v10/channels/${channel}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: botAuth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'Appeal your ban',
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 1, label: 'Appeal', custom_id: 'appeal' },
                {
                  type: 2,
                  style: 4,
                  label: 'Gone',
                  custom_id: 'gone',
                  disabled: true,
                },
                {
                  type: 2,
                  style: 5,
                  label: 'Docs',
                  url: 'https://example.com',
                },
              ],
            },
          ],
        }),
      }
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { id: string }).id
  }

  beforeEach(async () => {
    context = createFullTestApp()
    const { db } = context
    const botToken = seedBot(db, botAuth, applicationId)
    guildId = seedGuild(db, botToken)
    channelId = seedChannel(db, guildId)
    user = createTestUser(db, { username: 'Clicker' }).id
    db.prepare(
      'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
    ).run(guildId, user)
    messageId = await sendBotMessage(channelId)
  })

  afterEach(() => {
    context.cleanup()
  })

  /** Posts a simulated component click. */
  function click(
    body: Record<string, unknown> = {}
  ): Response | Promise<Response> {
    return context.app.request('/_test/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_id: applicationId,
        type: 3,
        channel_id: channelId,
        message_id: messageId,
        custom_id: 'appeal',
        user_id: user,
        ...body,
      }),
    })
  }

  /** Sends a callback as the bot would. */
  function callback(
    interaction: Started,
    body: unknown,
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

  /** Reads the field errors of a 400 response. */
  async function errorFields(
    response: Response
  ): Promise<Record<string, { _errors: { message: string }[] }>> {
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      code: number
      errors: Record<string, { _errors: { message: string }[] }>
    }
    expect(body.code).toBe(50_035)
    return body.errors
  }

  /** Reads a Discord-shaped error code of a response with the status. */
  async function errorCode(
    response: Response,
    status: number
  ): Promise<number> {
    expect(response.status).toBe(status)
    return ((await response.json()) as { code: number }).code
  }

  describe('success', () => {
    it('creates a native type-3 interaction with the full message', async () => {
      const response = await click({ locale: 'pl' })
      expect(response.status).toBe(201)
      const interaction = (await response.json()) as Record<string, unknown>
      const rest = await context.app.request(
        `/api/v10/channels/${channelId}/messages/${messageId}`,
        { headers: { Authorization: botAuth } }
      )
      expect(interaction).toMatchObject({
        application_id: applicationId,
        type: 3,
        version: 1,
        locale: 'pl',
        guild_id: guildId,
        channel_id: channelId,
        member: { user: { id: user } },
        data: { custom_id: 'appeal', component_type: 2 },
      })
      expect(interaction.token).toEqual(expect.any(String))
      expect(interaction).not.toHaveProperty('user')
      expect(interaction.message).toEqual(await rest.json())
      expect(interaction.message).toMatchObject({
        id: messageId,
        components: [
          {
            type: 1,
            components: [
              { custom_id: 'appeal' },
              { custom_id: 'gone', disabled: true },
              { url: 'https://example.com' },
            ],
          },
        ],
      })
    })

    it('accepts a click on an ephemeral original response', async () => {
      const firstClick = await click()
      const first = (await firstClick.json()) as Started
      const response = await context.app.request(
        `/api/v10/interactions/${first.id}/${first.token}/callback?with_response=true`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 4,
            data: {
              flags: 64,
              content: 'Sure?',
              components: [
                {
                  type: 1,
                  components: [
                    { type: 2, style: 1, label: 'Yes', custom_id: 'yes' },
                  ],
                },
              ],
            },
          }),
        }
      )
      const ephemeral = (
        (await response.json()) as { resource: { message: { id: string } } }
      ).resource.message.id
      const second = await click({ message_id: ephemeral, custom_id: 'yes' })
      expect(second.status).toBe(201)
      const other = createTestUser(context.db, { username: 'Other' }).id
      context.db
        .prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)')
        .run(guildId, other)
      const third = await click({
        message_id: ephemeral,
        custom_id: 'yes',
        user_id: other,
      })
      expect(await errorCode(third, 404)).toBe(10_008)
    })

    it('accepts custom_ids counted in characters, not UTF-16 units', async () => {
      const emoji = '😀'.repeat(51)
      context.db.prepare('UPDATE messages SET components = ? WHERE id = ?').run(
        JSON.stringify([
          {
            type: 1,
            components: [{ type: 2, style: 1, label: 'Hi', custom_id: emoji }],
          },
        ]),
        messageId
      )
      const response = await click({ custom_id: emoji })
      expect(response.status).toBe(201)
    })

    it('infers the guild from the channel and defaults the locale', async () => {
      const response = await click()
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({
        guild_id: guildId,
        locale: 'en-US',
      })
    })

    it('carries a user instead of a member in a DM', async () => {
      const { db } = context
      const dm = getOrCreateDmChannel(db, user, applicationId)
      const dmMessage = seedMessage(db, dm.id, applicationId, 'x')
      db.prepare('UPDATE messages SET components = ? WHERE id = ?').run(
        JSON.stringify([
          {
            type: 1,
            components: [{ type: 2, style: 1, label: 'Hi', custom_id: 'hi' }],
          },
        ]),
        dmMessage
      )
      const response = await click({
        channel_id: dm.id,
        message_id: dmMessage,
        custom_id: 'hi',
      })
      expect(response.status).toBe(201)
      const interaction = (await response.json()) as Record<string, unknown>
      expect(interaction).toMatchObject({ user: { id: user } })
      expect(interaction).not.toHaveProperty('member')
      expect(interaction).not.toHaveProperty('guild_id')
    })
  })

  describe('rejections', () => {
    it.each(['command_name', 'command_type', 'target_id', 'options'])(
      'rejects the command-only field %s',
      async (field) => {
        const value =
          field === 'options' ? [] : field === 'command_type' ? 1 : 'x'
        const errors = await errorFields(await click({ [field]: value }))
        expect(Object.keys(errors)).toEqual([field])
      }
    )

    it.each(['channel_id', 'message_id', 'custom_id', 'user_id'])(
      'requires %s',
      async (field) => {
        const errors = await errorFields(await click({ [field]: undefined }))
        expect(Object.keys(errors)).toEqual([field])
      }
    )

    it('rejects malformed identifiers and locales', async () => {
      const errors = await errorFields(
        await click({
          message_id: 'abc',
          custom_id: 5,
          user_id: 7,
          guild_id: 'x',
          locale: 'xx',
        })
      )
      expect(
        Object.keys(errors).toSorted((a, b) => a.localeCompare(b))
      ).toEqual(['custom_id', 'guild_id', 'locale', 'message_id', 'user_id'])
    })

    it('returns Unknown Message for a missing message or one from another channel', async () => {
      expect(await errorCode(await click({ message_id: '999' }), 404)).toBe(
        10_008
      )
      const other = seedChannel(context.db, guildId, '666666666666666666')
      expect(await errorCode(await click({ channel_id: other }), 404)).toBe(
        10_008
      )
    })

    it('rejects a message sent by another application', async () => {
      const { db } = context
      const other = seedBot(db, 'Bot other-bot', '444444444444444444')
      seedGuild(db, other, '555555555555555555')
      const foreign = seedMessage(db, channelId, '444444444444444444', 'x')
      const errors = await errorFields(await click({ message_id: foreign }))
      expect(Object.keys(errors)).toEqual(['message_id'])
      const human = seedMessage(db, channelId, user, 'x')
      await errorFields(await click({ message_id: human }))
    })

    it('rejects an unknown custom_id', async () => {
      const errors = await errorFields(await click({ custom_id: 'nope' }))
      expect(errors.custom_id._errors[0].message).toBe(
        'Message has no button with this custom_id.'
      )
    })

    it('rejects a link button', async () => {
      const errors = await errorFields(
        await click({ custom_id: 'https://example.com' })
      )
      expect(errors.custom_id._errors[0].message).toBe(
        'Link buttons cannot be clicked.'
      )
    })

    it('rejects a disabled button', async () => {
      const errors = await errorFields(await click({ custom_id: 'gone' }))
      expect(errors.custom_id._errors[0].message).toBe(
        'Disabled buttons cannot be clicked.'
      )
    })

    it('rejects a user who is not a guild member', async () => {
      const outsider = createTestUser(context.db, { username: 'Out' }).id
      expect(await errorCode(await click({ user_id: outsider }), 404)).toBe(
        10_007
      )
      expect(await errorCode(await click({ user_id: '999' }), 404)).toBe(10_007)
    })

    it('rejects an unknown user in a DM', async () => {
      const { db } = context
      const dm = getOrCreateDmChannel(db, user, applicationId)
      const dmMessage = seedMessage(db, dm.id, applicationId, 'x')
      db.prepare('UPDATE messages SET components = ? WHERE id = ?').run(
        JSON.stringify([
          {
            type: 1,
            components: [{ type: 2, style: 1, label: 'Hi', custom_id: 'hi' }],
          },
        ]),
        dmMessage
      )
      expect(
        await errorCode(
          await click({
            channel_id: dm.id,
            message_id: dmMessage,
            custom_id: 'hi',
            user_id: '999',
          }),
          404
        )
      ).toBe(10_013)
    })

    it('rejects a user who is not a recipient of the DM', async () => {
      const { db } = context
      const dm = getOrCreateDmChannel(db, user, applicationId)
      const dmMessage = seedMessage(db, dm.id, applicationId, 'x')
      db.prepare('UPDATE messages SET components = ? WHERE id = ?').run(
        JSON.stringify([
          {
            type: 1,
            components: [{ type: 2, style: 1, label: 'Hi', custom_id: 'hi' }],
          },
        ]),
        dmMessage
      )
      const stranger = createTestUser(db, { username: 'Stranger' }).id
      expect(
        await errorCode(
          await click({
            channel_id: dm.id,
            message_id: dmMessage,
            custom_id: 'hi',
            user_id: stranger,
          }),
          404
        )
      ).toBe(10_013)
    })

    it('applies the guild and channel gating of every interaction', async () => {
      expect(await errorCode(await click({ guild_id: '999' }), 404)).toBe(
        10_004
      )
      expect(await errorCode(await click({ channel_id: '999' }), 404)).toBe(
        10_003
      )
      context.db
        .prepare('UPDATE guilds SET bot_present = 0 WHERE id = ?')
        .run(guildId)
      expect(await errorCode(await click(), 404)).toBe(10_003)
      expect(await errorCode(await click({ guild_id: guildId }), 404)).toBe(
        10_004
      )
    })

    it('creates no interaction when rejected', async () => {
      await click({ custom_id: 'gone' })
      await click({ message_id: '999' })
      expect(
        context.db.prepare('SELECT COUNT(*) AS n FROM interactions').get()
      ).toEqual({ n: 0 })
    })

    it('stops accepting clicks once the button is disabled by a message edit', async () => {
      const before = await click()
      expect(before.status).toBe(201)
      const edit = await context.app.request(
        `/api/v10/channels/${channelId}/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: botAuth,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 1,
                    label: 'Appeal',
                    custom_id: 'appeal',
                    disabled: true,
                  },
                ],
              },
            ],
          }),
        }
      )
      expect(edit.status).toBe(200)
      const errors = await errorFields(await click())
      expect(errors.custom_id._errors[0].message).toBe(
        'Disabled buttons cannot be clicked.'
      )
    })

    it('leaves command interactions unchanged', async () => {
      const response = await context.app.request('/_test/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: applicationId,
          command_name: 'missing',
        }),
      })
      expect(response.status).toBe(404)
    })
  })

  describe('callbacks', () => {
    /** Starts a click and returns it. */
    async function start(): Promise<Started> {
      const response = await click()
      expect(response.status).toBe(201)
      return (await response.json()) as Started
    }

    it('creates a public original response for type 4', async () => {
      const interaction = await start()
      const response = await callback(
        interaction,
        { type: 4, data: { content: 'Thanks' } },
        '?with_response=true'
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        interaction: {
          type: 3,
          channel_id: channelId,
          response_message_ephemeral: false,
        },
        resource: { type: 4, message: { content: 'Thanks', type: 0 } },
      })
      const messages = await context.app.request(
        `/api/v10/channels/${channelId}/messages`,
        { headers: { Authorization: botAuth } }
      )
      expect(
        ((await messages.json()) as { content: string }[]).map((m) => m.content)
      ).toContain('Thanks')
    })

    it('creates an ephemeral original response for type 4', async () => {
      const interaction = await start()
      const response = await callback(
        interaction,
        { type: 4, data: { content: 'Only you', flags: 64 } },
        '?with_response=true'
      )
      expect(await response.json()).toMatchObject({
        interaction: { response_message_ephemeral: true },
        resource: { message: { flags: 64 } },
      })
      const messages = await context.app.request(
        `/api/v10/channels/${channelId}/messages`,
        { headers: { Authorization: botAuth } }
      )
      expect(
        ((await messages.json()) as { content: string }[]).map((m) => m.content)
      ).not.toContain('Only you')
    })

    it('creates a loading original response for type 5', async () => {
      const interaction = await start()
      const response = await callback(
        interaction,
        { type: 5, data: { flags: 64 } },
        '?with_response=true'
      )
      expect(await response.json()).toMatchObject({
        interaction: {
          response_message_loading: true,
          response_message_ephemeral: true,
        },
      })
      const original = await context.app.request(
        `/api/v10/webhooks/${applicationId}/${interaction.token}/messages/@original`
      )
      expect(await original.json()).toMatchObject({ flags: 64 | 128 })
    })

    it('acknowledges types 6 and 7 without creating a message', async () => {
      for (const type of [6, 7]) {
        const interaction = await start()
        const acknowledged = await callback(interaction, { type })
        expect(acknowledged.status).toBe(204)
        const observed = await context.app.request(
          `/_test/interactions/${interaction.id}/callback?application_id=${applicationId}`,
          { headers: { 'X-Interaction-Token': interaction.token } }
        )
        expect(await observed.json()).toMatchObject({
          responded: true,
          initial_callback_type: type,
        })
      }
      expect(
        context.db
          .prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE author_token = 'interaction'"
          )
          .get()
      ).toEqual({ n: 0 })
    })

    it('observes a modal shown to a click and submits it with the message', async () => {
      const interaction = await start()
      const target = createTestUser(context.db, { username: 'Target' }).id
      const shown = await callback(interaction, {
        type: 9,
        data: buildMuteModalData(target),
      })
      expect(shown.status).toBe(204)
      const observed = await context.app.request(
        `/_test/interactions/${interaction.id}/callback?application_id=${applicationId}`,
        { headers: { 'X-Interaction-Token': interaction.token } }
      )
      expect(await observed.json()).toMatchObject({
        initial_callback_type: 9,
        modal: { custom_id: `user_mute:${target}` },
      })
      const submitted = await context.app.request(
        `/_test/interactions/${interaction.id}/modal-submit`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Interaction-Token': interaction.token,
          },
          body: JSON.stringify({
            application_id: applicationId,
            custom_id: `user_mute:${target}`,
            values: { reason: 'Spam' },
          }),
        }
      )
      expect(submitted.status).toBe(201)
      const submission = (await submitted.json()) as Record<string, unknown>
      expect(submission).toMatchObject({
        type: 5,
        guild_id: guildId,
        member: { user: { id: user } },
        message: { id: messageId, content: 'Appeal your ban' },
      })
    })

    it('does not attach a message to a modal opened from a command', async () => {
      const { db } = context
      createCommand(db, applicationId, null, { name: 'Mute', type: 2 })
      const target = createTestUser(db, { username: 'Target' }).id
      const response = await context.app.request('/_test/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: applicationId,
          command_name: 'Mute',
          target_id: target,
          channel_id: channelId,
          user_id: user,
        }),
      })
      const started = (await response.json()) as Started
      await callback(started, { type: 9, data: buildMuteModalData(target) })
      const submitted = await context.app.request(
        `/_test/interactions/${started.id}/modal-submit`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Interaction-Token': started.token,
          },
          body: JSON.stringify({
            application_id: applicationId,
            custom_id: `user_mute:${target}`,
            values: { reason: 'Spam' },
          }),
        }
      )
      expect(submitted.status).toBe(201)
      expect(await submitted.json()).not.toHaveProperty('message')
    })
  })
})
