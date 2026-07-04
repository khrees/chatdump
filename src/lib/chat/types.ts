import type { NormalizedConversation } from '../types'

export interface ChatMessage {
  content: string
  role: 'assistant' | 'system' | 'user'
}

export type ChatProvider = 'anthropic' | 'custom' | 'google' | 'grok' | 'lmstudio' | 'mistral' | 'ollama' | 'openai' | 'webapp'

export type ModelTier = 'best' | 'cheap'

export interface ModelInfo {
  id: string
  name: string
  provider: ChatProvider
  tier: ModelTier
}

export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  enabled: boolean
}

export interface ChatCompletionOptions {
  messages: ChatMessage[]
  model: string
  provider: ChatProvider
  providerConfig: ProviderConfig
  signal?: AbortSignal
}

export interface ChatSession {
  id: string
  messages: ChatMessage[]
  model: string
  provider: ChatProvider
  sourceConversation: NormalizedConversation | null
}

export interface ProviderSettings {
  apiKey: string
  baseUrl: string
  enabled: boolean
}

export interface WebAppOption {
  id: string
  name: string
  url: string
}
