import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import { useDeferredValue, useEffect, useRef, useState, startTransition } from 'react'
import { Button } from '../components/ui/button'
import { ShareDropdown } from '../components/ui/share-dropdown'
import { cn } from '../lib/cn'
import { splitMarkdownForPreview } from '../lib/markdown-preview'
import { stripMarkdown } from '../lib/markdown-utils'
import { deleteShareConversationCacheEntry } from '../lib/share-cache'

const RECENT_URLS_KEY = 'chatdump.recent-urls.v1'
const MAX_RECENT_URLS = 10

type ConvertInput = {
  url: string
}

type Toast = {
  id: number
  kind: 'error' | 'warning'
  message: string
}

type PersistedHomeState = {
  markdown: string
  outputMode: 'markdown' | 'preview'
  url: string
  warnings: string[]
}

function buildImageCandidates(src: string | undefined): string[] {
  if (!src) {
    return []
  }

  const candidates = new Set<string>()
  const trimmed = src.trim()

  if (!trimmed) {
    return []
  }

  candidates.add(trimmed)

  try {
    const url = new URL(trimmed)

    if (
      url.hostname === 'grok.com' &&
      /^\/users\/.+/u.test(url.pathname)
    ) {
      candidates.add(`https://assets.grok.com${url.pathname}`)
      candidates.add(`https://assets.grokusercontent.com${url.pathname}`)
    } else if (
      url.hostname === 'assets.grok.com' &&
      /^\/users\/.+/u.test(url.pathname)
    ) {
      candidates.add(`https://assets.grokusercontent.com${url.pathname}`)
    }
  } catch {
    if (/^users\/.+/u.test(trimmed)) {
      candidates.add(`https://assets.grok.com/${trimmed}`)
      candidates.add(`https://assets.grokusercontent.com/${trimmed}`)
    }
  }

  return [...candidates]
}

function getImageReferrerPolicy(
  src: string | undefined,
): React.ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'] | undefined {
  if (!src) {
    return undefined
  }

  try {
    const url = new URL(src)

    if (
      url.hostname.endsWith('googleusercontent.com') ||
      url.hostname === 'lh3.googleusercontent.com'
    ) {
      return 'no-referrer'
    }
  } catch {
    return undefined
  }

  return undefined
}

function PreviewImage(
  props: React.ImgHTMLAttributes<HTMLImageElement>,
) {
  const candidates = buildImageCandidates(props.src)
  const [candidateIndex, setCandidateIndex] = useState(0)
  const currentSrc = candidates[candidateIndex] ?? props.src
  const fallbackHref = candidates.at(-1) ?? props.src
  const referrerPolicy = getImageReferrerPolicy(currentSrc)

  return (
    <span className="preview-image-wrapper">
      <img
        {...props}
        crossOrigin="anonymous"
        decoding="async"
        loading="eager"
        referrerPolicy={referrerPolicy}
        src={currentSrc}
        onError={() => {
          if (candidateIndex < candidates.length - 1) {
            setCandidateIndex(candidateIndex + 1)
          }
        }}
      />
      {fallbackHref ? (
        <a
          className="preview-image-link"
          href={fallbackHref}
          rel="noreferrer"
          target="_blank"
        >
          Open image
        </a>
      ) : null}
    </span>
  )
}

function getRecentUrls(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_URLS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : []
  } catch {
    return []
  }
}

function addRecentUrl(url: string): void {
  if (typeof window === 'undefined') return
  try {
    const recent = getRecentUrls().filter((u) => u !== url)
    const updated = [url, ...recent].slice(0, MAX_RECENT_URLS)
    window.localStorage.setItem(RECENT_URLS_KEY, JSON.stringify(updated))
  } catch {
    // Ignore storage failures
  }
}

function removeRecentUrl(url: string): void {
  if (typeof window === 'undefined') return
  try {
    const recent = getRecentUrls().filter((u) => u !== url)
    window.localStorage.setItem(RECENT_URLS_KEY, JSON.stringify(recent))
  } catch {
    // Ignore storage failures
  }
}

const monoCapsClass = 'font-mono uppercase tracking-[0.14em]'
const persistedHomeStateKey = 'chatdump.home-state.v1'

function hasMarkdownTable(markdown: string): boolean {
  return splitMarkdownForPreview(markdown).some(
    (segment) => segment.kind === 'table',
  )
}

function renderInlineCell(value: string): React.ReactNode {
  let result = value

  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>')
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noreferrer" target="_blank">$1</a>')

  return <span dangerouslySetInnerHTML={{ __html: result }} />
}

function readPersistedHomeState(): PersistedHomeState | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const rawState = window.sessionStorage.getItem(persistedHomeStateKey)

    if (!rawState) {
      return null
    }

    const parsedState = JSON.parse(rawState)

    if (typeof parsedState !== 'object' || parsedState === null) {
      window.sessionStorage.removeItem(persistedHomeStateKey)
      return null
    }

    const outputMode =
      parsedState.outputMode === 'preview' ? 'preview' : 'markdown'
    const url = typeof parsedState.url === 'string' ? parsedState.url : ''
    const markdown =
      typeof parsedState.markdown === 'string' ? parsedState.markdown : ''
    const warnings = Array.isArray(parsedState.warnings)
      ? parsedState.warnings.filter(
        (warning: unknown): warning is string => typeof warning === 'string',
      )
      : []

    if (!url && !markdown && warnings.length === 0 && outputMode === 'markdown') {
      return null
    }

    return {
      url,
      markdown,
      warnings,
      outputMode,
    }
  } catch {
    window.sessionStorage.removeItem(persistedHomeStateKey)
    return null
  }
}

function writePersistedHomeState(state: PersistedHomeState) {
  if (typeof window === 'undefined') {
    return
  }

  window.sessionStorage.setItem(persistedHomeStateKey, JSON.stringify(state))
}

function clearPersistedHomeState() {
  if (typeof window === 'undefined') {
    return
  }

  window.sessionStorage.removeItem(persistedHomeStateKey)
}

const convertShare = createServerFn({ method: 'POST' })
  .inputValidator((data: ConvertInput) => ({
    url: data.url.trim(),
  }))
  .handler(async ({ data }) => {
    const { convertShareUrlToMarkdown } = await import('../lib/convert')
    const exportedAt = new Date()

    const result = await convertShareUrlToMarkdown(data.url, { exportedAt })

    return {
      markdown: result.markdown,
      warnings: result.warnings,
    }
  })

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const [url, setUrl] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [outputMode, setOutputMode] = useState<'markdown' | 'preview'>('markdown')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [hasHydratedState, setHasHydratedState] = useState(false)
  const [isPlainText, setIsPlainText] = useState(false)
  const [recentUrls, setRecentUrls] = useState<string[]>([])
  const [isShareDropdownOpen, setIsShareDropdownOpen] = useState(false)
  const [isWhyModalOpen, setIsWhyModalOpen] = useState(false)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const outputSectionRef = useRef<HTMLElement | null>(null)
  const outputBodyRef = useRef<HTMLElement | null>(null)
  const nextToastIdRef = useRef(0)
  const toastTimeoutsRef = useRef(new Map<number, number>())
  const previousFeedbackRef = useRef<{
    error: string | null
    warnings: string[]
  }>({
    error: null,
    warnings: [],
  })

  const deferredMarkdown = useDeferredValue(markdown)
  const hasResult = deferredMarkdown.length > 0

  const useCases = [
    {
      id: 1,
      title: 'Export AI chat conversations',
      description:
        'Export any AI chat to readable Markdown — no more copy-pasting messages manually. Copy, or download the file.',
    },
    {
      id: 2,
      title: 'Continue conversations elsewhere',
      description:
        'Use the Share dropdown to copy a conversation and continue it in ChatGPT, Claude, or any other AI chat. Get a different perspective on the same context.',
    },
    {
      id: 3,
      title: 'Works with any AI platform',
      description:
        'One tool for ChatGPT, Claude, Copilot, Gemini, and Grok. No need to switch between different export methods.',
    },
  ]
  const isRenderedPreview = outputMode === 'preview'
  const lineCount = hasResult ? deferredMarkdown.split('\n').length : 0
  const characterCount = hasResult ? deferredMarkdown.length : 0
  const warningCount = warnings.length
  const previewSegments = splitMarkdownForPreview(deferredMarkdown)
  const copyLabel =
    copyState === 'copied'
      ? 'Copied'
      : copyState === 'error'
        ? 'Copy failed'
        : 'Copy .MD'
  const previewLabel = isRenderedPreview ? 'Show Markdown' : 'Show Preview'
  const plainTextLabel = isPlainText ? 'Show Markdown' : 'Plain Text'
  const displayMarkdown = isPlainText ? stripMarkdown(deferredMarkdown) : deferredMarkdown

  function removeToast(id: number) {
    const timeoutId = toastTimeoutsRef.current.get(id)

    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId)
      toastTimeoutsRef.current.delete(id)
    }

    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  function clearToasts() {
    toastTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId)
    })
    toastTimeoutsRef.current.clear()
    setToasts([])
  }

  function pushToast(kind: Toast['kind'], message: string) {
    const id = nextToastIdRef.current + 1
    nextToastIdRef.current = id

    setToasts((current) => [...current, { id, kind, message }])

    const timeoutId = window.setTimeout(() => {
      removeToast(id)
    }, kind === 'error' ? 7000 : 5600)

    toastTimeoutsRef.current.set(id, timeoutId)
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsPending(true)
    setError(null)
    setCopyState('idle')
    clearToasts()
    addRecentUrl(url)
    setRecentUrls(getRecentUrls())

    startTransition(() => {
      convertShare({
        data: {
          url,
        },
      })
        .then((result) => {
          if (
            !result ||
            typeof result.markdown !== 'string' ||
            !Array.isArray(result.warnings)
          ) {
            throw new Error('Received an invalid response while loading this share URL')
          }

          setMarkdown(result.markdown)
          setOutputMode(hasMarkdownTable(result.markdown) ? 'preview' : 'markdown')
          setWarnings(result.warnings)
        })
        .catch((cause) => {
          const message =
            cause instanceof Error ? cause.message : 'Conversion failed'

          setError(message)
        })
        .finally(() => {
          setIsPending(false)
        })
    })
  }

  function handleRemoveRecentUrl(urlToRemove: string, event: React.MouseEvent) {
    event.stopPropagation()
    removeRecentUrl(urlToRemove)
    deleteShareConversationCacheEntry(urlToRemove)
    setRecentUrls(getRecentUrls())
  }

  function handleSelectRecentUrl(recentUrl: string) {
    setUrl(recentUrl)
    urlInputRef.current?.focus()
  }

  function handleEditUrl() {
    setMarkdown('')
    setWarnings([])
    setError(null)
    setOutputMode('markdown')
    setCopyState('idle')
    clearToasts()
    previousFeedbackRef.current = {
      error: null,
      warnings: [],
    }

    window.requestAnimationFrame(() => {
      urlInputRef.current?.focus()
      urlInputRef.current?.select()
    })
  }

  async function handleCopy() {
    if (!displayMarkdown) {
      return
    }

    try {
      await navigator.clipboard.writeText(displayMarkdown)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1600)
    } catch {
      setCopyState('error')
    }
  }

  function handleDownload() {
    if (!deferredMarkdown) {
      return
    }

    const blob = new Blob([deferredMarkdown], { type: 'text/markdown' })
    const urlBlob = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = urlBlob
    a.download = 'conversation.md'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(urlBlob)
  }

  function handleOpenProvider(url: string) {
    window.open(url, '_blank')
  }

  function handleLogoClick() {
    if (typeof window === 'undefined') return
    localStorage.removeItem('chatdump.home-state.v1')
    localStorage.removeItem('chatdump.recent-urls.v1')
    setUrl('')
    setMarkdown('')
    setWarnings([])
    setOutputMode('markdown')
    setIsPlainText(false)
    setError(null)
    urlInputRef.current?.focus()
  }

  function handlePreview() {
    setOutputMode((currentMode) =>
      currentMode === 'preview' ? 'markdown' : 'preview',
    )

    outputSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    })

    window.requestAnimationFrame(() => {
      outputBodyRef.current?.scrollTo({
        top: 0,
        behavior: 'smooth',
      })

      outputBodyRef.current?.focus()
    })
  }

  useEffect(() => {
    const previousFeedback = previousFeedbackRef.current

    if (error && error !== previousFeedback.error) {
      pushToast('error', error)
    }

    const previousWarnings = new Set(previousFeedback.warnings)

    warnings.forEach((warning) => {
      if (!previousWarnings.has(warning)) {
        pushToast('warning', warning)
      }
    })

    previousFeedbackRef.current = {
      error,
      warnings,
    }
  }, [error, warnings])

  useEffect(() => {
    setRecentUrls(getRecentUrls())
  }, [])

  useEffect(() => {
    return () => {
      toastTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId)
      })
      toastTimeoutsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!isWhyModalOpen) return

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsWhyModalOpen(false)
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isWhyModalOpen])

  useEffect(() => {
    const persistedState = readPersistedHomeState()

    if (persistedState) {
      setUrl(persistedState.url)
      setMarkdown(persistedState.markdown)
      setWarnings(persistedState.warnings)
      setOutputMode(
        persistedState.outputMode === 'preview' ||
          hasMarkdownTable(persistedState.markdown)
          ? 'preview'
          : 'markdown',
      )
      previousFeedbackRef.current = {
        error: null,
        warnings: persistedState.warnings,
      }
    }

    setHasHydratedState(true)
  }, [])

  useEffect(() => {
    if (!hasHydratedState) {
      return
    }

    if (!url && !markdown && warnings.length === 0 && outputMode === 'markdown') {
      clearPersistedHomeState()
      return
    }

    try {
      writePersistedHomeState({
        url,
        markdown,
        warnings,
        outputMode,
      })
    } catch {
      // Ignore storage failures and keep the in-memory state intact.
    }
  }, [hasHydratedState, markdown, outputMode, url, warnings])

  useEffect(() => {
    if (!hasResult) {
      return
    }

    outputSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }, [hasResult])

  return (
    <main className="app-frame">
      {toasts.length > 0 ? (
        <div
          aria-live="polite"
          className="pointer-events-none fixed top-5 right-5 z-30 grid w-[min(24rem,calc(100vw-2rem))] gap-3 max-[500px]:top-3 max-[500px]:right-3 max-[500px]:left-3 max-[500px]:w-auto max-[720px]:top-4 max-[720px]:right-4 max-[720px]:w-[calc(100vw-2rem)]"
        >
          {toasts.map((toast) => (
            <div
              className={cn(
                'pointer-events-auto grid grid-cols-[minmax(0,1fr)_auto] items-start gap-[0.85rem] rounded-[1.1rem] border p-[0.95rem] pr-[0.95rem] pl-4 shadow-soft backdrop-blur-[20px]',
                toast.kind === 'error'
                  ? 'border-[rgba(142,57,44,0.18)] bg-[linear-gradient(180deg,rgba(255,240,236,0.94),rgba(255,246,242,0.9))]'
                  : 'border-[rgba(156,118,45,0.18)] bg-[linear-gradient(180deg,rgba(255,245,228,0.94),rgba(255,249,240,0.88))]',
              )}
              key={toast.id}
              role={toast.kind === 'error' ? 'alert' : 'status'}
            >
              <div className="grid gap-[0.3rem]">
                <p
                  className={cn(
                    monoCapsClass,
                    'font-mono text-[0.72rem]',
                    toast.kind === 'error'
                      ? 'text-danger-ink'
                      : 'text-warning-ink',
                  )}
                >
                  {toast.kind === 'error' ? 'Error' : 'Warning'}
                </p>
                <p className="leading-[1.6] text-ink">{toast.message}</p>
              </div>

              <button
                aria-label={`Dismiss ${toast.kind}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-white/46 text-ink-soft transition-[transform,background,border-color] duration-[180ms] ease-out hover:-translate-y-px hover:border-line-strong hover:bg-white/68"
                type="button"
                onClick={() => removeToast(toast.id)}
              >
                <span aria-hidden="true" className="inline-block rotate-45 text-base leading-none">
                  +
                </span>
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {isWhyModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4 backdrop-blur-[2px]"
          onClick={() => setIsWhyModalOpen(false)}
        >
          <div
            className="panel-shell w-full max-w-lg p-6 max-[720px]:p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-5">
              <h2 className="text-[1.05rem] font-bold text-ink">
                Why use chatdump?
              </h2>
              <button
                type="button"
                onClick={() => setIsWhyModalOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-white/46 text-ink-soft transition-colors hover:bg-white/68 hover:border-line-strong"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M18 6L6 18M6 6l12 12"
                    className="fill-none stroke-current stroke-[2] stroke-linecap-round"
                  />
                </svg>
              </button>
            </div>

            <div className="grid gap-5">
              {useCases.map((useCase) => (
                <div
                  key={useCase.id}
                  className="rounded-xl border border-line bg-[rgba(255,255,255,0.4)] p-5"
                >
                  <div className="mb-3 flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brass/15 text-[0.85rem] font-semibold">
                      {useCase.id}
                    </span>
                    <h3 className="font-semibold text-ink">{useCase.title}</h3>
                  </div>
                  <p className="text-[0.9rem] leading-relaxed text-ink-muted">
                    {useCase.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto grid max-w-[1380px] gap-4 max-[720px]:gap-3">
        <header className="flex items-center justify-between gap-4 px-1 pt-1 max-[500px]:pt-0.5 max-[720px]:px-0">
          <button
            type="button"
            onClick={handleLogoClick}
            className="flex items-center gap-[0.9rem] rounded-lg p-1 -m-1 transition-opacity hover:opacity-70"
            aria-label="Deep refresh"
          >
            <span className="grid h-12 w-12 place-items-center rounded-2xl border border-[rgba(32,24,17,0.08)] bg-[linear-gradient(135deg,rgba(188,132,66,0.16),rgba(49,67,58,0.08)),rgba(255,255,255,0.56)] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_14px_28px_rgba(62,43,23,0.08)]">
              <img
                src="/logo-mark.svg"
                alt="chatdump logo"
                className="h-8 w-8 object-contain"
              />
            </span>
          </button>

          {!hasResult && (
            <button
              type="button"
              onClick={() => setIsWhyModalOpen(true)}
              className="w-fit rounded-full border border-line-strong bg-white/72 px-4 py-2 text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-ink-soft shadow-soft transition-colors hover:bg-white hover:text-ink max-[721px]:hidden"
            >
              Why use chatdump
            </button>)}

        </header>

        <div className="grid gap-4">
          {!hasResult ? (
            <section
              className="panel-shell grid content-start gap-6 p-6 max-[500px]:gap-4 max-[500px]:rounded-[1.35rem] max-[500px]:p-3.5 max-[720px]:gap-5 max-[720px]:rounded-[1.5rem] max-[720px]:p-4"
            >
              <div className="grid gap-3">
                <div className="grid gap-3">
                  <h1 className="text-[clamp(2.8rem,6.2vw,5.3rem)] font-bold leading-[0.95] tracking-[-0.07em] max-[500px]:text-[1.95rem] max-[500px]:leading-[0.96] max-[500px]:tracking-[-0.06em] max-[720px]:text-[clamp(2.15rem,14vw,3.75rem)] max-[720px]:leading-[0.94] max-[720px]:tracking-[-0.08em]">
                    Turn a public share link into Markdown.
                  </h1>
                  <p className="max-w-[36rem] text-[1.02rem] leading-[1.72] text-ink-muted max-[500px]:text-[0.9rem] max-[500px]:leading-[1.6] max-[720px]:max-w-none max-[720px]:text-[0.97rem]">
                    Paste a supported share link to generate a clean transcript
                    you can review and copy.
                  </p>
                </div>
              </div>

              <form
                className="form-shell grid gap-4 p-4 max-[500px]:gap-3 max-[500px]:rounded-[1.1rem] max-[500px]:p-3 max-[720px]:gap-3.5 max-[720px]:rounded-[1.2rem] max-[720px]:p-3.5"
                onSubmit={handleSubmit}
              >
                <label className="grid gap-[0.6rem]">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        monoCapsClass,
                        'text-[0.78rem] tracking-[0.12em] text-ink-soft',
                      )}
                    >
                      Public share link
                    </span>
                    <span className="group relative inline-flex">
                      <button
                        aria-label="Supported share sources"
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-line bg-white/50 text-[0.68rem] font-semibold text-ink-soft transition-[border-color,background,color,transform] duration-[180ms] ease-out hover:-translate-y-px hover:border-line-strong hover:bg-white/72 hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--focus)]"
                        title="Supported sources: ChatGPT, Claude, Copilot, Gemini, and Grok share links."
                        type="button"
                      >
                        ?
                      </button>
                      <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-[15.5rem] -translate-x-1/2 rounded-[0.85rem] border border-line bg-[rgba(255,251,246,0.98)] px-3 py-2 font-mono text-[0.7rem] leading-[1.5] tracking-[0.01em] text-ink-muted opacity-0 shadow-soft transition duration-[160ms] ease-out group-hover:opacity-100 group-focus-within:opacity-100">
                        ChatGPT, Claude, Copilot, Gemini, and Grok share links
                        are supported.
                      </span>
                    </span>
                  </span>
                  <div className="grid min-h-[3.75rem] grid-cols-[auto_minmax(0,1fr)] items-center gap-[0.8rem] rounded-[1.1rem] border border-line-strong bg-paper-inset pl-[0.95rem] pr-[0.4rem] transition-[border-color,box-shadow,transform] duration-[180ms] ease-out focus-within:-translate-y-px focus-within:border-[rgba(155,106,51,0.48)] focus-within:shadow-[0_0_0_4px_var(--focus)] max-[500px]:min-h-[3.2rem] max-[500px]:gap-[0.6rem] max-[500px]:rounded-[0.95rem] max-[500px]:pl-[0.8rem] max-[500px]:pr-[0.28rem] max-[720px]:min-h-[3.45rem] max-[720px]:gap-[0.65rem] max-[720px]:rounded-[1rem] max-[720px]:pl-[0.85rem] max-[720px]:pr-[0.3rem]">
                    <svg aria-hidden="true" className="h-[1.05rem] w-[1.05rem]" viewBox="0 0 24 24">
                      <path
                        d="M14 5h5v5M10 14 19 5M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"
                        className="fill-none stroke-[rgba(22,19,16,0.56)] stroke-[1.9] stroke-linecap-round stroke-linejoin-round"
                      />
                    </svg>
                    <input
                      autoComplete="off"
                      className="min-h-full min-w-0 bg-transparent py-4 pr-[0.75rem] font-mono text-[0.96rem] text-ink outline-none placeholder:text-ink-soft max-[500px]:py-[0.88rem] max-[500px]:pr-[0.5rem] max-[500px]:text-[0.84rem] max-[500px]:placeholder:text-[0.78rem] max-[720px]:py-[0.95rem] max-[720px]:pr-[0.55rem] max-[720px]:text-[0.88rem] max-[720px]:placeholder:text-[0.82rem]"
                      inputMode="url"
                      name="url"
                      placeholder="https://.../share/..."
                      ref={urlInputRef}
                      required
                      type="url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  </div>
                </label>

                <div className="grid gap-3 min-[1100px]:items-center">
                  <Button disabled={isPending} type="submit" variant="primary">
                    <span>
                      {isPending ? 'Generating export...' : 'Generate Markdown'}
                    </span>
                    <svg
                      aria-hidden="true"
                      className="h-8 w-8 rounded-full bg-white/8 p-[0.45rem] max-[720px]:h-7 max-[720px]:w-7"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M7 12h10M13 6l6 6-6 6"
                        className="fill-none stroke-current stroke-2 stroke-linecap-round stroke-linejoin-round"
                      />
                    </svg>
                  </Button>
                </div>
              </form>

              {recentUrls.length > 0 ? (
                <div className="grid gap-2">
                  <p className={cn(monoCapsClass, 'text-[0.72rem] text-ink-soft')}>
                    Recent URLs
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {recentUrls.map((recentUrl) => (
                      <button
                        key={recentUrl}
                        className="group relative inline-flex max-w-[20rem] items-center gap-1.5 rounded-full border border-line bg-white/40 px-3 py-1.5 font-mono text-[0.73rem] text-ink-soft transition-[border-color,background,color] duration-[180ms] ease-out hover:border-line-strong hover:bg-white/60 hover:text-ink"
                        onClick={() => handleSelectRecentUrl(recentUrl)}
                        type="button"
                      >
                        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24">
                          <path
                            d="M14 5h5v5M10 14 19 5M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"
                            className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                          />
                        </svg>
                        <span className="truncate">{recentUrl}</span>
                        <span
                          aria-label="Remove from recent"
                          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-line bg-white text-[0.6rem] opacity-0 shadow-sm transition-opacity duration-[180ms] ease-out group-hover:opacity-100"
                          onClick={(e) => handleRemoveRecentUrl(recentUrl, e)}
                        >
                          ×
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {isPending ? (
                <div className="h-[0.42rem] overflow-hidden rounded-full bg-[rgba(23,20,17,0.08)]" aria-label="Processing share link">
                  <div className="h-full w-[36%] animate-[slide_1.4s_ease-in-out_infinite] rounded-full bg-[linear-gradient(90deg,var(--brass),var(--brass-strong))]" />
                </div>
              ) : null}
            </section>
          ) : null}

          {hasResult ? (
            <section
              className="panel-shell grid h-[min(32rem,calc(100dvh-3rem))] min-h-[28rem] grid-rows-[auto_1fr] gap-6 p-6 max-[1099px]:h-[min(31rem,calc(100dvh-1.75rem))] max-[1099px]:min-h-[24rem] max-[500px]:h-[calc(100svh-8rem)] max-[500px]:min-h-[26rem] max-[720px]:gap-5 max-[720px]:rounded-[1.5rem] max-[720px]:p-4 max-[720px]:max-h-[calc(100svh-5rem)] min-[1100px]:h-[calc(100dvh-8.5rem)]"
              ref={outputSectionRef}
            >
              <div className="flex items-start justify-between gap-4 max-[500px]:gap-3 max-[720px]:flex-col max-[720px]:items-stretch">
                <div className="grid gap-[0.55rem]">
                  <p className={cn(monoCapsClass, 'text-[0.72rem] text-ink-soft')}>
                    Output
                  </p>
                  <h2 className="text-[clamp(1.55rem,3vw,2.2rem)] font-semibold leading-[1.02] tracking-[-0.05em] max-[500px]:text-[1.35rem] max-[500px]:tracking-[-0.04em] max-[720px]:text-[clamp(1.4rem,8vw,1.9rem)]">
                    Markdown export ready
                  </h2>
                  <p className="text-[1rem] leading-[1.65] text-ink-muted max-[500px]:text-[0.9rem] max-[500px]:leading-[1.55] max-[720px]:text-[0.96rem]">
                    Review the generated transcript, then copy the Markdown
                    directly into your workflow.
                  </p>
                </div>

                <div className="grid w-full gap-3 max-[720px]:justify-items-stretch min-[721px]:min-w-fit min-[721px]:justify-items-end">
                  <div
                    className="flex flex-wrap gap-[0.55rem] max-[720px]:justify-start min-[721px]:justify-end"
                    aria-label="Export metadata"
                  >
                    {lineCount > 0 ? (
                      <span className="inline-flex min-h-8 items-center rounded-full border border-line bg-[rgba(63,47,33,0.05)] px-[0.74rem] font-mono text-[0.74rem] uppercase tracking-[0.08em] text-ink-soft max-[500px]:min-h-7 max-[500px]:px-[0.6rem] max-[500px]:text-[0.68rem]">
                        {lineCount} lines
                      </span>
                    ) : null}
                    {characterCount > 0 ? (
                      <span className="inline-flex min-h-8 items-center rounded-full border border-line bg-[rgba(63,47,33,0.05)] px-[0.74rem] font-mono text-[0.74rem] uppercase tracking-[0.08em] text-ink-soft max-[500px]:min-h-7 max-[500px]:px-[0.6rem] max-[500px]:text-[0.68rem]">
                        {characterCount} chars
                      </span>
                    ) : null}
                    {warningCount > 0 ? (
                      <span className="inline-flex min-h-8 items-center rounded-full border border-[rgba(156,118,45,0.18)] bg-[rgba(156,118,45,0.12)] px-[0.74rem] font-mono text-[0.74rem] uppercase tracking-[0.08em] text-warning-ink max-[500px]:min-h-7 max-[500px]:px-[0.6rem] max-[500px]:text-[0.68rem]">
                        {warningCount} warning{warningCount > 1 ? 's' : ''}
                      </span>
                    ) : null}
                    <button
                      aria-label="Edit URL"
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-white/40 px-2.5 font-mono text-[0.7rem] uppercase tracking-[0.06em] text-ink-soft transition-[border-color,background,color] duration-[180ms] ease-out hover:border-line-strong hover:bg-white/60 hover:text-ink max-[720px]:hidden"
                      onClick={handleEditUrl}
                    >
                      <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24">
                        <path
                          d="M19 12H5M11 6l-6 6 6 6"
                          className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                        />
                      </svg>
                      Edit URL
                    </button>
                    <button
                      aria-label="Edit URL"
                      className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-line bg-white/46 text-ink-soft transition-[border-color,background,color,transform] duration-[180ms] ease-out hover:-translate-y-px hover:border-line-strong hover:bg-white/68 hover:text-ink min-[721px]:hidden"
                      onClick={handleEditUrl}
                    >
                      <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
                        <path
                          d="M15 18l-6-6 6-6M19 12H9"
                          className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                        />
                      </svg>
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 max-[500px]:gap-1.5 max-[720px]:justify-between">
                    <div className="inline-flex rounded-full border border-line-strong bg-white/72 p-0.5 shadow-soft max-[720px]:order-2">
                      <button
                        aria-label="Markdown"
                        aria-pressed={!isRenderedPreview && !isPlainText}
                        className={cn(
                          'inline-flex h-[2.6rem] items-center gap-1.5 rounded-l-full border border-transparent px-3 font-mono text-[0.72rem] uppercase tracking-[0.06em] transition-[background,color,box-shadow,border-color] duration-[180ms] ease-out',
                          !isRenderedPreview && !isPlainText
                            ? 'border-line bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_4px_12px_rgba(23,20,17,0.06)] text-ink'
                            : 'text-ink-soft hover:text-ink',
                        )}
                        onClick={() => {
                          setIsPlainText(false)
                          if (isRenderedPreview) setOutputMode('markdown')
                        }}
                      >
                        <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24">
                          <path
                            d="M3 7h18M3 12h12M3 17h18"
                            className="fill-none stroke-current stroke-[1.8] stroke-linecap-round"
                          />
                        </svg>
                        <span className="hidden sm:inline">Markdown</span>
                      </button>

                      <button
                        aria-label="Preview"
                        aria-pressed={isRenderedPreview}
                        className={cn(
                          'inline-flex h-[2.6rem] items-center gap-1.5 border border-transparent px-3 font-mono text-[0.72rem] uppercase tracking-[0.06em] transition-[background,color,box-shadow,border-color] duration-[180ms] ease-out',
                          isRenderedPreview
                            ? 'border-line bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_4px_12px_rgba(23,20,17,0.06)] text-ink'
                            : 'text-ink-soft hover:text-ink',
                        )}
                        onClick={() => {
                          setIsPlainText(false)
                          if (!isRenderedPreview) setOutputMode('preview')
                        }}
                      >
                        <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24">
                          <path
                            d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
                            className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                          />
                        </svg>
                        <span className="hidden sm:inline">Preview</span>
                      </button>

                      <button
                        aria-label="Plain text"
                        aria-pressed={isPlainText}
                        className={cn(
                          'inline-flex h-[2.6rem] items-center gap-1.5 rounded-r-full border border-transparent px-3 font-mono text-[0.72rem] uppercase tracking-[0.06em] transition-[background,color,box-shadow,border-color] duration-[180ms] ease-out',
                          isPlainText
                            ? 'border-line bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_4px_12px_rgba(23,20,17,0.06)] text-ink'
                            : 'text-ink-soft hover:text-ink',
                        )}
                        onClick={() => setIsPlainText((v) => !v)}
                      >
                        <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24">
                          <path
                            d="M4 7V4h16v3M9 20h6M12 4v16"
                            className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                          />
                        </svg>
                        <span className="hidden sm:inline">Plain</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-2 max-[720px]:order-1">
                      <ShareDropdown
                        markdown={displayMarkdown}
                        isOpen={isShareDropdownOpen}
                        onOpenChange={setIsShareDropdownOpen}
                        onOpenProvider={handleOpenProvider}
                      />

                      <Button
                        aria-label={copyLabel}
                        className="max-[500px]:min-h-[2.8rem] max-[500px]:w-11 max-[500px]:justify-center max-[500px]:gap-0 max-[500px]:px-0 max-[500px]:pl-0 max-[720px]:min-h-11 max-[720px]:w-11 max-[720px]:justify-center max-[720px]:gap-0 max-[720px]:px-0 max-[720px]:pl-0"
                        onClick={handleCopy}
                      >
                        {copyState === 'copied' ? (
                          <svg aria-hidden="true" className="h-[1.05rem] w-[1.05rem]" viewBox="0 0 24 24">
                            <path
                              d="M20 6L9 17l-5-5"
                              className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round"
                            />
                          </svg>
                        ) : (
                          <svg aria-hidden="true" className="h-[1.05rem] w-[1.05rem]" viewBox="0 0 24 24">
                            <path
                              d="M9 9h10v12H9zM5 3h10v4H9v10H5z"
                              className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                            />
                          </svg>
                        )}
                        <span className="max-[720px]:hidden">{copyLabel}</span>
                      </Button>

                      <Button
                        aria-label="Download .md"
                        className="max-[500px]:min-h-[2.8rem] max-[500px]:w-11 max-[500px]:justify-center max-[500px]:gap-0 max-[500px]:px-0 max-[500px]:pl-0 max-[720px]:min-h-11 max-[720px]:w-11 max-[720px]:justify-center max-[720px]:gap-0 max-[720px]:px-0 max-[720px]:pl-0"
                        onClick={handleDownload}
                      >
                        <svg aria-hidden="true" className="h-[1.05rem] w-[1.05rem]" viewBox="0 0 24 24">
                          <path
                            d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"
                            className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                          />
                        </svg>
                        <span className="max-[720px]:hidden">.md</span>
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {isRenderedPreview && !isPlainText ? (
                <article
                  className="output-surface markdown-preview h-full leading-[1.68] text-ink max-[720px]:text-[0.95rem]"
                  ref={(node) => {
                    outputBodyRef.current = node
                  }}
                  tabIndex={0}
                >
                  {previewSegments.map((segment, index) => {
                    if (segment.kind === 'table') {
                      const tableMd = [
                        `| ${segment.headers.join(' | ')} |`,
                        `| ${segment.headers.map(() => '---').join(' | ')} |`,
                        ...segment.rows.map((row) => `| ${row.join(' | ')} |`),
                      ].join('\n')

                      return (
                        <div className="table-scroll-wrapper" key={`table-${index}`}>
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              table: ({ node: _node, ...props }) => (
                                <table {...props} />
                              ),
                            }}
                          >
                            {tableMd}
                          </ReactMarkdown>
                        </div>
                      )
                    }

                    return (
                      <ReactMarkdown
                        key={`markdown-${index}`}
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeRaw, rehypeHighlight]}
                        components={{
                          a: ({ node: _node, ...props }) => (
                            <a {...props} rel="noreferrer" target="_blank" />
                          ),
                          img: ({ node: _node, ...props }) => (
                            <PreviewImage {...props} />
                          ),
                          // Skip rendering empty code blocks (show as invisible
                          // dark bars otherwise) and show a language label
                          pre: ({ node: _node, children, ...props }) => {
                            // Extract text from React children tree
                            const getTextContent = (child: React.ReactNode): string => {
                              if (typeof child === 'string') return child
                              if (typeof child === 'number') return String(child)
                              if (!child) return ''
                              if (Array.isArray(child)) return child.map(getTextContent).join('')
                              if (typeof child === 'object' && child !== null && 'props' in child) {
                                const el = child as unknown as { props: { children?: React.ReactNode } }
                                return getTextContent(el.props.children)
                              }
                              return ''
                            }

                            const textContent = getTextContent(children)

                            // Don't render empty code blocks
                            if (!textContent.trim()) {
                              return null
                            }

                            // Try to extract language from the code element's className
                            let lang: string | undefined
                            const firstChild = Array.isArray(children) ? children[0] : children
                            if (
                              firstChild &&
                              typeof firstChild === 'object' &&
                              'props' in firstChild
                            ) {
                              const el = firstChild as unknown as { props: { className?: string } }
                              const cls = el.props.className
                              if (typeof cls === 'string') {
                                const match = cls.match(/language-(\S+)/)
                                if (match) lang = match[1]
                              }
                            }

                            return (
                              <div className="code-block-wrapper">
                                {lang ? (
                                  <span className="code-block-lang">{lang}</span>
                                ) : null}
                                <pre {...props}>{children}</pre>
                              </div>
                            )
                          },
                          // Ensure HR renders as a proper themed element
                          hr: ({ node: _node, ...props }) => (
                            <hr {...props} />
                          ),
                        }}
                      >
                        {segment.content}
                      </ReactMarkdown>
                    )
                  })}
                </article>
              ) : isPlainText ? (
                <pre
                  className="output-surface m-0 h-full whitespace-pre-wrap font-mono text-[0.92rem] leading-[1.72] text-ink max-[720px]:text-[0.84rem]"
                  ref={(node) => {
                    outputBodyRef.current = node
                  }}
                  tabIndex={0}
                >
                  {displayMarkdown}
                </pre>
              ) : (
                <pre
                  className="output-surface m-0 h-full whitespace-pre-wrap font-mono text-[0.92rem] leading-[1.72] text-ink max-[720px]:text-[0.84rem]"
                  ref={(node) => {
                    outputBodyRef.current = node
                  }}
                  tabIndex={0}
                >
                  {deferredMarkdown}
                </pre>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </main>
  )
}
