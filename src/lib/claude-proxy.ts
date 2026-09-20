import { ProxyAgent } from 'undici'
import type { FetchImpl } from './types'

export const CLAUDE_SNAPSHOT_PATH = '/api/claude-snapshot'

/**
 * Residential/paid HTTP proxy used for Claude snapshot requests.
 * Set it to a full proxy URL including auth, e.g.
 * `http://username:password@p.webshare.io:80/`.
 */
export const CLAUDE_PROXY_URL_ENV_NAME = 'CHATDUMP_CLAUDE_PROXY_URL'
export const CLAUDE_PROXY_URL_ALIAS_ENV_NAME = 'CLAUDE_PROXY_URL'

export interface ClaudeProxyOptions {
  env?: Record<string, string | undefined>
  /** Explicit override (takes precedence over env). `null`/empty disables. */
  proxyUrl?: string | null
}

export function isClaudeSnapshotProxyRequest(request: Request): boolean {
  return new URL(request.url).pathname === CLAUDE_SNAPSHOT_PATH
}

/**
 * Proxies requests to claude.ai/api/chat_snapshots/<uuid>.
 * This runs in the same Node.js Lambda as the main app, but uses
 * browser-like headers to improve the chance of bypassing Cloudflare.
 * If Cloudflare still blocks it, we return 503 so the caller can fall back
 * to other strategies (e.g. Playwright or a meaningful error message).
 */
export async function handleClaudeSnapshotProxyRequest(
  request: Request,
  fetchImpl: FetchImpl = fetch,
  options: ClaudeProxyOptions = {},
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      headers: { 'content-type': 'application/json' },
      status: 405,
    })
  }

  const url = new URL(request.url)
  const shareId = url.searchParams.get('shareId')

  if (!shareId || !/^[a-f0-9-]+$/i.test(shareId)) {
    return new Response(JSON.stringify({ error: 'invalid_share_id' }), {
      headers: { 'content-type': 'application/json' },
      status: 400,
    })
  }

  const snapshotUrl = `https://claude.ai/api/chat_snapshots/${shareId}`
  const env = options.env ?? process.env
  const proxyUrl =
    options.proxyUrl !== undefined ? options.proxyUrl : getClaudeProxyUrl(env)

  let response: Response

  try {
    response = await fetchSnapshot(snapshotUrl, shareId, fetchImpl, proxyUrl)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'network error'
    console.warn('[chatdump] Claude snapshot proxy: fetch failed', { message, shareId })
    return new Response(
      JSON.stringify({ error: 'fetch_failed', message }),
      {
        headers: { 'content-type': 'application/json' },
        status: 502,
      },
    )
  }

  // Cloudflare managed challenge → 403 from claude.ai. Return 503 so
  // the caller knows to fall back gracefully.
  if (response.status === 403) {
    const body = await response.text().catch(() => '')
    const isCloudflareChallenge = body.includes('challenges.cloudflare.com') || body.includes('Just a moment')
    console.warn('[chatdump] Claude snapshot proxy: Cloudflare challenge', {
      isCloudflareChallenge,
      shareId,
      status: response.status,
    })
    return new Response(
      JSON.stringify({
        error: 'cloudflare_blocked',
        message: 'Claude API returned a Cloudflare challenge (bot protection)',
      }),
      {
        headers: { 'content-type': 'application/json' },
        status: 503,
      },
    )
  }

  if (!response.ok) {
    console.warn('[chatdump] Claude snapshot proxy: upstream error', {
      shareId,
      status: response.status,
    })
    return new Response(
      JSON.stringify({
        error: 'upstream_error',
        message: `Claude API returned HTTP ${response.status}`,
        status: response.status,
      }),
      {
        headers: { 'content-type': 'application/json' },
        status: 502,
      },
    )
  }

  const text = await response.text()
  console.info('[chatdump] Claude snapshot proxy: success', { shareId })

  return new Response(text, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
    status: 200,
  })
}

/**
 * Reads the configured Claude proxy URL from the environment.
 * Returns the trimmed URL, or `null` when unset/invalid.
 * Never logs the raw value — it contains proxy credentials.
 */
export function getClaudeProxyUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw =
    env[CLAUDE_PROXY_URL_ENV_NAME] ?? env[CLAUDE_PROXY_URL_ALIAS_ENV_NAME]

  if (!raw || !raw.trim()) {
    return null
  }

  const proxyUrl = raw.trim()

  try {
    const parsed = new URL(proxyUrl)

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn('[chatdump] Claude proxy URL has an unsupported protocol; ignoring', {
        envVar:
          env[CLAUDE_PROXY_URL_ENV_NAME] !== undefined
            ? CLAUDE_PROXY_URL_ENV_NAME
            : CLAUDE_PROXY_URL_ALIAS_ENV_NAME,
        protocol: parsed.protocol,
      })
      return null
    }
  } catch {
    console.warn('[chatdump] Claude proxy URL is not a valid URL; ignoring')
    return null
  }

  return proxyUrl
}

/** Redacts the password from a proxy URL for safe logging. */
export function getRedactedProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl)

    if (parsed.password) {
      parsed.password = '***'
    }

    return parsed.toString()
  } catch {
    return '[invalid-proxy-url]'
  }
}

async function fetchSnapshot(
  snapshotUrl: string,
  shareId: string,
  fetchImpl: FetchImpl,
  proxyUrl: string | null | undefined,
): Promise<Response> {
  const init: RequestInit = {
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'anthropic-client-platform': 'web_claude_ai',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      referer: `https://claude.ai/share/${shareId}`,
      'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  }

  if (!proxyUrl) {
    return fetchImpl(snapshotUrl, init)
  }

  let dispatcher: ProxyAgent | null = null

  try {
    dispatcher = new ProxyAgent(proxyUrl)
  } catch (cause) {
    console.warn('[chatdump] Claude proxy URL could not be used; falling back to direct', {
      message: cause instanceof Error ? cause.message : 'invalid proxy URL',
      proxy: getRedactedProxyUrl(proxyUrl),
      shareId,
    })
    return fetchImpl(snapshotUrl, init)
  }

  console.info('[chatdump] Claude snapshot proxy: fetching via proxy', {
    proxy: getRedactedProxyUrl(proxyUrl),
    shareId,
  })

  try {
    return await fetchImpl(snapshotUrl, {
      ...init,
      dispatcher,
    } as RequestInit)
  } finally {
    // undici's Dispatcher API differs across runtimes (Bun's build lacks
    // close/destroy); only clean up when the method exists.
    const agent = dispatcher as unknown as {
      close?: () => Promise<unknown>
      destroy?: () => unknown
    }

    try {
      if (typeof agent.close === 'function') {
        await agent.close()
      } else if (typeof agent.destroy === 'function') {
        await agent.destroy()
      }
    } catch {
      // Ignore cleanup errors — the fetch itself already completed.
    }
  }
}
