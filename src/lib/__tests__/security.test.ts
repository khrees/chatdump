import { describe, expect, test } from 'bun:test'
import {
  createRateLimiter,
  forbiddenResponse,
  getClientIp,
  isSameOriginRequest,
  rateLimitedResponse,
} from '../security'

function request(
  url = 'https://chatdump.example/api/chat-proxy',
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers })
}

describe('getClientIp', () => {
  test('prefers the first x-forwarded-for entry', () => {
    const req = request('https://chatdump.example/api/x', {
      'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.4',
    })
    expect(getClientIp(req)).toBe('203.0.113.7')
  })

  test('falls back to x-real-ip and then unknown', () => {
    expect(
      getClientIp(request('https://chatdump.example/api/x', { 'x-real-ip': '198.51.100.9' })),
    ).toBe('198.51.100.9')
    expect(getClientIp(request())).toBe('unknown')
  })
})

describe('isSameOriginRequest', () => {
  test('trusts Sec-Fetch-Site: same-origin', () => {
    expect(
      isSameOriginRequest(request('https://chatdump.example/api/x', { 'sec-fetch-site': 'same-origin' })),
    ).toBe(true)
  })

  test('rejects cross-site fetch metadata', () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(
        isSameOriginRequest(request('https://chatdump.example/api/x', { 'sec-fetch-site': site })),
      ).toBe(false)
    }
  })

  test('falls back to Origin and Referer host matching', () => {
    expect(
      isSameOriginRequest(
        request('https://chatdump.example/api/x', { origin: 'https://chatdump.example' }),
      ),
    ).toBe(true)
    expect(
      isSameOriginRequest(
        request('https://chatdump.example/api/x', { origin: 'https://evil.example' }),
      ),
    ).toBe(false)
    expect(
      isSameOriginRequest(
        request('https://chatdump.example/api/x', {
          referer: 'https://chatdump.example/some/page',
        }),
      ),
    ).toBe(true)
  })

  test('rejects headerless clients', () => {
    expect(isSameOriginRequest(request())).toBe(false)
  })
})

describe('createRateLimiter', () => {
  test('allows up to max, then blocks until the window resets', () => {
    let nowMs = 1_000_000
    const limiter = createRateLimiter({
      max: 3,
      now: () => nowMs,
      windowMs: 60_000,
    })

    expect(limiter.check('ip-1').allowed).toBe(true)
    expect(limiter.check('ip-1').allowed).toBe(true)
    expect(limiter.check('ip-1').allowed).toBe(true)

    const blocked = limiter.check('ip-1')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000)

    // Other keys are unaffected.
    expect(limiter.check('ip-2').allowed).toBe(true)

    // After the window passes, the key works again.
    nowMs += 60_001
    expect(limiter.check('ip-1').allowed).toBe(true)
  })
})

describe('guard responses', () => {
  test('uses generic bodies and correct statuses', async () => {
    const forbidden = forbiddenResponse()
    expect(forbidden.status).toBe(403)
    await expect(forbidden.json()).resolves.toEqual({ error: 'forbidden' })

    const limited = rateLimitedResponse(45_000)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('45')
    await expect(limited.json()).resolves.toEqual({ error: 'rate_limited' })
  })
})
