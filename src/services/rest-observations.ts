import type { Database } from '../db'
import { generateSnowflake } from '../snowflake'
import {
  isRestFaultApplicationScoped,
  isRestFaultGuildChannelCreatePath,
} from '../validators/rest-fault'
import {
  concreteRestObservationPath,
  isRestObservationWildcard,
  type RestObservationRequest,
} from '../validators/rest-observation'
import { resolveRestFaultScope } from './rest-faults'

/** Maximum number of requests retained per observation; `count` keeps going. */
export const REST_OBSERVATION_MAX_REQUESTS = 1000

/** Kind of credential a counted request was authenticated with. */
export type RestObservationCredential = 'bot' | 'bearer'

/** One counted request with its final response status. */
export interface RestObservedRequest {
  method: string
  /** Concrete request path, without a version prefix. */
  path: string
  status: number
  /** ISO timestamp of when the request was recorded. */
  at: string
  credential: RestObservationCredential
}

/** Creation response of an observation, before any request is counted. */
export interface RestObservation {
  id: string
  method: string
  path: string
  guild_id: string
  count: number
  requests: RestObservedRequest[]
  expires_at: string
}

/** Readable observation state: it stops counting once it has expired. */
export interface RestObservationSnapshot extends RestObservation {
  state: 'active' | 'expired'
}

/** Private observation record; the owner token is never exposed. */
export interface RestObservationRecord {
  id: string
  method: string
  path: string
  guildId: string
  /** Bot owning the selected guild when the observation was created. */
  token: string
  /** Whether only the owning bot (or its application) is observed. */
  restricted: boolean
  /** Whether Bearer tokens of the owning bot's application are observed too. */
  applicationScoped: boolean
  /** Whether a concrete request path belongs to this observation's selector. */
  matchesPath: (path: string) => boolean
  deadline: number
  count: number
  requests: RestObservedRequest[]
}

/** Facts about an incoming request that decide which observations match it. */
export interface RestObservationCall {
  method: string
  /** Selector-form path, see `resolveRestFaultRequestTarget`. */
  path: string
  /** Bot owning an interaction route authorized by its interaction token. */
  interactionOwner?: string
  botToken?: string
  /** OAuth2 client (application) of a Bearer-authenticated caller. */
  clientId?: string
}

/** Escapes a literal path for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
}

/**
 * Builds the path predicate for a selector: exact equality, except that the
 * `*` command segment accepts any numeric command ID (including the
 * application ID used for application-level permissions).
 */
function pathMatcher(
  method: string,
  path: string
): RestObservationRecord['matchesPath'] {
  if (!isRestObservationWildcard(method, path)) return (other) => other === path
  const pattern = new RegExp(
    `^${escapeRegExp(path).replace(String.raw`\*`, String.raw`\d{1,20}`)}$`
  )
  return (other) => pattern.test(other)
}

/** Counts matching REST requests without ever changing them. */
export class RestObservations {
  private entries = new Map<string, RestObservationRecord>()

  /** Binds observations to one database's guild ownership. */
  constructor(private db: Database) {}

  /** Drops observations whose guild has gone away or changed owner. */
  prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.guildOwner(entry.guildId) !== entry.token)
        this.entries.delete(id)
    }
  }

  /** Whether any observation exists, so idle servers skip all matching work. */
  hasAny(): boolean {
    return this.entries.size > 0
  }

  /** Looks up the bot token that currently owns a guild. */
  private guildOwner(guildId: string): string | undefined {
    const guild = this.db
      .prepare('SELECT bot_token FROM guilds WHERE id = ?')
      .get(guildId) as { bot_token: string } | undefined
    return guild?.bot_token
  }

  /** Renders a record as an API object with copied, credential-free fields. */
  private view(entry: RestObservationRecord): RestObservation {
    return {
      id: entry.id,
      method: entry.method,
      path: entry.path,
      guild_id: entry.guildId,
      count: entry.count,
      requests: entry.requests.map((request) => ({ ...request })),
      expires_at: new Date(entry.deadline).toISOString(),
    }
  }

  /** Renders a record with its lifecycle state. */
  private snapshot(entry: RestObservationRecord): RestObservationSnapshot {
    return {
      ...this.view(entry),
      state: Date.now() >= entry.deadline ? 'expired' : 'active',
    }
  }

  /**
   * Starts observing an exact selector for the guild's owning bot. Overlapping
   * observations are allowed and count independently.
   */
  create(request: RestObservationRequest): RestObservation | 'UNKNOWN_SCOPE' {
    this.prune()
    const selectorPath = concreteRestObservationPath(
      request.method,
      request.path
    )
    const scope = resolveRestFaultScope(this.db, {
      method: request.method,
      path: selectorPath,
      guild_id: request.guild_id,
    })
    if (!scope) return 'UNKNOWN_SCOPE'
    const entry: RestObservationRecord = {
      id: generateSnowflake(),
      method: request.method,
      path: request.path,
      guildId: scope.guild.id,
      token: scope.guild.bot_token,
      // Mirrors which faults are consumed by every caller and which only by
      // the bot owning the selected guild.
      restricted:
        scope.ownerBound ||
        request.method === 'GET' ||
        selectorPath === '/users/@me/channels' ||
        (request.method === 'POST' &&
          isRestFaultGuildChannelCreatePath(selectorPath)),
      applicationScoped: isRestFaultApplicationScoped(
        request.method,
        selectorPath
      ),
      matchesPath: pathMatcher(request.method, request.path),
      deadline: Date.now() + request.timeout_ms,
      count: 0,
      requests: [],
    }
    this.entries.set(entry.id, entry)
    return this.view(entry)
  }

  /** Returns the current snapshot; expired observations stay readable. */
  get(id: string): RestObservationSnapshot | undefined {
    this.prune()
    const entry = this.entries.get(id)
    return entry ? this.snapshot(entry) : undefined
  }

  /** Removes one observation and its recorded requests. */
  remove(id: string): boolean {
    this.prune()
    return this.entries.delete(id)
  }

  /** Clears observations globally or for one bot and/or guild. */
  reset(token?: string, guildId?: string): void {
    for (const [id, entry] of this.entries) {
      if (
        (token === undefined || entry.token === token) &&
        (guildId === undefined || entry.guildId === guildId)
      )
        this.entries.delete(id)
    }
  }

  /** Whether the Bearer client is the application of the given bot. */
  private clientOwnsToken(token: string, clientId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM bots WHERE token = ? AND user_id = ?')
        .get(token, clientId) !== undefined
    )
  }

  /**
   * Selects the active observations an arriving request belongs to. The
   * caller scope matches fault consumption: restricted selectors observe the
   * guild's owning bot, and application-scoped ones also its Bearer tokens.
   */
  match(call: RestObservationCall): RestObservationRecord[] {
    const now = Date.now()
    const callerToken = call.interactionOwner ?? call.botToken
    const matched: RestObservationRecord[] = []
    for (const entry of this.entries.values()) {
      if (
        entry.method !== call.method ||
        now >= entry.deadline ||
        !entry.matchesPath(call.path)
      )
        continue
      if (
        entry.restricted &&
        callerToken !== entry.token &&
        !(
          entry.applicationScoped &&
          call.clientId !== undefined &&
          this.clientOwnsToken(entry.token, call.clientId)
        )
      )
        continue
      if (this.guildOwner(entry.guildId) !== entry.token) continue
      matched.push(entry)
    }
    return matched
  }

  /** Counts one finished request on each matched observation. */
  record(
    matched: RestObservationRecord[],
    request: Omit<RestObservedRequest, 'at'>
  ): void {
    const at = new Date().toISOString()
    for (const entry of matched) {
      // Removed or reset while the request ran: keep nothing.
      if (this.entries.get(entry.id) !== entry) continue
      entry.count++
      entry.requests.push({ ...request, at })
      if (entry.requests.length > REST_OBSERVATION_MAX_REQUESTS)
        entry.requests.shift()
    }
  }
}

/** Observation registries are isolated per database. */
const registries = new WeakMap<Database, RestObservations>()

/**
 * Gets the database's in-process REST observation registry.
 * @param db - Database
 * @returns The registry shared by routes, middleware and cleanup paths
 */
export function getRestObservations(db: Database): RestObservations {
  let registry = registries.get(db)
  if (!registry) {
    registry = new RestObservations(db)
    registries.set(db, registry)
  }
  return registry
}
