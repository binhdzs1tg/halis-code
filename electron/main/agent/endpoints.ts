import type { ModelEntry, ProviderEntry } from '../../shared/models'

export type AuthStyle = 'bearer' | 'api-key' | 'x-api-key'

export interface Endpoint {
  /** Base URL without trailing slash; the adapter appends its chat path. */
  base: string
  auth: AuthStyle
}

/**
 * models.dev leaves `api` empty for providers whose SDK bakes the URL in.
 * These defaults mirror those SDKs so requests reach the right host.
 */
const DEFAULT_BASES: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  cerebras: 'https://api.cerebras.ai/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  perplexity: 'https://api.perplexity.ai',
  moonshot: 'https://api.moonshot.ai/v1'
}

/** Providers where a plain Bearer header is not how they authenticate. */
const AUTH_OVERRIDES: Record<string, AuthStyle> = {
  anthropic: 'x-api-key',
  azure: 'api-key'
}

/** Auth schemes we do not implement (signed requests, device OAuth flows). */
const UNSUPPORTED = new Set(['amazon-bedrock', 'github-copilot'])

export function isUnsupported(providerId: string): boolean {
  return UNSUPPORTED.has(providerId)
}

/**
 * Resolve the chat endpoint for a model. A per-model `api` override wins over
 * the provider-level one, which wins over the defaults table above.
 */
export function resolveEndpoint(provider: ProviderEntry, model: ModelEntry): Endpoint | null {
  const raw = model.providerApi ?? provider.api ?? DEFAULT_BASES[provider.id]
  if (!raw) return null
  return {
    base: raw.replace(/\/+$/, ''),
    auth: AUTH_OVERRIDES[provider.id] ?? 'bearer'
  }
}
