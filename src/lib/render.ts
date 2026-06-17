import type {
  ContentBlock,
  ConvertOptions,
  NormalizedConversation,
  NormalizedMessage,
} from './types'

function formatDateTime(dateOrString: Date | string): string {
  try {
    const date = typeof dateOrString === 'string' ? new Date(dateOrString) : dateOrString
    if (Number.isNaN(date.getTime())) {
      return String(dateOrString)
    }
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ]
    const yyyy = date.getUTCFullYear()
    const month = months[date.getUTCMonth()]
    const dd = date.getUTCDate()
    let hh = date.getUTCHours()
    const min = String(date.getUTCMinutes()).padStart(2, '0')
    const ampm = hh >= 12 ? 'PM' : 'AM'
    hh = hh % 12
    hh = hh ? hh : 12
    return `${month} ${dd}, ${yyyy} at ${hh}:${min} ${ampm} UTC`
  } catch {
    return String(dateOrString)
  }
}

export function renderConversationToMarkdown(
  conversation: NormalizedConversation,
  options: Pick<
    ConvertOptions,
    'exportedAt' | 'includeMetadata' | 'includeSystemMessages'
  > = {},
): string {
  const title = cleanText(conversation.title) || 'Shared Conversation'
  const includeMetadata = options.includeMetadata !== false
  const includeSystemMessages = options.includeSystemMessages === true
  const sections: string[] = [`# ${title}`]

  if (includeMetadata) {
    sections.push(
      [
        `Source: ${conversation.sourceUrl}`,
        `Exported: ${formatDateTime(options.exportedAt ?? new Date())}`,
        conversation.createdAt
          ? `Conversation Created: ${formatDateTime(conversation.createdAt)}`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  const messages = includeSystemMessages
    ? conversation.messages
    : conversation.messages.filter((message) => message.role !== 'system')

  for (const message of messages) {
    sections.push(renderMessage(message, conversation.sourceUrl))
  }

  return `${sections.join('\n\n').trim()}\n`
}

function renderMessage(message: NormalizedMessage, sourceUrl: string): string {
  const heading = renderHeading(message)
  const body = message.blocks.length
    ? message.blocks.map((block) => renderBlock(block, sourceUrl)).filter(Boolean).join('\n\n')
    : '[No visible content]'

  return `${heading}\n\n${body}`
}

function renderHeading(message: NormalizedMessage): string {
  const role = capitalize(message.role)
  const authorLabel = message.authorName ? cleanText(message.authorName) : ''

  if (authorLabel && authorLabel.toLowerCase() !== role.toLowerCase()) {
    return `## ${role} (${authorLabel})`
  }

  return `## ${role}`
}

function renderBlock(block: ContentBlock, sourceUrl: string): string {
  switch (block.kind) {
    case 'text':
      if (block.text.includes('|')) {
        console.log('[chatdump:debug] Text block with | :', block.text.slice(0, 100) + '...')
      }
      return block.text.trim()
    case 'code':
      return renderCodeBlock(block.language, block.code)
    case 'quote':
      return block.text
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'list':
      return block.items
        .map((item, index) => {
          const prefix = block.ordered ? `${index + 1}. ` : '- '
          const lines = item.trim().split('\n')

          return lines
            .map((line, lineIndex) =>
              lineIndex === 0 ? `${prefix}${line}` : `  ${line}`,
            )
            .join('\n')
        })
        .join('\n')
    case 'table':
      return renderTable(block.headers, block.rows)
    case 'image':
      if (block.url) {
        return `![${block.alt ?? block.label ?? 'Image'}](${resolveBlockUrl(block.url, sourceUrl)})`
      }

      return `[Image: ${block.alt ?? block.label ?? 'unnamed'}]`
    case 'file':
      return block.url
        ? `[Attachment: ${block.name}](${resolveBlockUrl(block.url, sourceUrl)})`
        : `[Attachment: ${block.name}]`
    case 'unknown':
      if (block.rawText?.trim()) {
        return block.rawText.trim()
      }

      return `[Unsupported content block: ${block.description}]`
  }
}

function resolveBlockUrl(url: string, sourceUrl: string): string {
  const trimmed = url.trim()

  if (!trimmed) {
    return url
  }

  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
      return new URL(trimmed, sourceUrl).toString()
    }

    const base = new URL(sourceUrl)
    const normalizedPath =
      trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')
        ? trimmed
        : `/${trimmed}`

    return new URL(normalizedPath, base.origin).toString()
  } catch {
    return url
  }
}

function renderCodeBlock(language: string | undefined, code: string): string {
  const trimmed = code.replace(/\n+$/, '')
  const info = language?.trim() ?? ''

  return `\`\`\`${info}\n${trimmed}\n\`\`\``
}

function renderTable(headers: string[], rows: string[][]): string {
  const normalizedHeaders =
    headers.length > 0 ? headers : rows[0]?.map((_, index) => `Column ${index + 1}`) ?? []
  const normalizedRows = headers.length > 0 ? rows : rows.slice(1)

  if (normalizedHeaders.length === 0) {
    return ''
  }

  const headerRow = `| ${normalizedHeaders.map(escapeCell).join(' | ')} |`
  const separator = `| ${normalizedHeaders.map(() => '---').join(' | ')} |`
  const body = normalizedRows.map((row) => {
    const padded = normalizedHeaders.map((_, index) => escapeCell(row[index] ?? ''))
    return `| ${padded.join(' | ')} |`
  })

  return [headerRow, separator, ...body].join('\n')
}

function escapeCell(value: string): string {
  return cleanText(value)
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>')
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : 'Unknown'
}

function cleanText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}
