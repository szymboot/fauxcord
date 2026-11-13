import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  buildMuteModalData,
  createTestGatewayServer,
  seedBot,
  seedChannel,
  seedGuild,
} from '../test-helpers'
import type { Database } from '../db'
import { createCommand } from '../services/application-commands'
import { getOrCreateDmChannel } from '../services/channels'
import { ALL_PERMISSIONS } from '../services/guild-permissions'
import { createTestUser } from '../services/test-control'
import { GatewayOp } from './opcodes'

const applicationId = '111111111111111111'
const botToken = 'Bot interaction-permissions'

/** VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY. */
const EVERYONE = (1n << 10n) | (1n << 11n) | (1n << 16n)
/** MANAGE_MESSAGES, granted to the bot through an extra role. */
const MANAGE_MESSAGES = 1n << 13n

/** Gateway dispatch frame as received by a bot. */
interface Frame {
  t?: string
  d: Record<string, unknown>
}

describe('member.permissions and app_permissions in dispatched interactions', () => {
  let db: Database
  let httpUrl: string
  let guildId: string
  let channelId: string
  let caller: string
  let owner: string
  let target: string
  let close: (() => Promise<void>) | undefined
  let received: Frame[]
  const sockets: WebSocket[] = []

  /** Sends JSON over HTTP and returns the response. */
  function post(
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

  /** Waits until the bot has received the INTERACTION_CREATE with this ID. */
  async function dispatched(id: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const frame = received.find(
        (f) => f.t === 'INTERACTION_CREATE' && f.d.id === id
      )
      if (frame) return frame.d
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`INTERACTION_CREATE ${id} was not dispatched`)
  }

  /**
   * Creates an interaction over HTTP and returns the HTTP response body after
   * checking that the Gateway dispatched the identical payload.
   */
  async function create(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<Record<string, unknown>> {
    const response = await post(path, body, headers)
    expect(response.status).toBe(201)
    const interaction = (await response.json()) as Record<string, unknown>
    expect(await dispatched(String(interaction.id))).toEqual(interaction)
    return interaction
  }

  /** Sends a bot message with one button in a channel. */
  async function sendButtonMessage(channel: string): Promise<string> {
    const response = await post(
      `/api/v10/channels/${channel}/messages`,
      {
        content: 'Pick',
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 1, label: 'Go', custom_id: 'go' }],
          },
        ],
      },
      { Authorization: botToken }
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { id: string }).id
  }

  /** Answers an interaction with the mute modal, as the bot would. */
  async function showModal(interaction: Record<string, unknown>) {
    const response = await post(
      `/api/v10/interactions/${String(interaction.id)}/${String(interaction.token)}/callback`,
      { type: 9, data: buildMuteModalData(target) }
    )
    expect(response.status).toBe(204)
  }

  /** Submits the shown mute modal. */
  function submitModal(
    interaction: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return create(
      `/_test/interactions/${String(interaction.id)}/modal-submit`,
      {
        application_id: applicationId,
        custom_id: `user_mute:${target}`,
        values: { reason: 'Spam', visibility: ['private'] },
      },
      { 'X-Interaction-Token': String(interaction.token) }
    )
  }

  /** Expects the caller's and bot's permissions in a guild interaction. */
  function expectGuildPermissions(
    interaction: Record<string, unknown>,
    memberPermissions = EVERYONE
  ): void {
    expect(interaction).toMatchObject({
      guild_id: guildId,
      member: { permissions: memberPermissions.toString() },
      app_permissions: (EVERYONE | MANAGE_MESSAGES).toString(),
    })
  }

  beforeEach(async () => {
    const server = await createTestGatewayServer()
    db = server.db
    close = server.close
    httpUrl = server.url.replace('ws://', 'http://')
    seedBot(db, botToken, applicationId)
    guildId = seedGuild(db, botToken)
    channelId = seedChannel(db, guildId)
    caller = createTestUser(db, { username: 'Caller' }).id
    owner = createTestUser(db, { username: 'Owner' }).id
    target = createTestUser(db, { username: 'Target' }).id
    db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(
      owner,
      guildId
    )
    const insertRole = db.prepare(
      'INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES (?, ?, ?, 0, 0, ?, ?, 0)'
    )
    insertRole.run(guildId, guildId, '@everyone', 0, EVERYONE.toString())
    insertRole.run('900000000000000001', guildId, 'Bot', 1, '8192')
    for (const id of [applicationId, caller, owner, target]) {
      db.prepare(
        'INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)'
      ).run(guildId, id)
    }
    db.prepare(
      'INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)'
    ).run(guildId, applicationId, '900000000000000001')
    createCommand(db, applicationId, guildId, {
      name: 'config',
      description: 'Configure',
      options: [
        {
          name: 'query',
          description: 'Query',
          type: 3,
        },
      ],
    })
    createCommand(db, applicationId, guildId, { name: 'Mute', type: 2 })

    const ws = new WebSocket(server.url)
    sockets.push(ws)
    await new Promise((resolve) => ws.once('message', resolve))
    ws.send(
      JSON.stringify({
        op: GatewayOp.Identify,
        d: { token: botToken, intents: 0 },
      })
    )
    await new Promise((resolve) => ws.once('message', resolve))
    received = []
    ws.on('message', (raw: Buffer) => {
      received.push(JSON.parse(raw.toString()) as Frame)
    })
  })

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate()
    await close?.()
    close = undefined
  })

  it('carries both fields in a chat input command', async () => {
    const interaction = await create('/_test/interactions', {
      application_id: applicationId,
      command_name: 'config',
      guild_id: guildId,
      channel_id: channelId,
      user_id: caller,
    })
    expect(interaction.type).toBe(2)
    expectGuildPermissions(interaction)
  })

  it('sends every permission for the guild owner invoking a command', async () => {
    const interaction = await create('/_test/interactions', {
      application_id: applicationId,
      command_name: 'config',
      guild_id: guildId,
      channel_id: channelId,
      user_id: owner,
    })
    expectGuildPermissions(interaction, ALL_PERMISSIONS)
  })

  it('carries both fields in a user context command and its modal submission', async () => {
    const command = await create('/_test/interactions', {
      application_id: applicationId,
      command_name: 'Mute',
      target_id: target,
      guild_id: guildId,
      channel_id: channelId,
      user_id: caller,
    })
    expect(command.data).toMatchObject({ type: 2, target_id: target })
    expectGuildPermissions(command)

    await showModal(command)
    const submission = await submitModal(command)
    expect(submission.type).toBe(5)
    expectGuildPermissions(submission)
  })

  it('carries both fields in an autocomplete interaction', async () => {
    const interaction = await create('/_test/interactions', {
      application_id: applicationId,
      command_name: 'config',
      type: 4,
      guild_id: guildId,
      channel_id: channelId,
      user_id: caller,
      options: [{ name: 'query', type: 3, value: 'ab', focused: true }],
    })
    expect(interaction.type).toBe(4)
    expectGuildPermissions(interaction)
  })

  it('carries both fields in a component click and its modal submission', async () => {
    const messageId = await sendButtonMessage(channelId)
    const click = await create('/_test/interactions', {
      application_id: applicationId,
      type: 3,
      channel_id: channelId,
      message_id: messageId,
      custom_id: 'go',
      user_id: caller,
    })
    expect(click.type).toBe(3)
    expectGuildPermissions(click)

    await showModal(click)
    const submission = await submitModal(click)
    expect(submission).toMatchObject({ type: 5, message: { id: messageId } })
    expectGuildPermissions(submission)
  })

  it('reflects a channel overwrite for the member and the bot', async () => {
    db.prepare(
      'INSERT INTO channel_overwrites (channel_id, id, type, allow, deny) VALUES (?, ?, 1, ?, ?), (?, ?, 1, ?, ?)'
    ).run(
      channelId,
      caller,
      '0',
      (1n << 11n).toString(),
      channelId,
      applicationId,
      '0',
      (1n << 10n).toString()
    )
    const interaction = await create('/_test/interactions', {
      application_id: applicationId,
      command_name: 'config',
      guild_id: guildId,
      channel_id: channelId,
      user_id: caller,
    })
    expect(interaction).toMatchObject({
      member: { permissions: (EVERYONE & ~(1n << 11n)).toString() },
      app_permissions: ((EVERYONE | MANAGE_MESSAGES) & ~(1n << 10n)).toString(),
    })
  })

  it('inherits the parent channel overwrites in a thread', async () => {
    const threadId = '900000000000000010'
    db.prepare(
      'INSERT INTO channels (id, guild_id, name, type, parent_id) VALUES (?, ?, ?, 11, ?)'
    ).run(threadId, guildId, 'thread', channelId)
    db.prepare(
      'INSERT INTO channel_overwrites (channel_id, id, type, allow, deny) VALUES (?, ?, 0, ?, ?)'
    ).run(channelId, guildId, '0', (1n << 11n).toString())
    const interaction = await create('/_test/interactions', {
      application_id: applicationId,
      command_name: 'config',
      guild_id: guildId,
      channel_id: threadId,
      user_id: caller,
    })
    expect(interaction).toMatchObject({
      channel_id: threadId,
      member: { permissions: (EVERYONE & ~(1n << 11n)).toString() },
      app_permissions: ((EVERYONE | MANAGE_MESSAGES) & ~(1n << 11n)).toString(),
    })
  })

  it('sends no member and the bot DM app_permissions for a DM component click', async () => {
    const dm = getOrCreateDmChannel(db, applicationId, caller).id
    const messageId = await sendButtonMessage(dm)
    const click = await create('/_test/interactions', {
      application_id: applicationId,
      type: 3,
      channel_id: dm,
      message_id: messageId,
      custom_id: 'go',
      user_id: caller,
    })
    expect(click.member).toBeUndefined()
    expect(click).toMatchObject({
      user: { id: caller },
      // ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE | USE_EXTERNAL_EMOJIS
      app_permissions: '442368',
    })
  })
})
