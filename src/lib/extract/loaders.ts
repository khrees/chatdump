import type { BrowserExtractor, FetchImpl, NormalizedConversation } from '../types'
import { ChatdumpError } from '../errors'
import { getDefaultConversationTitle } from '../url'
import { createClaudeSnapshotApiUrl, extractClaudeConversationPayloads } from '../claude'
import { handleClaudeSnapshotProxyRequest } from '../claude-proxy'
import { createCopilotShareConversationApiUrl, extractCopilotConversationPayloads } from '../copilot'
import { createGrokShareConversationApiUrl, extractGrokConversationPayloads } from '../grok'
import { resolveBrowserFallback } from './browser'
import { extractConversationFromHtml, selectBestConversationFromPayloads } from './payloads'

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

export async function loadShareConversation(
  url: URL,
  options: {
    browserExtractor?: BrowserExtractor
    enableBrowserFallback?: boolean
    fetchImpl: FetchImpl
    provider: string
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
  const apiUrl = createClaudeSnapshotApiUrl(url)
  const shareId = apiUrl.pathname.split('/').pop()!

  const proxyRequest = new Request(
    `http://localhost/api/claude-snapshot?shareId=${shareId}`,
  )
  const response = await handleClaudeSnapshotProxyRequest(proxyRequest, options.fetchImpl)

  if (response.status === 503) {
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

    return resolveBrowserFallback(options.browserUrl, options.browserExtractor, cause)
  }
}
