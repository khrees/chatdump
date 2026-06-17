import type { ContentBlock, NormalizedConversation, NormalizedMessage } from '../types'
import type { ChatMessage, ChatProvider, ChatSession } from './types'

export function createSessionFromConversation(
  conversation: NormalizedConversation,
  model: string,
  provider: ChatProvider,
): ChatSession {
  const messages: ChatMessage[] = conversation.messages
    .filter((msg) => msg.role !== 'system')
    .map(normalizedToChatMessage)

  return {
    id: generateSessionId(),
    sourceConversation: conversation,
    messages,
    model,
    provider,
  }
}

export function appendUserMessage(session: ChatSession, content: string): ChatSession {
  return {
    ...session,
    messages: [...session.messages, { role: 'user', content }],
  }
}

export function appendAssistantMessage(session: ChatSession, content: string): ChatSession {
  return {
    ...session,
    messages: [...session.messages, { role: 'assistant', content }],
  }
}

export function generateSessionId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 10)
  return `session-${timestamp}-${random}`
}

function normalizedToChatMessage(message: NormalizedMessage): ChatMessage {
  const role = message.role === 'user' ? 'user' : 'assistant'
  const content = message.blocks.map(renderBlockToText).filter(Boolean).join('\n\n')

  return { role, content: content || '[No content]' }
}

function renderBlockToText(block: ContentBlock): string {
  switch (block.kind) {
    case 'text':
      return block.text.trim()
    case 'code': {
      const lang = block.language?.trim() ?? ''
      return `\`\`\`${lang}\n${block.code.replace(/\n+$/, '')}\n\`\`\``
    }
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
          return `${prefix}${item.trim()}`
        })
        .join('\n')
    case 'image':
      if (block.url) {
        return `![${block.alt ?? block.label ?? 'Image'}](${block.url})`
      }
      return `[Image: ${block.alt ?? block.label ?? 'unnamed'}]`
    case 'table': {
      if (block.headers.length === 0 && block.rows.length === 0) return ''
      const headers = block.headers.length > 0
        ? block.headers
        : block.rows[0]?.map((_, i) => `Column ${i + 1}`) ?? []
      const rows = block.headers.length > 0 ? block.rows : block.rows.slice(1)
      const headerRow = `| ${headers.join(' | ')} |`
      const separator = `| ${headers.map(() => '---').join(' | ')} |`
      const body = rows.map((row) => `| ${headers.map((_, i) => row[i] ?? '').join(' | ')} |`)
      return [headerRow, separator, ...body].join('\n')
    }
    case 'file':
      return block.url
        ? `[Attachment: ${block.name}](${block.url})`
        : `[Attachment: ${block.name}]`
    case 'unknown':
      return block.rawText?.trim() ?? ''
  }
}
