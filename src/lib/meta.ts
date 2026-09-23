import type {
  MessageRole,
  NormalizedConversation,
  NormalizedMessage,
} from './types'

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
 * Meta AI embeds a Relay-style message connection in its Next.js flight
 * data: `"messages":{"edges":[{cursor, node}]}` where each node is a
 * `UserMessage` (`content`) or an `AssistantMessage` (`content`).
 * Assistant content is either inline Markdown or a flight reference
 * (`$<rowId>`) resolved against `T`-type text rows (`<id>:T<hexlen>,<text>`).
 * Inline citation markers (`{{IE_n}}…{{/IE_n}}`) are stripped.
 * Returns null when no usable messages are found so callers fall through
 * to DOM extraction.
 */
export function normalizeMetaConversation(
  payloads: unknown[],
  sourceUrl: string,
  pageTitle: string,
): NormalizedConversation | null {
  let best: { conversation: NormalizedConversation; score: number } | null =
    null

  for (const payload of payloads) {
    if (typeof payload !== 'string') continue

    const textRows = collectFlightTextRows(payload)
    const edges = findMessageEdges(payload)
    if (!edges) continue

    const messages: NormalizedMessage[] = []
    let conversationId: string | undefined

    edges.forEach((edge, index) => {
      const node = asRecord(edge)?.node
      const record = asRecord(node)
      if (!record) return

      const typename = readString(record.__typename)
      const role: MessageRole =
        typename === 'AssistantMessage' ? 'assistant' : 'user'
      if (typename !== 'AssistantMessage' && typename !== 'UserMessage') {
        return
      }

      if (conversationId === undefined) {
        conversationId = readString(record.conversationId)
      }

      if (
        typename === 'AssistantMessage' &&
        record.error !== null &&
        record.error !== undefined
      ) {
        return
      }

      let text =
        readString(record.content) ?? readString(record.userContent) ?? ''
      const ref = /^\$([0-9a-z]+)$/.exec(text.trim())
      if (ref) {
        text = resolveFlightRef(textRows, ref[1]!) ?? ''
      }
      text = cleanMetaMarkdown(text)

      if (!text) return

      messages.push({
        blocks: [{ kind: 'text', text }],
        createdAt: normalizeTimestamp(record.createdAt) ?? undefined,
        id: readString(record.id) ? `meta-${readString(record.id)}` : `meta-msg-${index + 1}`,
        role,
      })
    })

    if (messages.length === 0) continue

    const score = messages.length * 10 + (conversationId ? 4 : 0)
    if (!best || score > best.score) {
      best = {
        conversation: {
          conversationId,
          createdAt: messages[0]?.createdAt,
          messages,
          sourceUrl,
          title: pageTitle,
        },
        score,
      }
    }
  }

  return best?.conversation ?? null
}

/**
 * Collects React Flight text rows (`<id>:T<hexlen>,<text>`) from a flight
 * payload, keyed by row id. Last definition wins.
 */
function collectFlightTextRows(payload: string): Map<string, string> {
  const rows = new Map<string, string>()
  const rowRegex = /([0-9a-z]{1,4}):T([0-9a-f]+),/g
  let match

  while ((match = rowRegex.exec(payload)) !== null) {
    const length = Number.parseInt(match[2]!, 16)
    if (!Number.isFinite(length) || length < 0) continue
    rows.set(match[1]!, payload.slice(match.index + match[0].length, match.index + match[0].length + length))
  }

  return rows
}

/**
 * Resolves a `$<id>` flight reference to row text. Prefers an exact row id
 * match; falls back to a unique suffix match (Meta emits rows with prefixed
 * ids like `ll8d` referenced as `$8d`). Ambiguous or missing refs → null.
 */
function resolveFlightRef(
  rows: Map<string, string>,
  ref: string,
): string | null {
  const exact = rows.get(ref)
  if (exact !== undefined) return exact

  let suffix: string | null = null
  for (const [id, text] of rows) {
    if (id !== ref && id.endsWith(ref)) {
      if (suffix !== null) return null
      suffix = text
    }
  }
  return suffix
}

/**
 * Finds Meta's Relay-style message connection in a flight payload and
 * returns its edges array, or null when absent/unparseable.
 */
function findMessageEdges(payload: string): unknown[] | null {
  const marker = '"messages":{"edges":['
  let searchFrom = 0

  while (true) {
    const markerIndex = payload.indexOf(marker, searchFrom)
    if (markerIndex === -1) return null

    const arrayStart = markerIndex + marker.length - 1
    const arrayEnd = findBalancedBracketEnd(payload, arrayStart)
    if (arrayEnd !== null) {
      const parsed: unknown = safeJsonParse(
        payload.slice(arrayStart, arrayEnd + 1),
      )
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }

    searchFrom = arrayStart + 1
  }
}

/** Finds the matching `]` for the `[` at `start`, string-aware. */
function findBalancedBracketEnd(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return null
}

/**
 * Strips Meta's inline citation markers (`{{IE_n}}id{{/IE_n}}`) from
 * Markdown text, keeping the surrounding prose.
 */
function cleanMetaMarkdown(text: string): string {
  return text
    .replace(/\{\{IE_\d+\}\}[0-9a-f]*\{\{\/IE_\d+\}\}/g, '')
    .replace(/\{\{\/?IE_\d+\}\}/g, '')
    .trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }

  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value.trim() : date.toISOString()
  }

  return undefined
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
