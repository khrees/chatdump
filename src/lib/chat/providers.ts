import type { ChatProvider, ModelInfo } from './types'

export interface ProviderEntry {
  defaultBaseUrl?: string
  local?: boolean
  models: ModelInfo[]
  name: string
  requiresProxy: boolean
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
