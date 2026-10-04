/**
 * Parses a bulk-delete body without rounding unquoted Snowflakes. Node 24's
 * JSON reviver source preserves integer tokens while JSON.parse validates the
 * complete JSON syntax, structure, escaping and duplicate-key semantics.
 * @param rawBody - Original request body
 * @returns Canonical Snowflake strings, or null for invalid body/ID types
 */
export function parseBulkDeleteMessages(rawBody: string): string[] | null {
  let payload: unknown
  try {
    payload = JSON.parse(
      rawBody,
      (_key: string, value: unknown, context?: { source: string }) =>
        typeof value === 'number' ? context?.source : value
    ) as unknown
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const messages = (payload as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return null
  return messages.some(
    (id: unknown) =>
      !(
        typeof id === 'string' &&
        /^(0|[1-9]\d{0,19})$/.test(id) &&
        BigInt(id) <= 18_446_744_073_709_551_615n
      )
  )
    ? null
    : (messages as string[])
}
