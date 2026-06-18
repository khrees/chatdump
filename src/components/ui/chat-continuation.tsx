import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '../../lib/cn'

// ─── Storage keys ────────────────────────────────────────────────────────────

const CHAT_SETTINGS_KEY = 'chatdump.chat-settings.v1'

// ─── Types ───────────────────────────────────────────────────────────────────

type ChatProvider = 'openai' | 'anthropic' | 'google' | 'grok' | 'mistral' | 'ollama' | 'lmstudio' | 'custom' | 'webapp'

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
  grok: ProviderSettings
  mistral: ProviderSettings
  ollama: ProviderSettings
  lmstudio: ProviderSettings
  custom: ProviderSettings
  webapp: ProviderSettings
  selectedProvider: ChatProvider
  selectedModel: string
}

interface ContinuationMessage {
  role: 'user' | 'assistant'
  content: string
  model?: string
  provider?: ChatProvider
}

interface WebAppOption {
  id: string
  name: string
  url: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ChatSettings = {
  openai: { apiKey: '', baseUrl: 'https://api.openai.com', enabled: false },
  anthropic: { apiKey: '', baseUrl: 'https://api.anthropic.com', enabled: false },
  google: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', enabled: false },
  grok: { apiKey: '', baseUrl: 'https://api.x.ai', enabled: false },
  mistral: { apiKey: '', baseUrl: 'https://api.mistral.ai', enabled: false },
  ollama: { apiKey: '', baseUrl: 'http://localhost:11434', enabled: false },
  lmstudio: { apiKey: '', baseUrl: 'http://localhost:1234', enabled: false },
  custom: { apiKey: '', baseUrl: '', enabled: false },
  webapp: { apiKey: '', baseUrl: '', enabled: true },
  selectedProvider: 'webapp',
  selectedModel: 'chatgpt-web',
}

const CLOUD_MODELS: ModelOption[] = [
  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', provider: 'openai' },
  { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', provider: 'openai' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai' },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { id: 'claude-4.5-haiku', name: 'Claude 4.5 Haiku', provider: 'anthropic' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'google' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', provider: 'google' },
  { id: 'grok-4.3', name: 'Grok 4.3', provider: 'grok' },
  { id: 'grok-4.1-fast', name: 'Grok 4.1 Fast', provider: 'grok' },
  { id: 'mistral-large-latest', name: 'Mistral Large', provider: 'mistral' },
  { id: 'mistral-small-latest', name: 'Mistral Small', provider: 'mistral' },
]

const WEB_APPS: WebAppOption[] = [
  { id: 'chatgpt-web', name: 'ChatGPT Web App', url: 'https://chatgpt.com/' },
  { id: 'claude-web', name: 'Claude Web App', url: 'https://claude.ai/new' },
  { id: 'gemini-web', name: 'Gemini Web App', url: 'https://gemini.google.com/' },
  { id: 'grok-web', name: 'Grok Web App', url: 'https://grok.com/' },
  { id: 'copilot-web', name: 'Copilot Web App', url: 'https://copilot.microsoft.com/' },
]

const PROVIDER_LABELS: Record<ChatProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google AI',
  grok: 'Grok',
  mistral: 'Mistral',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom',
  webapp: 'Web App',
}

const monoCapsClass = 'font-mono uppercase tracking-[0.14em]'

function wrapMarkdown(text: string): string {
  return `Taking this conversation history into context, answer the next questions \n\n${text}`
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      console.warn('Clipboard API failed, using fallback:', err)
    }
  }

  try {
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.top = '0'
    textArea.style.left = '0'
    textArea.style.position = 'fixed'
    textArea.style.opacity = '0'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()
    const successful = document.execCommand('copy')
    document.body.removeChild(textArea)
    return successful
  } catch (err) {
    console.error('Fallback copy failed:', err)
    return false
  }
}

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

async function parseErrorResponse(response: Response, defaultPrefix: string): Promise<Error> {
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

  return new Error(`${defaultPrefix}: ${errorMessage}`)
}

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
    throw await parseErrorResponse(response, 'API Error')
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
    throw await parseErrorResponse(response, 'Ollama Error')
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
    throw await parseErrorResponse(response, 'Google AI Error')
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
    case 'anthropic':
    case 'grok':
    case 'mistral': {
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

    case 'webapp': {
      throw new Error('Web Apps do not support direct API streaming.')
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
  disableCollapse?: boolean
  className?: string
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ChatContinuation({ markdown, disableCollapse = false, className }: ChatContinuationProps) {
  const [isExpanded, setIsExpanded] = useState(disableCollapse)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS)
  const [continuationMessages, setContinuationMessages] = useState<ContinuationMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Auto-dismiss error toast after 7 seconds
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => {
      setError(null)
    }, 7000)
    return () => clearTimeout(timer)
  }, [error])
  const [localModels, setLocalModels] = useState<ModelOption[]>([])
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<Record<ChatProvider, 'idle' | 'testing' | 'ok' | 'fail'>>({
    openai: 'idle',
    anthropic: 'idle',
    google: 'idle',
    grok: 'idle',
    mistral: 'idle',
    ollama: 'idle',
    lmstudio: 'idle',
    custom: 'idle',
    webapp: 'idle',
  })
  const [activeCloudEdit, setActiveCloudEdit] = useState<'openai' | 'anthropic' | 'google' | 'grok' | 'mistral'>('openai')
  const [activeLocalEdit, setActiveLocalEdit] = useState<'ollama' | 'lmstudio' | 'custom'>('ollama')

  // Synchronize active cloud and local edit providers with selected provider
  useEffect(() => {
    if (isSettingsOpen) {
      if (['openai', 'anthropic', 'google', 'grok', 'mistral'].includes(settings.selectedProvider)) {
        setActiveCloudEdit(settings.selectedProvider as any)
      } else if (['ollama', 'lmstudio', 'custom'].includes(settings.selectedProvider)) {
        setActiveLocalEdit(settings.selectedProvider as any)
      }
    }
  }, [isSettingsOpen, settings.selectedProvider])

  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Synchronize isExpanded with disableCollapse
  useEffect(() => {
    if (disableCollapse) {
      setIsExpanded(true)
    }
  }, [disableCollapse])

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
      : settings.selectedProvider === 'webapp'
      ? WEB_APPS.map(w => ({ id: w.id, name: w.name, provider: 'webapp' }))
      : CLOUD_MODELS.filter((m) => m.provider === settings.selectedProvider)

  const selectedModelName =
    settings.selectedProvider === 'webapp'
      ? WEB_APPS.find((w) => w.id === settings.selectedModel)?.name ?? settings.selectedModel
      : availableModels.find((m) => m.id === settings.selectedModel)?.name ??
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

    const provider = settings.selectedProvider
    const providerSettings = settings[provider]

    // Pre-check for missing cloud API keys
    if (['openai', 'anthropic', 'grok', 'mistral', 'google'].includes(provider) && !providerSettings.apiKey) {
      setError(`API key is missing for ${PROVIDER_LABELS[provider] || provider}. Please click the settings button (⚙) to enter your API key.`)
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

  // Generate packaged prompt context including imported history and continuation messages
  function getFullConversationMarkdown() {
    let fullMarkdown = markdown
    if (continuationMessages.length > 0) {
      fullMarkdown += '\n\n' + continuationMessages.map(m => {
        const roleName = m.role === 'user' ? 'You' : (m.model || 'Assistant')
        return `## ${roleName}\n\n${m.content}`
      }).join('\n\n')
    }
    return fullMarkdown
  }

  const fullMarkdownContext = getFullConversationMarkdown()
  const promptText = wrapMarkdown(fullMarkdownContext)
  const promptLength = promptText.length
  const isTooLong = promptLength > 1000

  async function handleWebappRedirect() {
    const copied = await copyToClipboard(promptText)
    
    // Determine provider redirect URL
    let redirectUrl = 'https://chatgpt.com/'
    if (settings.selectedModel === 'chatgpt-web') {
      redirectUrl = isTooLong ? 'https://chatgpt.com/' : `https://chatgpt.com/?prompt=${encodeURIComponent(promptText)}`
    } else if (settings.selectedModel === 'claude-web') {
      redirectUrl = isTooLong ? 'https://claude.ai/new' : `https://claude.ai/new?q=${encodeURIComponent(promptText)}`
    } else if (settings.selectedModel === 'gemini-web') {
      redirectUrl = isTooLong ? 'https://gemini.google.com/' : `https://gemini.google.com/?prompt=${encodeURIComponent(promptText)}`
    } else if (settings.selectedModel === 'grok-web') {
      redirectUrl = isTooLong ? 'https://grok.com/' : `https://grok.com/?prompt=${encodeURIComponent(promptText)}`
    } else if (settings.selectedModel === 'copilot-web') {
      redirectUrl = isTooLong ? 'https://copilot.microsoft.com/' : `https://copilot.microsoft.com/?prompt=${encodeURIComponent(promptText)}`
    }

    if (copied) {
      setError(`Context copied to clipboard! Opening ${
        settings.selectedModel === 'chatgpt-web' ? 'ChatGPT' :
        settings.selectedModel === 'claude-web' ? 'Claude' :
        settings.selectedModel === 'gemini-web' ? 'Gemini' :
        settings.selectedModel === 'grok-web' ? 'Grok' : 'Copilot'
      }...`)
    } else {
      setError(`Failed to copy to clipboard, opening web app anyway...`)
    }

    window.open(redirectUrl, '_blank', 'noopener,noreferrer')
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

  if (!isExpanded && !disableCollapse) {
    return (
      <button
        type="button"
        onClick={() => setIsExpanded(true)}
        className="group mt-4 flex w-full items-center justify-between gap-3 rounded-lg border border-border-contrast bg-paper-solid-elevated px-5 py-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-teal hover:bg-paper-solid hover:shadow-soft text-left"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal/10 text-teal text-[0.9rem] transition-colors group-hover:bg-teal/20">
            <svg className="h-4 w-4 text-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </span>
          <span className="text-[0.95rem] font-bold text-ink">
            Continue this conversation
          </span>
        </div>
        <span className={cn(monoCapsClass, 'text-[0.68rem] font-bold text-ink-soft group-hover:text-teal transition-colors')}>
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-xs"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 max-[720px]:p-5 animate-slide-up bg-paper-solid border border-border-contrast rounded-xl shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-4 border-b border-border-contrast mb-5">
              <h2 className="text-[1.05rem] font-extrabold text-ink uppercase tracking-wider">
                Model Settings
              </h2>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-contrast bg-paper-solid text-ink-soft hover:text-ink hover:bg-paper-solid-inset transition-colors"
              >
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                  <path d="M18 6L6 18M6 6l12 12" className="fill-none stroke-current stroke-[2] stroke-linecap-round" />
                </svg>
              </button>
            </div>

            <div className="grid gap-5">
              {/* Cloud Providers */}
              <div className="grid gap-3">
                <p className={cn(monoCapsClass, 'text-[0.72rem] font-bold text-ink-soft')}>
                  Cloud Providers
                </p>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[0.82rem] font-bold text-ink">
                    Select Provider to Configure
                  </label>
                  <div className="relative">
                    <select
                      value={activeCloudEdit}
                      onChange={(e) => setActiveCloudEdit(e.target.value as any)}
                      className="w-full appearance-none rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2 pr-8 font-mono text-[0.82rem] text-ink outline-none transition-all hover:bg-paper-solid hover:border-line-strong focus:border-teal focus:ring-2 focus:ring-teal/20"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="google">Google AI</option>
                      <option value="grok">Grok (xAI)</option>
                      <option value="mistral">Mistral</option>
                    </select>
                    <svg
                      aria-hidden="true"
                      className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M6 9l6 6 6-6"
                        className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round"
                      />
                    </svg>
                  </div>
                </div>

                <div className="rounded-lg border border-border-contrast bg-paper-solid-elevated p-4 shadow-sm mt-1">
                  <div className="flex items-center justify-between pb-3">
                    <span className="text-[0.9rem] font-bold text-ink">
                      {PROVIDER_LABELS[activeCloudEdit]} Settings
                    </span>
                    <ConnectionBadge status={connectionStatus[activeCloudEdit]} />
                  </div>
                  <div className="grid gap-2.5">
                    <input
                      type="password"
                      placeholder="API Key"
                      value={settings[activeCloudEdit].apiKey}
                      onChange={(e) => updateProviderSettings(activeCloudEdit, { apiKey: e.target.value })}
                      className="w-full rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-all focus:border-teal focus:ring-2 focus:ring-teal/20 placeholder:text-ink-soft"
                    />
                    <button
                      type="button"
                      onClick={() => handleTestConnection(activeCloudEdit)}
                      className="w-fit rounded-lg border border-border-contrast bg-paper-solid px-3.5 py-2 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-ink transition-colors hover:border-line-strong hover:bg-paper-solid-inset"
                    >
                      Test Connection
                    </button>
                  </div>
                </div>
              </div>

              {/* Local Providers */}
              <div className="grid gap-3">
                <p className={cn(monoCapsClass, 'text-[0.72rem] font-bold text-ink-soft')}>
                  Local Models
                </p>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[0.82rem] font-bold text-ink">
                    Select Local Provider to Configure
                  </label>
                  <div className="relative">
                    <select
                      value={activeLocalEdit}
                      onChange={(e) => setActiveLocalEdit(e.target.value as any)}
                      className="w-full appearance-none rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2 pr-8 font-mono text-[0.82rem] text-ink outline-none transition-all hover:bg-paper-solid hover:border-line-strong focus:border-teal focus:ring-2 focus:ring-teal/20"
                    >
                      <option value="ollama">Ollama</option>
                      <option value="lmstudio">LM Studio</option>
                      <option value="custom">Custom</option>
                    </select>
                    <svg
                      aria-hidden="true"
                      className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M6 9l6 6 6-6"
                        className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round"
                      />
                    </svg>
                  </div>
                </div>

                <div className="rounded-lg border border-border-contrast bg-paper-solid-elevated p-4 shadow-sm mt-1">
                  <div className="flex items-center justify-between pb-3">
                    <span className="text-[0.9rem] font-bold text-ink">
                      {PROVIDER_LABELS[activeLocalEdit]} Settings
                    </span>
                    <ConnectionBadge status={connectionStatus[activeLocalEdit]} />
                  </div>
                  <div className="grid gap-2.5">
                    <input
                      type="text"
                      placeholder="Endpoint URL"
                      value={settings[activeLocalEdit].baseUrl}
                      onChange={(e) => updateProviderSettings(activeLocalEdit, { baseUrl: e.target.value })}
                      className="w-full rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-all focus:border-teal focus:ring-2 focus:ring-teal/20 placeholder:text-ink-soft"
                    />
                    {activeLocalEdit === 'custom' && (
                      <input
                        type="password"
                        placeholder="API Key (optional)"
                        value={settings[activeLocalEdit].apiKey}
                        onChange={(e) => updateProviderSettings(activeLocalEdit, { apiKey: e.target.value })}
                        className="w-full rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-all focus:border-teal focus:ring-2 focus:ring-teal/20 placeholder:text-ink-soft"
                      />
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleFetchModels(activeLocalEdit)}
                        disabled={isFetchingModels}
                        className="rounded-lg border border-border-contrast bg-paper-solid px-3.5 py-2 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-ink transition-colors hover:border-line-strong hover:bg-paper-solid-inset disabled:opacity-50"
                      >
                        {isFetchingModels ? 'Fetching...' : 'Fetch Models'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTestConnection(activeLocalEdit)}
                        className="rounded-lg border border-border-contrast bg-paper-solid px-3.5 py-2 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-ink transition-colors hover:border-line-strong hover:bg-paper-solid-inset"
                      >
                        Test
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <p className="text-center text-[0.75rem] text-ink-soft mt-2">
                All keys are stored in your browser only. Nothing is sent to our server.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Continuation Panel */}
      <div className={cn("mt-4 rounded-xl border border-border-contrast bg-paper-solid-elevated shadow-lg animate-fade-in overflow-hidden", className)}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-contrast px-5 py-3.5 bg-paper-solid">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal/10 text-teal text-[0.85rem]">
              <svg className="h-4.5 w-4.5 text-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </span>
            <span className="text-[0.9rem] font-extrabold text-ink uppercase tracking-wide">
              Continuation Chat
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
                className="h-8 appearance-none rounded-lg border border-border-contrast bg-paper-solid-inset px-3 pr-7 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-ink outline-none transition-all hover:bg-paper-solid hover:border-line-strong focus:border-teal focus:ring-2 focus:ring-teal/20"
              >
                {CLOUD_MODELS.length > 0 && (
                  <optgroup label="Cloud API (Requires Key)">
                    {CLOUD_MODELS.map((m) => (
                      <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {localModels.length > 0 && (
                  <optgroup label="Local API">
                    {localModels.map((m) => (
                      <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Browser Web Apps (Free)">
                  <option value="webapp:chatgpt-web">ChatGPT Web App</option>
                  <option value="webapp:claude-web">Claude Web App</option>
                  <option value="webapp:gemini-web">Gemini Web App</option>
                  <option value="webapp:grok-web">Grok Web App</option>
                  <option value="webapp:copilot-web">Copilot Web App</option>
                </optgroup>
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
              disabled={settings.selectedProvider === 'webapp'}
              onClick={() => setIsSettingsOpen(true)}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-contrast bg-paper-solid text-ink-soft hover:text-ink hover:bg-paper-solid-inset transition-colors",
                settings.selectedProvider === 'webapp' && "opacity-35 cursor-not-allowed"
              )}
              title={settings.selectedProvider === 'webapp' ? "No configuration needed for web apps" : "Model settings"}
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
            {!disableCollapse && (
              <button
                type="button"
                onClick={() => setIsExpanded(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-contrast bg-paper-solid text-ink-soft hover:text-ink hover:bg-paper-solid-inset transition-colors"
              >
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                  <path d="M18 15l-6-6-6 6" className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Dynamic Body content */}
        {settings.selectedProvider === 'webapp' ? (
          <div className="bg-paper-solid p-6 border-b border-border-contrast flex flex-col items-center justify-center gap-4 text-center animate-fade-in">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-teal/10 text-teal text-[1.2rem] mb-1">
              <svg className="h-5.5 w-5.5 text-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </span>
            <div className="max-w-md">
              <p className="text-[0.92rem] font-bold text-ink">
                Continue this conversation in {
                  settings.selectedModel === 'chatgpt-web' ? 'ChatGPT' :
                  settings.selectedModel === 'claude-web' ? 'Claude' :
                  settings.selectedModel === 'gemini-web' ? 'Gemini' :
                  settings.selectedModel === 'grok-web' ? 'Grok' : 'Copilot'
                }
              </p>
              <p className="text-[0.78rem] text-ink-soft mt-1 leading-relaxed">
                Browser web apps do not support API streaming. Instead, we'll package the entire conversation context (including any continuation messages below), copy it to your clipboard, and launch the platform.
              </p>
            </div>

            {/* Prompt preview container */}
            <div className="w-full max-w-md text-left mt-2">
              <span className="text-[0.68rem] font-mono font-bold uppercase tracking-wider text-ink-soft mb-1 block">Context Prompt Preview</span>
              <div className="relative rounded-lg border border-border-contrast bg-paper-solid-inset p-3 max-h-36 overflow-y-auto w-full">
                <pre className="font-mono text-[0.72rem] text-ink-muted whitespace-pre-wrap leading-normal">
                  {promptText}
                </pre>
                <div className="absolute bottom-2 right-2">
                  <span className="text-[0.58rem] font-mono bg-paper-solid border border-border-contrast rounded px-1.5 py-0.5 text-ink-soft">
                    {promptLength.toLocaleString()} chars
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleWebappRedirect}
              className="w-full max-w-md flex items-center justify-center gap-2 rounded-lg bg-teal text-white py-2.5 px-4 text-xs font-mono font-bold uppercase tracking-wider border border-teal/10 hover:bg-teal-hover transition-all shadow-sm mt-2"
            >
              Copy Context & Open Web App
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            {/* Messages */}
            <div className="max-h-[30rem] min-h-[8rem] overflow-y-auto overscroll-contain px-5 py-5 border-b border-border-contrast bg-paper-solid flex flex-col gap-4">
              {continuationMessages.length === 0 && !isStreaming && (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-teal/10 text-teal text-[1.2rem] mb-2">
                    <svg className="h-6 w-6 text-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </span>
                  <p className="text-[0.92rem] font-bold text-ink-muted">
                    Type a message to continue the conversation with{' '}
                    <span className="text-teal font-extrabold">{selectedModelName}</span>
                  </p>
                  <p className="text-[0.78rem] text-ink-soft max-w-sm">
                    The imported conversation above is automatically loaded in context.
                  </p>
                </div>
              )}

              {continuationMessages.map((msg, index) => (
                <div
                  key={index}
                  className={cn(
                    'flex flex-col w-full',
                    msg.role === 'user' ? 'items-end' : 'items-start',
                  )}
                >
                  <div className="mb-1 flex items-center gap-2 px-1">
                    <span className={cn(monoCapsClass, 'text-[0.68rem] font-bold text-ink-soft')}>
                      {msg.role === 'user' ? 'You' : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[0.62rem] font-mono font-bold uppercase bg-teal/10 text-teal border border-teal/20">
                          {msg.model ?? 'assistant'}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className={cn(
                    "rounded-xl border p-4 text-[0.92rem] shadow-sm max-w-[85%] min-w-[12rem]",
                    msg.role === 'user'
                      ? "bg-paper-solid-inset border-border-contrast text-ink"
                      : "bg-paper-solid-elevated border-border-contrast text-ink"
                  )}>
                    {msg.role === 'user' ? (
                      <div className="whitespace-pre-wrap leading-[1.6]">{msg.content}</div>
                    ) : (
                      <div className="markdown-preview leading-[1.68]">
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
                    )}
                  </div>
                </div>
              ))}

              {/* Streaming message */}
              {isStreaming && streamingContent && (
                <div className="flex flex-col items-start w-full">
                  <div className="mb-1 flex items-center gap-2 px-1">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[0.62rem] font-mono font-bold uppercase bg-teal/10 text-teal border border-teal/20">
                      {settings.selectedModel}
                    </span>
                    <span className="inline-flex items-center text-[0.6rem] font-mono font-bold uppercase text-teal animate-pulse">
                      (STREAMING)
                    </span>
                  </div>
                  <div className="rounded-xl border border-border-contrast bg-paper-solid-elevated p-4 text-[0.92rem] shadow-sm max-w-[85%] w-full">
                    <div className="markdown-preview leading-[1.68]">
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
                </div>
              )}

              {isStreaming && !streamingContent && (
                <div className="flex flex-col items-start w-full">
                  <div className="mb-1 flex items-center gap-2 px-1">
                    <span className={cn(monoCapsClass, 'font-mono text-[0.68rem] font-bold text-ink-soft')}>
                      Thinking
                    </span>
                  </div>
                  <div className="rounded-xl border border-border-contrast bg-paper-solid-elevated px-4 py-3 shadow-sm flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 animate-[bounce_1s_ease-in-out_infinite] rounded-full bg-teal" />
                    <span className="inline-block h-2 w-2 animate-[bounce_1s_ease-in-out_0.15s_infinite] rounded-full bg-teal" />
                    <span className="inline-block h-2 w-2 animate-[bounce_1s_ease-in-out_0.3s_infinite] rounded-full bg-teal" />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="px-4 py-3 bg-paper-solid border-t border-border-contrast">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message to continue conversation..."
                  rows={1}
                  className="min-h-[2.5rem] max-h-[8rem] flex-1 resize-none rounded-lg border border-border-contrast bg-paper-solid-inset px-4 py-2.5 text-[0.9rem] text-ink outline-none transition-all placeholder:text-ink-soft focus:border-teal focus:ring-2 focus:ring-teal/20 disabled:opacity-50"
                  disabled={isStreaming}
                />
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-rose-500/20 bg-rose-600 text-white shadow-sm hover:bg-rose-700 hover:shadow transition-colors"
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
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-teal/20 bg-teal text-white shadow-sm hover:enabled:bg-teal-hover hover:enabled:shadow transition-all disabled:opacity-30"
                    title="Send message"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                      <path d="M12 19V5M5 12l7-7 7 7" className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {error && (
        <div
          aria-live="assertive"
          className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] gap-2.5 animate-slide-up"
        >
          <div className="pointer-events-auto grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-rose-200 bg-rose-50/95 dark:bg-rose-950/90 dark:border-rose-900/50 text-rose-800 dark:text-rose-200 p-3.5 pr-3 pl-4 shadow-lg backdrop-blur-md">
            <div className="grid gap-[0.2rem]">
              <p className={cn(monoCapsClass, 'font-mono text-[0.68rem] font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400')}>
                Connection Error
              </p>
              <p className="text-[0.85rem] leading-[1.5] font-medium">{error}</p>
            </div>
            <button
              aria-label="Dismiss error"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-paper/50 hover:bg-paper-raised text-ink-soft hover:text-ink transition-colors animate-fade-in"
              type="button"
              onClick={() => setError(null)}
            >
              <span aria-hidden="true" className="inline-block rotate-45 text-base leading-none">
                +
              </span>
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ConnectionBadge({ status }: { status: 'idle' | 'testing' | 'ok' | 'fail' }) {
  if (status === 'idle') return null

  const config = {
    testing: { label: 'Testing...', bg: 'bg-amber-500/10 border-amber-500/30', text: 'text-amber-700 dark:text-amber-400' },
    ok: { label: 'Connected', bg: 'bg-emerald-500/10 border-emerald-500/30', text: 'text-emerald-700 dark:text-emerald-400' },
    fail: { label: 'Failed', bg: 'bg-rose-500/10 border-rose-500/30', text: 'text-rose-700 dark:text-rose-400' },
  }[status]

  return (
    <span className={cn('rounded px-2 py-0.5 font-mono text-[0.66rem] uppercase tracking-wider border font-bold', config.bg, config.text)}>
      {config.label}
    </span>
  )
}
