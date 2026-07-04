export const CHAT_PROXY_PATH = '/api/chat-proxy'

type ChatProvider = 'anthropic' | 'openai' | 'grok' | 'mistral'

interface ChatMessage {
  content: string
  role: string
}

interface ChatProxyRequestBody {
  apiKey?: string
  messages: ChatMessage[]
  model: string
  provider: ChatProvider
}

export function isChatProxyRequest(request: Request): boolean {
  return new URL(request.url).pathname === CHAT_PROXY_PATH
}

/**
 * Streaming chat proxy that forwards chat completion requests to cloud AI
 * providers (OpenAI, Anthropic, Grok, Mistral). The browser can't call these APIs directly
 * due to CORS restrictions. This proxy:
 * - Receives the request from the browser
 * - Forwards it to the appropriate provider API
 * - Streams the SSE response back
 * - NEVER stores or logs the API key — it's just a pipe
 */
export async function handleChatProxyRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      headers: { 'content-type': 'application/json' },
      status: 405,
    })
  }

  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > 500_000) {
    return new Response(JSON.stringify({ error: 'payload_too_large' }), {
      headers: { 'content-type': 'application/json' },
      status: 413,
    })
  }

  let body: ChatProxyRequestBody

  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      headers: { 'content-type': 'application/json' },
      status: 400,
    })
  }

  if (JSON.stringify(body).length > 500_000) {
    return new Response(JSON.stringify({ error: 'payload_too_large' }), {
      headers: { 'content-type': 'application/json' },
      status: 413,
    })
  }

  const { apiKey: bodyApiKey, messages, model, provider } = body
  const authHeader = request.headers.get('authorization')
  const apiKey = bodyApiKey || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined)

  if (!provider || !model || !messages || !apiKey) {
    return new Response(
      JSON.stringify({
        error: 'missing_fields',
        message: 'Required fields: provider, model, messages, apiKey (in body or Authorization header)',
      }),
      {
        headers: { 'content-type': 'application/json' },
        status: 400,
      },
    )
  }

  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'grok' && provider !== 'mistral') {
    return new Response(
      JSON.stringify({
        error: 'unsupported_provider',
        message: `Provider must be "openai", "anthropic", "grok", or "mistral", got "${provider}"`,
      }),
      {
        headers: { 'content-type': 'application/json' },
        status: 400,
      },
    )
  }

  let upstreamResponse: Response

  try {
    if (provider === 'openai') {
      upstreamResponse = await fetchOpenAI(model, messages, apiKey)
    } else if (provider === 'anthropic') {
      upstreamResponse = await fetchAnthropic(model, messages, apiKey)
    } else if (provider === 'grok') {
      upstreamResponse = await fetchGrok(model, messages, apiKey)
    } else if (provider === 'mistral') {
      upstreamResponse = await fetchMistral(model, messages, apiKey)
    } else {
      throw new Error(`Unsupported provider: ${provider}`)
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'network error'
    console.warn('[chatdump] Chat proxy: fetch failed', { message, provider })
    return new Response(
      JSON.stringify({ error: 'fetch_failed', message }),
      {
        headers: { 'content-type': 'application/json' },
        status: 502,
      },
    )
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => '')
    console.warn('[chatdump] Chat proxy: upstream error', {
      provider,
      status: upstreamResponse.status,
    })
    return new Response(
      JSON.stringify({
        error: 'upstream_error',
        message: `${provider} API returned HTTP ${upstreamResponse.status}`,
        upstream: tryParseJson(errorText),
      }),
      {
        headers: { 'content-type': 'application/json' },
        status: 502,
      },
    )
  }

  if (!upstreamResponse.body) {
    return new Response(
      JSON.stringify({ error: 'no_response_body', message: 'Upstream returned no body' }),
      {
        headers: { 'content-type': 'application/json' },
        status: 502,
      },
    )
  }

  console.info('[chatdump] Chat proxy: streaming', { model, provider })

  return new Response(upstreamResponse.body, {
    headers: {
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'content-type': 'text/event-stream',
    },
    status: 200,
  })
}

const UPSTREAM_TIMEOUT_MS = 30_000

async function fetchOpenAI(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
): Promise<Response> {
  return fetch('https://api.openai.com/v1/chat/completions', {
    body: JSON.stringify({
      messages,
      model,
      stream: true,
    }),
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
}

async function fetchGrok(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
): Promise<Response> {
  return fetch('https://api.x.ai/v1/chat/completions', {
    body: JSON.stringify({
      messages,
      model,
      stream: true,
    }),
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
}

async function fetchMistral(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
): Promise<Response> {
  return fetch('https://api.mistral.ai/v1/chat/completions', {
    body: JSON.stringify({
      messages,
      model,
      stream: true,
    }),
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
}

async function fetchAnthropic(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
): Promise<Response> {
  const systemMessage = messages.find((m) => m.role === 'system')
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')

  const body: Record<string, unknown> = {
    max_tokens: 8192,
    messages: nonSystemMessages,
    model,
    stream: true,
  }

  if (systemMessage) {
    body.system = systemMessage.content
  }

  return fetch('https://api.anthropic.com/v1/messages', {
    body: JSON.stringify(body),
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text || undefined
  }
}
