import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '../../lib/cn'

// ─── Storage keys ────────────────────────────────────────────────────────────

const CHAT_SETTINGS_KEY = 'chatdump.chat-settings.v1'

// ─── Types ───────────────────────────────────────────────────────────────────

type ChatProvider = 'openai' | 'anthropic' | 'google' | 'ollama' | 'lmstudio' | 'custom'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ModelOption {
  id: string
  name: string
  provider: ChatProvider
}

interface ProviderSettings {
  apiKey: string
  baseUrl: string
  enabled: boolean
}

interface ChatSettings {
  openai: ProviderSettings
  anthropic: ProviderSettings
  google: ProviderSettings
  ollama: ProviderSettings
  lmstudio: ProviderSettings
  custom: ProviderSettings
  selectedProvider: ChatProvider
  selectedModel: string
}

interface ContinuationMessage {
  role: 'user' | 'assistant'
  content: string
  model?: string
  provider?: ChatProvider
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ChatSettings = {
  openai: { apiKey: '', baseUrl: 'https://api.openai.com', enabled: false },
  anthropic: { apiKey: '', baseUrl: 'https://api.anthropic.com', enabled: false },
  google: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', enabled: false },
  ollama: { apiKey: '', baseUrl: 'http://localhost:11434', enabled: false },
  lmstudio: { apiKey: '', baseUrl: 'http://localhost:1234', enabled: false },
  custom: { apiKey: '', baseUrl: '', enabled: false },
  selectedProvider: 'ollama',
  selectedModel: '',
}

const CLOUD_MODELS: ModelOption[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
  { id: 'o3-mini', name: 'o3-mini', provider: 'openai' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic' },
  { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku', provider: 'anthropic' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google' },
]

const PROVIDER_LABELS: Record<ChatProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google AI',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom',
}

const monoCapsClass = 'font-mono uppercase tracking-[0.14em]'

// ─── Settings persistence ────────────────────────────────────────────────────

function loadSettings(): ChatSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(CHAT_SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(settings: ChatSettings): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Ignore storage failures
  }
}

// ─── Streaming helpers ───────────────────────────────────────────────────────

async function* streamOpenAICompat(
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
    const text = await response.text().catch(() => '')
    throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`)
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
        const parsed = JSON.parse(data)
        const token = parsed.choices?.[0]?.delta?.content
        if (typeof token === 'string') yield token
      } catch {
        // Skip malformed SSE lines
      }
    }
  }
}

async function* streamOllama(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Ollama error ${response.status}: ${text.slice(0, 200)}`)
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
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        const token = parsed.message?.content
        if (typeof token === 'string') yield token
      } catch {
        // Skip malformed lines
      }
    }
  }
}

async function* streamGoogleAI(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const systemMessages = messages.filter((m) => m.role === 'system')
  const chatMessages = messages.filter((m) => m.role !== 'system')

  const contents = chatMessages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const body: Record<string, unknown> = { contents }

  if (systemMessages.length > 0) {
    body.systemInstruction = {
      parts: [{ text: systemMessages.map((m) => m.content).join('\n') }],
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Google AI error ${response.status}: ${text.slice(0, 200)}`)
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

      try {
        const parsed = JSON.parse(data)
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text
        if (typeof text === 'string') yield text
      } catch {
        // Skip malformed SSE lines
      }
    }
  }
}

async function* streamChatCompletion(
  provider: ChatProvider,
  model: string,
  messages: ChatMessage[],
  settings: ChatSettings,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const providerSettings = settings[provider]

  switch (provider) {
    case 'ollama': {
      yield* streamOllama(providerSettings.baseUrl, model, messages, signal)
      return
    }

    case 'lmstudio':
    case 'custom': {
      const baseUrl = providerSettings.baseUrl.replace(/\/+$/, '')
      const headers: Record<string, string> = {}
      if (providerSettings.apiKey) {
        headers['authorization'] = `Bearer ${providerSettings.apiKey}`
      }
      yield* streamOpenAICompat(
        `${baseUrl}/v1/chat/completions`,
        { model, messages, stream: true },
        headers,
        signal,
      )
      return
    }

    case 'google': {
      yield* streamGoogleAI(providerSettings.apiKey, model, messages, signal)
      return
    }

    case 'openai':
    case 'anthropic': {
      // Route through server proxy for CORS
      const body: Record<string, unknown> = {
        provider,
        model,
        messages,
        apiKey: providerSettings.apiKey,
      }
      yield* streamOpenAICompat(
        '/api/chat-proxy',
        body,
        {},
        signal,
      )
      return
    }
  }
}

// ─── Local model discovery ───────────────────────────────────────────────────

async function fetchLocalModels(
  provider: ChatProvider,
  baseUrl: string,
): Promise<ModelOption[]> {
  try {
    if (provider === 'ollama') {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`)
      if (!response.ok) return []
      const data = await response.json()
      return (data.models ?? []).map((m: { name: string }) => ({
        id: m.name,
        name: m.name,
        provider: 'ollama' as ChatProvider,
      }))
    }

    // LM Studio / Custom: OpenAI-compatible /v1/models
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`)
    if (!response.ok) return []
    const data = await response.json()
    return (data.data ?? []).map((m: { id: string }) => ({
      id: m.id,
      name: m.id,
      provider,
    }))
  } catch {
    return []
  }
}

// ─── Conversation-to-messages converter ──────────────────────────────────────

function conversationMarkdownToMessages(markdown: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  const sections = markdown.split(/^## /m).slice(1)

  for (const section of sections) {
    const newlineIndex = section.indexOf('\n')
    if (newlineIndex === -1) continue

    const heading = section.slice(0, newlineIndex).trim().toLowerCase()
    const content = section.slice(newlineIndex + 1).trim()

    if (!content) continue

    let role: 'user' | 'assistant' | 'system' = 'user'
    if (heading.startsWith('assistant') || heading.startsWith('model')) {
      role = 'assistant'
    } else if (heading.startsWith('system')) {
      role = 'system'
    }

    messages.push({ role, content })
  }

  return messages
}

// ─── Component props ─────────────────────────────────────────────────────────

interface ChatContinuationProps {
  markdown: string
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ChatContinuation({ markdown }: ChatContinuationProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS)
  const [continuationMessages, setContinuationMessages] = useState<ContinuationMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [localModels, setLocalModels] = useState<ModelOption[]>([])
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<Record<ChatProvider, 'idle' | 'testing' | 'ok' | 'fail'>>({
    openai: 'idle',
    anthropic: 'idle',
    google: 'idle',
    ollama: 'idle',
    lmstudio: 'idle',
    custom: 'idle',
  })

  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Load settings on mount
  useEffect(() => {
    setSettings(loadSettings())
  }, [])

  // Save settings when they change
  const updateSettings = useCallback((update: Partial<ChatSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...update }
      saveSettings(next)
      return next
    })
  }, [])

  const updateProviderSettings = useCallback((provider: ChatProvider, update: Partial<ProviderSettings>) => {
    setSettings((prev) => {
      const next = {
        ...prev,
        [provider]: { ...prev[provider], ...update },
      }
      saveSettings(next)
      return next
    })
  }, [])

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [continuationMessages, streamingContent])

  // Get available models for current provider
  const availableModels: ModelOption[] =
    settings.selectedProvider === 'ollama' ||
    settings.selectedProvider === 'lmstudio' ||
    settings.selectedProvider === 'custom'
      ? localModels.filter((m) => m.provider === settings.selectedProvider)
      : CLOUD_MODELS.filter((m) => m.provider === settings.selectedProvider)

  const selectedModelName =
    availableModels.find((m) => m.id === settings.selectedModel)?.name ??
    settings.selectedModel ??
    'No model selected'

  // Fetch local models
  async function handleFetchModels(provider: ChatProvider) {
    setIsFetchingModels(true)
    const baseUrl = settings[provider].baseUrl
    const models = await fetchLocalModels(provider, baseUrl)
    setLocalModels((prev) => [
      ...prev.filter((m) => m.provider !== provider),
      ...models,
    ])
    if (models.length > 0 && (!settings.selectedModel || settings.selectedProvider !== provider)) {
      updateSettings({ selectedModel: models[0]!.id, selectedProvider: provider })
    }
    setIsFetchingModels(false)
  }

  // Test connection
  async function handleTestConnection(provider: ChatProvider) {
    setConnectionStatus((prev) => ({ ...prev, [provider]: 'testing' }))
    try {
      const baseUrl = settings[provider].baseUrl.replace(/\/+$/, '')
      if (provider === 'ollama') {
        const r = await fetch(`${baseUrl}/api/tags`)
        setConnectionStatus((prev) => ({ ...prev, [provider]: r.ok ? 'ok' : 'fail' }))
      } else if (provider === 'lmstudio' || provider === 'custom') {
        const r = await fetch(`${baseUrl}/v1/models`)
        setConnectionStatus((prev) => ({ ...prev, [provider]: r.ok ? 'ok' : 'fail' }))
      } else {
        // Cloud providers — just check if key is set
        setConnectionStatus((prev) => ({
          ...prev,
          [provider]: settings[provider].apiKey ? 'ok' : 'fail',
        }))
      }
    } catch {
      setConnectionStatus((prev) => ({ ...prev, [provider]: 'fail' }))
    }
  }

  // Send message
  async function handleSend() {
    const trimmed = inputValue.trim()
    if (!trimmed || isStreaming) return
    if (!settings.selectedModel) {
      setError('Select a model first. Open settings with the ⚙ button.')
      return
    }

    setError(null)
    setInputValue('')

    const userMessage: ContinuationMessage = { role: 'user', content: trimmed }
    setContinuationMessages((prev) => [...prev, userMessage])

    // Build full message history
    const historyMessages = conversationMarkdownToMessages(markdown)
    const continuationChatMessages: ChatMessage[] = continuationMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }))
    const allMessages: ChatMessage[] = [
      ...historyMessages,
      ...continuationChatMessages,
      { role: 'user', content: trimmed },
    ]

    setIsStreaming(true)
    setStreamingContent('')

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      let fullContent = ''
      const stream = streamChatCompletion(
        settings.selectedProvider,
        settings.selectedModel,
        allMessages,
        settings,
        controller.signal,
      )

      for await (const token of stream) {
        fullContent += token
        setStreamingContent(fullContent)
      }

      const assistantMessage: ContinuationMessage = {
        role: 'assistant',
        content: fullContent,
        model: settings.selectedModel,
        provider: settings.selectedProvider,
      }
      setContinuationMessages((prev) => [...prev, assistantMessage])
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User cancelled
      } else {
        const message = err instanceof Error ? err.message : 'Something went wrong'
        setError(message)
      }
    } finally {
      setIsStreaming(false)
      setStreamingContent('')
      abortControllerRef.current = null
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Close settings on Escape
  useEffect(() => {
    if (!isSettingsOpen) return
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsSettingsOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isSettingsOpen])

  if (!isExpanded) {
    return (
      <button
        type="button"
        onClick={() => setIsExpanded(true)}
        className="group mt-3 flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-[linear-gradient(180deg,rgba(255,255,255,0.54),rgba(255,255,255,0.32))] px-5 py-4 transition-all duration-200 hover:-translate-y-px hover:border-line-strong hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.7),rgba(255,255,255,0.46))] hover:shadow-soft"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[linear-gradient(135deg,rgba(188,132,66,0.18),rgba(49,67,58,0.1))] text-[0.9rem]">
            ▶
          </span>
          <span className="text-[0.95rem] font-semibold text-ink">
            Continue this conversation
          </span>
        </div>
        <span className={cn(monoCapsClass, 'text-[0.68rem] text-ink-soft group-hover:text-ink')}>
          Pick any model
        </span>
      </button>
    )
  }

  return (
    <>
      {/* Settings Modal */}
      {isSettingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4 backdrop-blur-[2px]"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="panel-shell w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 max-[720px]:p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-5">
              <h2 className="text-[1.05rem] font-bold text-ink">
                Model Settings
              </h2>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-white/46 text-ink-soft transition-colors hover:bg-white/68 hover:border-line-strong"
              >
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                  <path d="M18 6L6 18M6 6l12 12" className="fill-none stroke-current stroke-[2] stroke-linecap-round" />
                </svg>
              </button>
            </div>

            <div className="grid gap-5">
              {/* Cloud Providers */}
              <div className="grid gap-3">
                <p className={cn(monoCapsClass, 'text-[0.72rem] text-ink-soft')}>
                  Cloud Providers
                </p>
                {(['openai', 'anthropic', 'google'] as const).map((provider) => (
                  <div
                    key={provider}
                    className="rounded-xl border border-line bg-[rgba(255,255,255,0.4)] p-4"
                  >
                    <div className="flex items-center justify-between pb-3">
                      <span className="text-[0.9rem] font-semibold text-ink">
                        {PROVIDER_LABELS[provider]}
                      </span>
                      <ConnectionBadge status={connectionStatus[provider]} />
                    </div>
                    <div className="grid gap-2.5">
                      <input
                        type="password"
                        placeholder="API Key"
                        value={settings[provider].apiKey}
                        onChange={(e) => updateProviderSettings(provider, { apiKey: e.target.value })}
                        className="w-full rounded-lg border border-line bg-paper-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-[border-color,box-shadow] focus:border-[rgba(155,106,51,0.48)] focus:shadow-[0_0_0_4px_var(--focus)]"
                      />
                      <button
                        type="button"
                        onClick={() => handleTestConnection(provider)}
                        className="w-fit rounded-lg border border-line bg-white/50 px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-[0.08em] text-ink-soft transition-colors hover:border-line-strong hover:bg-white/72 hover:text-ink"
                      >
                        Test Connection
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Local Providers */}
              <div className="grid gap-3">
                <p className={cn(monoCapsClass, 'text-[0.72rem] text-ink-soft')}>
                  Local Models
                </p>
                {(['ollama', 'lmstudio', 'custom'] as const).map((provider) => (
                  <div
                    key={provider}
                    className="rounded-xl border border-line bg-[rgba(255,255,255,0.4)] p-4"
                  >
                    <div className="flex items-center justify-between pb-3">
                      <span className="text-[0.9rem] font-semibold text-ink">
                        {PROVIDER_LABELS[provider]}
                      </span>
                      <ConnectionBadge status={connectionStatus[provider]} />
                    </div>
                    <div className="grid gap-2.5">
                      <input
                        type="text"
                        placeholder="Endpoint URL"
                        value={settings[provider].baseUrl}
                        onChange={(e) => updateProviderSettings(provider, { baseUrl: e.target.value })}
                        className="w-full rounded-lg border border-line bg-paper-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-[border-color,box-shadow] focus:border-[rgba(155,106,51,0.48)] focus:shadow-[0_0_0_4px_var(--focus)]"
                      />
                      {provider === 'custom' && (
                        <input
                          type="password"
                          placeholder="API Key (optional)"
                          value={settings[provider].apiKey}
                          onChange={(e) => updateProviderSettings(provider, { apiKey: e.target.value })}
                          className="w-full rounded-lg border border-line bg-paper-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-[border-color,box-shadow] focus:border-[rgba(155,106,51,0.48)] focus:shadow-[0_0_0_4px_var(--focus)]"
                        />
                      )}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleFetchModels(provider)}
                          disabled={isFetchingModels}
                          className="w-fit rounded-lg border border-line bg-white/50 px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-[0.08em] text-ink-soft transition-colors hover:border-line-strong hover:bg-white/72 hover:text-ink disabled:opacity-50"
                        >
                          {isFetchingModels ? 'Fetching...' : 'Fetch Models'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleTestConnection(provider)}
                          className="w-fit rounded-lg border border-line bg-white/50 px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-[0.08em] text-ink-soft transition-colors hover:border-line-strong hover:bg-white/72 hover:text-ink"
                        >
                          Test
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-center text-[0.78rem] text-ink-soft">
                All keys are stored in your browser only. Nothing is sent to our server.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Continuation Panel */}
      <div className="mt-3 rounded-2xl border border-line bg-[linear-gradient(180deg,rgba(255,255,255,0.54),rgba(255,255,255,0.32))] backdrop-blur-[20px]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[linear-gradient(135deg,rgba(188,132,66,0.18),rgba(49,67,58,0.1))] text-[0.8rem]">
              ▶
            </span>
            <span className="text-[0.9rem] font-semibold text-ink">
              Continue
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Model selector */}
            <div className="relative">
              <select
                value={`${settings.selectedProvider}:${settings.selectedModel}`}
                onChange={(e) => {
                  const [provider, ...modelParts] = e.target.value.split(':')
                  const model = modelParts.join(':')
                  updateSettings({
                    selectedProvider: provider as ChatProvider,
                    selectedModel: model,
                  })
                }}
                className="h-8 appearance-none rounded-full border border-line bg-white/50 px-3 pr-7 font-mono text-[0.72rem] uppercase tracking-[0.06em] text-ink outline-none transition-[border-color,background] hover:border-line-strong hover:bg-white/72 focus:border-[rgba(155,106,51,0.48)] focus:shadow-[0_0_0_4px_var(--focus)]"
              >
                {CLOUD_MODELS.length > 0 && (
                  <optgroup label="Cloud">
                    {CLOUD_MODELS.map((m) => (
                      <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {localModels.length > 0 && (
                  <optgroup label="Local">
                    {localModels.map((m) => (
                      <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft"
                viewBox="0 0 24 24"
              >
                <path
                  d="M6 9l6 6 6-6"
                  className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round"
                />
              </svg>
            </div>

            {/* Settings button */}
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-white/46 text-ink-soft transition-[border-color,background,color] hover:border-line-strong hover:bg-white/68 hover:text-ink"
              title="Model settings"
            >
              <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                <path
                  d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
                  className="fill-none stroke-current stroke-[1.6] stroke-linecap-round stroke-linejoin-round"
                />
                <circle cx="12" cy="12" r="3" className="fill-none stroke-current stroke-[1.6]" />
              </svg>
            </button>

            {/* Collapse button */}
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-white/46 text-ink-soft transition-[border-color,background,color] hover:border-line-strong hover:bg-white/68 hover:text-ink"
            >
              <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                <path d="M18 15l-6-6-6 6" className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round" />
              </svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="max-h-[24rem] min-h-[8rem] overflow-y-auto overscroll-contain px-5 py-4">
          {continuationMessages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
              <p className="text-[0.9rem] text-ink-muted">
                Type a message to continue the conversation with{' '}
                <span className="font-semibold text-ink">{selectedModelName}</span>
              </p>
              <p className="text-[0.78rem] text-ink-soft">
                The full imported conversation will be included as context.
              </p>
            </div>
          )}

          {continuationMessages.map((msg, index) => (
            <div
              key={index}
              className={cn(
                'mb-4 last:mb-0',
                msg.role === 'user' ? 'pl-8' : '',
              )}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className={cn(monoCapsClass, 'text-[0.68rem] text-ink-soft')}>
                  {msg.role === 'user' ? 'You' : (
                    <>
                      {msg.model && (
                        <span className="text-brass">{msg.model}</span>
                      )}
                    </>
                  )}
                </span>
              </div>
              {msg.role === 'assistant' ? (
                <div className="markdown-preview text-[0.92rem] leading-[1.68]">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw, rehypeHighlight]}
                    components={{
                      a: ({ node: _node, ...props }) => (
                        <a {...props} rel="noreferrer" target="_blank" />
                      ),
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="rounded-xl border border-line bg-[rgba(255,255,255,0.5)] px-4 py-3 text-[0.92rem] leading-[1.68] text-ink">
                  {msg.content}
                </div>
              )}
            </div>
          ))}

          {/* Streaming message */}
          {isStreaming && streamingContent && (
            <div className="mb-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span className={cn(monoCapsClass, 'text-[0.68rem] text-brass')}>
                  {settings.selectedModel}
                </span>
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brass" />
              </div>
              <div className="markdown-preview text-[0.92rem] leading-[1.68]">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, rehypeHighlight]}
                  components={{
                    a: ({ node: _node, ...props }) => (
                      <a {...props} rel="noreferrer" target="_blank" />
                    ),
                  }}
                >
                  {streamingContent}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {isStreaming && !streamingContent && (
            <div className="mb-4 flex items-center gap-2 py-2">
              <span className={cn(monoCapsClass, 'text-[0.68rem] text-ink-soft')}>
                Thinking
              </span>
              <span className="flex gap-1">
                <span className="inline-block h-1.5 w-1.5 animate-[bounce_1s_ease-in-out_infinite] rounded-full bg-ink-soft" />
                <span className="inline-block h-1.5 w-1.5 animate-[bounce_1s_ease-in-out_0.15s_infinite] rounded-full bg-ink-soft" />
                <span className="inline-block h-1.5 w-1.5 animate-[bounce_1s_ease-in-out_0.3s_infinite] rounded-full bg-ink-soft" />
              </span>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-xl border border-[rgba(142,57,44,0.18)] bg-[rgba(255,240,236,0.94)] px-4 py-3">
              <p className={cn(monoCapsClass, 'pb-1 text-[0.68rem] text-danger-ink')}>Error</p>
              <p className="text-[0.88rem] leading-[1.6] text-ink">{error}</p>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-line px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className="min-h-[2.5rem] max-h-[8rem] flex-1 resize-none rounded-xl border border-line bg-paper-inset px-4 py-2.5 text-[0.92rem] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-soft focus:border-[rgba(155,106,51,0.48)] focus:shadow-[0_0_0_4px_var(--focus)]"
              disabled={isStreaming}
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[rgba(142,57,44,0.28)] bg-[rgba(142,57,44,0.08)] text-danger-ink transition-colors hover:bg-[rgba(142,57,44,0.14)]"
                title="Stop generating"
              >
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" className="fill-current" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!inputValue.trim()}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[rgba(23,20,17,0.18)] bg-[linear-gradient(135deg,#292520,#171411)] text-[#f5eee5] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-[box-shadow,transform] hover:enabled:-translate-y-px hover:enabled:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_8px_16px_rgba(23,20,17,0.12)] disabled:opacity-40"
                title="Send message"
              >
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                  <path d="M12 19V5M5 12l7-7 7 7" className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ConnectionBadge({ status }: { status: 'idle' | 'testing' | 'ok' | 'fail' }) {
  if (status === 'idle') return null

  const config = {
    testing: { label: 'Testing...', bg: 'bg-[rgba(156,118,45,0.12)]', text: 'text-warning-ink' },
    ok: { label: 'Connected', bg: 'bg-[rgba(49,120,60,0.12)]', text: 'text-[#2d6a34]' },
    fail: { label: 'Failed', bg: 'bg-[rgba(142,57,44,0.12)]', text: 'text-danger-ink' },
  }[status]

  return (
    <span className={cn('rounded-full px-2.5 py-1 font-mono text-[0.66rem] uppercase tracking-[0.08em]', config.bg, config.text)}>
      {config.label}
    </span>
  )
}
