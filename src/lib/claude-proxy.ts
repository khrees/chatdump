import type { FetchImpl } from './types'

export const CLAUDE_SNAPSHOT_PATH = '/api/claude-snapshot'

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

  let response: Response

  try {
    response = await fetchImpl(snapshotUrl, {
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
    })
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
