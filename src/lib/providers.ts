import type { ShareProvider as ShareProviderType } from './url'

export interface ShareProvider {
  id: ShareProviderType
  name: string
  url: string
  faviconUrl: string
  description: string
}

export const shareProviders: ShareProvider[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    faviconUrl: 'https://www.google.com/s2/favicons?domain=chatgpt.com',
    description: 'Continue conversation',
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    faviconUrl: 'https://www.google.com/s2/favicons?domain=claude.ai',
    description: 'Continue conversation',
  },
  {
    id: 'copilot',
    name: 'Copilot',
    url: 'https://copilot.microsoft.com',
    faviconUrl: 'https://www.google.com/s2/favicons?domain=copilot.microsoft.com',
    description: 'Continue conversation',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    faviconUrl: 'https://www.google.com/s2/favicons?domain=gemini.google.com',
    description: 'Continue conversation',
  },
  {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com',
    faviconUrl: 'https://www.google.com/s2/favicons?domain=grok.com',
    description: 'Continue conversation',
  },
  {
    id: 'meta',
    name: 'Meta AI',
    url: 'https://www.meta.ai',
    faviconUrl: 'https://www.google.com/s2/favicons?domain=meta.ai',
    description: 'Continue conversation',
  },
]
