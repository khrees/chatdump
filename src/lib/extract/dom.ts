import { load, type CheerioAPI } from 'cheerio'
import type { AnyNode, Element } from 'domhandler'
import type { CodeBlock, ContentBlock, ImageBlock, ListBlock, MessageRole, NormalizedConversation, NormalizedMessage, QuoteBlock, TableBlock } from '../types'
import { getDefaultConversationTitle, tryNormalizeShareUrl } from '../url'
import { normalizeInlineText, textBlock, BLOCK_TAGS } from './utils'

export function extractDomConversation(
  $: CheerioAPI,
  sourceUrl: string,
): NormalizedConversation | null {
  const claudeDomConversation = extractClaudeDomConversation($, sourceUrl)

  if (claudeDomConversation) {
    return claudeDomConversation
  }

  const metaDomConversation = extractMetaDomConversation($, sourceUrl)

  if (metaDomConversation) {
    return metaDomConversation
  }

  const elements = $('[data-message-author-role]').toArray()

  if (elements.length === 0) {
    return null
  }

  const messages: NormalizedMessage[] = []

  elements.forEach((element, index) => {
    const role = normalizeDomRole($(element).attr('data-message-author-role'))
    const blocks = compactBlocks(extractBlocksFromNodes($(element).contents().toArray(), $))

    if (blocks.length === 0) {
      return
    }

    messages.push({
      blocks,
      id: `dom-${index + 1}`,
      role,
    })
  })

  if (messages.length === 0) {
    return null
  }

  return {
    messages,
    sourceUrl,
    title: extractPageTitle($, sourceUrl),
  }
}

export function extractClaudeDomConversation(
  $: CheerioAPI,
  sourceUrl: string,
): NormalizedConversation | null {
  if (tryNormalizeShareUrl(sourceUrl)?.provider !== 'claude') {
    return null
  }

  const elements = $('[data-testid="user-message"], .font-claude-response, .standard-markdown')
    .toArray()
    .filter((element) => {
      const parentMatch = $(element)
        .parents('[data-testid="user-message"], .font-claude-response, .standard-markdown')
        .first()

      return parentMatch.length === 0
    })

  if (elements.length === 0) {
    return null
  }

  const messages: NormalizedMessage[] = []

  elements.forEach((element, index) => {
    const isUser = $(element).attr('data-testid') === 'user-message'
    const role: MessageRole = isUser ? 'user' : 'assistant'
    const blocks = compactBlocks([
      ...extractBlocksFromNodes($(element).contents().toArray(), $),
      ...(role === 'assistant' ? extractClaudeDomImageBlocks(element, $) : []),
    ])

    if (blocks.length === 0) {
      return
    }

    messages.push({
      blocks,
      id: `claude-dom-${index + 1}`,
      role,
    })
  })

  if (messages.length === 0) {
    return null
  }

  return {
    messages,
    sourceUrl,
    title: extractPageTitle($, sourceUrl),
  }
}

export function extractMetaDomConversation(
  $: CheerioAPI,
  sourceUrl: string,
): NormalizedConversation | null {
  if (tryNormalizeShareUrl(sourceUrl)?.provider !== 'meta') {
    return null
  }

  const elements = $('.group\\/message-row').toArray()

  if (elements.length === 0) {
    return null
  }

  const messages: NormalizedMessage[] = []

  elements.forEach((element, index) => {
    const el = $(element)
    const isUser = el.find('.group\\/user-message').length > 0
    const role: MessageRole = isUser ? 'user' : 'assistant'

    let blocks: ContentBlock[] = []
    if (isUser) {
      const contentElement = el.find('.bg-accent-surface')
      blocks = compactBlocks(extractBlocksFromNodes(contentElement.contents().toArray(), $))
    } else {
      // Meta AI assistant messages can have multiple .markdown-content blocks
      // (e.g. one for thinking, one for the actual response).
      const markdownBlocks = el.find('.markdown-content').toArray()
      for (const mb of markdownBlocks) {
        const mbBlocks = extractBlocksFromNodes($(mb).contents().toArray(), $)
        // Filter out the "Show thinking" trigger block
        const filteredBlocks = mbBlocks.filter(block => {
          if (block.kind === 'text' && block.text.includes('Show thinking')) {
            return block.text.trim() !== 'Show thinking'
          }
          return true
        })
        blocks.push(...filteredBlocks)
      }
      blocks = compactBlocks(blocks)
    }

    if (blocks.length === 0) {
      return
    }

    messages.push({
      blocks,
      id: `meta-dom-${index + 1}`,
      role,
    })
  })

  if (messages.length === 0) {
    return null
  }

  return {
    messages,
    sourceUrl,
    title: extractPageTitle($, sourceUrl),
  }
}

function extractClaudeDomImageBlocks(
  element: AnyNode,
  $: CheerioAPI,
): ImageBlock[] {
  const seen = new Set<string>()

  return $(element)
    .find('img')
    .toArray()
    .map((image) => extractImageBlock(image, $))
    .filter((block) => {
      if (!block.url || isClaudeDecorativeImage(block.url)) {
        return false
      }

      if (seen.has(block.url)) {
        return false
      }

      seen.add(block.url)
      return true
    })
}

function isClaudeDecorativeImage(url: string): boolean {
  return /google\.com\/s2\/favicons/i.test(url)
}

export function mergeDomImagesIntoConversation(
  structured: NormalizedConversation,
  dom: NormalizedConversation,
): NormalizedConversation {
  const messages = structured.messages.map((message, index) =>
    mergeDomImagesIntoMessage(message, dom.messages[index]),
  )

  return {
    ...structured,
    messages,
  }
}

function mergeDomImagesIntoMessage(
  message: NormalizedMessage,
  domMessage: NormalizedMessage | undefined,
): NormalizedMessage {
  if (!domMessage || domMessage.role !== message.role) {
    return message
  }

  const domImages = domMessage.blocks.filter(
    (block): block is ImageBlock => block.kind === 'image' && Boolean(block.url),
  )

  if (domImages.length === 0) {
    return message
  }

  let domImageIndex = 0
  let changed = false
  const mergedBlocks = message.blocks.map((block) => {
    if (block.kind !== 'image' || block.url) {
      return block
    }

    const replacement = domImages[domImageIndex]

    if (!replacement) {
      return block
    }

    domImageIndex += 1
    changed = true

    return {
      ...replacement,
      alt: block.alt ?? replacement.alt,
      label: block.label ?? replacement.label,
    }
  })

  const hasStructuredImages = message.blocks.some((block) => block.kind === 'image')
  const extraDomImages = !hasStructuredImages ? domImages : domImages.slice(domImageIndex)

  if (extraDomImages.length > 0) {
    changed = true
    mergedBlocks.push(...extraDomImages)
  }

  return changed
    ? {
        ...message,
        blocks: compactBlocks(mergedBlocks),
      }
    : message
}

function normalizeDomRole(value: string | undefined): MessageRole {
  switch ((value ?? '').toLowerCase()) {
    case 'assistant':
      return 'assistant'
    case 'system':
      return 'system'
    case 'user':
      return 'user'
    default:
      return 'unknown'
  }
}

export function extractBlocksFromNodes(nodes: AnyNode[], $: CheerioAPI): ContentBlock[] {
  const blocks = nodes.flatMap((node) => extractBlocksFromNode(node, $))
  return compactBlocks(blocks)
}

function extractBlocksFromNode(node: AnyNode, $: CheerioAPI): ContentBlock[] {
  if (node.type === 'text') {
    const text = normalizeInlineText(node.data)
    return text ? [textBlock(text)] : []
  }

  if (node.type !== 'tag') {
    return []
  }

  const element = node as Element
  const tag = element.tagName.toLowerCase()

  switch (tag) {
    case 'pre':
      return [extractCodeBlock(element, $)]
    case 'blockquote':
      return [extractQuoteBlock(element, $)]
    case 'ul':
    case 'ol':
      return [extractListBlock(element, $, tag === 'ol')]
    case 'table':
      return [extractTableBlock(element, $)]
    case 'img':
      return [extractImageBlock(element, $)]
    case 'article':
    case 'div':
    case 'section':
      if (hasNestedBlockChildren(element)) {
        return extractBlocksFromNodes(element.children, $)
      }

      return paragraphBlock(element, $)
    case 'p':
      return paragraphBlock(element, $)
    default: {
      const inline = renderInlineNodes(element.children, $)
      return inline ? [textBlock(inline)] : []
    }
  }
}

function paragraphBlock(element: Element, $: CheerioAPI): ContentBlock[] {
  const inline = renderInlineNodes(element.children, $)
  return inline ? [textBlock(inline)] : []
}

function hasNestedBlockChildren(element: Element): boolean {
  return element.children.some(
    (child) => child.type === 'tag' && BLOCK_TAGS.has((child as Element).tagName),
  )
}

function extractCodeBlock(element: Element, $: CheerioAPI): CodeBlock {
  const codeElement = $(element).find('code').first()
  const languageClass = codeElement.attr('class') ?? ''
  const languageMatch = languageClass.match(/language-([\w-]+)/)

  return {
    code: codeElement.text() || $(element).text(),
    kind: 'code',
    language: languageMatch?.[1],
  }
}

function extractQuoteBlock(element: Element, $: CheerioAPI): QuoteBlock {
  return {
    kind: 'quote',
    text: renderInlineNodes(element.children, $),
  }
}

function extractListBlock(
  element: Element,
  $: CheerioAPI,
  ordered: boolean,
): ListBlock {
  const items = $(element)
    .children('li')
    .toArray()
    .map((item) => {
      const cloned = $(item).clone()

      cloned.children('ul, ol').remove()

      const primary = renderInlineNodes(cloned.contents().toArray(), $)
      const nested = $(item)
        .children('ul, ol')
        .toArray()
        .map((list) =>
          $(list)
            .children('li')
            .toArray()
            .map((nestedItem, index) => {
              const prefix = list.tagName.toLowerCase() === 'ol' ? `${index + 1}. ` : '- '
              return `${prefix}${renderInlineNodes($(nestedItem).contents().toArray(), $)}`
            })
            .join('\n'),
        )
        .filter(Boolean)
        .join('\n')

      return [primary, nested].filter(Boolean).join('\n')
    })
    .filter(Boolean)

  return {
    items,
    kind: 'list',
    ordered,
  }
}

function extractTableBlock(element: Element, $: CheerioAPI): TableBlock {
  const rows = $(element)
    .find('tr')
    .toArray()
    .map((row) =>
      $(row)
        .children('th, td')
        .toArray()
        .map((cell) => renderInlineNodes($(cell).contents().toArray(), $)),
    )
    .filter((row) => row.length > 0)

  if (rows.length === 0) {
    return {
      headers: [],
      kind: 'table',
      rows: [],
    }
  }

  const headerCells = $(element)
    .find('thead tr')
    .first()
    .children('th, td')
    .toArray()
    .map((cell) => renderInlineNodes($(cell).contents().toArray(), $))

  return {
    headers: headerCells.length > 0 ? headerCells : rows[0] ?? [],
    kind: 'table',
    rows: headerCells.length > 0 ? rows.slice(1) : rows,
  }
}

function extractImageBlock(element: Element, $: CheerioAPI): ImageBlock {
  return {
    alt: $(element).attr('alt') ?? undefined,
    kind: 'image',
    label: $(element).attr('title') ?? undefined,
    url: $(element).attr('src') ?? undefined,
  }
}

function renderInlineNodes(nodes: AnyNode[], $: CheerioAPI): string {
  const rendered = nodes.map((node) => renderInlineNode(node, $)).join('')
  return rendered
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function renderInlineNode(node: AnyNode, $: CheerioAPI): string {
  if (node.type === 'text') {
    return normalizeInlineText(node.data)
  }

  if (node.type !== 'tag') {
    return ''
  }

  const element = node as Element
  const tag = element.tagName.toLowerCase()

  switch (tag) {
    case 'br':
      return '\n'
    case 'strong':
    case 'b':
      return wrap('**', renderInlineNodes(element.children, $))
    case 'em':
    case 'i':
      return wrap('*', renderInlineNodes(element.children, $))
    case 'code':
      return wrap('`', renderInlineNodes(element.children, $))
    case 'a': {
      const href = $(element).attr('href')
      const label = renderInlineNodes(element.children, $) || href || ''
      return href ? `[${label}](${href})` : label
    }
    case 'img': {
      const alt = $(element).attr('alt') || 'Image'
      const src = $(element).attr('src')
      return src ? `![${alt}](${src})` : `[Image: ${alt}]`
    }
    default:
      return renderInlineNodes(element.children, $)
  }
}

function wrap(token: string, text: string): string {
  if (!text) {
    return ''
  }

  return `${token}${text}${token}`
}

function compactBlocks(blocks: ContentBlock[]): ContentBlock[] {
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

function isMeaningfulBlock(block: ContentBlock): boolean {
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

export function extractPageTitle($: CheerioAPI, sourceUrl?: string): string {
  const rawTitle =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').text().trim()
  const cleanedTitle = rawTitle
    .replace(/^[\u200e\u200f\u202a-\u202e]+/gu, '')
    .replace(/\s*-\s*ChatGPT$/i, '')
    .replace(/^Gemini\s*-\s*/i, '')
    .replace(/\s*-\s*Gemini$/i, '')
    .trim()

  return cleanedTitle || getDefaultConversationTitle(sourceUrl)
}

