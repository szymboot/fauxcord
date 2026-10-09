import { normalizeMemberJoinDate } from './member-join-date'

/** Synthetic voice flags; identities and session IDs are server-owned. */
export interface TestVoiceStatePatch {
  channel_id?: string | null
  deaf?: boolean
  mute?: boolean
  self_deaf?: boolean
  self_mute?: boolean
  self_stream?: boolean
  self_video?: boolean
  suppress?: boolean
  request_to_speak_timestamp?: string | null
  /** False reserves silent preparation when live dispatch is installed. */
  emit?: boolean
}

/** Validates a strict fixture object and normalizes its optional timestamp. */
export function validateTestVoiceState(
  value: unknown
): TestVoiceStatePatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  const normalized: Record<string, unknown> = {}
  for (const [field, item] of Object.entries(payload)) {
    switch (field) {
      case 'channel_id': {
        if (
          item !== null &&
          (typeof item !== 'string' ||
            !/^\d{1,20}$/.test(item) ||
            BigInt(item) === 0n ||
            BigInt(item) > 18_446_744_073_709_551_615n)
        )
          return null
        normalized[field] = item
        break
      }
      case 'request_to_speak_timestamp': {
        const timestamp = item === null ? null : normalizeMemberJoinDate(item)
        if (item !== null && timestamp === null) return null
        normalized[field] = timestamp
        break
      }
      case 'deaf':
      case 'mute':
      case 'self_deaf':
      case 'self_mute':
      case 'self_stream':
      case 'self_video':
      case 'suppress':
      case 'emit': {
        if (typeof item !== 'boolean') return null
        normalized[field] = item
        break
      }
      default: {
        return null
      }
    }
  }
  return normalized
}
