import type { ChatProvider, ModelInfo, WebAppOption } from './types'

export interface ProviderEntry {
  defaultBaseUrl?: string
  local?: boolean
  models: ModelInfo[]
  name: string
  requiresProxy: boolean
}

export interface ModelOption {
  id: string
  name: string
  provider: ChatProvider
}

export const CLOUD_MODELS: ModelOption[] = [
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

export const WEB_APPS: WebAppOption[] = [
  { id: 'chatgpt-web', name: 'ChatGPT Web App', url: 'https://chatgpt.com/' },
  { id: 'claude-web', name: 'Claude Web App', url: 'https://claude.ai/new' },
  { id: 'gemini-web', name: 'Gemini Web App', url: 'https://gemini.google.com/' },
  { id: 'grok-web', name: 'Grok Web App', url: 'https://grok.com/' },
  { id: 'copilot-web', name: 'Copilot Web App', url: 'https://copilot.microsoft.com/' },
]

export const PROVIDER_LABELS: Record<ChatProvider, string> = {
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

export const MODEL_PROVIDERS: Record<ChatProvider, ProviderEntry> = {
  openai: {
    name: 'OpenAI',
    requiresProxy: true,
    models: [
      { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', tier: 'best', provider: 'openai' },
      { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', tier: 'best', provider: 'openai' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', tier: 'cheap', provider: 'openai' },
    ],
  },
  anthropic: {
    name: 'Anthropic',
    requiresProxy: true,
    models: [
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', tier: 'best', provider: 'anthropic' },
      { id: 'claude-4.5-haiku', name: 'Claude 4.5 Haiku', tier: 'cheap', provider: 'anthropic' },
    ],
  },
  google: {
    name: 'Google AI',
    requiresProxy: false,
    models: [
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', tier: 'best', provider: 'google' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', tier: 'cheap', provider: 'google' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', tier: 'cheap', provider: 'google' },
    ],
  },
  grok: {
    name: 'Grok',
    requiresProxy: true,
    models: [
      { id: 'grok-4.3', name: 'Grok 4.3', tier: 'best', provider: 'grok' },
      { id: 'grok-4.1-fast', name: 'Grok 4.1 Fast', tier: 'cheap', provider: 'grok' },
    ],
  },
  mistral: {
    name: 'Mistral',
    requiresProxy: true,
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', tier: 'best', provider: 'mistral' },
      { id: 'mistral-small-latest', name: 'Mistral Small', tier: 'cheap', provider: 'mistral' },
    ],
  },
  ollama: {
    name: 'Ollama',
    requiresProxy: false,
    local: true,
    defaultBaseUrl: 'http://localhost:11434',
    models: [],
  },
  lmstudio: {
    name: 'LM Studio',
    requiresProxy: false,
    local: true,
    defaultBaseUrl: 'http://localhost:1234',
    models: [],
  },
  custom: {
    name: 'Custom',
    requiresProxy: false,
    models: [],
  },
  webapp: {
    name: 'Web App',
    requiresProxy: false,
    models: [],
  },
}

export function getProviderModels(provider: ChatProvider): ModelInfo[] {
  return MODEL_PROVIDERS[provider].models
}

export function getDefaultModel(provider: ChatProvider): ModelInfo | undefined {
  return MODEL_PROVIDERS[provider].models[0]
}

export function getAllModels(): ModelInfo[] {
  return Object.values(MODEL_PROVIDERS).flatMap((entry) => entry.models)
}
