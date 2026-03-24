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

export function ShareDropdown({
  markdown,
  isOpen,
  onOpenChange,
  onOpenProvider,
}: ShareDropdownProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

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
    const wrappedText = wrapMarkdown(markdown)
    try {
      await navigator.clipboard.writeText(wrappedText)
      setCopyStatus('success')
      copyTimeoutRef.current = setTimeout(() => setCopyStatus('idle'), 1600)
    } catch {
      setCopyStatus('error')
    }
  }

  function handleOpen(provider: ShareProvider) {
    const promptText = markdown ? wrapMarkdown(markdown) : ''
    const providerUrl = buildPromptUrl(provider.id, promptText)
    onOpenProvider(providerUrl)
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
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-line bg-white p-3 shadow-[0_8px_24px_rgba(23,20,17,0.12)]"
          role="menu"
          aria-orientation="vertical"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-ink">
              Share
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

          <button
            type="button"
            onClick={handleCopy}
            disabled={copyStatus === 'success'}
            className={`mb-3 w-full rounded-lg px-3 py-2.5 text-[0.82rem] font-semibold transition-colors ${copyStatus === 'success'
                ? 'bg-green-100 text-green-700'
                : copyStatus === 'error'
                  ? 'bg-red-50 text-red-600'
                  : 'bg-[linear-gradient(135deg,#292520,#171411)] text-[#f5eee5] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
              }`}
          >
            {copyStatus === 'success'
              ? 'Copied! Now paste in chat'
              : copyStatus === 'error'
                ? 'Copy failed - try again'
                : 'Copy and continue in chat'}
          </button>

          <div className="border-t border-line pt-2">
            <span className="mb-2 block text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-ink-soft">
              Paste in...
            </span>
            <div className="space-y-1">
              {shareProviders.map((provider) => (
                <div
                  key={provider.id}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-line"
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
                    className="flex shrink-0 items-center gap-1 rounded-full border border-line-strong bg-white px-2.5 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.04em] text-ink shadow-sm transition-colors hover:bg-line"
                  >
                    Open
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
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
