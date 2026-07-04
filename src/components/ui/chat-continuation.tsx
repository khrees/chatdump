import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '../../lib/cn'
import {
  CLOUD_MODELS,
  WEB_APPS,
  PROVIDER_LABELS,
  fetchLocalModels as libFetchLocalModels,
  streamChatCompletion as libStreamChatCompletion,
  streamOpenAICompat,
} from '../../lib/chat'
import type { ChatProvider, ProviderSettings } from '../../lib/chat'

const CHAT_SETTINGS_KEY = 'chatdump.chat-settings.v1'

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

const monoCapsClass = 'font-mono uppercase tracking-[0.14em]'

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

function conversationMarkdownToMessages(markdown: string): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
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

interface ChatContinuationProps {
  markdown: string
  disableCollapse?: boolean
  className?: string
}

export function ChatContinuation({ markdown, disableCollapse = false, className }: ChatContinuationProps) {
  const [isExpanded, setIsExpanded] = useState(disableCollapse)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS)
  const [continuationMessages, setContinuationMessages] = useState<ContinuationMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editableContext, setEditableContext] = useState('')
  const [contextEdited, setContextEdited] = useState(false)

  // Auto-dismiss error toast after 7 seconds
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => {
      setError(null)
    }, 7000)
    return () => clearTimeout(timer)
  }, [error])

  const [localModels, setLocalModels] = useState<{ id: string; name: string; provider: ChatProvider }[]>([])
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
  const availableModels =
    settings.selectedProvider === 'ollama' ||
    settings.selectedProvider === 'lmstudio' ||
    settings.selectedProvider === 'custom'
      ? localModels.filter((m) => m.provider === settings.selectedProvider)
      : settings.selectedProvider === 'webapp'
      ? WEB_APPS.map(w => ({ id: w.id, name: w.name, provider: 'webapp' as ChatProvider }))
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
    const models = await libFetchLocalModels(provider as any, baseUrl)
    setLocalModels((prev) => [
      ...prev.filter((m) => m.provider !== provider),
      ...models.map(m => ({ id: m.id, name: m.name, provider: m.provider })),
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
    const continuationChatMessages = continuationMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }))
    const allMessages = [
      ...historyMessages,
      ...continuationChatMessages,
      { role: 'user' as const, content: trimmed },
    ]

    setIsStreaming(true)
    setStreamingContent('')

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      let fullContent = ''

      if (settings.selectedProvider === 'webapp') {
        throw new Error('Web Apps do not support direct API streaming.')
      }

      const stream = libStreamChatCompletion({
        provider: settings.selectedProvider as any,
        model: settings.selectedModel,
        messages: allMessages,
        providerConfig: {
          apiKey: settings[provider].apiKey,
          baseUrl: settings[provider].baseUrl,
          enabled: settings[provider].enabled,
        },
        signal: controller.signal,
      })

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
  const promptLength = fullMarkdownContext.length
  const isTooLong = promptLength > 8000

  // Keep editableContext in sync when the source markdown changes, unless user has edited it
  useEffect(() => {
    if (!contextEdited) {
      setEditableContext(fullMarkdownContext)
    }
  }, [fullMarkdownContext, contextEdited])

  async function handleWebappRedirect() {
    const copied = await copyToClipboard(editableContext)

    // Determine provider redirect URL
    let redirectUrl = 'https://chatgpt.com/'
    if (settings.selectedModel === 'chatgpt-web') {
      redirectUrl = isTooLong ? 'https://chatgpt.com/' : `https://chatgpt.com/?prompt=${encodeURIComponent(editableContext)}`
    } else if (settings.selectedModel === 'claude-web') {
      redirectUrl = isTooLong ? 'https://claude.ai/new' : `https://claude.ai/new?q=${encodeURIComponent(editableContext)}`
    } else if (settings.selectedModel === 'gemini-web') {
      redirectUrl = isTooLong ? 'https://gemini.google.com/' : `https://gemini.google.com/?prompt=${encodeURIComponent(editableContext)}`
    } else if (settings.selectedModel === 'grok-web') {
      redirectUrl = isTooLong ? 'https://grok.com/' : `https://grok.com/?prompt=${encodeURIComponent(editableContext)}`
    } else if (settings.selectedModel === 'copilot-web') {
      redirectUrl = isTooLong ? 'https://copilot.microsoft.com/' : `https://copilot.microsoft.com/?prompt=${encodeURIComponent(editableContext)}`
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

            {/* Editable context prompt */}
            <div className="w-full max-w-md text-left mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[0.68rem] font-mono font-bold uppercase tracking-wider text-ink-soft">Context Prompt</span>
                <div className="flex items-center gap-2">
                  {contextEdited && (
                    <span className="text-[0.6rem] font-mono text-amber-500 font-bold uppercase tracking-wide">Edited</span>
                  )}
                  <span className="text-[0.6rem] font-mono bg-paper-solid border border-border-contrast rounded px-1.5 py-0.5 text-ink-soft">
                    {editableContext.length.toLocaleString()} chars
                  </span>
                  {contextEdited && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditableContext(fullMarkdownContext)
                        setContextEdited(false)
                      }}
                      className="text-[0.6rem] font-mono font-bold uppercase tracking-wide text-ink-soft hover:text-ink border border-border-contrast rounded px-1.5 py-0.5 bg-paper-solid hover:bg-paper-solid-inset transition-colors"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              <textarea
                value={editableContext}
                onChange={(e) => {
                  setEditableContext(e.target.value)
                  setContextEdited(true)
                }}
                rows={8}
                spellCheck={false}
                className="w-full rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2.5 font-mono text-[0.72rem] text-ink-muted whitespace-pre-wrap leading-normal resize-y outline-none transition-all focus:border-teal focus:ring-2 focus:ring-teal/20 min-h-[8rem] max-h-64"
              />
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
                          rehypePlugins={[rehypeHighlight]}
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
                        rehypePlugins={[rehypeHighlight]}
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
                  <div className="rounded-xl border border-border-contrast bg-paper-solid-elevated p-4 max-w-[85%]">
                    <div className="flex gap-1.5">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-teal/60" style={{ animationDelay: '0ms' }} />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-teal/60" style={{ animationDelay: '150ms' }} />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-teal/60" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input bar */}
            <div className="bg-paper-solid-elevated px-5 py-4">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={`Ask ${selectedModelName || 'the model'} a question...`}
                  rows={1}
                  className="min-h-[2.8rem] max-h-32 flex-1 resize-none rounded-lg border border-border-contrast bg-paper-solid-inset px-3.5 py-2.5 font-mono text-[0.82rem] text-ink outline-none transition-all focus:border-teal focus:ring-2 focus:ring-teal/20 placeholder:text-ink-soft"
                />

                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="flex h-[2.8rem] w-[2.8rem] shrink-0 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 transition-colors"
                    title="Stop generation"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="2" className="fill-current" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                    className="flex h-[2.8rem] w-[2.8rem] shrink-0 items-center justify-center rounded-lg bg-teal text-white hover:bg-teal-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="Send message"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24">
                      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function ConnectionBadge({ status }: { status: 'idle' | 'testing' | 'ok' | 'fail' }) {
  if (status === 'idle') return null

  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[0.62rem] font-mono font-bold uppercase border',
      status === 'testing' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
      status === 'ok' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
      status === 'fail' && 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30',
    )}>
      {status === 'testing' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />}
      {status === 'ok' && 'Connected'}
      {status === 'fail' && 'Failed'}
      {status === 'testing' && 'Testing...'}
    </span>
  )
}
