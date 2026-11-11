import type { RestFaultRequest } from './rest-fault'
import { validateRestFaultSelector } from './rest-fault'

/** Default and maximum lifetime of an observation. */
export const REST_OBSERVATION_DEFAULT_TIMEOUT_MS = 60_000
export const REST_OBSERVATION_MAX_TIMEOUT_MS = 600_000

/** Validated exact request selector observed without altering requests. */
export interface RestObservationRequest {
  method: RestFaultRequest['method']
  /** Bare path with concrete numeric IDs; `*` may stand for a command ID. */
  path: string
  guild_id?: string
  timeout_ms: number
}

/**
 * Matches the command permission selectors whose `{command}` segment may be
 * `*`: `GET|PUT /applications/{app}/guilds/{guild}/commands/{command}/permissions`.
 */
const COMMAND_WILDCARD_PATH =
  /^(\/applications\/\d{1,20}\/guilds\/\d{1,20}\/commands\/)\*(\/permissions)$/

/**
 * Replaces the `*` command segment of a command permission selector with a
 * concrete numeric ID so the fault selector rules can validate and scope it.
 * Any other path is returned unchanged.
 */
export function concreteRestObservationPath(
  method: unknown,
  path: string
): string {
  return (method === 'GET' || method === 'PUT') &&
    COMMAND_WILDCARD_PATH.test(path)
    ? path.replace(
        COMMAND_WILDCARD_PATH,
        (_, prefix: string, suffix: string) => `${prefix}0${suffix}`
      )
    : path
}

/** Whether a selector path uses the `*` command wildcard. */
export function isRestObservationWildcard(
  method: unknown,
  path: string
): boolean {
  return concreteRestObservationPath(method, path) !== path
}

/**
 * Returns a validated observation request, or undefined for invalid input.
 * The selector (method, path, guild_id) follows exactly the rules of
 * `/_test/rest-faults`; the `*` command wildcard is the only addition.
 */
export function validateRestObservation(
  value: unknown
): RestObservationRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).some(
      (key) => !['method', 'path', 'guild_id', 'timeout_ms'].includes(key)
    ) ||
    typeof body.path !== 'string' ||
    (body.guild_id !== undefined &&
      (typeof body.guild_id !== 'string' || !/^\d{1,20}$/.test(body.guild_id)))
  )
    return undefined
  const timeout =
    body.timeout_ms === undefined
      ? REST_OBSERVATION_DEFAULT_TIMEOUT_MS
      : body.timeout_ms
  if (
    typeof timeout !== 'number' ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > REST_OBSERVATION_MAX_TIMEOUT_MS
  )
    return undefined
  const selector = validateRestFaultSelector({
    ...body,
    path: concreteRestObservationPath(body.method, body.path),
  })
  return selector
    ? {
        method: body.method as RestObservationRequest['method'],
        path: body.path,
        ...(typeof body.guild_id === 'string' && { guild_id: body.guild_id }),
        timeout_ms: timeout,
      }
    : undefined
}
