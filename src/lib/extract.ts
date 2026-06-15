import { load, type CheerioAPI } from 'cheerio'
import type { AnyNode, Element } from 'domhandler'
import { extractConversationInBrowser } from './browser'
import { ChatdumpError } from './errors'
import {
  createClaudeSnapshotApiUrl,
  extractClaudeConversationPayloads,
} from './claude'
import { handleClaudeSnapshotProxyRequest } from './claude-proxy'
import {
  createCopilotShareConversationApiUrl,
  extractCopilotConversationPayloads,
} from './copilot'
import {
  createGrokShareConversationApiUrl,
  extractGrokConversationPayloads,
} from './grok'
import { renderConversationToMarkdown } from './render'
import type {
  BrowserExtractor,
  CodeBlock,
  ContentBlock,
  ConvertOptions,
  ConvertResult,
  FileBlock,
  FetchImpl,
  ImageBlock,
  ListBlock,
  MessageRole,
  NormalizedConversation,
  NormalizedMessage,
  QuoteBlock,
  TableBlock,
  TextBlock,
} from './types'
import { getOrCreateCachedShareConversation } from './share-cache'
import {
  getDefaultConversationTitle,
  normalizeShareUrl,
  tryNormalizeShareUrl,
} from './url'

const BLOCK_TAGS = new Set([
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

const STRUCTURED_PAYLOAD_HINT =
  /("__NEXT_DATA__"|"loaderData"|"mapping"|"messages"|"conversation_id"|"serverResponse")|__NEXT_DATA__|__remixContext|__reactRouterDataRouter|__staticRouterHydrationData/

export async function convertShareUrlToMarkdown(
  rawUrl: string,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  const { provider, url } = normalizeShareUrl(rawUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const loader = async () => {
    const { conversation, warnings } = await loadShareConversation(url, {
      browserExtractor: options.browserExtractor,
      enableBrowserFallback: options.enableBrowserFallback,
      fetchImpl,
      provider,
    })

    return {
      conversation,
      warnings,
    }
  }
  const cached = options.disableCache
    ? await loader()
    : await getOrCreateCachedShareConversation(url.toString(), loader)

  const conversation = cached.conversation

  if (options.title?.trim()) {
    conversation.title = options.title.trim()
  }

  const markdown = renderConversationToMarkdown(conversation, {
    exportedAt: options.exportedAt,
    includeMetadata: options.includeMetadata,
    includeSystemMessages: options.includeSystemMessages,
  })

  return {
    conversation,
    markdown,
    warnings: cached.warnings,
  }
}

export async function fetchSharePage(
  url: URL,
  fetchImpl: FetchImpl,
): Promise<{ finalUrl: string; html: string }> {
  let response: Response

  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'chatdump/0.1',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    })
  } catch (cause) {
    throw new ChatdumpError(
      'FETCH_FAILED',
      `failed to fetch share page: ${cause instanceof Error ? cause.message : 'network error'}`,
    )
  }

  if (!response.ok) {
    throw new ChatdumpError(
      'FETCH_FAILED',
      `failed to fetch share page: HTTP ${response.status}`,
    )
  }

  const html = await response.text()

  if (!html.trim()) {
    throw new ChatdumpError('FETCH_FAILED', 'failed to fetch share page: empty body')
  }

  return {
    finalUrl: response.url || url.toString(),
    html,
  }
}

async function loadShareConversation(
  url: URL,
  options: {
    browserExtractor?: BrowserExtractor
    enableBrowserFallback?: boolean
    fetchImpl: FetchImpl
    provider: ReturnType<typeof normalizeShareUrl>['provider']
  },
): Promise<{ conversation: NormalizedConversation; warnings: string[] }> {
  if (options.provider === 'claude') {
    return loadClaudeShareConversation(url, {
      browserExtractor: options.browserExtractor,
      enableBrowserFallback: options.enableBrowserFallback,
      fetchImpl: options.fetchImpl,
    })
  }

  if (options.provider === 'grok') {
    return loadGrokShareConversation(url, {
      browserExtractor: options.browserExtractor,
      enableBrowserFallback: options.enableBrowserFallback,
      fetchImpl: options.fetchImpl,
    })
  }

  if (options.provider === 'copilot') {
    return loadCopilotShareConversation(url, options.fetchImpl)
  }

  try {
    const { finalUrl, html } = await fetchSharePage(url, options.fetchImpl)

    return await extractConversation(html, {
      browserExtractor: options.browserExtractor,
      browserUrl: url.toString(),
      enableBrowserFallback: options.enableBrowserFallback,
      sourceUrl: finalUrl,
    })
  } catch (cause) {
    if (
      !(cause instanceof ChatdumpError) ||
      cause.code !== 'FETCH_FAILED' ||
      options.enableBrowserFallback === false
    ) {
      throw cause
    }

    console.warn('[chatdump] Share page fetch failed; trying browser fallback', {
      browserUrl: url.toString(),
      error: cause.message,
    })

    return resolveBrowserFallback(url.toString(), options.browserExtractor, cause)
  }
}

async function loadClaudeShareConversation(
  url: URL,
  options: {
    browserExtractor?: BrowserExtractor
    enableBrowserFallback?: boolean
    fetchImpl: FetchImpl
  },
): Promise<{ conversation: NormalizedConversation; warnings: string[] }> {
  // Call the proxy handler directly (no HTTP self-call) to avoid VERCEL_URL
  // auth issues. The handler fetches claude.ai/api/chat_snapshots/<id> with
  // browser-like headers that bypass Cloudflare's bot check.
  const apiUrl = createClaudeSnapshotApiUrl(url)
  const shareId = apiUrl.pathname.split('/').pop()!

  const proxyRequest = new Request(
    `http://localhost/api/claude-snapshot?shareId=${shareId}`,
  )
  const response = await handleClaudeSnapshotProxyRequest(proxyRequest)

  if (response.status === 503) {
    // 503 = Cloudflare managed challenge — fall back to browser
    const error = new ChatdumpError(
      'FETCH_FAILED',
      'Claude share links are currently blocked by Cloudflare bot protection.',
    )

    if (options.enableBrowserFallback === false) {
      throw error
    }

    console.warn('[chatdump] Claude snapshot blocked by Cloudflare; trying browser fallback', {
      browserUrl: url.toString(),
    })

    return resolveBrowserFallback(url.toString(), options.browserExtractor, error)
  }

  if (!response.ok) {
    const error = new ChatdumpError(
      'FETCH_FAILED',
      `Claude snapshot proxy returned HTTP ${response.status}`,
    )

    if (options.enableBrowserFallback === false) {
      throw error
    }

    console.warn('[chatdump] Claude snapshot proxy non-OK; trying browser fallback', {
      browserUrl: url.toString(),
      status: response.status,
    })

    return resolveBrowserFallback(url.toString(), options.browserExtractor, error)
  }

  const responseText = await response.text()
  const conversation = selectBestConversationFromPayloads(
    extractClaudeConversationPayloads(responseText),
    url.toString(),
    getDefaultConversationTitle(url.toString()),
  )

  if (!conversation) {
    const error = new ChatdumpError(
      'EXTRACT_FAILED',
      'could not extract conversation data from Claude snapshot payload',
    )

    if (options.enableBrowserFallback === false) {
      throw error
    }

    console.warn('[chatdump] Claude snapshot extraction failed; trying browser fallback', {
      browserUrl: url.toString(),
      error: error.message,
    })

    return resolveBrowserFallback(url.toString(), options.browserExtractor, error)
  }

  return {
    conversation,
    warnings: [],
  }
}

async function loadGrokShareConversation(
  url: URL,
  options: {
    browserExtractor?: BrowserExtractor
    enableBrowserFallback?: boolean
    fetchImpl: FetchImpl
  },
): Promise<{ conversation: NormalizedConversation; warnings: string[] }> {
  const apiUrl = createGrokShareConversationApiUrl(url)
  let response: Response

  try {
    response = await options.fetchImpl(apiUrl.toString(), {
      headers: {
        accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
        'user-agent': 'chatdump/0.1',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    })
  } catch (cause) {
    const error = new ChatdumpError(
      'FETCH_FAILED',
      `failed to fetch Grok share payload: ${cause instanceof Error ? cause.message : 'network error'}`,
    )

    if (options.enableBrowserFallback === false) {
      throw error
    }

    console.warn('[chatdump] Grok payload fetch failed; trying browser fallback', {
      browserUrl: url.toString(),
      error: error.message,
    })

    return resolveBrowserFallback(url.toString(), options.browserExtractor, error)
  }

  if (!response.ok) {
    const error = new ChatdumpError(
      'FETCH_FAILED',
      `failed to fetch Grok share payload: HTTP ${response.status}`,
    )

    if (options.enableBrowserFallback === false) {
      throw error
    }

    console.warn('[chatdump] Grok payload fetch returned non-OK status; trying browser fallback', {
      browserUrl: url.toString(),
      error: error.message,
    })

    return resolveBrowserFallback(url.toString(), options.browserExtractor, error)
  }

  const responseText = await response.text()
  const conversation = selectBestConversationFromPayloads(
    extractGrokConversationPayloads(responseText),
    url.toString(),
    getDefaultConversationTitle(url.toString()),
  )

  if (!conversation) {
    const error = new ChatdumpError(
      'EXTRACT_FAILED',
      'could not extract conversation data from Grok share payload',
    )

    if (options.enableBrowserFallback === false) {
      throw error
    }

    console.warn('[chatdump] Grok payload extraction failed; trying browser fallback', {
      browserUrl: url.toString(),
      error: error.message,
    })

    return resolveBrowserFallback(url.toString(), options.browserExtractor, error)
  }

  return {
    conversation,
    warnings: [],
  }
}

async function loadCopilotShareConversation(
  url: URL,
  fetchImpl: FetchImpl,
): Promise<{ conversation: NormalizedConversation; warnings: string[] }> {
  const apiUrl = createCopilotShareConversationApiUrl(url)
  let response: Response

  try {
    response = await fetchImpl(apiUrl.toString(), {
      headers: {
        accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
        'user-agent': 'chatdump/0.1',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    })
  } catch (cause) {
    throw new ChatdumpError(
      'FETCH_FAILED',
      `failed to fetch Copilot share payload: ${cause instanceof Error ? cause.message : 'network error'}`,
    )
  }

  if (!response.ok) {
    throw new ChatdumpError(
      'FETCH_FAILED',
      `failed to fetch Copilot share payload: HTTP ${response.status}`,
    )
  }

  const responseText = await response.text()
  const conversation = selectBestConversationFromPayloads(
    extractCopilotConversationPayloads(responseText),
    url.toString(),
    getDefaultConversationTitle(url.toString()),
  )

  if (!conversation) {
    throw new ChatdumpError(
      'EXTRACT_FAILED',
      'could not extract conversation data from Copilot share payload',
    )
  }

  return {
    conversation,
    warnings: [],
  }
}

async function extractConversation(
  html: string,
  options: {
    browserExtractor?: BrowserExtractor
    browserUrl: string
    enableBrowserFallback?: boolean
    sourceUrl: string
  },
): Promise<{ conversation: NormalizedConversation; warnings: string[] }> {
  try {
    return extractConversationFromHtml(html, options.sourceUrl)
  } catch (cause) {
    if (
      !(cause instanceof ChatdumpError) ||
      cause.code !== 'EXTRACT_FAILED' ||
      options.enableBrowserFallback === false
    ) {
      throw cause
    }

    console.warn('[chatdump] Static extraction failed; trying browser fallback', {
      browserUrl: options.browserUrl,
      error: cause.message,
      sourceUrl: options.sourceUrl,
    })

    const fallback = await tryBrowserFallback(
      options.browserUrl,
      options.browserExtractor,
    )

    return resolveBrowserFallbackResult(fallback, cause, 'EXTRACT_FAILED')
  }
}

async function resolveBrowserFallback(
  url: string,
  browserExtractor: BrowserExtractor | undefined,
  originalCause: ChatdumpError,
): Promise<{ conversation: NormalizedConversation; warnings: string[] }> {
  const fallback = await tryBrowserFallback(url, browserExtractor)
  return resolveBrowserFallbackResult(fallback, originalCause, originalCause.code)
}

async function tryBrowserFallback(
  url: string,
  browserExtractor?: BrowserExtractor,
): Promise<
  | {
      result: { conversation: NormalizedConversation; warnings: string[] }
      status: 'success'
    }
  | { status: 'failed'; cause: unknown }
  | { status: 'unavailable' }
> {
  const extractor = browserExtractor ?? extractConversationInBrowser
  console.info('[chatdump] Browser fallback starting', {
    extractor: browserExtractor ? 'custom' : 'default',
    url,
  })

  try {
    const browserResult = await extractor(url)

    if (!browserResult) {
      console.warn('[chatdump] Browser fallback unavailable', { url })
      return { status: 'unavailable' }
    }

    const warnings = [...(browserResult.warnings ?? [])]
    const pageTitle = browserResult.html
      ? extractPageTitle(load(browserResult.html), browserResult.sourceUrl)
      : getDefaultConversationTitle(browserResult.sourceUrl)
    const conversation = selectBestConversationFromPayloads(
      browserResult.payloads ?? [],
      browserResult.sourceUrl,
      pageTitle,
    )

    if (conversation) {
      const mergedConversation = browserResult.html
        ? mergeBrowserDomImagesIntoConversation(
            conversation,
            browserResult.html,
            browserResult.sourceUrl,
          )
        : conversation

      console.info('[chatdump] Browser fallback succeeded from extracted payloads', {
        payloadCount: browserResult.payloads?.length ?? 0,
        sourceUrl: browserResult.sourceUrl,
        url,
        warningCount: warnings.length,
      })
      return {
        result: {
          conversation: mergedConversation,
          warnings,
        },
        status: 'success',
      }
    }

    if (browserResult.html) {
      const extracted = extractConversationFromHtml(
        browserResult.html,
        browserResult.sourceUrl,
      )

      console.info('[chatdump] Browser fallback succeeded from browser HTML', {
        sourceUrl: browserResult.sourceUrl,
        url,
        warningCount: warnings.length + extracted.warnings.length,
      })

      return {
        result: {
          conversation: extracted.conversation,
          warnings: [...warnings, ...extracted.warnings],
        },
        status: 'success',
      }
    }

    return {
      cause: new ChatdumpError(
        'EXTRACT_FAILED',
        'browser fallback executed but no conversation payload or message markup was found',
      ),
      status: 'failed',
    }
  } catch (cause) {
    console.error('[chatdump] Browser fallback failed', {
      error: getFailureMessage(cause),
      url,
    })
    return {
      cause,
      status: 'failed',
    }
  }
}

function mergeBrowserDomImagesIntoConversation(
  conversation: NormalizedConversation,
  html: string,
  sourceUrl: string,
): NormalizedConversation {
  const domConversation = extractDomConversation(load(html), sourceUrl)

  if (!domConversation) {
    return conversation
  }

  return mergeDomImagesIntoConversation(conversation, domConversation)
}

function resolveBrowserFallbackResult(
  fallback:
    | {
        result: { conversation: NormalizedConversation; warnings: string[] }
        status: 'success'
      }
    | { status: 'failed'; cause: unknown }
    | { status: 'unavailable' },
  originalCause: ChatdumpError,
  errorCode: ChatdumpError['code'],
): { conversation: NormalizedConversation; warnings: string[] } {
  switch (fallback.status) {
    case 'success':
      return fallback.result
    case 'unavailable':
      throw new ChatdumpError(
        errorCode,
        `${originalCause.message}; ${getBrowserFallbackUnavailableMessage()}`,
      )
    case 'failed':
      throw new ChatdumpError(
        errorCode,
        `${originalCause.message}; browser fallback failed: ${getFailureMessage(fallback.cause)}`,
      )
  }
}

function getBrowserFallbackUnavailableMessage(): string {
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    return 'browser fallback was unavailable in this deployment; check Vercel logs for serverless runtime loading errors'
  }

  return 'install playwright to enable browser fallback'
}

function getFailureMessage(cause: unknown): string {
  const message = getRawFailureMessage(cause)
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return firstLine ?? 'unknown browser error'
}

function getRawFailureMessage(cause: unknown): string {
  if (cause instanceof ChatdumpError) {
    return cause.message
  }

  if (cause instanceof Error) {
    return cause.message
  }

  return 'unknown browser error'
}

export function extractConversationFromHtml(
  html: string,
  sourceUrl: string,
): { conversation: NormalizedConversation; warnings: string[] } {
  const $ = load(html)
  const warnings: string[] = []
  const structured = extractStructuredConversation($, sourceUrl)
  const domConversation = extractDomConversation($, sourceUrl)

  if (structured) {
    return {
      conversation: domConversation
        ? mergeDomImagesIntoConversation(structured, domConversation)
        : structured,
      warnings,
    }
  }

  if (domConversation) {
    warnings.push('Fell back to DOM extraction; formatting may be lossy.')

    return {
      conversation: domConversation,
      warnings,
    }
  }

  throw new ChatdumpError(
    'EXTRACT_FAILED',
    buildExtractionFailureMessage($, sourceUrl),
  )
}

function buildExtractionFailureMessage(
  $: CheerioAPI,
  sourceUrl: string,
): string {
  const defaultTitle = getDefaultConversationTitle(sourceUrl)
  const pageTitle = extractPageTitle($, sourceUrl)
  const scriptTexts = $('script')
    .toArray()
    .map((element) => $(element).html()?.trim() ?? '')
    .filter(Boolean)
  const hasStructuredHint = scriptTexts.some((text) => hasStructuredPayloadHint(text))
  const hasDomMessages = $('[data-message-author-role]').length > 0
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
  const looksLikeLoginPage =
    /(?:^|\b)log in(?:\b|$)/i.test(bodyText) &&
    /(?:^|\b)sign up(?:\b|$)/i.test(bodyText)
  const looksLikeAntiBotChallenge = isAntiBotChallengePage($, bodyText, scriptTexts)
  const redirectedAwayFromShare = didRedirectAwayFromShare(sourceUrl)
  const titleSuffix =
    pageTitle && pageTitle !== defaultTitle ? ` (page title: ${pageTitle})` : ''

  if (redirectedAwayFromShare) {
    return `could not extract conversation data from share page: request resolved to a non-share page (${sourceUrl})${titleSuffix}`
  }

  if (hasStructuredHint) {
    return `could not extract conversation data from share page: found embedded payload markers but could not decode a conversation payload${titleSuffix}`
  }

  if (looksLikeAntiBotChallenge) {
    return `could not extract conversation data from share page: received an anti-bot challenge page instead of the public shared conversation${titleSuffix}`
  }

  if (!hasDomMessages && looksLikeLoginPage) {
    return `could not extract conversation data from share page: received a generic page instead of a public shared conversation${titleSuffix}`
  }

  return `could not extract conversation data from share page: no conversation payload or message markup was found${titleSuffix}`
}

function didRedirectAwayFromShare(sourceUrl: string): boolean {
  return tryNormalizeShareUrl(sourceUrl) === null
}

function isAntiBotChallengePage(
  $: CheerioAPI,
  bodyText: string,
  scriptTexts: string[],
): boolean {
  const title = $('title').first().text().replace(/\s+/g, ' ').trim()
  const combinedBodyText = bodyText.toLowerCase()
  const combinedScripts = scriptTexts.join('\n')

  return (
    title.toLowerCase() === 'just a moment...' ||
    combinedBodyText.includes('performing security verification') ||
    combinedBodyText.includes('verifying you are human') ||
    combinedBodyText.includes('enable javascript and cookies to continue') ||
    combinedBodyText.includes('performance and security by cloudflare') ||
    $('#challenge-error-text').length > 0 ||
    combinedScripts.includes('_cf_chl_opt')
  )
}

function extractStructuredConversation(
  $: CheerioAPI,
  sourceUrl: string,
): NormalizedConversation | null {
  const pageTitle = extractPageTitle($, sourceUrl)
  const targetedConversation = selectBestConversationFromPayloads(
    collectFastStructuredPayloads($),
    sourceUrl,
    pageTitle,
  )

  if (targetedConversation) {
    return targetedConversation
  }

  return selectBestConversationFromPayloads(collectStructuredPayloads($), sourceUrl, pageTitle)
}

function selectBestConversationFromPayloads(
  payloads: unknown[],
  sourceUrl: string,
  pageTitle: string,
): NormalizedConversation | null {
  const preferred = selectBestConversationFromCandidates(
    payloads.flatMap((payload) => findKnownConversationCandidates(payload)),
    sourceUrl,
    pageTitle,
  )

  if (preferred) {
    return preferred
  }

  return selectBestConversationFromCandidates(
    payloads.flatMap((payload) => findConversationCandidates(payload)),
    sourceUrl,
    pageTitle,
  )
}

function selectBestConversationFromCandidates(
  candidates: unknown[],
  sourceUrl: string,
  pageTitle: string,
): NormalizedConversation | null {
  const defaultTitle = getDefaultConversationTitle(sourceUrl)
  let best: { conversation: NormalizedConversation; score: number } | null = null

  for (const candidate of candidates) {
    const conversation = normalizeConversationCandidate(
      candidate,
      sourceUrl,
      pageTitle,
    )

    if (!conversation || conversation.messages.length === 0) {
      continue
    }

    const score =
      conversation.messages.length * 10 +
      (conversation.conversationId ? 4 : 0) +
      (conversation.title !== defaultTitle ? 2 : 0)

    if (!best || score > best.score) {
      best = {
        conversation,
        score,
      }
    }
  }

  return best?.conversation ?? null
}

function collectFastStructuredPayloads($: CheerioAPI): unknown[] {
  const payloads: unknown[] = []
  const nextDataText = $('#__NEXT_DATA__').first().html()?.trim() ?? ''

  if (nextDataText) {
    const parsed = safeJsonParse(nextDataText)

    if (parsed !== null) {
      payloads.push(parsed)
    }
  }

  $('script').each((_, element) => {
    const script = $(element)

    if (script.attr('id') === '__NEXT_DATA__') {
      return
    }

    const text = script.html()?.trim() ?? ''

    if (!looksLikeHydrationBootstrap(text)) {
      return
    }

    for (const candidate of extractJsonParsePayloads(text)) {
      const parsed = safeJsonParse(candidate)

      if (parsed !== null) {
        payloads.push(parsed)
      }
    }
  })

  return payloads
}

function collectStructuredPayloads($: CheerioAPI): unknown[] {
  const payloads: unknown[] = []

  $('script').each((_, element) => {
    const script = $(element)
    const text = script.html()?.trim() ?? ''

    if (!text) {
      return
    }

    const type = script.attr('type') ?? ''
    const isJsonScript = type.includes('json') || script.attr('id') === '__NEXT_DATA__'

    if (isJsonScript || looksLikeJson(text)) {
      const parsed = safeJsonParse(text)

      if (parsed !== null) {
        payloads.push(parsed)
        return
      }
    }

    if (!hasStructuredPayloadHint(text)) {
      return
    }

    for (const candidate of extractJsonParsePayloads(text)) {
      const parsed = safeJsonParse(candidate)

      if (parsed !== null) {
        payloads.push(parsed)
      }
    }

    for (const candidate of extractBalancedJsonObjects(text)) {
      const parsed = safeJsonParse(candidate)

      if (parsed !== null) {
        payloads.push(parsed)
      }
    }
  })

  return payloads
}

function looksLikeJson(text: string): boolean {
  return text.startsWith('{') || text.startsWith('[')
}

function looksLikeHydrationBootstrap(text: string): boolean {
  return (
    text.includes('__staticRouterHydrationData') ||
    text.includes('__reactRouterDataRouter') ||
    text.includes('__remixContext')
  )
}

function hasStructuredPayloadHint(text: string): boolean {
  return STRUCTURED_PAYLOAD_HINT.test(text)
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function extractJsonParsePayloads(text: string): string[] {
  const results: string[] = []
  let searchIndex = 0

  while (searchIndex < text.length) {
    const parseIndex = text.indexOf('JSON.parse(', searchIndex)

    if (parseIndex === -1) {
      break
    }

    let index = parseIndex + 'JSON.parse('.length

    while (/\s/.test(text[index] ?? '')) {
      index += 1
    }

    const argument = readJsonParseArgument(text, index)

    if (argument && looksLikeJson(argument.value)) {
      results.push(argument.value)
      searchIndex = argument.end
      continue
    }

    searchIndex = index
  }

  return results
}

function readJsonParseArgument(
  text: string,
  index: number,
): { end: number; value: string } | null {
  if (text.startsWith('decodeURIComponent(', index)) {
    let cursor = index + 'decodeURIComponent('.length

    while (/\s/.test(text[cursor] ?? '')) {
      cursor += 1
    }

    const literal = readQuotedString(text, cursor)

    if (!literal) {
      return null
    }

    cursor = literal.end

    while (/\s/.test(text[cursor] ?? '')) {
      cursor += 1
    }

    if (text[cursor] !== ')') {
      return null
    }

    try {
      return {
        end: cursor + 1,
        value: decodeURIComponent(literal.value),
      }
    } catch {
      return null
    }
  }

  return readQuotedString(text, index)
}

function readQuotedString(
  text: string,
  start: number,
): { end: number; value: string } | null {
  const quote = text[start]

  if (quote !== '"' && quote !== '\'' && quote !== '`') {
    return null
  }

  let value = ''

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]

    if (char === '\\') {
      const escaped = decodeEscapedCharacter(text, index + 1)

      if (!escaped) {
        return null
      }

      value += escaped.value
      index = escaped.end - 1
      continue
    }

    if (char === quote) {
      return {
        end: index + 1,
        value,
      }
    }

    if (quote !== '`' && (char === '\n' || char === '\r')) {
      return null
    }

    value += char
  }

  return null
}

function decodeEscapedCharacter(
  text: string,
  index: number,
): { end: number; value: string } | null {
  const char = text[index]

  if (!char) {
    return null
  }

  switch (char) {
    case '\n':
      return { end: index + 1, value: '' }
    case '\r':
      return {
        end: text[index + 1] === '\n' ? index + 2 : index + 1,
        value: '',
      }
    case 'b':
      return { end: index + 1, value: '\b' }
    case 'f':
      return { end: index + 1, value: '\f' }
    case 'n':
      return { end: index + 1, value: '\n' }
    case 'r':
      return { end: index + 1, value: '\r' }
    case 't':
      return { end: index + 1, value: '\t' }
    case 'v':
      return { end: index + 1, value: '\v' }
    case 'x': {
      const hex = text.slice(index + 1, index + 3)

      if (!/^[\da-fA-F]{2}$/.test(hex)) {
        return null
      }

      return {
        end: index + 3,
        value: String.fromCodePoint(Number.parseInt(hex, 16)),
      }
    }
    case 'u': {
      if (text[index + 1] === '{') {
        const closingIndex = text.indexOf('}', index + 2)

        if (closingIndex === -1) {
          return null
        }

        const codePoint = text.slice(index + 2, closingIndex)

        if (!/^[\da-fA-F]+$/.test(codePoint)) {
          return null
        }

        return {
          end: closingIndex + 1,
          value: String.fromCodePoint(Number.parseInt(codePoint, 16)),
        }
      }

      const hex = text.slice(index + 1, index + 5)

      if (!/^[\da-fA-F]{4}$/.test(hex)) {
        return null
      }

      return {
        end: index + 5,
        value: String.fromCodePoint(Number.parseInt(hex, 16)),
      }
    }
    default:
      return { end: index + 1, value: char }
  }
}

function extractBalancedJsonObjects(text: string): string[] {
  const results: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  let quote = '"'

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
      }

      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        inString = false
      }

      continue
    }

    if (char === '"' || char === '\'') {
      inString = true
      quote = char
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1

      if (depth === 0) {
        const candidate = text.slice(start, index + 1)

        if (hasStructuredPayloadHint(candidate)) {
          results.push(candidate)
        }

        start = -1
      }
    }
  }

  return results
}

function findKnownConversationCandidates(root: unknown): unknown[] {
  const candidates: unknown[] = []
  const seen = new Set<unknown>()

  function add(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) {
      return
    }

    seen.add(value)
    candidates.push(value)
  }

  const record = asRecord(root)

  if (!record) {
    return candidates
  }

  add(record.shareData)
  add(record.conversation)
  add(asRecord(record.serverResponse)?.data)
  add(record.data)

  const props = asRecord(record.props)
  const pageProps = asRecord(props?.pageProps)
  add(pageProps?.shareData)
  add(pageProps?.conversation)
  add(pageProps?.data)

  collectKnownLoaderCandidates(record.loaderData, add)
  collectKnownLoaderCandidates(asRecord(record.state)?.loaderData, add)

  return candidates
}

function collectKnownLoaderCandidates(
  loaderData: unknown,
  add: (value: unknown) => void,
) {
  const record = asRecord(loaderData)

  if (!record) {
    return
  }

  for (const value of Object.values(record)) {
    add(value)
    add(asRecord(value)?.data)
    add(asRecord(asRecord(value)?.serverResponse)?.data)
  }
}

function findConversationCandidates(root: unknown): unknown[] {
  const seen = new Set<unknown>()
  const candidates: unknown[] = []

  function visit(value: unknown) {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return
    }

    seen.add(value)

    if (looksLikeMappingConversation(value) || looksLikeMessagesConversation(value)) {
      candidates.push(value)
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item)
      }
      return
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      visit(child)
    }
  }

  visit(root)

  return candidates
}

function looksLikeMappingConversation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const mapping = (value as Record<string, unknown>).mapping

  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return false
  }

  return Object.values(mapping).some((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return false
    }

    const candidate = node as Record<string, unknown>
    return 'message' in candidate || 'children' in candidate
  })
}

function looksLikeMessagesConversation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const messages = (value as Record<string, unknown>).messages

  return (
    Array.isArray(messages) &&
    messages.some((message) => looksLikeMessageRecord(message))
  )
}

function looksLikeMessageRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record.role === 'string' ||
    typeof (record.author as Record<string, unknown> | undefined)?.role === 'string' ||
    'content' in record
  )
}

function normalizeConversationCandidate(
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
      pageTitle ??
      getDefaultConversationTitle(sourceUrl),
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
      pageTitle ??
      getDefaultConversationTitle(sourceUrl),
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

function extractDomConversation(
  $: CheerioAPI,
  sourceUrl: string,
): NormalizedConversation | null {
  const claudeDomConversation = extractClaudeDomConversation($, sourceUrl)

  if (claudeDomConversation) {
    return claudeDomConversation
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

function extractClaudeDomConversation(
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

function mergeDomImagesIntoConversation(
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

function extractBlocksFromNodes(nodes: AnyNode[], $: CheerioAPI): ContentBlock[] {
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

function textBlock(text: string): TextBlock {
  return {
    kind: 'text',
    text: text.replace(/\r\n/g, '\n').trim(),
  }
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractPageTitle($: CheerioAPI, sourceUrl?: string): string {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readFirstString(value: unknown): string | undefined {
  return Array.isArray(value)
    ? value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined
}

function readNestedString(
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
