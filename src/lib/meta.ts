import type { NormalizedConversation } from './types'

/**
 * Extracts conversation payloads from Meta AI's Next.js App Router "Flight" data.
 * The data is delivered in a series of `self.__next_f.push([chunk_id, content])` calls.
 */
export function extractMetaConversationPayloads(html: string): unknown[] {
  const payloads: unknown[] = []

  // Match self.__next_f.push([ ... ])
  const pushRegex = /self\.__next_f\.push\(\s*\[\s*(\d+),\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g
  let match

  while ((match = pushRegex.exec(html)) !== null) {
    try {
      // The second capture group is a JSON-quoted string
      const content = JSON.parse(match[2])
      payloads.push(content)
    } catch {
      // Skip malformed JSON
    }
  }

  return payloads
}

/**
 * Normalizes Meta AI flight-data payloads into the internal format.
 *
 * Meta AI's flight data (React Server Components) is highly nested and uses
 * markers like ` 1:` / ` 2:` plus raw message strings. A full RSC parser for
 * Meta's specific format doesn't exist yet, so this intentionally returns
 * null and callers fall through to the robust DOM extraction
 * (`extractMetaDomConversation` in `./extract`).
 */
export function normalizeMetaConversation(
  _payloads: unknown[],
  _sourceUrl: string,
  _pageTitle: string,
): NormalizedConversation | null {
  return null
}
