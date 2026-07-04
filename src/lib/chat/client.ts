import type { ChatCompletionOptions, ChatMessage, ModelInfo } from './types'
import { MODEL_PROVIDERS } from './providers'

export async function* streamChatCompletion(
  options: ChatCompletionOptions,
): AsyncGenerator<string, void, void> {
  const { provider, model, messages, providerConfig, signal } = options

  if (provider === 'webapp') {
    throw new Error('Web Apps do not support direct API streaming.')
  }

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
    throw new Error(await parseErrorResponseText(response, `Ollama error (${response.status})`))
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
    throw new Error(await parseErrorResponseText(response, `Google AI error (${response.status})`))
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
    throw new Error(await parseErrorResponseText(response, `Proxy error (${response.status})`))
  }

  yield* parseSSEStream(response, (parsed: unknown) => {
    const data = parsed as {
      choices?: { delta?: { content?: string } }[]
    }
    return data.choices?.[0]?.delta?.content ?? ''
  })
}

export async function* streamOpenAICompat(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(await parseErrorResponseText(response, 'API Error'))
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return

      try {
        const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
        const token = parsed.choices?.[0]?.delta?.content
        if (typeof token === 'string') yield token
      } catch {
        // Skip malformed SSE lines
      }
    }
  }
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
    throw new Error(await parseErrorResponseText(response, `API error (${response.status})`))
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

async function parseErrorResponseText(response: Response, defaultPrefix: string): Promise<string> {
  const text = await response.text().catch(() => '')
  let errorMessage = ''
  try {
    const parsed = JSON.parse(text)
    if (parsed.message) {
      errorMessage = parsed.message
    } else if (parsed.error) {
      if (typeof parsed.error === 'string') {
        errorMessage = parsed.error
      } else if (parsed.error.message) {
        errorMessage = parsed.error.message
      } else {
        errorMessage = JSON.stringify(parsed.error)
      }
    }
  } catch {
    // Keep raw text if not JSON
  }

  if (!errorMessage) {
    errorMessage = text.slice(0, 300) || `HTTP error ${response.status}`
  }

  return `${defaultPrefix}: ${errorMessage}`
}
