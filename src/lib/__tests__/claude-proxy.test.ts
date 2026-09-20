import { describe, expect, test } from 'bun:test'
import { getClaudeBrowserProxyConfig } from '../browser'
import {
  getClaudeProxyUrl,
  getRedactedProxyUrl,
  handleClaudeSnapshotProxyRequest,
} from '../claude-proxy'

const SHARE_ID = '51c6593c-c94b-4708-ba87-92e60b693f7b'
const PROXY_URL = 'http://testuser:testpass@proxy.example:8080/'

function proxyRequest(shareId: string | null = SHARE_ID): Request {
  const url =
    shareId === null
      ? 'http://localhost/api/claude-snapshot'
      : `http://localhost/api/claude-snapshot?shareId=${shareId}`

  return new Request(url)
}

describe('getClaudeProxyUrl', () => {
  test('returns null when no proxy env var is set', () => {
    expect(getClaudeProxyUrl({})).toBeNull()
    expect(getClaudeProxyUrl({ CHATDUMP_CLAUDE_PROXY_URL: '  ' })).toBeNull()
  })

  test('reads the primary env var and trims whitespace', () => {
    expect(getClaudeProxyUrl({ CHATDUMP_CLAUDE_PROXY_URL: `  ${PROXY_URL}  ` })).toBe(
      PROXY_URL,
    )
  })

  test('falls back to the CLAUDE_PROXY_URL alias', () => {
    expect(getClaudeProxyUrl({ CLAUDE_PROXY_URL: PROXY_URL })).toBe(PROXY_URL)
  })

  test('prefers the primary env var over the alias', () => {
    expect(
      getClaudeProxyUrl({
        CHATDUMP_CLAUDE_PROXY_URL: 'http://primary:pass@proxy.example:8080/',
        CLAUDE_PROXY_URL: 'http://alias:pass@proxy.example:8080/',
      }),
    ).toBe('http://primary:pass@proxy.example:8080/')
  })

  test('rejects invalid URLs and non-http protocols', () => {
    expect(getClaudeProxyUrl({ CHATDUMP_CLAUDE_PROXY_URL: 'not-a-url' })).toBeNull()
    expect(
      getClaudeProxyUrl({ CHATDUMP_CLAUDE_PROXY_URL: 'socks5://user:pass@host:1080/' }),
    ).toBeNull()
  })
})

describe('getRedactedProxyUrl', () => {
  test('redacts the password but keeps the rest', () => {
    expect(getRedactedProxyUrl(PROXY_URL)).toBe('http://testuser:***@proxy.example:8080/')
  })

  test('handles invalid input without throwing', () => {
    expect(getRedactedProxyUrl('not-a-url')).toBe('[invalid-proxy-url]')
  })
})

describe('handleClaudeSnapshotProxyRequest', () => {
  test('rejects non-GET methods and invalid share ids', async () => {
    const postResponse = await handleClaudeSnapshotProxyRequest(
      new Request('http://localhost/api/claude-snapshot', { method: 'POST' }),
    )
    expect(postResponse.status).toBe(405)

    const badResponse = await handleClaudeSnapshotProxyRequest(
      proxyRequest('not a uuid!!'),
    )
    expect(badResponse.status).toBe(400)
  })

  test('fetches directly without a dispatcher when no proxy is set', async () => {
    let seenInit: RequestInit | undefined

    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      seenInit = init
      expect(String(input)).toBe(`https://claude.ai/api/chat_snapshots/${SHARE_ID}`)
      return new Response(JSON.stringify({ chat_messages: [] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    }

    const response = await handleClaudeSnapshotProxyRequest(
      proxyRequest(),
      fetchImpl,
      { env: {}, proxyUrl: null },
    )

    expect(response.status).toBe(200)
    expect(seenInit).toBeDefined()
    expect('dispatcher' in (seenInit as Record<string, unknown>)).toBe(false)
  })

  test('routes through a ProxyAgent dispatcher when a proxy is configured', async () => {
    let seenInit: RequestInit | undefined

    const fetchImpl = async (_input: string | URL, init?: RequestInit) => {
      seenInit = init
      return new Response(JSON.stringify({ chat_messages: [] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    }

    const response = await handleClaudeSnapshotProxyRequest(
      proxyRequest(),
      fetchImpl,
      { env: {}, proxyUrl: PROXY_URL },
    )

    expect(response.status).toBe(200)
    const dispatcher = (seenInit as Record<string, unknown> | undefined)?.dispatcher
    expect(dispatcher).toBeDefined()
    expect((dispatcher as { constructor: { name: string } }).constructor.name).toBe(
      'ProxyAgent',
    )
  })

  test('maps Cloudflare challenges to 503 for browser fallback', async () => {
    const fetchImpl = async () =>
      new Response('<html><head><title>Just a moment...</title></head></html>', {
        status: 403,
      })

    const response = await handleClaudeSnapshotProxyRequest(
      proxyRequest(),
      fetchImpl,
      { env: {}, proxyUrl: null },
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: 'cloudflare_blocked',
    })
  })
})

describe('getClaudeBrowserProxyConfig', () => {
  test('returns null when no proxy is configured', () => {
    expect(getClaudeBrowserProxyConfig({})).toBeNull()
  })

  test('splits the proxy URL into a Playwright proxy option', () => {
    expect(
      getClaudeBrowserProxyConfig({ CHATDUMP_CLAUDE_PROXY_URL: PROXY_URL }),
    ).toEqual({
      password: 'testpass',
      server: 'http://proxy.example:8080',
      username: 'testuser',
    })
  })
})
