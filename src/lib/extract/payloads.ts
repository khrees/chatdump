import { load, type CheerioAPI } from 'cheerio'
import type { NormalizedConversation } from '../types'
import { ChatdumpError } from '../errors'
import { getDefaultConversationTitle, tryNormalizeShareUrl } from '../url'
import { findConversationCandidates, findKnownConversationCandidates } from './candidates'
import { extractDomConversation, extractPageTitle, mergeDomImagesIntoConversation } from './dom'
import { extractBalancedJsonObjects, extractJsonParsePayloads } from './json'
import { normalizeConversationCandidate } from './normalize'
import { hasStructuredPayloadHint, looksLikeHydrationBootstrap, looksLikeJson, safeJsonParse } from './utils'

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

export function selectBestConversationFromPayloads(
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


