import { load } from 'cheerio'
import type { BrowserExtractor, NormalizedConversation } from '../types'
import { ChatdumpError } from '../errors'
import { getDefaultConversationTitle } from '../url'
import { extractDomConversation, extractPageTitle, mergeDomImagesIntoConversation } from './dom'
import { extractConversationFromHtml, selectBestConversationFromPayloads } from './payloads'

export async function resolveBrowserFallback(
  url: string,
  browserExtractor: BrowserExtractor | undefined,
  originalCause: ChatdumpError,
): Promise<{ conversation: NormalizedConversation; warnings: string[] }> {
  const fallback = await tryBrowserFallback(url, browserExtractor)
  return resolveBrowserFallbackResult(fallback, originalCause, originalCause.code)
}

export async function tryBrowserFallback(
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
  const { extractConversationInBrowser } = await import('../browser')
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
