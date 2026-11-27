/**
 * Discord-compatible Snowflake ID generation module
 *
 * Generates 64-bit integer IDs based on milliseconds since
 * the Discord Epoch (2015-01-01T00:00:00.000Z).
 */

/** Discord Epoch: 2015-01-01T00:00:00.000Z */
const DISCORD_EPOCH = 1_420_070_400_000n
/** Largest unsigned 64-bit integer, the upper bound of a Snowflake */
const MAX_SNOWFLAKE = 18_446_744_073_709_551_615n
const WORKER_ID = 1n
const PROCESS_ID = 1n

/** Increment counter (to keep uniqueness within the same millisecond) */
let increment = 0n
/** Timestamp of the last generated Snowflake */
let lastTimestamp = -1n

/**
 * Generates a Discord-compatible Snowflake ID.
 *
 * If more than 4096 calls occur within the same millisecond, waits until the next millisecond.
 * @returns String representation of the Snowflake ID
 */
export function generateSnowflake(): string {
  let timestamp = BigInt(Date.now()) - DISCORD_EPOCH

  if (timestamp === lastTimestamp) {
    increment = (increment + 1n) & 0xf_ffn
    // If the counter overflows within the same millisecond, wait until the next millisecond
    if (increment === 0n) {
      while (BigInt(Date.now()) - DISCORD_EPOCH <= lastTimestamp) {
        // Busy-wait until the clock advances to the next millisecond.
        // Blocks for up to ~1ms in the worst case (see the jsdoc above for
        // when this triggers).
      }
      timestamp = BigInt(Date.now()) - DISCORD_EPOCH
    }
  } else {
    increment = 0n
  }

  lastTimestamp = timestamp

  const id =
    (timestamp << 22n) | (WORKER_ID << 17n) | (PROCESS_ID << 12n) | increment

  return id.toString()
}

/**
 * Restores the timestamp from a Snowflake ID.
 * @param snowflake - Snowflake ID string
 * @returns Date object of the timestamp
 */
export function snowflakeToTimestamp(snowflake: string): Date {
  const id = BigInt(snowflake)
  const timestamp = (id >> 22n) + DISCORD_EPOCH
  return new Date(Number(timestamp))
}

/**
 * Restores the timestamp of an ID only when it is a valid Snowflake: an
 * unsigned 64-bit integer written in decimal without leading zeros.
 * @param id - Candidate ID
 * @returns Date object of the timestamp, or null for any other ID
 */
export function parseSnowflakeTimestamp(id: string): Date | null {
  return /^(?:0|[1-9]\d{0,19})$/.test(id) && BigInt(id) <= MAX_SNOWFLAKE
    ? snowflakeToTimestamp(id)
    : null
}
