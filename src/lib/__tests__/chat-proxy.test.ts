import { describe, expect, test } from 'bun:test'
import { handleChatProxyRequest, CHAT_PROXY_PATH } from '../chat-proxy'

const proxyUrl = `https://chatdump.vercel.app${CHAT_PROXY_PATH}`

describe('chat-proxy', () => {
  test('rejects non-POST requests', async () => {
    const response = await handleChatProxyRequest(new Request(proxyUrl, { method: 'GET' }))
    expect(response.status).toBe(405)
    await expect(response.json()).resolves.toEqual({ error: 'method_not_allowed' })
  })

  test('rejects requests with missing fields', async () => {
    const response = await handleChatProxyRequest(new Request(proxyUrl, {
      method: 'POST',
      body: JSON.stringify({}),
    }))
    expect(response.status).toBe(400)
    const data = await response.json() as any
    expect(data.error).toBe('missing_fields')
  })

  test('routes OpenAI requests through the proxy using body apiKey', async () => {
    const originalFetch = globalThis.fetch
    let fetchedUrl = ''
    let fetchedOptions: any = null

    globalThis.fetch = (async (url: any, options: any) => {
      fetchedUrl = url.toString()
      fetchedOptions = options
      return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as any

    try {
      const response = await handleChatProxyRequest(new Request(proxyUrl, {
        method: 'POST',
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.5-pro',
          messages: [{ role: 'user', content: 'Hi' }],
          apiKey: 'test-key-openai',
        }),
      }))

      expect(response.status).toBe(200)
      expect(fetchedUrl).toBe('https://api.openai.com/v1/chat/completions')
      expect(fetchedOptions.headers.authorization).toBe('Bearer test-key-openai')
      const text = await response.text()
      expect(text).toContain('Hello')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('routes Grok requests through the proxy using auth header', async () => {
    const originalFetch = globalThis.fetch
    let fetchedUrl = ''
    let fetchedOptions: any = null

    globalThis.fetch = (async (url: any, options: any) => {
      fetchedUrl = url.toString()
      fetchedOptions = options
      return new Response('data: {"choices":[{"delta":{"content":"Grokking"}}]}\n\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as any

    try {
      const response = await handleChatProxyRequest(new Request(proxyUrl, {
        method: 'POST',
        headers: {
          'authorization': 'Bearer test-key-grok',
        },
        body: JSON.stringify({
          provider: 'grok',
          model: 'grok-4.3',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      }))

      expect(response.status).toBe(200)
      expect(fetchedUrl).toBe('https://api.x.ai/v1/chat/completions')
      expect(fetchedOptions.headers.authorization).toBe('Bearer test-key-grok')
      const text = await response.text()
      expect(text).toContain('Grokking')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('routes Mistral requests through the proxy using body apiKey', async () => {
    const originalFetch = globalThis.fetch
    let fetchedUrl = ''
    let fetchedOptions: any = null

    globalThis.fetch = (async (url: any, options: any) => {
      fetchedUrl = url.toString()
      fetchedOptions = options
      return new Response('data: {"choices":[{"delta":{"content":"Mistral API"}}]}\n\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as any

    try {
      const response = await handleChatProxyRequest(new Request(proxyUrl, {
        method: 'POST',
        body: JSON.stringify({
          provider: 'mistral',
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: 'Hi' }],
          apiKey: 'test-key-mistral',
        }),
      }))

      expect(response.status).toBe(200)
      expect(fetchedUrl).toBe('https://api.mistral.ai/v1/chat/completions')
      expect(fetchedOptions.headers.authorization).toBe('Bearer test-key-mistral')
      const text = await response.text()
      expect(text).toContain('Mistral API')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
