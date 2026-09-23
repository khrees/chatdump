/**
 * Server-front-door guards: same-origin checks and per-IP rate limiting.
 *
 * Why this exists: several endpoints burn paid resources per call
 * (residential proxy bandwidth, Playwright browser launches, LLM-sized
 * streamed responses). They must only serve our own browser UI, and even
 * then only at human rates.
 *
 * Scope notes:
 * - Rate limiting is in-memory per server instance. On serverless scale-out
 *   each instance tracks its own counters, so this is a flood guard, not a
 *   precise quota. Good enough to make abuse uneconomical.
 * - `isSameOriginRequest` rejects requests with no provenance at all
 *   (curl-style). All legitimate callers are same-origin browser fetches.
 *   External monitors should use token-gated endpoints, which are exempt
 *   from the origin check (see server.ts).
 */

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')

  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }

  const realIp = request.headers.get('x-real-ip')?.trim()
  if (realIp) return realIp

  return 'unknown'
}

function requestHost(request: Request): string | null {
  try {
    return new URL(request.url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function headerHost(value: string | null): string | null {
  if (!value) return null
  try {
    // Origin is a full origin ("https://example.com"); Referer is a URL.
    return new URL(value).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * True only when the request provably comes from our own origin:
 * - `Sec-Fetch-Site: same-origin` (modern browsers), or
 * - matching `Origin` / `Referer` host as a fallback.
 *
 * Anything else — cross-site, direct navigation, headerless clients —
 * returns false.
 */
export function isSameOriginRequest(request: Request): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()

  if (secFetchSite) {
    return secFetchSite === 'same-origin'
  }

  const host = requestHost(request)
  if (!host) return false

  const origin = headerHost(request.headers.get('origin'))
  if (origin) return origin === host

  const referer = headerHost(request.headers.get('referer'))
  if (referer) return referer === host

  return false
}

export interface RateLimiterOptions {
  /** Max requests per window per key. */
  max: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Clock override (tests). */
  now?: () => number
}

export interface RateLimitResult {
  allowed: boolean
  /** Milliseconds until the window resets (0 when allowed). */
  retryAfterMs: number
}

/**
 * Fixed-window per-key rate limiter. Call `check(key)` (usually the client
 * IP scoped to an endpoint) before doing expensive work.
 */
export function createRateLimiter(options: RateLimiterOptions): {
  check: (key: string) => RateLimitResult
} {
  const { max, windowMs, now = Date.now } = options
  const hits = new Map<string, number[]>()

  function pruneList(timestamps: number[], nowMs: number): number[] {
    const cutoff = nowMs - windowMs
    let drop = 0
    while (drop < timestamps.length && timestamps[drop]! <= cutoff) {
      drop += 1
    }
    return drop === 0 ? timestamps : timestamps.slice(drop)
  }

  return {
    check(key: string): RateLimitResult {
      const nowMs = now()
      const recent = pruneList(hits.get(key) ?? [], nowMs)

      if (recent.length >= max) {
        const oldest = recent[0] ?? nowMs
        return {
          allowed: false,
          retryAfterMs: Math.max(0, oldest + windowMs - nowMs),
        }
      }

      recent.push(nowMs)
      hits.set(key, recent)

      // Opportunistic cleanup so idle keys don't accumulate.
      if (hits.size > 10_000) {
        for (const [k, v] of hits) {
          if (pruneList(v, nowMs).length === 0) hits.delete(k)
          if (hits.size <= 5_000) break
        }
      }

      return { allowed: true, retryAfterMs: 0 }
    },
  }
}

export function forbiddenResponse(): Response {
  return new Response(JSON.stringify({ error: 'forbidden' }), {
    headers: { 'content-type': 'application/json' },
    status: 403,
  })
}

export function rateLimitedResponse(retryAfterMs: number): Response {
  return new Response(JSON.stringify({ error: 'rate_limited' }), {
    headers: {
      'content-type': 'application/json',
      'retry-after': String(Math.ceil(retryAfterMs / 1000)),
    },
    status: 429,
  })
}
