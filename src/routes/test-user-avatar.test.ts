import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase } from '../db'
import { createFullTestApp, seedBot, seedGuild } from '../test-helpers'
import type { GuildMemberObject } from '../services/guild-members'

const userId = '555555555555555555'
const token = 'Bot avatar-fixture'

describe('Human fixture avatars in native REST responses', () => {
  let context: ReturnType<typeof createFullTestApp>
  let guildId: string

  beforeEach(() => {
    context = createFullTestApp()
    guildId = seedGuild(context.db, seedBot(context.db, token))
  })

  afterEach(() => {
    closeDatabase(context.db)
  })

  it.each(['0123456789abcdef0123456789abcdef', null, undefined])(
    'exposes avatar=%s in user GET and member GET/list under every API prefix',
    async (avatar) => {
      const registration = await context.app.request('/_test/users', {
        method: 'POST',
        body: JSON.stringify({ id: userId, username: 'Human', avatar }),
      })
      expect(registration.status).toBe(201)
      const join = await context.app.request(
        `/_test/guilds/${guildId}/members/${userId}`,
        { method: 'POST' }
      )
      expect(join.status).toBe(201)
      const expectedUser = { id: userId, avatar: avatar ?? null, bot: false }
      const expectedMember = { avatar: null, user: expectedUser }
      expect(await join.json()).toMatchObject(expectedMember)

      for (const prefix of ['/api/v10', '/api', '']) {
        const headers = { Authorization: token }
        const user = await context.app.request(`${prefix}/users/${userId}`, {
          headers,
        })
        expect(user.status).toBe(200)
        expect(await user.json()).toMatchObject(expectedUser)
        const member = await context.app.request(
          `${prefix}/guilds/${guildId}/members/${userId}`,
          { headers }
        )
        expect(member.status).toBe(200)
        expect(await member.json()).toMatchObject(expectedMember)
        const list = await context.app.request(
          `${prefix}/guilds/${guildId}/members?limit=100`,
          { headers }
        )
        expect(list.status).toBe(200)
        const members = (await list.json()) as GuildMemberObject[]
        expect(members.find((m) => m.user.id === userId)).toMatchObject(
          expectedMember
        )
      }
    }
  )
})
