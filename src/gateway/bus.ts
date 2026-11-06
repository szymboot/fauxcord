import { EventEmitter } from 'node:events'
import type { Database } from '../db'
import type { GatewayVoiceStateUpdateDispatchData } from 'discord-api-types/v10'
import type { ReactionEmoji } from '../services/reaction-emoji'
import type { EmojiObject } from '../services/guild-emojis'
import type { StoredAuditEntry } from '../services/audit-logs'

/** Mapping of event names to their payloads exchanged over gatewayBus */
export interface GatewayBusEvents {
  'voice.state.update': {
    state: GatewayVoiceStateUpdateDispatchData
    scope: { db: Database; botId: string; token: string }
  }
  'message.create': {
    /** Originating database for persisted creates; absent on synthetic events. */
    db?: Database
    guildId: string | undefined
    channelId: string
    message: Record<string, unknown>
    // Real Discord's MESSAGE_CREATE always embeds the author's guild member
    // object for guild channel messages; omitted for DM-like channels.
    member: Record<string, unknown> | undefined
  }
  'message.update': {
    /** Originating database; resolves the recipients of DM channel events. */
    db?: Database
    guildId: string | undefined
    channelId: string
    message: Record<string, unknown>
    member: Record<string, unknown> | undefined
  }
  'message.delete': {
    /** Originating database; resolves the recipients of DM channel events. */
    db?: Database
    guildId: string | undefined
    channelId: string
    messageId: string
  }
  'message.delete.bulk': {
    guildId: string
    channelId: string
    messageIds: string[]
    botId: string
    /** Scope the singleton bus event to its originating app/database. */
    db: Database
  }
  'message.reaction.add': {
    /** Originating database; resolves the recipients of DM channel events. */
    db?: Database
    guildId: string | undefined
    channelId: string
    messageId: string
    userId: string
    emoji: ReactionEmoji
    /** Existing human member and exact setup scope for test reactions. */
    member?: Record<string, unknown>
    messageAuthorId?: string
    scope?: { db: Database; botId: string; token: string }
    /** True for a burst (super) reaction; omitted for normal reactions. */
    burst?: boolean
    /** "#rrggbb" animation colors of a burst reaction. */
    burstColors?: string[]
  }
  'message.reaction.remove': {
    /** Originating database; resolves the recipients of DM channel events. */
    db?: Database
    guildId: string | undefined
    channelId: string
    messageId: string
    userId: string
    emoji: ReactionEmoji
    /** Whether the removed membership was a burst (super) reaction. */
    burst?: boolean
    /** Exact setup scope for human fixture removals. */
    scope?: { db: Database; botId: string; token: string }
  }
  'message.reaction.remove.all': {
    guildId: string | undefined
    channelId: string
    messageId: string
    scope: { db: Database; botId: string; token: string }
  }
  'message.reaction.remove.emoji': {
    guildId: string | undefined
    channelId: string
    messageId: string
    emoji: ReactionEmoji
    scope: { db: Database; botId: string; token: string }
  }
  'guild.create': {
    guild: Record<string, unknown>
    /** Exact setup scope; omitted by legacy callers that broadcast to all. */
    scope?: { db: Database; botId: string; token: string }
  }
  'guild.emojis.update': {
    guildId: string
    /** Full current emoji list of the guild. */
    emojis: EmojiObject[]
    /** Exact setup scope of the guild. */
    scope: { db: Database; botId: string; token: string }
  }
  'guild.update': {
    guild: Record<string, unknown>
    /** Exact setup scope of the updated guild. */
    scope: { db: Database; botId: string; token: string }
  }
  'channel.create': { channel: Record<string, unknown> }
  'channel.update': {
    channel: Record<string, unknown>
    /** Optional delivery scope for guild channel mutations. */
    scope?: { db: Database; botId: string; token: string }
  }
  'channel.delete': { channel: Record<string, unknown> }
  'guild.member.add': {
    guildId: string
    member: Record<string, unknown>
    /**
     * Setup whose sessions already learned of the member from another event
     * (the bot's own join is carried by its GUILD_CREATE) and must not get a
     * duplicate GUILD_MEMBER_ADD.
     */
    exceptScope?: { db: Database; token: string }
  }
  'guild.member.update': {
    guildId: string
    member: Record<string, unknown>
    /** Exact producer scope; omitted only by legacy bus callers. */
    scope?: { db: Database; botId: string; token: string }
  }
  'guild.member.remove': {
    guildId: string
    userId: string
    user: Record<string, unknown>
    /** Exact delivery scope; omitted by legacy unscoped removals. */
    scope?: { db: Database; botId: string; token: string }
  }
  'guild.ban.add': {
    guildId: string
    user: Record<string, unknown>
    /** Message deletion window the ban was created with, in seconds. */
    deleteMessageSeconds: number
    scope: { db: Database; botId: string; token: string }
  }
  'guild.ban.remove': {
    guildId: string
    user: Record<string, unknown>
    scope: { db: Database; botId: string; token: string }
  }
  'guild.audit.log.entry.create': {
    guildId: string
    /** Audit log entry object as returned by the audit log endpoint. */
    entry: StoredAuditEntry
    /** Exact setup scope of the entry's guild. */
    scope: { db: Database; botId: string; token: string }
  }
  'invite.delete': {
    guildId: string
    channelId: string
    code: string
    /** Exact setup scope of the invite's guild. */
    scope: { db: Database; botId: string; token: string }
  }
  'guild.delete': {
    guildId: string
    /** The bot (and exact setup token) that lost access to the guild. */
    scope: { db: Database; botId: string; token: string }
  }
  'guild.role.create': { guildId: string; role: Record<string, unknown> }
  'guild.role.update': { guildId: string; role: Record<string, unknown> }
  'guild.role.delete': { guildId: string; roleId: string }
  'interaction.create': {
    applicationId: string
    interaction: Record<string, unknown>
    /** Database that created the interaction; other apps ignore it. */
    db?: Database
    /** Owning setup token of the interaction's guild, when it has one. */
    token?: string
  }
}

/**
 * Typed internal event bus that decouples the REST service layer from the
 * Gateway dispatch layer.
 */
// eslint-disable-next-line unicorn/prefer-event-target -- Node's EventEmitter API (on/emit/off/setMaxListeners) is required here; EventTarget lacks equivalent typed payload ergonomics.
class TypedGatewayBus extends EventEmitter {
  /**
   * Emits an event.
   * @param event - Event name
   * @param payload - Event payload
   * @returns true if a listener existed
   */
  // eslint-disable-next-line unicorn/no-useless-override -- narrows EventEmitter's untyped signature to GatewayBusEvents; not a no-op forward.
  emit<K extends keyof GatewayBusEvents>(
    event: K,
    payload: GatewayBusEvents[K]
  ): boolean {
    return super.emit(event, payload)
  }

  /**
   * Registers an event listener.
   * @param event - Event name
   * @param listener - Listener function
   * @returns this
   */
  // eslint-disable-next-line unicorn/no-useless-override -- narrows EventEmitter's untyped signature to GatewayBusEvents; not a no-op forward.
  on<K extends keyof GatewayBusEvents>(
    event: K,
    listener: (payload: GatewayBusEvents[K]) => void
  ): this {
    return super.on(event, listener)
  }

  /**
   * Removes an event listener.
   * @param event - Event name
   * @param listener - Listener function
   * @returns this
   */
  // eslint-disable-next-line unicorn/no-useless-override -- narrows EventEmitter's untyped signature to GatewayBusEvents; not a no-op forward.
  off<K extends keyof GatewayBusEvents>(
    event: K,
    listener: (payload: GatewayBusEvents[K]) => void
  ): this {
    return super.off(event, listener)
  }
}

/** Singleton Gateway internal bus shared across the whole app */
export const gatewayBus = new TypedGatewayBus()
// Raise the listener limit so frequent emits from the REST layer don't
// trigger Node's max-listeners warning (leaves headroom for more concurrent
// sessions).
// eslint-disable-next-line unicorn/no-top-level-side-effects -- one-time setup on the module's own singleton, not a shared/exported binding mutation.
gatewayBus.setMaxListeners(50)

/** Database whose service is synchronously emitting a scope-less event, if any. */
let emitDatabase: Database | undefined

/**
 * Runs a synchronous emit while recording the producing database.
 * @param db - Database whose service produced the event
 * @param emit - Emission whose listeners run synchronously inside this call
 */
function withEmitDatabase(db: Database, emit: () => void): void {
  const previous = emitDatabase
  emitDatabase = db
  try {
    emit()
  } finally {
    emitDatabase = previous
  }
}

/**
 * Emits a role event while recording the producing database. Role events carry
 * no delivery scope of their own, so scoped test captures use this to ignore
 * dispatches produced by another app database. The payload and delivery are
 * unchanged; listeners run synchronously inside this call.
 * @param db - Database whose service produced the event
 * @param event - Role event name
 * @param payload - Event payload
 */
export function emitRoleEvent<
  K extends 'guild.role.create' | 'guild.role.update' | 'guild.role.delete',
>(db: Database, event: K, payload: GatewayBusEvents[K]): void {
  withEmitDatabase(db, () => gatewayBus.emit(event, payload))
}

/**
 * Emits `guild.member.add` while recording the producing database, exactly
 * like {@link emitRoleEvent}: the event has no delivery scope of its own, so
 * scoped test captures use the recorded database to ignore joins produced by
 * another app database. The payload and delivery are unchanged.
 * @param db - Database whose service produced the join
 * @param payload - Event payload
 */
export function emitMemberAddEvent(
  db: Database,
  payload: GatewayBusEvents['guild.member.add']
): void {
  withEmitDatabase(db, () => gatewayBus.emit('guild.member.add', payload))
}

/** Returns the database producing the scope-less event being dispatched, if known. */
export function currentEmitDatabase(): Database | undefined {
  return emitDatabase
}
