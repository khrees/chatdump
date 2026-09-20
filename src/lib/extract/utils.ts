import type { ContentBlock, TextBlock } from '../types'

export const BLOCK_TAGS = new Set([
  'article',
  'blockquote',
  'div',
  'figure',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
])

export const STRUCTURED_PAYLOAD_HINT =
  /("__NEXT_DATA__"|"loaderData"|"mapping"|"messages"|"conversation_id"|"serverResponse")|__NEXT_DATA__|__remixContext|__reactRouterDataRouter|__staticRouterHydrationData/

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function readFirstString(value: unknown): string | undefined {
  return Array.isArray(value)
    ? value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined
}

export function readNestedString(
  record: Record<string, unknown>,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    let value: unknown = record

    for (const segment of path) {
      value = asRecord(value)?.[segment]
    }

    const result = readString(value)

    if (result) {
      return result
    }
  }

  return undefined
}

export function normalizeTimestamp(value: unknown): string | undefined {
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

export function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function looksLikeJson(text: string): boolean {
  return text.startsWith('{') || text.startsWith('[')
}

export function looksLikeHydrationBootstrap(text: string): boolean {
  return (
    text.includes('__staticRouterHydrationData') ||
    text.includes('__reactRouterDataRouter') ||
    text.includes('__remixContext')
  )
}

export function hasStructuredPayloadHint(text: string): boolean {
  return STRUCTURED_PAYLOAD_HINT.test(text)
}

export function compactBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const compacted: ContentBlock[] = []

  for (const block of blocks) {
    if (!isMeaningfulBlock(block)) {
      continue
    }

    const previous = compacted.at(-1)

    if (previous?.kind === 'text' && block.kind === 'text') {
      previous.text = `${previous.text}\n\n${block.text}`.trim()
      continue
    }

    compacted.push(block)
  }

  return compacted
}

export function isMeaningfulBlock(block: ContentBlock): boolean {
  switch (block.kind) {
    case 'text':
      return block.text.trim().length > 0
    case 'code':
      return block.code.trim().length > 0
    case 'quote':
      return block.text.trim().length > 0
    case 'list':
      return block.items.some((item) => item.trim().length > 0)
    case 'table':
      return block.headers.length > 0 || block.rows.length > 0
    case 'image':
      return Boolean(block.url || block.alt || block.label)
    case 'file':
      return block.name.trim().length > 0
    case 'unknown':
      return Boolean(block.description || block.rawText)
  }
}

export function cleanChatGptText(text: string): string {
  return text.replace(/\ue200([a-z]+)\ue202([^\ue201]*?)\ue201/g, (match, type, content) => {
    if (type === 'url') {
      const parts = content.split('\ue202')
      const linkText = parts[0] || ''
      const linkUrl = parts[1] || ''
      if (linkUrl.startsWith('http://') || linkUrl.startsWith('https://')) {
        return `[${linkText}](${linkUrl})`
      }
      return linkText
    }
    if (type === 'entity') {
      try {
        const parsed = JSON.parse(content)
        if (Array.isArray(parsed) && parsed.length >= 2) {
          return parsed[1]
        }
      } catch {
        const match = content.match(/"([^"]+)"/)
        if (match && match[1]) {
          return match[1]
        }
      }
      return content
    }
    if (type === 'cite') {
      return ''
    }
    return content.split('\ue202')[0] || ''
  })
}

export function textBlock(text: string): TextBlock {
  return {
    kind: 'text',
    text: cleanChatGptText(text.replace(/\r\n/g, '\n')).trim(),
  }
}

export function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
