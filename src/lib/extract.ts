export { fetchSharePage } from './extract/loaders'
export { extractConversationFromHtml } from './extract/payloads'

import { loadShareConversation } from './extract/loaders'
import { renderConversationToMarkdown } from './render'
import type { ConvertOptions, ConvertResult } from './types'
import { normalizeShareUrl } from './url'
import { getOrCreateCachedShareConversation } from './share-cache'

export async function convertShareUrlToMarkdown(
  rawUrl: string,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  let urlToNormalize = rawUrl
  try {
    const parsedUrl = new URL(rawUrl)
    if (parsedUrl.hostname.toLowerCase() === 'share.gemini.google') {
      const fetchImpl = options.fetchImpl ?? fetch
      try {
        const response = await fetchImpl(rawUrl, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(10_000),
        })
        if (response.url) {
          urlToNormalize = response.url
        }
      } catch (err) {
        console.warn('[chatdump] Failed to resolve share.gemini.google redirect', err)
      }
    }
  } catch {
    // Ignore URL parse error; normalizeShareUrl will throw the appropriate error
  }

  const { provider, url } = normalizeShareUrl(urlToNormalize)
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
