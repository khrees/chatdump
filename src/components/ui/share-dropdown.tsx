import { useEffect, useRef, useState } from 'react'
import { shareProviders, type ShareProvider } from '../../lib/providers'
import { cn } from '../../lib/cn'

interface ShareDropdownProps {
  markdown: string | null
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onOpenProvider: (url: string) => void
}

type CopyStatus = 'idle' | 'success' | 'error'

function wrapMarkdown(text: string): string {
  return `Taking this conversation history into context, answer the next questions \n\n${text}`
}

function buildPromptUrl(providerId: string, prompt: string): string {
  const encoded = encodeURIComponent(prompt)

  switch (providerId) {
    case 'chatgpt':
      return `https://chatgpt.com/?prompt=${encoded}`
    case 'claude':
      return `https://claude.ai/new?q=${encoded}`
    case 'copilot':
      return `https://copilot.microsoft.com/?prompt=${encoded}`
    case 'gemini':
      return `https://gemini.google.com/?prompt=${encoded}`
    case 'grok':
      return `https://grok.com/?prompt=${encoded}`
    default:
      return '#'
  }
}

function getBaseProviderUrl(providerId: string): string {
  switch (providerId) {
    case 'chatgpt':
      return 'https://chatgpt.com/'
    case 'claude':
      return 'https://claude.ai/new'
    case 'copilot':
      return 'https://copilot.microsoft.com/'
    case 'gemini':
      return 'https://gemini.google.com/'
    case 'grok':
      return 'https://grok.com/'
    default:
      return '#'
  }
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

export function ShareDropdown({
  markdown,
  isOpen,
  onOpenChange,
  onOpenProvider,
}: ShareDropdownProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const [clickedProviderId, setClickedProviderId] = useState<string | null>(null)
  
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const promptText = markdown ? wrapMarkdown(markdown) : ''
  const promptLength = promptText.length
  const isTooLong = promptLength > 1000

  useEffect(() => {
    if (!isOpen) return

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onOpenChange(false)
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }
    }
  }, [isOpen, onOpenChange])

  async function handleCopy() {
    if (!markdown) return
    setClickedProviderId('manual-copy')
    const copied = await copyToClipboard(promptText)
    if (copied) {
      setCopyStatus('success')
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => {
        setCopyStatus('idle')
        setClickedProviderId(null)
      }, 3000)
    } else {
      setCopyStatus('error')
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => {
        setCopyStatus('idle')
        setClickedProviderId(null)
      }, 3000)
    }
  }

  async function handleOpen(provider: ShareProvider) {
    if (!markdown) return
    setClickedProviderId(provider.id)
    
    const copied = await copyToClipboard(promptText)
    if (copied) {
      setCopyStatus('success')
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => {
        setCopyStatus('idle')
        setClickedProviderId(null)
      }, 3500)
    } else {
      setCopyStatus('error')
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => {
        setCopyStatus('idle')
        setClickedProviderId(null)
      }, 3500)
    }

    if (isTooLong) {
      const baseUrl = getBaseProviderUrl(provider.id)
      onOpenProvider(baseUrl)
    } else {
      const providerUrl = buildPromptUrl(provider.id, promptText)
      onOpenProvider(providerUrl)
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onOpenChange(!isOpen)}
        className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-paper-elevated px-4 py-[0.35rem] pl-[0.9rem] text-ink shadow-soft transition-colors hover:bg-paper-raised max-[500px]:min-h-[2.8rem] max-[500px]:px-[0.75rem] max-[500px]:pl-[0.7rem] max-[720px]:min-h-[3.15rem] max-[720px]:px-[0.95rem] max-[720px]:pl-[0.85rem]"
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <svg
          aria-hidden="true"
          className="h-[1.05rem] w-[1.05rem]"
          viewBox="0 0 24 24"
        >
          <path
            d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"
            className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
          />
        </svg>
        <span className="max-[720px]:hidden">Share</span>
        <svg
          aria-hidden="true"
          className="h-3 w-3 text-ink-soft transition-transform max-[720px]:hidden"
          viewBox="0 0 24 24"
          style={{ transform: isOpen ? 'rotate(180deg)' : undefined }}
        >
          <path
            d="M6 9l6 6 6-6"
            className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round"
          />
        </svg>
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-xs"
          onClick={() => onOpenChange(false)}
        >
          <div
            ref={dropdownRef}
            className="w-full max-w-xl rounded-xl border border-border-contrast bg-paper-solid p-6 shadow-2xl max-h-[90vh] overflow-y-auto animate-slide-up relative"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="mb-4 flex items-center justify-between pb-4 border-b border-border-contrast">
              <span className="text-sm font-extrabold uppercase tracking-wider text-ink">
                Share Conversation Context
              </span>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-contrast bg-paper-solid text-ink-soft hover:text-ink hover:bg-paper-solid-inset transition-colors"
                aria-label="Close"
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

            <p className="text-xs text-ink-muted leading-relaxed mb-4">
              Continue your work in another model! We will automatically package this conversation history as context, copy it to your clipboard, and launch the selected AI chat assistant.
            </p>

            {/* Prompt preview section */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[0.7rem] font-mono font-bold uppercase tracking-wider text-ink-soft">
                  Context Prompt Preview
                </span>
                <span
                  className={cn(
                    "inline-flex items-center rounded px-1.5 py-0.5 text-[0.65rem] font-mono font-bold uppercase border",
                    isTooLong
                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                  )}
                >
                  {isTooLong ? 'Copy & Manual Paste' : 'Direct URL Pre-fill'}
                </span>
              </div>
              <div className="relative rounded-lg border border-border-contrast bg-paper-solid-inset p-3 max-h-36 overflow-y-auto">
                <pre className="font-mono text-xs text-ink-muted whitespace-pre-wrap leading-relaxed">
                  {promptText}
                </pre>
                <div className="absolute bottom-2 right-2">
                  <span className="text-[0.62rem] font-mono bg-paper-solid border border-border-contrast rounded px-1.5 py-0.5 text-ink-soft">
                    {promptLength.toLocaleString()} chars
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCopy}
              disabled={copyStatus === 'success' && clickedProviderId === 'manual-copy'}
              className={cn(
                "mb-5 w-full rounded-lg py-2.5 text-xs font-mono font-bold uppercase tracking-wider transition-colors border",
                copyStatus === 'success' && clickedProviderId === 'manual-copy'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                  : copyStatus === 'error' && clickedProviderId === 'manual-copy'
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-400'
                    : 'bg-teal text-white border-teal/10 hover:bg-teal-hover shadow-sm'
              )}
            >
              {copyStatus === 'success' && clickedProviderId === 'manual-copy'
                ? '✓ Context Copied!'
                : copyStatus === 'error' && clickedProviderId === 'manual-copy'
                  ? 'Copy failed - try again'
                  : 'Copy Context Prompt to Clipboard'}
            </button>

            <span className="mb-2.5 block text-[0.7rem] font-mono font-bold uppercase tracking-wider text-ink-soft">
              Select platform to open
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {shareProviders.map((provider) => {
                const isClicked = clickedProviderId === provider.id && copyStatus === 'success'
                const isError = clickedProviderId === provider.id && copyStatus === 'error'
                
                let brandColorClass = 'hover:border-teal/50 border-border-contrast bg-paper-solid-elevated'
                let brandBadge = 'bg-teal/10 text-teal border border-teal/20'
                if (provider.id === 'chatgpt') {
                  brandColorClass = 'hover:border-emerald-500/50 border-border-contrast bg-paper-solid-elevated'
                  brandBadge = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                } else if (provider.id === 'claude') {
                  brandColorClass = 'hover:border-amber-500/50 border-border-contrast bg-paper-solid-elevated'
                  brandBadge = 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30'
                } else if (provider.id === 'gemini') {
                  brandColorClass = 'hover:border-indigo-500/50 border-border-contrast bg-paper-solid-elevated'
                  brandBadge = 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/30'
                } else if (provider.id === 'copilot') {
                  brandColorClass = 'hover:border-cyan-500/50 border-border-contrast bg-paper-solid-elevated'
                  brandBadge = 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/30'
                } else if (provider.id === 'grok') {
                  brandColorClass = 'hover:border-slate-800/50 dark:hover:border-slate-200/50 border-border-contrast bg-paper-solid-elevated'
                  brandBadge = 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30'
                }

                return (
                  <div
                    key={provider.id}
                    className={cn(
                      "group relative flex flex-col justify-between p-3.5 rounded-lg border transition-all hover:bg-paper-solid hover:shadow-sm",
                      brandColorClass
                    )}
                  >
                    <div className="flex items-center gap-2.5 mb-2">
                      <img
                        src={provider.faviconUrl}
                        alt=""
                        className="h-5 w-5 shrink-0 rounded"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                      <span className="font-bold text-sm text-ink">{provider.name}</span>
                    </div>

                    <p className="text-[0.68rem] text-ink-muted leading-relaxed mb-3">
                      {isTooLong 
                        ? 'Prompts >1k chars must be manually pasted after opening.'
                        : 'Automatically injects conversation context into input.'
                      }
                    </p>

                    <button
                      type="button"
                      onClick={() => handleOpen(provider)}
                      className={cn(
                        "w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[0.72rem] font-mono font-bold uppercase tracking-wider transition-colors",
                        isClicked
                          ? "bg-emerald-600 text-white border-transparent"
                          : isError
                            ? "bg-rose-600 text-white border-transparent"
                            : "bg-paper-solid text-ink hover:bg-paper-solid-inset border border-border-contrast"
                      )}
                    >
                      {isClicked ? '✓ Copied' : 'Open'}
                      {!isClicked && (
                        <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 24 24">
                          <path d="M7 17L17 7M17 7H7M17 7v10" className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round" />
                        </svg>
                      )}
                    </button>
                    
                    <div className="absolute right-3 top-3">
                      <span className={cn("text-[0.58rem] font-mono font-bold uppercase px-1.5 py-0.5 rounded", brandBadge)}>
                        Online
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
