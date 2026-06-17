import type { ChatCompletionOptions, ChatMessage, ModelInfo } from './types'
import { MODEL_PROVIDERS } from './providers'

export async function* streamChatCompletion(
  options: ChatCompletionOptions,
): AsyncGenerator<string, void, void> {
  const { provider, model, messages, providerConfig, signal } = options
  const entry = MODEL_PROVIDERS[provider]

  if (provider === 'ollama') {
    yield* streamOllama(providerConfig.baseUrl ?? entry.defaultBaseUrl!, model, messages, signal)
    return
  }

  if (provider === 'google') {
    yield* streamGoogle(providerConfig.apiKey!, model, messages, signal)
    return
  }

  if (entry.requiresProxy) {
    yield* streamViaProxy(provider, model, messages, providerConfig.apiKey!, signal)
    return
  }

  // lmstudio, custom — OpenAI-compatible direct
  const baseUrl = providerConfig.baseUrl ?? entry.defaultBaseUrl ?? ''
  yield* streamOpenAICompatible(`${baseUrl}/v1/chat/completions`, model, messages, providerConfig.apiKey, signal)
}

export async function fetchLocalModels(
  provider: 'custom' | 'lmstudio' | 'ollama',
  baseUrl: string,
): Promise<ModelInfo[]> {
  if (provider === 'ollama') {
    const response = await fetch(`${baseUrl}/api/tags`)
    const data = (await response.json()) as { models: { name: string }[] }
    return data.models.map((m) => ({
      id: m.name,
      name: m.name,
      tier: 'best' as const,
      provider,
    }))
  }

  // LM Studio / Custom — OpenAI-compatible
  const response = await fetch(`${baseUrl}/v1/models`)
  const data = (await response.json()) as { data: { id: string }[] }
  return data.data.map((m) => ({
    id: m.id,
    name: m.id,
    tier: 'best' as const,
    provider,
  }))
}

async function* streamOllama(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`)
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as { done: boolean; message?: { content?: string } }
      if (parsed.message?.content) {
        yield parsed.message.content
      }
      if (parsed.done) return
    }
  }
}

async function* streamGoogle(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const systemMessages = messages.filter((m) => m.role === 'system')
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')

  const contents = nonSystemMessages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const body: Record<string, unknown> = { contents }

  if (systemMessages.length > 0) {
    body.systemInstruction = {
      parts: [{ text: systemMessages.map((m) => m.content).join('\n\n') }],
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Google AI error: ${response.status} ${response.statusText}`)
  }

  yield* parseSSEStream(response, (parsed: unknown) => {
    const data = parsed as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  })
}

async function* streamViaProxy(
  provider: string,
  model: string,
  messages: ChatMessage[],
  apiKey: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const body: Record<string, unknown> = { provider, model, stream: true }

  if (provider === 'anthropic') {
    const systemMessages = messages.filter((m) => m.role === 'system')
    const nonSystemMessages = messages.filter((m) => m.role !== 'system')
    body.messages = nonSystemMessages
    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join('\n\n')
    }
  } else {
    body.messages = messages
  }

  const response = await fetch('/api/chat-proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Proxy error: ${response.status} ${response.statusText}`)
  }

  yield* parseSSEStream(response, (parsed: unknown) => {
    const data = parsed as {
      choices?: { delta?: { content?: string } }[]
    }
    return data.choices?.[0]?.delta?.content ?? ''
  })
}

async function* streamOpenAICompatible(
  url: string,
  model: string,
  messages: ChatMessage[],
  apiKey?: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  yield* parseSSEStream(response, (parsed: unknown) => {
    const data = parsed as {
      choices?: { delta?: { content?: string } }[]
    }
    return data.choices?.[0]?.delta?.content ?? ''
  })
}

async function* parseSSEStream<T>(
  response: Response,
  extractToken: (data: T) => string,
): AsyncGenerator<string, void, void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue

      const payload = trimmed.slice(6)
      if (payload === '[DONE]') return

      try {
        const parsed = JSON.parse(payload) as T
        const token = extractToken(parsed)
        if (token) yield token
      } catch {
        // skip malformed JSON lines
      }
    }
  }
}
