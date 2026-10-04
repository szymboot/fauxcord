import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('member join timestamps on non-UTC hosts', () => {
  it('preserves known UTC instants in REST, OAuth and initial Gateway members', () => {
    // A separate process owns TZ; parallel tests keep their own timezone.
    const script = `
      import { createFullTestApp, seedBot, seedGuild, seedMember, seedBearerCredential } from './src/test-helpers.ts'
      import { buildGuildCreatePayload } from './src/services/guilds.ts'
      const context = createFullTestApp()
      try {
        const token = seedBot(context.db)
        const guild = seedGuild(context.db, token)
        const user = seedMember(context.db, guild)
        const credential = seedBearerCredential(context.db, user)
        context.db.prepare("UPDATE oauth2_access_tokens SET scope = 'guilds.members.read' WHERE token = ?").run(credential.bearerToken)
        /** Reads the joined_at field from every native member read surface. */
        async function read() {
          const dates = []
          const statuses = []
          for (const prefix of ['', '/api', '/api/v10']) {
            const member = await context.app.request(prefix + '/guilds/' + guild + '/members/' + user, { headers: { Authorization: token } })
            statuses.push(member.status)
            dates.push((await member.json()).joined_at)
            const list = await context.app.request(prefix + '/guilds/' + guild + '/members?limit=100', { headers: { Authorization: token } })
            statuses.push(list.status)
            dates.push((await list.json()).find(m => m.user.id === user).joined_at)
            const oauth = await context.app.request(prefix + '/users/@me/guilds/' + guild + '/member', { headers: { Authorization: 'Bearer ' + credential.bearerToken } })
            statuses.push(oauth.status)
            dates.push((await oauth.json()).joined_at)
          }
          dates.push(buildGuildCreatePayload(context.db, guild).members.find(m => m.user.id === user).joined_at)
          return { dates, statuses }
        }
        const results = []
        for (const date of ['2020-02-29 12:34:56', '2020-07-01 12:34:56.123']) {
          context.db.prepare('UPDATE guild_members SET joined_at = ? WHERE guild_id = ? AND user_id = ?').run(date, guild, user)
          results.push(await read())
        }
        for (const date of ['2020-02-29T14:34:56.123+02:00', '2020-02-29T12:34:56.123000+00:00', '2020-02-29T12:34:56.123Z']) {
          const fixture = await context.app.request('/_test/guilds/' + guild + '/members/' + user, { method: 'PATCH', body: JSON.stringify({ joined_at: date }) })
          if (fixture.status !== 200) throw new Error('Fixture failed')
          results.push(await read())
        }
        console.log(JSON.stringify(results))
      } finally {
        context.cleanup()
      }
    `
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, TZ: 'Europe/Warsaw' },
        encoding: 'utf8',
        timeout: 10_000,
      }
    )
    const results = JSON.parse(output) as {
      dates: string[]
      statuses: number[]
    }[]
    expect(results).toEqual(
      [
        '2020-02-29T12:34:56.000000+00:00',
        '2020-07-01T12:34:56.123000+00:00',
        ...Array.from({ length: 3 }, () => '2020-02-29T12:34:56.123000+00:00'),
      ].map((date) => ({
        dates: Array.from({ length: 10 }, () => date),
        statuses: Array.from({ length: 9 }, () => 200),
      }))
    )
  })
})
