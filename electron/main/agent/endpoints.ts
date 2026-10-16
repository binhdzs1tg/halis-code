import type { ModelEntry, ProviderEntry } from '../../shared/models'

export type AuthStyle = 'bearer' | 'api-key' | 'x-api-key'

export interface Endpoint {
  /** Base URL without trailing slash; the adapter appends its chat path. */
  base: string
  auth: AuthStyle
}

/**
 * The outcome of endpoint resolution. Halis never guesses: a provider whose
 * base URL is baked into its SDK, or built from an environment variable that
 * is not set, reports exactly why it cannot be reached.
 */
export type EndpointResolution =
  | { kind: 'ok'; endpoint: Endpoint }
  | { kind: 'unknown' }
  | { kind: 'missing-env'; variable: string }

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
  togetherai: 'https://api.together.xyz/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  venice: 'https://api.venice.ai/api/openai/v1',
  perplexity: 'https://api.perplexity.ai',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  aihubmix: 'https://aihubmix.com/v1',
  moonshot: 'https://api.moonshot.ai/v1'
}

/** Auth schemes we do not implement (signed requests, OAuth flows, IAM). */
const UNSUPPORTED = new Set([
  'amazon-bedrock', // SigV4 request signing
  'github-copilot', // GitHub OAuth device flow
  'google-vertex', // service-account JWT exchange
  'google-vertex-anthropic', // service-account JWT exchange
  'watsonx', // IAM bearer token flow
  'sap-ai-core', // OAuth client credentials
  'gitlab' // GitLab Duo session auth
])

/** Providers where a plain Bearer header is not how they authenticate. */
const AUTH_OVERRIDES: Record<string, AuthStyle> = {
  anthropic: 'x-api-key',
  azure: 'api-key'
}

export function isUnsupported(providerId: string): boolean {
  return UNSUPPORTED.has(providerId)
}

/** Query parameter that authenticates Azure Data Plane requests. */
export const AZURE_API_VERSION = '2025-04-01-preview'

/**
 * Expand the `${ENV_VAR}` placeholders some providers document inside their
 * `api` URL. Every template names its own variable, so the requirement is
 * read straight from the URL — the same treatment Codex gives
 * `env_http_headers` and the DeepSeek Harness gives `baseURLEnv`.
 */
function interpolate(raw: string): { url: string } | { kind: 'missing-env'; variable: string } {
  const match = /\$\{([A-Z0-9_]+)\}/.exec(raw)
  const name = match?.[1]
  if (!name) return { url: raw }
  const value = process.env[name]
  if (!value || !value.trim()) return { kind: 'missing-env', variable: name }
  return { url: raw.replace(/\$\{[A-Z0-9_]+\}/g, value.trim()) }
}

/**
 * Resolve the chat endpoint for a model. A per-model `api` override wins over
 * the provider-level one, which wins over the defaults table above. Azure
 * builds per-deployment URLs, so its base stays resource-rooted and the
 * adapter appends the deployment path.
 */
export function resolveEndpoint(provider: ProviderEntry, model: ModelEntry): EndpointResolution {
  if (provider.id === 'azure') {
    const resource = process.env.AZURE_RESOURCE_NAME
    if (!resource || !resource.trim()) {
      return { kind: 'missing-env', variable: 'AZURE_RESOURCE_NAME' }
    }
    return {
      kind: 'ok',
      endpoint: {
        base: `https://${resource.trim()}.openai.azure.com/openai`,
        auth: AUTH_OVERRIDES[provider.id] ?? 'bearer'
      }
    }
  }
  const raw = model.providerApi ?? provider.api ?? DEFAULT_BASES[provider.id]
  if (!raw) return { kind: 'unknown' }
  const expanded = raw.includes('${') ? interpolate(raw) : { url: raw }
  if ('kind' in expanded) return expanded
  return {
    kind: 'ok',
    endpoint: {
      base: expanded.url.replace(/\/+$/, ''),
      auth: AUTH_OVERRIDES[provider.id] ?? 'bearer'
    }
  }
}
