import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
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

/** A started interaction. */
interface Started {
  id: string
  token: string
  type: number
  data?: Record<string, unknown>
}

/** Focused option nested in a subcommand group's subcommand. */
const nestedOptions = [
  {
    name: 'admin',
    type: 2,
    options: [
      {
        name: 'lookup',
        type: 1,
        options: [
          { name: 'reason', type: 3, value: 'spam' },
          { name: 'count', type: 4, value: '1', focused: true },
        ],
      },
    ],
  },
]

describe('autocomplete interactions', () => {
  let context: FullTestContext
  let guildId: string
  let channelId: string
  let caller: string

  beforeEach(() => {
    context = createFullTestApp()
    const { db } = context
    const botToken = seedBot(db, 'Bot autocomplete-bot', applicationId)
    guildId = seedGuild(db, botToken)
    channelId = seedChannel(db, guildId)
    caller = createTestUser(db, { username: 'Caller' }).id
    db.prepare(
      'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
    ).run(guildId, caller)
    createCommand(db, applicationId, guildId, {
      name: 'search',
      description: 'Search',
    })
    createCommand(db, applicationId, guildId, { name: 'Mute', type: 2 })
  })

  afterEach(() => {
    context.cleanup()
  })

  /** Posts to `/_test/interactions`. */
  function create(
    extra: Record<string, unknown>
  ): Response | Promise<Response> {
    return context.app.request('/_test/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_id: applicationId,
        command_name: 'search',
        guild_id: guildId,
        channel_id: channelId,
        user_id: caller,
        ...extra,
      }),
    })
  }

  /** Starts an autocomplete interaction with a focused option. */
  async function startAutocomplete(
    options: unknown = [{ name: 'query', type: 3, value: 'ab', focused: true }]
  ): Promise<Started> {
    const response = await create({ type: 4, options })
    expect(response.status).toBe(201)
    return (await response.json()) as Started
  }

  /** Starts an ordinary command interaction. */
  async function startCommand(): Promise<Started> {
    const response = await create({
      options: [{ name: 'query', type: 3, value: 'ab' }],
    })
    expect(response.status).toBe(201)
    return (await response.json()) as Started
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
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }
    )
  }

  /** Reads the callback observation as JSON. */
  async function observe(
    interaction: Started
  ): Promise<Record<string, unknown>> {
    const response = await context.app.request(
      `/_test/interactions/${interaction.id}/callback?application_id=${applicationId}`,
      { headers: { 'X-Interaction-Token': interaction.token } }
    )
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }

  /** Reads one field of the callback observation. */
  async function observedField(
    interaction: Started,
    field: string
  ): Promise<unknown> {
    const observation = await observe(interaction)
    return observation[field]
  }

  /** Counts the messages in the interaction's channel. */
  function messageCount(): number {
    return (
      context.db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?')
        .get(channelId) as { n: number }
    ).n
  }

  describe('POST /_test/interactions with type 4', () => {
    it('creates an autocomplete interaction echoing the focused option', async () => {
      const options = [{ name: 'query', type: 3, value: 'ab', focused: true }]
      const interaction = await startAutocomplete(options)
      expect(interaction).toMatchObject({
        type: 4,
        application_id: applicationId,
        guild_id: guildId,
        channel_id: channelId,
        locale: 'en-US',
        member: { user: { id: caller } },
        data: { name: 'search', type: 1, options },
      })
    })

    it('echoes a focused option nested in a subcommand group', async () => {
      const interaction = await startAutocomplete(nestedOptions)
      expect(interaction.data).toMatchObject({ options: nestedOptions })
    })

    it('accepts a string value for a focused option of any type', async () => {
      const interaction = await startAutocomplete([
        { name: 'count', type: 10, value: '3.', focused: true },
      ])
      expect(interaction.data).toMatchObject({
        options: [{ name: 'count', type: 10, value: '3.', focused: true }],
      })
    })

    it('accepts a focused option without a value yet', async () => {
      expect(
        await statusOf(
          create({
            type: 4,
            options: [{ name: 'q', type: 3, focused: true }],
          })
        )
      ).toBe(201)
    })

    it('dispatches INTERACTION_CREATE to the application', async () => {
      const events: Record<string, unknown>[] = []
      const { gatewayBus } = await import('../gateway/bus')
      const listener = (event: {
        interaction: Record<string, unknown>
      }): void => {
        events.push(event.interaction)
      }
      gatewayBus.on('interaction.create', listener)
      try {
        const interaction = await startAutocomplete()
        expect(events).toEqual([
          expect.objectContaining({ id: interaction.id, type: 4 }),
        ])
      } finally {
        gatewayBus.off('interaction.create', listener)
      }
    })

    it.each([
      ['no options', undefined],
      ['empty options', []],
      [
        'options without a focused one',
        [{ name: 'query', type: 3, value: 'a' }],
      ],
      [
        'two focused options',
        [
          { name: 'a', type: 3, value: 'x', focused: true },
          { name: 'b', type: 3, value: 'y', focused: true },
        ],
      ],
      [
        'two focused options at different depths',
        [
          { name: 'a', type: 3, value: 'x', focused: true },
          {
            name: 'sub',
            type: 1,
            options: [{ name: 'b', type: 3, value: 'y', focused: true }],
          },
        ],
      ],
      ['focused: false', [{ name: 'a', type: 3, value: 'x', focused: false }]],
    ])('refuses type 4 with %s', async (_name, options) => {
      const response = await create({ type: 4, options })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 50_035,
        errors: { options: { _errors: [{ code: 'BASE_TYPE_BAD_VALUE' }] } },
      })
    })

    it.each([
      ['top level', [{ name: 'a', type: 3, value: 'x', focused: true }]],
      ['nested', nestedOptions],
    ])(
      'refuses a focused option (%s) on a type 2 request',
      async (_name, options) => {
        for (const extra of [{ options }, { type: 2, options }]) {
          const response = await create(extra)
          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            errors: { options: { _errors: [{ code: 'BASE_TYPE_BAD_VALUE' }] } },
          })
        }
      }
    )

    it('refuses a non-string focused value, a non-list and a non-object option', async () => {
      const bad = await create({
        type: 4,
        options: [{ name: 'n', type: 4, value: 3, focused: true }],
      })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({
        errors: {
          'options.0.value': { _errors: [{ code: 'BASE_TYPE_BAD_TYPE' }] },
        },
      })
      const notList = await create({ type: 4, options: { focused: true } })
      expect(notList.status).toBe(400)
      expect(await notList.json()).toMatchObject({
        errors: { options: { _errors: [{ code: 'BASE_TYPE_BAD_TYPE' }] } },
      })
      const notObject = await create({ type: 4, options: ['x'] })
      expect(notObject.status).toBe(400)
      expect(await notObject.json()).toMatchObject({
        errors: { 'options.0': { _errors: [{ code: 'BASE_TYPE_BAD_TYPE' }] } },
      })
    })

    it('does not create an interaction for a refused request', async () => {
      await create({ type: 4 })
      const count = context.db
        .prepare('SELECT COUNT(*) AS n FROM interactions')
        .get() as { n: number }
      expect(count.n).toBe(0)
    })

    it('still refuses type 4 for a USER command', async () => {
      const response = await create({
        type: 4,
        command_name: 'Mute',
        target_id: caller,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        errors: { type: { _errors: [{ code: 'BASE_TYPE_BAD_VALUE' }] } },
      })
    })

    it('returns 404 for an unknown command', async () => {
      const response = await create({
        type: 4,
        command_name: 'missing',
        options: [{ name: 'q', type: 3, value: '', focused: true }],
      })
      expect(response.status).toBe(404)
    })
  })

  describe('autocomplete result callback (type 8)', () => {
    const choices = [
      { name: 'Alpha', value: 'alpha' },
      { name: 'One', value: 1 },
      { name: 'Half', value: 0.5 },
      {
        name: 'Beta',
        value: 'b'.repeat(100),
        name_localizations: { pl: 'Bêta', 'en-GB': 'Beta' },
      },
    ]

    it('stores the choices and exposes them through observation', async () => {
      const interaction = await startAutocomplete()
      const response = await callback(interaction, {
        type: 8,
        data: { choices },
      })
      expect(response.status).toBe(204)
      expect(await observe(interaction)).toEqual({
        interaction_id: interaction.id,
        application_id: applicationId,
        responded: true,
        initial_callback_type: 8,
        choices,
      })
      expect(messageCount()).toBe(0)
    })

    it('normalizes null localizations and drops unknown choice fields', async () => {
      const interaction = await startAutocomplete()
      await callback(interaction, {
        type: 8,
        data: {
          choices: [
            { name: 'A', value: 'a', name_localizations: null, extra: 1 },
          ],
        },
      })
      expect(await observedField(interaction, 'choices')).toEqual([
        { name: 'A', value: 'a' },
      ])
    })

    it('accepts exactly 25 choices and a 100-character name', async () => {
      const interaction = await startAutocomplete()
      const many = Array.from({ length: 25 }, (_, index) => ({
        name: 'n'.repeat(index === 0 ? 100 : 1),
        value: index,
      }))
      expect(
        await statusOf(
          callback(interaction, { type: 8, data: { choices: many } })
        )
      ).toBe(204)
      expect(await observedField(interaction, 'choices')).toHaveLength(25)
    })

    it.each([
      ['an empty choices array', { type: 8, data: { choices: [] } }],
      ['no choices key', { type: 8, data: {} }],
      ['no data', { type: 8 }],
      ['null data', { type: 8, data: null }],
      ['null choices', { type: 8, data: { choices: null } }],
    ])('records an empty result for %s', async (_name, body) => {
      const interaction = await startAutocomplete()
      expect(await statusOf(callback(interaction, body))).toBe(204)
      expect(await observe(interaction)).toEqual({
        interaction_id: interaction.id,
        application_id: applicationId,
        responded: true,
        initial_callback_type: 8,
        choices: [],
      })
    })

    it('accepts the DiscordGo empty result and ignores its message fields', async () => {
      const interaction = await startAutocomplete()
      const response = await callback(
        interaction,
        '{"type":8,"data":{"tts":false,"content":"","components":null,"embeds":null}}'
      )
      expect(response.status).toBe(204)
      expect(await observedField(interaction, 'choices')).toEqual([])
      expect(messageCount()).toBe(0)
    })

    it('ignores message fields sent next to choices', async () => {
      const interaction = await startAutocomplete()
      const response = await callback(interaction, {
        type: 8,
        data: {
          content: 'ignored',
          tts: true,
          flags: 64,
          choices: [{ name: 'A', value: 'a' }],
        },
      })
      expect(response.status).toBe(204)
      expect(await observedField(interaction, 'choices')).toEqual([
        { name: 'A', value: 'a' },
      ])
      expect(messageCount()).toBe(0)
    })

    it('returns only the interaction for with_response=true', async () => {
      const interaction = await startAutocomplete()
      const response = await callback(
        interaction,
        { type: 8, data: { choices: [{ name: 'A', value: 'a' }] } },
        '?with_response=true'
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as Record<string, unknown>
      expect(body).toEqual({
        interaction: {
          id: interaction.id,
          type: 4,
          channel_id: channelId,
          guild_id: guildId,
        },
      })
      expect(body).not.toHaveProperty('resource')
    })

    it('refuses a second callback with 40060', async () => {
      const interaction = await startAutocomplete()
      await callback(interaction, { type: 8 })
      const response = await callback(interaction, { type: 8 })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 40_060 })
    })

    it.each([
      ['not a list', { choices: 'x' }, 'data.choices', 'BASE_TYPE_BAD_TYPE'],
      [
        'more than 25',
        {
          choices: Array.from({ length: 26 }, (_, i) => ({
            name: 'n',
            value: i,
          })),
        },
        'data.choices',
        'BASE_TYPE_MAX_LENGTH',
      ],
      [
        'not an object',
        { choices: ['x'] },
        'data.choices.0',
        'BASE_TYPE_BAD_TYPE',
      ],
      [
        'no name',
        { choices: [{ value: 'a' }] },
        'data.choices.0.name',
        'BASE_TYPE_REQUIRED',
      ],
      [
        'numeric name',
        { choices: [{ name: 1, value: 'a' }] },
        'data.choices.0.name',
        'BASE_TYPE_BAD_TYPE',
      ],
      [
        'empty name',
        { choices: [{ name: '', value: 'a' }] },
        'data.choices.0.name',
        'BASE_TYPE_BAD_LENGTH',
      ],
      [
        'long name',
        { choices: [{ name: 'n'.repeat(101), value: 'a' }] },
        'data.choices.0.name',
        'BASE_TYPE_BAD_LENGTH',
      ],
      [
        'no value',
        { choices: [{ name: 'a' }] },
        'data.choices.0.value',
        'BASE_TYPE_REQUIRED',
      ],
      [
        'long value',
        { choices: [{ name: 'a', value: 'v'.repeat(101) }] },
        'data.choices.0.value',
        'BASE_TYPE_MAX_LENGTH',
      ],
      [
        'boolean value',
        { choices: [{ name: 'a', value: true }] },
        'data.choices.0.value',
        'BASE_TYPE_BAD_TYPE',
      ],
      [
        'second choice invalid',
        {
          choices: [
            { name: 'a', value: 'a' },
            { name: '', value: 'b' },
          ],
        },
        'data.choices.1.name',
        'BASE_TYPE_BAD_LENGTH',
      ],
      [
        'bad localization type',
        { choices: [{ name: 'a', value: 'a', name_localizations: [] }] },
        'data.choices.0.name_localizations',
        'BASE_TYPE_BAD_TYPE',
      ],
      [
        'unknown locale',
        {
          choices: [{ name: 'a', value: 'a', name_localizations: { xx: 'a' } }],
        },
        'data.choices.0.name_localizations.xx',
        'BASE_TYPE_CHOICES',
      ],
      [
        'empty localized name',
        {
          choices: [{ name: 'a', value: 'a', name_localizations: { pl: '' } }],
        },
        'data.choices.0.name_localizations.pl',
        'BASE_TYPE_BAD_LENGTH',
      ],
    ])(
      'refuses choices that are %s without acknowledging',
      async (_name, data, path, code) => {
        const interaction = await startAutocomplete()
        const response = await callback(interaction, { type: 8, data })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          code: 50_035,
          errors: { [path]: { _errors: [{ code }] } },
        })
        expect(await observe(interaction)).toEqual({
          interaction_id: interaction.id,
          application_id: applicationId,
          responded: false,
          initial_callback_type: null,
        })
        // The bot can still answer correctly afterwards.
        expect(await statusOf(callback(interaction, { type: 8 }))).toBe(204)
      }
    )

    it('reports every invalid choice at once', async () => {
      const interaction = await startAutocomplete()
      const response = await callback(interaction, {
        type: 8,
        data: { choices: [{ name: '', value: 'a' }, { name: 'b' }] },
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as {
        errors: Record<string, unknown>
      }
      expect(
        Object.keys(body.errors).toSorted((a, b) => a.localeCompare(b))
      ).toEqual(['data.choices.0.name', 'data.choices.1.value'])
    })

    it('counts Unicode code points, not UTF-16 units, for text limits', async () => {
      const interaction = await startAutocomplete()
      const emoji = (count: number): string => '😀'.repeat(count)
      const accepted = await callback(interaction, {
        type: 8,
        data: {
          choices: [
            {
              name: emoji(100),
              value: emoji(100),
              name_localizations: { pl: emoji(100) },
            },
          ],
        },
      })
      expect(accepted.status).toBe(204)
      const other = await startAutocomplete()
      const refused = await callback(other, {
        type: 8,
        data: {
          choices: [
            {
              name: emoji(101),
              value: emoji(101),
              name_localizations: { pl: emoji(101) },
            },
          ],
        },
      })
      expect(refused.status).toBe(400)
      const body = (await refused.json()) as { errors: Record<string, unknown> }
      expect(
        Object.keys(body.errors).toSorted((a, b) => a.localeCompare(b))
      ).toEqual([
        'data.choices.0.name',
        'data.choices.0.name_localizations.pl',
        'data.choices.0.value',
      ])
    })

    it('refuses non-object data', async () => {
      const interaction = await startAutocomplete()
      const response = await callback(interaction, { type: 8, data: [] })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        errors: { data: { _errors: [{ code: 'BASE_TYPE_BAD_TYPE' }] } },
      })
    })

    it('does not expose choices for other callback types', async () => {
      const command = await startCommand()
      expect(
        await statusOf(callback(command, { type: 4, data: { content: 'hi' } }))
      ).toBe(204)
      expect(await observe(command)).not.toHaveProperty('choices')
    })
  })

  describe('callback types refused for the interaction type', () => {
    const message = {
      type: 4,
      data: { content: 'Not allowed' },
    }

    it.each([
      [4, message],
      [5, { type: 5 }],
      [6, { type: 6 }],
      [7, { type: 7, data: { content: 'x' } }],
      [
        9,
        {
          type: 9,
          data: {
            custom_id: 'a',
            title: 'T',
            components: [{ type: 10, content: 'Sure?' }],
          },
        },
      ],
      [1, { type: 1 }],
    ])(
      'refuses callback type %i for an autocomplete interaction without acknowledging it',
      async (type, body) => {
        const interaction = await startAutocomplete()
        const response = await callback(interaction, body)
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          code: 50_035,
          errors: {
            type: {
              _errors: [
                {
                  code: 'BASE_TYPE_CHOICES',
                  message: expect.stringContaining('autocomplete result'),
                },
              ],
            },
          },
        })
        expect(messageCount()).toBe(0)
        expect(await observe(interaction)).toEqual({
          interaction_id: interaction.id,
          application_id: applicationId,
          responded: false,
          initial_callback_type: null,
          rejected_callback_type: type,
        })
        expect(
          context.db
            .prepare('SELECT responded FROM interactions WHERE id = ?')
            .get(interaction.id)
        ).toEqual({ responded: 0 })
      }
    )

    it('lets the bot answer correctly after a refusal', async () => {
      const interaction = await startAutocomplete()
      expect(await statusOf(callback(interaction, message))).toBe(400)
      expect(
        await statusOf(
          callback(interaction, {
            type: 8,
            data: { choices: [{ name: 'A', value: 'a' }] },
          })
        )
      ).toBe(204)
      expect(await observe(interaction)).toEqual({
        interaction_id: interaction.id,
        application_id: applicationId,
        responded: true,
        initial_callback_type: 8,
        choices: [{ name: 'A', value: 'a' }],
        // The last refusal stays on record next to the accepted callback.
        rejected_callback_type: 4,
      })
    })

    it('records the latest refusal', async () => {
      const interaction = await startAutocomplete()
      await callback(interaction, message)
      await callback(interaction, { type: 5 })
      expect(await observedField(interaction, 'rejected_callback_type')).toBe(5)
    })

    it.each([
      ['an application command', startCommand],
      [
        'a message component',
        async (): Promise<Started> => {
          const sentResponse = await context.app.request(
            `/api/v10/channels/${channelId}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: 'Bot autocomplete-bot',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                content: 'Click',
                components: [
                  {
                    type: 1,
                    components: [
                      { type: 2, style: 1, label: 'Go', custom_id: 'go' },
                    ],
                  },
                ],
              }),
            }
          )
          const sent = (await sentResponse.json()) as { id: string }
          const response = await context.app.request('/_test/interactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 3,
              application_id: applicationId,
              guild_id: guildId,
              channel_id: channelId,
              message_id: sent.id,
              custom_id: 'go',
              user_id: caller,
            }),
          })
          expect(response.status).toBe(201)
          return (await response.json()) as Started
        },
      ],
    ])('refuses an autocomplete result for %s', async (_name, start) => {
      const interaction = await start()
      const response = await callback(interaction, {
        type: 8,
        data: { choices: [{ name: 'A', value: 'a' }] },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 50_035,
        errors: {
          type: {
            _errors: [
              {
                code: 'BASE_TYPE_CHOICES',
                message:
                  'An autocomplete result can only answer an autocomplete interaction.',
              },
            ],
          },
        },
      })
      expect(await observe(interaction)).toEqual({
        interaction_id: interaction.id,
        application_id: applicationId,
        responded: false,
        initial_callback_type: null,
        rejected_callback_type: 8,
      })
      // A normal answer still works.
      expect(await statusOf(callback(interaction, message))).toBe(204)
    })

    it('keeps refusing a modal for an interaction that cannot open one', async () => {
      const { db } = context
      db.prepare(
        'INSERT INTO interactions (id, application_id, token, type, user_id) VALUES (?, ?, ?, 1, ?)'
      ).run('ping-1', applicationId, 'ping-token', caller)
      const ping: Started = { id: 'ping-1', token: 'ping-token', type: 1 }
      const response = await callback(ping, {
        type: 9,
        data: {
          custom_id: 'a',
          title: 'T',
          components: [{ type: 10, content: 'Sure?' }],
        },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        errors: {
          type: {
            _errors: [
              {
                code: 'BASE_TYPE_CHOICES',
                message:
                  'A modal can only answer an application command or message component interaction.',
              },
            ],
          },
        },
      })
      expect(await observe(ping)).toMatchObject({
        responded: false,
        rejected_callback_type: 9,
      })
    })

    it('does not record a refusal for an acknowledged interaction', async () => {
      const command = await startCommand()
      await callback(command, message)
      const response = await callback(command, {
        type: 8,
        data: { choices: [] },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 40_060 })
      expect(await observe(command)).not.toHaveProperty(
        'rejected_callback_type'
      )
    })

    it('does not record payload validation failures or unknown tokens', async () => {
      const interaction = await startAutocomplete()
      expect(
        await statusOf(callback(interaction, { type: 4, data: { content: 5 } }))
      ).toBe(400)
      expect(await statusOf(callback(interaction, { type: 99 }))).toBe(400)
      expect(
        await statusOf(
          callback({ ...interaction, token: 'wrong' }, { type: 4 })
        )
      ).toBe(404)
      expect(await observe(interaction)).toEqual({
        interaction_id: interaction.id,
        application_id: applicationId,
        responded: false,
        initial_callback_type: null,
      })
    })

    it('omits rejected_callback_type for an untouched interaction', async () => {
      const interaction = await startAutocomplete()
      expect(await observe(interaction)).not.toHaveProperty(
        'rejected_callback_type'
      )
    })
  })
})
