import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFullTestApp,
  seedBot,
  seedChannel,
  seedGuild,
  type FullTestContext,
} from '../test-helpers'
import { createCommand } from '../services/application-commands'
import { getOrCreateDmChannel } from '../services/channels'
import { createTestUser } from '../services/test-control'

const applicationId = '111111111111111111'

/** Reads a response body as JSON. */
async function json(response: Response | Promise<Response>): Promise<unknown> {
  const resolved = await response
  return resolved.json()
}

describe('POST /_test/interactions for USER commands', () => {
  let context: FullTestContext
  let botToken: string
  let guildId: string
  let channelId: string
  let caller: string
  let member: string
  let outsider: string

  beforeEach(() => {
    context = createFullTestApp()
    const { db } = context
    botToken = seedBot(db, 'Bot user-command-bot', applicationId)
    guildId = seedGuild(db, botToken)
    channelId = seedChannel(db, guildId)
    caller = createTestUser(db, { username: 'Caller' }).id
    member = createTestUser(db, { username: 'Target', global_name: 'Tar' }).id
    outsider = createTestUser(db, { username: 'Outsider' }).id
    for (const id of [caller, member]) {
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, id)
    }
    createCommand(db, applicationId, guildId, { name: 'Mute', type: 2 })
    createCommand(db, applicationId, null, { name: 'Report', type: 2 })
    createCommand(db, applicationId, null, {
      name: 'Mute',
      type: 1,
      description: 'Slash',
    })
    createCommand(db, applicationId, null, { name: 'Quote', type: 3 })
  })

  afterEach(() => {
    context.cleanup()
  })

  /** Posts a simulated interaction. */
  function simulate(
    body: Record<string, unknown>
  ): Response | Promise<Response> {
    return context.app.request('/_test/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_id: applicationId, ...body }),
    })
  }

  it('sends target_id and resolved users and members for a guild member', async () => {
    const response = await simulate({
      command_name: 'Mute',
      target_id: member,
      guild_id: guildId,
      channel_id: channelId,
      user_id: caller,
      locale: 'pl',
    })
    expect(response.status).toBe(201)
    const interaction = (await response.json()) as Record<string, unknown>
    expect(interaction).toMatchObject({
      type: 2,
      locale: 'pl',
      guild_id: guildId,
      channel_id: channelId,
      member: { user: { id: caller } },
      data: {
        name: 'Mute',
        type: 2,
        target_id: member,
        resolved: {
          users: {
            [member]: { id: member, username: 'Target', global_name: 'Tar' },
          },
          members: { [member]: { roles: [], nick: null, pending: false } },
        },
      },
    })
    const data = interaction.data as {
      id: string
      resolved: { members: Record<string, Record<string, unknown>> }
    }
    expect(data.id).toEqual(expect.any(String))
    expect(data).not.toHaveProperty('options')
    for (const key of ['user', 'deaf', 'mute']) {
      expect(data.resolved.members[member]).not.toHaveProperty(key)
    }
  })

  it('omits resolved members for a user outside the guild or a DM', async () => {
    const outside = (await json(
      simulate({
        command_name: 'Mute',
        target_id: outsider,
        guild_id: guildId,
        channel_id: channelId,
      })
    )) as { data: { resolved: Record<string, unknown> } }
    expect(Object.keys(outside.data.resolved)).toEqual(['users'])

    const dm = getOrCreateDmChannel(context.db, applicationId, member).id
    const response = await simulate({
      command_name: 'Report',
      target_id: member,
      channel_id: dm,
      user_id: caller,
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty('guild_id')
    expect(body).toMatchObject({
      user: { id: caller },
      data: { name: 'Report', type: 2, target_id: member },
    })
    expect(Object.keys((body.data as { resolved: object }).resolved)).toEqual([
      'users',
    ])
  })

  it('falls back to a global USER command and accepts command_type 2', async () => {
    const response = await simulate({
      command_name: 'Report',
      command_type: 2,
      target_id: member,
      guild_id: guildId,
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      data: { name: 'Report', type: 2, target_id: member },
    })
  })

  it('keeps CHAT_INPUT the default and never matches a USER command of the same name', async () => {
    const response = await simulate({ command_name: 'mute', guild_id: guildId })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { data: Record<string, unknown> }
    expect(body.data).toMatchObject({ name: 'mute', type: 1, options: [] })
    expect(body.data).not.toHaveProperty('target_id')
    expect(body.data).not.toHaveProperty('resolved')
  })

  it.each([
    ['a CHAT_INPUT command name', { command_name: 'mute', target_id: '1' }],
    ['a MESSAGE command', { command_name: 'Quote', command_type: 2 }],
    ['an unregistered command', { command_name: 'Nope', command_type: 2 }],
  ])('returns 404 for %s used as a USER command', async (_name, extra) => {
    const response = await simulate({ target_id: member, ...extra })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      message: '404: Not Found',
      code: 0,
    })
  })

  it('returns 404 Unknown User without creating an interaction for a missing target', async () => {
    const response = await simulate({
      command_name: 'Report',
      target_id: '999999999999999999',
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 10_013 })
    expect(
      context.db.prepare('SELECT COUNT(*) FROM interactions').pluck().get()
    ).toBe(0)
  })

  it.each([
    ['a missing target', { command_type: 2 }, 'target_id'],
    ['a non-string target', { target_id: 5 }, 'target_id'],
    ['a malformed target', { target_id: 'abc' }, 'target_id'],
    [
      'a target on a CHAT_INPUT command',
      { command_type: 1, target_id: '1' },
      'target_id',
    ],
    [
      'an unknown command_type',
      { command_type: 7, target_id: '1' },
      'command_type',
    ],
    [
      'a MESSAGE command_type',
      { command_type: 3, target_id: '1' },
      'command_type',
    ],
    ['a non-command interaction type', { target_id: '1', type: 3 }, 'type'],
    [
      'options on a USER command',
      { target_id: '1', options: [{ name: 'a', type: 3, value: 'b' }] },
      'options',
    ],
  ])('returns 400/50035 for %s', async (_name, extra, field) => {
    const response = await simulate({ command_name: 'Report', ...extra })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      code: number
      errors: Record<string, unknown>
    }
    expect(body.code).toBe(50_035)
    expect(Object.keys(body.errors)).toEqual([field])
    expect(
      context.db.prepare('SELECT COUNT(*) FROM interactions').pluck().get()
    ).toBe(0)
  })

  it('returns 400 for a body that is not an object', async () => {
    const response = await context.app.request('/_test/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 50_035 })
  })

  it('keeps the guild and channel gating', async () => {
    const unknownGuild = await simulate({
      command_name: 'Mute',
      target_id: member,
      guild_id: '555555555555555555',
    })
    expect(unknownGuild.status).toBe(404)
    expect(await unknownGuild.json()).toMatchObject({ code: 10_004 })
    const unknownChannel = await simulate({
      command_name: 'Report',
      target_id: member,
      channel_id: '555555555555555555',
    })
    expect(unknownChannel.status).toBe(404)
    expect(await unknownChannel.json()).toMatchObject({ code: 10_003 })

    context.db
      .prepare('UPDATE guilds SET bot_present = 0 WHERE id = ?')
      .run(guildId)
    const removed = await simulate({
      command_name: 'Mute',
      target_id: member,
      guild_id: guildId,
    })
    expect(removed.status).toBe(404)
    expect(await removed.json()).toMatchObject({ code: 10_004 })
  })

  it('answers with a context-menu response message', async () => {
    const created = (await json(
      simulate({
        command_name: 'Mute',
        target_id: member,
        guild_id: guildId,
        channel_id: channelId,
        user_id: caller,
      })
    )) as { id: string; token: string }
    const callback = await context.app.request(
      `/api/v10/interactions/${created.id}/${created.token}/callback?with_response=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 4,
          data: { content: 'Muted', flags: 64 },
        }),
      }
    )
    expect(callback.status).toBe(200)
    expect(await callback.json()).toMatchObject({
      interaction: { response_message_ephemeral: true },
      resource: {
        message: {
          type: 23,
          content: 'Muted',
          interaction: { id: created.id, type: 2, name: 'Mute' },
        },
      },
    })
  })
})
