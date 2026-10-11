/**
 * Channel-scoped request validators
 *
 * Validation follows the Discord API error format (code 50035).
 */

import {
  DiscordErrorCode,
  discordError,
  type DiscordErrorResponse,
} from '../errors'
import { maxLengthError, requiredError, typeError } from './common'
import type { FieldError, ValidationErrors } from './common'

/** Invite creation payload */
export interface InviteCreatePayload {
  max_age?: number | null
  max_uses?: number | null
  temporary?: boolean | null
  unique?: boolean | null
}

/** Invite limit constants (from the Discord spec) */
export const INVITE_LIMITS = {
  MAX_AGE_MAX: 5_184_000,
  MAX_USES_MAX: 100,
} as const

/**
 * Validates that an optional field, when present, is an integer within
 * [0, max]. Non-numeric or out-of-range values add a Discord-format error.
 * The value is typed as `unknown` because it originates from untrusted JSON
 * and may not actually be a number at runtime.
 * @param value - Raw field value (untrusted)
 * @param max - Inclusive upper bound
 * @param field - Field name used as the error key
 * @param errors - Error map to append to
 */
function validateOptionalIntBound(
  value: unknown,
  max: number,
  field: string,
  errors: Record<string, unknown>
): void {
  if (value === undefined || value === null) return
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  ) {
    errors[field] = {
      _errors: [
        {
          code: 'NUMBER_TYPE_MAX',
          message: `Must be an integer between 0 and ${max}.`,
        },
      ],
    }
  }
}

/**
 * Validates an invite creation payload.
 * @param payload - Request payload
 * @returns Field-keyed error map (empty when valid)
 */
export function validateInviteCreate(
  payload: InviteCreatePayload
): Record<string, unknown> {
  const errors: Record<string, unknown> = {}

  validateOptionalIntBound(
    payload.max_age,
    INVITE_LIMITS.MAX_AGE_MAX,
    'max_age',
    errors
  )
  validateOptionalIntBound(
    payload.max_uses,
    INVITE_LIMITS.MAX_USES_MAX,
    'max_uses',
    errors
  )

  return errors
}

/** Channel field limits (from the Discord spec) */
export const CHANNEL_LIMITS = {
  NAME_MAX: 100,
  TOPIC_MAX: 1024,
  RATE_LIMIT_PER_USER_MAX: 21_600,
} as const

/** Channel update (PATCH) payload (unknown fields until validated) */
export interface ChannelUpdatePayload extends VoiceChannelSettingsPayload {
  type?: unknown
  name?: unknown
  topic?: unknown
  nsfw?: unknown
  rate_limit_per_user?: unknown
  position?: unknown
}

/**
 * Validates a channel update (PATCH) payload. When present: `name` must be a
 * non-empty string of at most `CHANNEL_LIMITS.NAME_MAX` characters, `topic` a
 * string of at most `CHANNEL_LIMITS.TOPIC_MAX` characters,
 * `rate_limit_per_user` an integer in
 * `[0, CHANNEL_LIMITS.RATE_LIMIT_PER_USER_MAX]`, and `position` a
 * non-negative integer. Fields are untrusted JSON, so each is type-checked at
 * runtime.
 * @param payload - Payload to validate
 * @returns Validation error map (empty when valid)
 */
export function validateChannelUpdate(
  payload: ChannelUpdatePayload
): ValidationErrors {
  const errors: ValidationErrors = {}

  if (payload.name !== undefined && payload.name !== null) {
    if (typeof payload.name !== 'string') {
      errors.name = { _errors: [typeError('string')] }
    } else if (payload.name.length === 0) {
      errors.name = { _errors: [requiredError()] }
    } else if (payload.name.length > CHANNEL_LIMITS.NAME_MAX) {
      errors.name = { _errors: [maxLengthError(CHANNEL_LIMITS.NAME_MAX)] }
    }
  }

  if (payload.topic !== undefined && payload.topic !== null) {
    if (typeof payload.topic !== 'string') {
      errors.topic = { _errors: [typeError('string')] }
    } else if (payload.topic.length > CHANNEL_LIMITS.TOPIC_MAX) {
      errors.topic = { _errors: [maxLengthError(CHANNEL_LIMITS.TOPIC_MAX)] }
    }
  }

  if (
    payload.nsfw !== undefined &&
    payload.nsfw !== null &&
    typeof payload.nsfw !== 'boolean'
  ) {
    errors.nsfw = { _errors: [typeError('boolean')] }
  }

  validateOptionalIntBound(
    payload.rate_limit_per_user,
    CHANNEL_LIMITS.RATE_LIMIT_PER_USER_MAX,
    'rate_limit_per_user',
    errors
  )
  validateOptionalIntBound(
    payload.position,
    Number.MAX_SAFE_INTEGER,
    'position',
    errors
  )

  return errors
}

/**
 * Whether an untrusted channel type value denotes a voice (2) or stage (13)
 * channel.
 * @param type - Channel type value
 * @returns true for voice-capable channel types
 */
function isVoiceCapable(type: unknown): boolean {
  return type === 2 || type === 13
}

/**
 * Validates a requested channel `type` against the stored type. Discord only
 * converts between text (0) and announcement (5) channels, so a voice or
 * stage channel can never change type and no other channel can become voice
 * or stage. Other non-voice conversions are not modeled and stay ignored.
 * @param currentType - Stored channel type
 * @param requested - Untrusted `type` field from the PATCH payload
 * @returns Validation error map (empty when the request is acceptable)
 */
export function validateChannelTypeChange(
  currentType: number,
  requested: unknown
): ValidationErrors {
  if (
    requested === undefined ||
    requested === null ||
    requested === currentType ||
    (!isVoiceCapable(currentType) && !isVoiceCapable(requested))
  )
    return {}
  const choices =
    currentType === 0 || currentType === 5 ? '(0, 5)' : `(${currentType})`
  return {
    type: {
      _errors: [
        {
          code: 'BASE_TYPE_CHOICES',
          message: `Value must be one of ${choices}.`,
        },
      ],
    },
  }
}

/** Permission overwrite request payload (unknown fields until validated) */
export interface PermissionOverwritePayload {
  type?: unknown
  allow?: unknown
  deny?: unknown
}

/**
 * Checks whether a value is an acceptable permission bitfield input:
 * a non-negative safe integer, a numeric string, null, or undefined.
 * Numbers above Number.MAX_SAFE_INTEGER are rejected because they lose
 * precision and stringify to exponential notation (e.g. "1e+21"), which
 * would violate the digit-string form the string path enforces.
 * @param value - Value to check
 * @returns True if the value is an acceptable bitfield input
 */
function isValidBitfield(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0
  return typeof value === 'string' ? /^\d+$/.test(value) : false
}

/**
 * Builds the error reported when a permission bitfield (`allow`/`deny`) is
 * neither a non-negative integer nor a numeric string. The message reflects
 * both accepted input forms rather than claiming a plain string is required.
 * @returns Field error object
 */
function bitfieldTypeError(): FieldError {
  return {
    code: 'BASE_TYPE_BAD_TYPE',
    message: 'Value must be an integer or a numeric string.',
  }
}

/**
 * Validates a channel permission overwrite payload. `type` must be 0 (role)
 * or 1 (member); `allow`/`deny`, when present, must be a non-negative integer
 * or a numeric string.
 * @param payload - Payload to validate
 * @returns Validation error map (empty when valid)
 */
export function validatePermissionOverwrite(
  payload: PermissionOverwritePayload
): ValidationErrors {
  const errors: ValidationErrors = {
    ...(payload.type !== 0 &&
      payload.type !== 1 && {
        type: {
          _errors: [
            {
              code: 'BASE_TYPE_CHOICES',
              message: 'Value must be one of (0, 1).',
            },
          ],
        },
      }),
    ...(!isValidBitfield(payload.allow) && {
      allow: { _errors: [bitfieldTypeError()] },
    }),
    ...(!isValidBitfield(payload.deny) && {
      deny: { _errors: [bitfieldTypeError()] },
    }),
  }

  return errors
}

/**
 * Converts a validated bitfield value (a non-negative integer, a numeric
 * string, or null/undefined) into its stored string form (default "0").
 * @param value - Validated bitfield value
 * @returns Numeric string representation
 */
function bitfieldToString(value: unknown): string {
  if (value === undefined || value === null) return '0'
  // Guaranteed to be a numeric string once validatePermissionOverwrite passes.
  return typeof value === 'number' ? String(value) : (value as string)
}

/**
 * Normalizes a validated permission overwrite payload into stored form:
 * `type` as a number and `allow`/`deny` as numeric strings (default "0").
 * Call only after validatePermissionOverwrite reports no errors.
 * @param payload - Validated payload
 * @returns Normalized overwrite values
 */
export function normalizePermissionOverwrite(
  payload: PermissionOverwritePayload
): { type: number; allow: string; deny: string } {
  return {
    type: payload.type as number,
    allow: bitfieldToString(payload.allow),
    deny: bitfieldToString(payload.deny),
  }
}

/** Voice channel status limit (from the Discord spec) */
export const VOICE_STATUS_LIMITS = {
  STATUS_MAX: 500,
} as const

/** Voice channel status update payload (unknown fields until validated) */
export interface VoiceStatusPayload {
  status?: unknown
}

/**
 * Validates a voice channel status update payload. `status`, when present
 * and non-null, must be a string of at most
 * `VOICE_STATUS_LIMITS.STATUS_MAX` characters.
 * @param payload - Payload to validate
 * @returns Validation error map (empty when valid)
 */
export function validateVoiceStatus(
  payload: VoiceStatusPayload
): ValidationErrors {
  const errors: ValidationErrors = {}

  if (payload.status !== undefined && payload.status !== null) {
    if (typeof payload.status !== 'string') {
      errors.status = { _errors: [typeError('string')] }
    } else if (payload.status.length > VOICE_STATUS_LIMITS.STATUS_MAX) {
      errors.status = {
        _errors: [maxLengthError(VOICE_STATUS_LIMITS.STATUS_MAX)],
      }
    }
  }

  return errors
}

/** Voice and stage channel setting limits (from the Discord docs). */
export const VOICE_CHANNEL_LIMITS = {
  BITRATE_MIN: 8000,
  /** Voice channel bitrate ceiling indexed by guild boost tier (0-3). */
  VOICE_BITRATE_MAX_BY_TIER: [96_000, 128_000, 256_000, 384_000],
  STAGE_BITRATE_MAX: 64_000,
  VOICE_USER_LIMIT_MAX: 99,
  STAGE_USER_LIMIT_MAX: 10_000,
  VIDEO_QUALITY_MODES: [1, 2],
  /** Discord's default bitrate for new voice and stage channels. */
  DEFAULT_BITRATE: 64_000,
} as const

/**
 * Discord's default `user_limit` for a channel type: 0 (unlimited) for voice
 * channels and 10000 for stage channels.
 * @param channelType - Voice (2) or stage (13) channel type
 * @returns Default user limit
 */
export function defaultUserLimit(channelType: number): number {
  return channelType === 13 ? VOICE_CHANNEL_LIMITS.STAGE_USER_LIMIT_MAX : 0
}

/**
 * Applies Discord's silent truncation of stage channel user limits above
 * 10000 (confirmed by Discord staff in discord-api-docs#5929).
 * @param settings - Validated settings
 * @param channelType - Channel type the settings apply to
 * @returns Settings with a stage `user_limit` capped at 10000
 */
export function normalizeVoiceChannelSettings(
  settings: VoiceChannelSettings,
  channelType: number
): VoiceChannelSettings {
  return channelType === 13 &&
    typeof settings.user_limit === 'number' &&
    settings.user_limit > VOICE_CHANNEL_LIMITS.STAGE_USER_LIMIT_MAX
    ? { ...settings, user_limit: VOICE_CHANNEL_LIMITS.STAGE_USER_LIMIT_MAX }
    : settings
}

/** Voice/stage channel settings (unknown fields until validated). */
export interface VoiceChannelSettingsPayload {
  bitrate?: unknown
  user_limit?: unknown
  rtc_region?: unknown
  video_quality_mode?: unknown
}

/** Validated voice/stage channel settings; null restores the default. */
export interface VoiceChannelSettings {
  bitrate?: number | null
  user_limit?: number | null
  rtc_region?: string | null
  video_quality_mode?: number | null
}

/**
 * Builds Discord's form-body error for an integer field, matching responses
 * observed from the live API (e.g. `int value should be less than or equal
 * to 96000.` with code `NUMBER_TYPE_MAX`).
 * @param value - Untrusted field value
 * @param min - Inclusive lower bound
 * @param max - Inclusive upper bound, or undefined when unbounded
 * @returns Field error, or null when the value is acceptable
 */
function intFieldError(
  value: unknown,
  min: number,
  max?: number
): FieldError | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    return {
      code: 'NUMBER_TYPE_COERCE',
      // JSON.stringify never invokes user-controlled coercion methods.
      message: `Value "${typeof value === 'string' ? value : JSON.stringify(value)}" is not int.`,
    }
  if (value < min)
    return {
      code: 'NUMBER_TYPE_MIN',
      message: `int value should be greater than or equal to ${min}.`,
    }
  return max !== undefined && value > max
    ? {
        code: 'NUMBER_TYPE_MAX',
        message: `int value should be less than or equal to ${max}.`,
      }
    : null
}

/**
 * Validates voice/stage channel settings for a channel of the given type,
 * following Discord's documented limits and observed responses:
 * - `bitrate` is at least 8000; voice channels allow at most
 *   96000/128000/256000/384000 by boost tier 0-3 (the `VIP_REGIONS` feature
 *   is not modeled). A stage bitrate above 64000 is not a form error but
 *   error 30052, see `isStageBitrateTooHigh`.
 * - `user_limit` is 0-99 for voice channels; stage channels accept any
 *   non-negative integer and Discord truncates it to 10000, see
 *   `normalizeVoiceChannelSettings`.
 * - `rtc_region` is a voice region ID from `GET /voice/regions` or null
 *   (automatic); `video_quality_mode` is 1 (auto) or 2 (full).
 * Null restores each field's default.
 * @param payload - Untrusted settings
 * @param channelType - Voice (2) or stage (13) channel type
 * @param premiumTier - Guild boost tier (0-3)
 * @param regionIds - Accepted voice region IDs
 * @returns Validation error map (empty when valid)
 */
export function validateVoiceChannelSettings(
  payload: VoiceChannelSettingsPayload,
  channelType: number,
  premiumTier: number,
  regionIds: readonly string[]
): ValidationErrors {
  const errors: ValidationErrors = {}
  const stage = channelType === 13

  if (payload.bitrate !== undefined && payload.bitrate !== null) {
    const error = intFieldError(
      payload.bitrate,
      VOICE_CHANNEL_LIMITS.BITRATE_MIN,
      stage
        ? undefined
        : (VOICE_CHANNEL_LIMITS.VOICE_BITRATE_MAX_BY_TIER[premiumTier] ??
            VOICE_CHANNEL_LIMITS.VOICE_BITRATE_MAX_BY_TIER[0])
    )
    if (error) errors.bitrate = { _errors: [error] }
  }

  if (payload.user_limit !== undefined && payload.user_limit !== null) {
    const error = intFieldError(
      payload.user_limit,
      0,
      stage ? undefined : VOICE_CHANNEL_LIMITS.VOICE_USER_LIMIT_MAX
    )
    if (error) errors.user_limit = { _errors: [error] }
  }

  if (
    payload.rtc_region !== undefined &&
    payload.rtc_region !== null &&
    (typeof payload.rtc_region !== 'string' ||
      !regionIds.includes(payload.rtc_region))
  ) {
    errors.rtc_region = {
      _errors: [
        {
          code: 'BASE_TYPE_CHOICES',
          message: `Value must be one of (${regionIds.join(', ')}).`,
        },
      ],
    }
  }

  if (
    payload.video_quality_mode !== undefined &&
    payload.video_quality_mode !== null &&
    VOICE_CHANNEL_LIMITS.VIDEO_QUALITY_MODES.every(
      (mode) => mode !== payload.video_quality_mode
    )
  ) {
    errors.video_quality_mode = {
      _errors: [
        { code: 'BASE_TYPE_CHOICES', message: 'Value must be one of (1, 2).' },
      ],
    }
  }

  return errors
}

/**
 * Builds Discord's JSON error 30052 for a stage bitrate above 64000.
 * @returns Discord error response (HTTP 400)
 */
export function bitrateTooHigh(): DiscordErrorResponse {
  return discordError(
    DiscordErrorCode.BITRATE_TOO_HIGH,
    'Bitrate is too high for channel of this type',
    400
  )
}

/**
 * Whether a (form-valid) bitrate exceeds the stage channel ceiling. Discord
 * reports this as JSON error 30052 "Bitrate is too high for channel of this
 * type" rather than as a form-body field error.
 * @param bitrate - Validated bitrate, null or undefined
 * @param channelType - Channel type
 * @returns true for a stage channel bitrate above 64000
 */
export function isStageBitrateTooHigh(
  bitrate: unknown,
  channelType: number
): boolean {
  return (
    channelType === 13 &&
    typeof bitrate === 'number' &&
    bitrate > VOICE_CHANNEL_LIMITS.STAGE_BITRATE_MAX
  )
}

/**
 * Picks the voice settings present in a payload that already passed
 * `validateVoiceChannelSettings`.
 * @param payload - Validated payload
 * @returns Only the provided settings, typed
 */
export function pickVoiceChannelSettings(
  payload: VoiceChannelSettingsPayload
): VoiceChannelSettings {
  return {
    ...(payload.bitrate !== undefined && {
      bitrate: payload.bitrate as number | null,
    }),
    ...(payload.user_limit !== undefined && {
      user_limit: payload.user_limit as number | null,
    }),
    ...(payload.rtc_region !== undefined && {
      rtc_region: payload.rtc_region as string | null,
    }),
    ...(payload.video_quality_mode !== undefined && {
      video_quality_mode: payload.video_quality_mode as number | null,
    }),
  }
}
