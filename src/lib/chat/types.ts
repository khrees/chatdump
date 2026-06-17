import type { NormalizedConversation } from '../types'

export interface ChatMessage {
  content: string
  role: 'assistant' | 'system' | 'user'
}

export type ChatProvider = 'anthropic' | 'custom' | 'google' | 'lmstudio' | 'ollama' | 'openai'

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
