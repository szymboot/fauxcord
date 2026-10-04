import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { toMessageObject, type MessageRow, type UserRow } from './messages'

describe('toMessageObject', () => {
  const row: MessageRow = {
    id: '1',
    channel_id: '2',
    author_id: '3',
    author_token: 'Bot test',
    content: 'hello',
    tts: 0,
    mention_everyone: 0,
    pinned: 0,
    type: 0,
    flags: 0,
    referenced_message_id: null,
    created_at: '2026-01-01 00:00:00',
    edited_at: null,
  }
  const author: UserRow = {
    id: '3',
    username: 'bot',
    discriminator: '0',
    avatar: null,
    bot: 1,
  }

  it.each(['Display Name', null, undefined])(
    'preserves author global_name=%s',
    (globalName) => {
      const message = toMessageObject(
        row,
        { ...author, global_name: globalName },
        [],
        [],
        [],
        'http://localhost:3000'
      )
      expect(message.author.global_name).toBe(globalName ?? null)
    }
  )

  it('includes the full Reaction shape (count_details, me_burst, burst_colors)', () => {
    // Real Discord's Reaction object (discord-api-types APIReaction) requires
    // count_details/me_burst/burst_colors — omitting them causes a real
    // NullReferenceException in Discord.Net.Rest's RestReaction.Create,
    // confirmed via the compat/dotnet-discordnet verifier.
    const obj = toMessageObject(
      row,
      author,
      [],
      [],
      [{ emoji: '👍', count: 2 }],
      'http://localhost:3000'
    )
    expect(obj.reactions).toHaveLength(1)
    const reaction = obj.reactions?.[0]
    expect(reaction?.count).toBe(2)
    expect(reaction?.me).toBe(false)
    expect(reaction?.me_burst).toBe(false)
    expect(reaction?.burst_colors).toEqual([])
    expect(reaction?.count_details).toEqual({ burst: 0, normal: 2 })
    expect(reaction?.emoji).toEqual({ id: null, name: '👍' })
  })

  it('omits the reactions field entirely when there are no reactions', () => {
    const obj = toMessageObject(
      row,
      author,
      [],
      [],
      [],
      'http://localhost:3000'
    )
    expect(obj.reactions).toBeUndefined()
  })
  it.each([
    {
      name: 'POSIX indexed',
      filePath: path.posix.join('2', '1', '123', 'proof #?.txt'),
      suffix: '2/1/123/proof%20%23%3F.txt',
    },
    {
      name: 'Windows indexed',
      filePath: path.win32.join('2', '1', '123', 'proof #?.txt'),
      suffix: '2/1/123/proof%20%23%3F.txt',
    },
    {
      name: 'POSIX legacy',
      filePath: path.posix.join('2', '1', 'proof #?.txt'),
      suffix: '2/1/proof%20%23%3F.txt',
    },
    {
      name: 'Windows legacy',
      filePath: path.win32.join('2', '1', 'proof #?.txt'),
      suffix: '2/1/proof%20%23%3F.txt',
    },
  ])('serializes usable $name attachment URLs', ({ filePath, suffix }) => {
    const message = toMessageObject(
      row,
      author,
      [],
      [
        {
          id: '123',
          message_id: '1',
          filename: 'proof #?.txt',
          size: 3,
          content_type: 'image/png',
          file_path: filePath,
        },
      ],
      [],
      'http://localhost:3000'
    )
    expect(message.attachments[0].url).toBe(
      `http://localhost:3000/_mock/attachments/${suffix}`
    )
    expect(message.attachments[0].proxy_url).toBe(message.attachments[0].url)
  })
})
