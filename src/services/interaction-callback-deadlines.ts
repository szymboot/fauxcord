import { randomUUID } from 'node:crypto'
import type { Database } from '../db'
import {
  DEFAULT_CALLBACK_DEADLINE_MS,
  type InteractionCallbackDeadlineRequest,
} from '../validators/interaction-callback-deadline'

/** Public inspection state; the owning setup token remains private. */
export interface InteractionCallbackDeadline {
  id: string
  guild_id: string
  /** Bot (application) whose interactions in the guild the deadline covers. */
  bot_id: string
  deadline_ms: number
  /** ISO 8601 instant the deadline was armed; earlier interactions are exempt. */
  created_at: string
}

/** Stored control row. */
interface DeadlineRow {
  id: string
  guild_id: string
  bot_id: string
  deadline_ms: number
  created_at_ms: number
}

/** Converts a stored row into its public shape. */
function toDeadline(row: DeadlineRow): InteractionCallbackDeadline {
  return {
    id: row.id,
    guild_id: row.guild_id,
    bot_id: row.bot_id,
    deadline_ms: row.deadline_ms,
    created_at: new Date(row.created_at_ms).toISOString(),
  }
}

/**
 * Removes controls whose guild has changed setup ownership, so a reassigned
 * guild never keeps a deadline armed by another setup.
 * @param db - Database
 */
export function pruneInteractionCallbackDeadlines(db: Database): void {
  db.prepare(
    `DELETE FROM test_interaction_callback_deadlines WHERE owner_token !=
      (SELECT bot_token FROM guilds WHERE id = guild_id)`
  ).run()
}

/**
 * Arms the initial callback deadline for a guild's owning bot.
 * @param db - Database
 * @param payload - Validated request; `deadline_ms` defaults to 3000
 * @returns The created control, `UNKNOWN_GUILD`, or `DUPLICATE` when the
 * guild already has an active control
 */
export function createInteractionCallbackDeadline(
  db: Database,
  payload: Pick<InteractionCallbackDeadlineRequest, 'guild_id'> &
    Partial<InteractionCallbackDeadlineRequest>
): InteractionCallbackDeadline | 'UNKNOWN_GUILD' | 'DUPLICATE' {
  const guild = db
    .prepare(
      `SELECT g.bot_token, b.user_id FROM guilds g
       JOIN bots b ON b.token = g.bot_token WHERE g.id = ?`
    )
    .get(payload.guild_id) as { bot_token: string; user_id: string } | undefined
  if (!guild) return 'UNKNOWN_GUILD'
  pruneInteractionCallbackDeadlines(db)
  const existing = db
    .prepare(
      'SELECT 1 FROM test_interaction_callback_deadlines WHERE guild_id = ?'
    )
    .get(payload.guild_id)
  if (existing) return 'DUPLICATE'
  const row: DeadlineRow = {
    id: randomUUID(),
    guild_id: payload.guild_id,
    bot_id: guild.user_id,
    deadline_ms: payload.deadline_ms ?? DEFAULT_CALLBACK_DEADLINE_MS,
    created_at_ms: Date.now(),
  }
  db.prepare(
    `INSERT INTO test_interaction_callback_deadlines
     (id, guild_id, bot_id, owner_token, deadline_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.guild_id,
    row.bot_id,
    guild.bot_token,
    row.deadline_ms,
    row.created_at_ms
  )
  return toDeadline(row)
}

/**
 * Inspects a control, hiding controls retired by guild reassignment.
 * @param db - Database
 * @param id - Control ID
 * @returns The control, or undefined when unknown or cleaned up
 */
export function getInteractionCallbackDeadline(
  db: Database,
  id: string
): InteractionCallbackDeadline | undefined {
  pruneInteractionCallbackDeadlines(db)
  const row = db
    .prepare('SELECT * FROM test_interaction_callback_deadlines WHERE id = ?')
    .get(id) as DeadlineRow | undefined
  return row ? toDeadline(row) : undefined
}

/**
 * Disarms a control. Interactions created while it was armed stop having a
 * deadline immediately.
 * @param db - Database
 * @param id - Control ID
 * @returns False for an unknown control
 */
export function deleteInteractionCallbackDeadline(
  db: Database,
  id: string
): boolean {
  pruneInteractionCallbackDeadlines(db)
  return (
    db
      .prepare('DELETE FROM test_interaction_callback_deadlines WHERE id = ?')
      .run(id).changes > 0
  )
}

/**
 * Clears controls globally or for the exact owning setup token.
 * @param db - Database
 * @param token - Owning bot token; all controls when omitted
 */
export function resetInteractionCallbackDeadlines(
  db: Database,
  token?: string
): void {
  if (token)
    db.prepare(
      'DELETE FROM test_interaction_callback_deadlines WHERE owner_token = ?'
    ).run(token)
  else db.exec('DELETE FROM test_interaction_callback_deadlines')
}

/**
 * Finds the deadline control that covers a new interaction: the one currently
 * armed for the interaction's guild and owning bot. The interaction records
 * its ID, so a control armed later never applies to it.
 * @param db - Database
 * @param interaction - Interaction scope
 * @returns The control ID, or null when no deadline is armed
 */
export function findArmedCallbackDeadlineId(
  db: Database,
  interaction: {
    application_id: string
    guild_id: string | null
    channel_id: string | null
  }
): string | null {
  const row = db
    .prepare(
      `SELECT d.id FROM test_interaction_callback_deadlines d
       JOIN guilds g ON g.id = d.guild_id AND g.bot_token = d.owner_token
       WHERE d.guild_id = COALESCE(?, (SELECT guild_id FROM channels WHERE id = ?))
         AND d.bot_id = ?`
    )
    .get(
      interaction.guild_id,
      interaction.channel_id,
      interaction.application_id
    ) as { id: string } | undefined
  return row?.id ?? null
}

/**
 * Finds the instant after which an interaction's initial callback is refused.
 * A deadline applies only while the control that was armed when the
 * interaction was created still exists for its guild and owning setup.
 * @param db - Database
 * @param interaction - Creation instant and the control recorded at creation
 * @returns Epoch milliseconds, or null when the interaction has no deadline
 */
export function findInteractionCallbackDeadlineAt(
  db: Database,
  interaction: {
    created_at_ms: number | null
    deadline_control_id: string | null
  }
): number | null {
  if (
    interaction.created_at_ms === null ||
    interaction.deadline_control_id === null
  )
    return null
  const row = db
    .prepare(
      `SELECT d.deadline_ms FROM test_interaction_callback_deadlines d
       JOIN guilds g ON g.id = d.guild_id AND g.bot_token = d.owner_token
       WHERE d.id = ?`
    )
    .get(interaction.deadline_control_id) as { deadline_ms: number } | undefined
  return row ? interaction.created_at_ms + row.deadline_ms : null
}
