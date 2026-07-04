import type { CodeBlock, ContentBlock, FileBlock, ImageBlock, MessageRole, NormalizedConversation, NormalizedMessage } from '../types'
import { looksLikeMappingConversation, looksLikeMessagesConversation } from './candidates'
import { asRecord, compactBlocks, normalizeTimestamp, readFirstString, readNestedString, readString, textBlock } from './utils'

export function normalizeConversationCandidate(
  candidate: unknown,
  sourceUrl: string,
  pageTitle: string,
): NormalizedConversation | null {
  if (looksLikeMappingConversation(candidate)) {
    return normalizeMappingConversation(
      candidate as Record<string, unknown>,
      sourceUrl,
      pageTitle,
    )
  }

  if (looksLikeMessagesConversation(candidate)) {
    return normalizeMessagesConversation(
      candidate as Record<string, unknown>,
      sourceUrl,
      pageTitle,
    )
  }

  return null
}

function normalizeMappingConversation(
  candidate: Record<string, unknown>,
  sourceUrl: string,
  pageTitle: string,
): NormalizedConversation | null {
  const mappingValue = candidate.mapping

  if (!mappingValue || typeof mappingValue !== 'object' || Array.isArray(mappingValue)) {
    return null
  }

  const mapping = mappingValue as Record<string, Record<string, unknown>>
  const orderedIds: string[] = []
  const visited = new Set<string>()

  const roots = Object.entries(mapping)
    .filter(([, node]) => {
      const parent = typeof node.parent === 'string' ? node.parent : undefined
      return !parent || !mapping[parent]
    })
    .map(([id]) => id)

  function walk(id: string) {
    if (visited.has(id) || !mapping[id]) {
      return
    }

    visited.add(id)
    orderedIds.push(id)

    const children = Array.isArray(mapping[id].children)
      ? mapping[id].children.filter((child): child is string => typeof child === 'string')
      : []

    for (const child of children) {
      walk(child)
    }
  }

  for (const rootId of roots) {
    walk(rootId)
  }

  for (const id of Object.keys(mapping)) {
    walk(id)
  }

  const messages = orderedIds
    .map((id) => normalizeMessage(mapping[id].message, id))
    .filter((message): message is NormalizedMessage => Boolean(message))

  if (messages.length === 0) {
    return null
  }

  return {
    conversationId:
      readString(candidate.conversation_id) ?? readString(candidate.id) ?? undefined,
    createdAt:
      normalizeTimestamp(candidate.create_time) ??
      normalizeTimestamp(candidate.created_at) ??
      messages[0]?.createdAt,
    messages,
    sourceUrl,
    title:
      readString(candidate.title) ??
      readString(candidate.name) ??
      pageTitle,
  }
}

function normalizeMessagesConversation(
  candidate: Record<string, unknown>,
  sourceUrl: string,
  pageTitle: string,
): NormalizedConversation | null {
  const messageList = candidate.messages

  if (!Array.isArray(messageList)) {
    return null
  }

  const normalized = messageList
    .map((message, index) => normalizeMessage(message, `message-${index + 1}`))
    .filter((message): message is NormalizedMessage => Boolean(message))

  if (normalized.length === 0) {
    return null
  }

  normalized.sort((left, right) => {
    if (!left.createdAt || !right.createdAt) {
      return 0
    }

    return left.createdAt.localeCompare(right.createdAt)
  })

  return {
    conversationId:
      readString(candidate.conversation_id) ?? readString(candidate.id) ?? undefined,
    createdAt:
      normalizeTimestamp(candidate.create_time) ??
      normalizeTimestamp(candidate.created_at) ??
      normalized[0]?.createdAt,
    messages: normalized,
    sourceUrl,
    title:
      readString(candidate.title) ??
      readString(candidate.name) ??
      pageTitle,
  }
}

function normalizeMessage(
  candidate: unknown,
  fallbackId: string,
): NormalizedMessage | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null
  }

  const message = candidate as Record<string, unknown>
  const role = normalizeRole(message)
  const blocks = compactBlocks([
    ...extractMessageBlocks(message),
    ...extractAttachments(message),
  ])

  if (blocks.length === 0) {
    return null
  }

  if (shouldDropMessage(role, blocks)) {
    return null
  }

  return {
    authorName: normalizeAuthorName(message),
    blocks,
    createdAt:
      normalizeTimestamp(message.create_time) ??
      normalizeTimestamp(message.created_at) ??
      undefined,
    id: readString(message.id) ?? fallbackId,
    role,
  }
}

function extractMessageBlocks(message: Record<string, unknown>): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const content = asRecord(message.content) ?? asRecord(message.message)

  if (typeof message.text === 'string') {
    blocks.push(textBlock(message.text))
  }

  if (!content) {
    return blocks
  }

  const contentType = readString(content.content_type) ?? readString(content.type)

  if (contentType === 'code') {
    const codeText =
      readString(content.text) ??
      readString(content.code) ??
      readFirstString(content.parts) ??
      ''

    if (looksLikeDallECodeBlock(codeText)) {
      blocks.push(textBlock('[DALL-E Image Generated]'))
    } else {
      blocks.push({
        code: codeText,
        kind: 'code',
        language: readString(content.language),
      } satisfies CodeBlock)
    }

    return blocks
  }

  for (const part of readParts(content)) {
    blocks.push(...normalizePart(part))
  }

  if (blocks.length === 0) {
    if (typeof content.text === 'string') {
      blocks.push(textBlock(content.text))
    } else if (Array.isArray(content.text)) {
      for (const part of content.text) {
        if (typeof part === 'string') {
          blocks.push(textBlock(part))
        }
      }
    }
  }

  return blocks
}

function readParts(content: Record<string, unknown>): unknown[] {
  if (Array.isArray(content.parts)) {
    return content.parts
  }

  if (typeof content.text === 'string') {
    return [content.text]
  }

  if (Array.isArray(content.text)) {
    return content.text
  }

  return []
}

function normalizePart(part: unknown): ContentBlock[] {
  if (typeof part === 'string') {
    return [textBlock(part)]
  }

  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return []
  }

  const record = part as Record<string, unknown>
  const type = readString(record.content_type) ?? readString(record.type)
  const imageBlock = normalizeImageRecord(record, type)

  if (imageBlock) {
    return [imageBlock]
  }

  if (type === 'code') {
    const codeText =
      readString(record.text) ??
      readString(record.code) ??
      readFirstString(record.parts) ??
      ''

    if (looksLikeDallEParameters(record) || looksLikeDallECodeBlock(codeText)) {
      return [textBlock('[DALL-E Image Generated]')]
    }
    return [
      {
        code: codeText,
        kind: 'code',
        language: readString(record.language),
      } satisfies CodeBlock,
    ]
  }

  if (type === 'file') {
    return [
      {
        kind: 'file',
        name: readString(record.name) ?? 'attachment',
        url: readString(record.url),
      } satisfies FileBlock,
    ]
  }

  if (typeof record.text === 'string') {
    return [textBlock(record.text)]
  }

  if (Array.isArray(record.parts)) {
    return record.parts.flatMap((nested) => normalizePart(nested))
  }

  if (looksLikeDallEParameters(record)) {
    const size = readString(record.size) ?? record.size
    const prompt = readString(record.prompt)
    if (prompt) {
      return [textBlock(`[DALL-E: ${prompt}]`)]
    }
    return [textBlock(`[DALL-E Image: ${size}]`)]
  }

  return []
}

function normalizeImageRecord(
  record: Record<string, unknown>,
  type?: string,
): ImageBlock | null {
  const mimeType =
    readString(record.mime_type) ??
    readString(record.mimeType) ??
    readString(record.contentType)
  const url =
    readString(record.url) ??
    readString(record.download_url) ??
    readString(record.downloadUrl) ??
    readString(record.image_url) ??
    readString(record.imageUrl) ??
    readString(record.src) ??
    readNestedString(record, [
      ['metadata', 'url'],
      ['metadata', 'download_url'],
      ['metadata', 'downloadUrl'],
      ['metadata', 'image_url'],
      ['metadata', 'imageUrl'],
      ['asset', 'url'],
      ['asset', 'download_url'],
      ['asset', 'downloadUrl'],
      ['asset', 'image_url'],
      ['asset', 'imageUrl'],
      ['file', 'url'],
      ['file', 'download_url'],
      ['file', 'downloadUrl'],
    ])
  const assetPointer =
    readString(record.asset_pointer) ??
    readString(record.assetPointer) ??
    readNestedString(record, [
      ['asset', 'asset_pointer'],
      ['asset', 'assetPointer'],
      ['metadata', 'asset_pointer'],
      ['metadata', 'assetPointer'],
    ])
  const isImageLike =
    type === 'image' ||
    type === 'image_url' ||
    type === 'image_asset_pointer' ||
    mimeType?.startsWith('image/') === true ||
    Boolean(url) ||
    Boolean(assetPointer)

  if (!isImageLike) {
    return null
  }

  const label =
    readString(record.alt) ??
    readString(record.name) ??
    readString(record.label) ??
    readString(record.title) ??
    readString(record.file_name) ??
    readString(record.filename) ??
    (assetPointer ? 'Generated image' : undefined)

  return {
    alt: readString(record.alt) ?? label,
    kind: 'image',
    label,
    url,
  }
}

function looksLikeDallEParameters(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record)
  const hasSizeField = keys.includes('size')
  const hasNField = keys.includes('n')
  const hasPromptField = keys.includes('prompt')
  const hasRevisionsField = keys.includes('revisions')
  const hasStyleField = keys.includes('style')
  return (
    (hasSizeField && hasNField) ||
    hasPromptField ||
    hasRevisionsField ||
    hasStyleField
  )
}

function looksLikeDallECodeBlock(codeText: string): boolean {
  if (!codeText.trim()) return false
  try {
    const parsed = JSON.parse(codeText)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    const keys = Object.keys(parsed)
    return (
      (keys.includes('size') && keys.includes('n')) ||
      keys.includes('prompt') ||
      keys.includes('revisions') ||
      keys.includes('style')
    )
  } catch {
    return false
  }
}

function extractAttachments(message: Record<string, unknown>): ContentBlock[] {
  const attachmentCollections = [
    message.attachments,
    asRecord(message.metadata)?.attachments,
  ]

  const blocks: ContentBlock[] = []

  for (const collection of attachmentCollections) {
    if (!Array.isArray(collection)) {
      continue
    }

    for (const entry of collection) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue
      }

      const attachment = entry as Record<string, unknown>
      const name =
        readString(attachment.name) ??
        readString(attachment.filename) ??
        readString(attachment.display_name) ??
        'attachment'
      const url =
        readString(attachment.url) ??
        readString(attachment.download_url) ??
        readString(attachment.downloadUrl) ??
        readString(attachment.image_url) ??
        readString(attachment.imageUrl)
      const mimeType =
        readString(attachment.mime_type) ??
        readString(attachment.mimeType) ??
        readString(attachment.contentType)

      if (mimeType?.startsWith('image/')) {
        blocks.push({
          alt: name,
          kind: 'image',
          label: name,
          url,
        } satisfies ImageBlock)
      } else {
        blocks.push({
          kind: 'file',
          name,
          url,
        } satisfies FileBlock)
      }
    }
  }

  return blocks
}

function normalizeRole(message: Record<string, unknown>): MessageRole {
  const author = asRecord(message.author)
  const rawRole =
    readString(author?.role) ??
    readString(message.role) ??
    readString(message.author_role) ??
    'unknown'

  switch (rawRole.toLowerCase()) {
    case 'assistant':
      return 'assistant'
    case 'system':
      return 'system'
    case 'user':
    case 'human':
      return 'user'
    default:
      return 'unknown'
  }
}

function shouldDropMessage(role: MessageRole, blocks: ContentBlock[]): boolean {
  if (role !== 'unknown') {
    return false
  }

  return blocks.every((block) => {
    if (block.kind === 'image') {
      return !block.url
    }

    if (block.kind === 'text') {
      return block.text === '[DALL-E Image Generated]'
    }

    return false
  })
}

function normalizeAuthorName(message: Record<string, unknown>): string | undefined {
  const author = asRecord(message.author)
  return (
    readString(author?.name) ??
    readString(asRecord(message.metadata)?.model_slug) ??
    undefined
  )
}
