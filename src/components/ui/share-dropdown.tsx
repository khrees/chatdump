import { useEffect, useRef, useState } from 'react'
import { shareProviders, type ShareProvider } from '../../lib/providers'

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

  // Fallback using document.execCommand
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

    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        onOpenChange(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
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
    
    // Always copy prompt context to clipboard as it's the most reliable way
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

    // Smart Share logic: If URL payload is too large, open clean URL so they can paste
    if (isTooLong) {
      const baseUrl = getBaseProviderUrl(provider.id)
      onOpenProvider(baseUrl)
    } else {
      const providerUrl = buildPromptUrl(provider.id, promptText)
      onOpenProvider(providerUrl)
    }
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onOpenChange(!isOpen)}
        className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-white/72 px-4 py-[0.35rem] pl-[0.9rem] text-ink shadow-soft transition-colors hover:bg-white max-[500px]:min-h-[2.8rem] max-[500px]:px-[0.75rem] max-[500px]:pl-[0.7rem] max-[720px]:min-h-[3.15rem] max-[720px]:px-[0.95rem] max-[720px]:pl-[0.85rem]"
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
          className="h-3 w-3 text-ink-soft transition-transform ui-open:rotate-180 max-[720px]:hidden"
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
          ref={dropdownRef}
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-line bg-white p-3 shadow-[0_8px_24px_rgba(23,20,17,0.12)]"
          role="menu"
          aria-orientation="vertical"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-ink">
              Share Context
            </span>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded p-1 text-ink-soft transition-colors hover:bg-line hover:text-ink"
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

          <div className="mb-2.5 flex items-center justify-between text-[0.7rem] border-b border-line pb-2">
            <span className="text-ink-soft font-medium">
              Size: <strong className="font-semibold text-ink">{promptLength.toLocaleString()} chars</strong>
            </span>
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase border ${
                isTooLong
                  ? 'bg-amber-50 text-amber-700 border-amber-200/60'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200/60'
              }`}
            >
              {isTooLong ? 'Copy & Paste' : 'Pre-fills URL'}
            </span>
          </div>

          <p className="mb-3 text-[0.72rem] leading-normal text-ink-soft">
            {isTooLong
              ? 'This transcript exceeds safe URL limits. We will copy it to your clipboard and open the chat provider so you can paste it (Cmd+V).'
              : 'This transcript is short. We will try to pre-fill the input, and copy it to your clipboard as a backup.'}
          </p>

          <button
            type="button"
            onClick={handleCopy}
            disabled={copyStatus === 'success' && clickedProviderId === 'manual-copy'}
            className={`mb-3 w-full rounded-lg border px-3 py-2 text-[0.82rem] font-semibold transition-colors ${
              copyStatus === 'success' && clickedProviderId === 'manual-copy'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : copyStatus === 'error' && clickedProviderId === 'manual-copy'
                  ? 'bg-rose-50 border-rose-200 text-rose-600'
                  : 'bg-[linear-gradient(135deg,#292520,#171411)] text-[#f5eee5] border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:opacity-90'
            }`}
          >
            {copyStatus === 'success' && clickedProviderId === 'manual-copy'
              ? '✓ Prompt Copied!'
              : copyStatus === 'error' && clickedProviderId === 'manual-copy'
                ? 'Copy failed - try again'
                : 'Copy Prompt to Clipboard'}
          </button>

          <div className="border-t border-line pt-2">
            <span className="mb-1.5 block text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-ink-soft">
              Copy & Open in...
            </span>
            <div className="space-y-1">
              {shareProviders.map((provider) => {
                const isClicked = clickedProviderId === provider.id && copyStatus === 'success'
                const isError = clickedProviderId === provider.id && copyStatus === 'error'

                return (
                  <div
                    key={provider.id}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-line"
                  >
                    <img
                      src={provider.faviconUrl}
                      alt=""
                      className="h-4 w-4 shrink-0 rounded"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="text-[0.82rem] font-medium text-ink">
                        {provider.name}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleOpen(provider)}
                      className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.04em] shadow-sm transition-colors ${
                        isClicked
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100'
                          : isError
                            ? 'bg-rose-50 border-rose-200 text-rose-600 hover:bg-rose-100'
                            : 'bg-white border-line-strong text-ink hover:bg-line'
                      }`}
                    >
                      {isClicked ? 'Copied' : 'Open'}
                      {!isClicked && (
                        <svg
                          aria-hidden="true"
                          className="h-3 w-3"
                          viewBox="0 0 24 24"
                        >
                          <path
                            d="M7 17L17 7M17 7H7M17 7v10"
                            className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round"
                          />
                        </svg>
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
