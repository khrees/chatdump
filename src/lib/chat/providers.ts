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
      { id: 'gpt-4o', name: 'GPT-4o', tier: 'best', provider: 'openai' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'cheap', provider: 'openai' },
      { id: 'o3-mini', name: 'o3-mini', tier: 'best', provider: 'openai' },
    ],
  },
  anthropic: {
    name: 'Anthropic',
    requiresProxy: true,
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', tier: 'best', provider: 'anthropic' },
      { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku', tier: 'cheap', provider: 'anthropic' },
    ],
  },
  google: {
    name: 'Google AI',
    requiresProxy: false,
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'best', provider: 'google' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'cheap', provider: 'google' },
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
