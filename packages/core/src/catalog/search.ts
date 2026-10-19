import { resolveEndpoint } from './endpoints'
import type { ModelCatalog, ModelEntry, ModelVariant, ProviderEntry } from './types'

/**
 * Lookup helpers over the models.dev catalog: find a provider/model pair,
 * search by free text, and pick the API key the catalog documents.
 */

export interface ModelRef {
  provider: ProviderEntry
  model: ModelEntry
}

export function findProvider(catalog: ModelCatalog, id: string): ProviderEntry | null {
  const wanted = id.toLowerCase()
  return catalog.providers.find((p) => p.id.toLowerCase() === wanted) ?? null
}

/** `model` may be a bare model id or `model-variant`; the suffix wins first. */
export function findModel(provider: ProviderEntry, id: string): ModelEntry | null {
  const wanted = id.toLowerCase()
  return provider.models.find((m) => m.id.toLowerCase() === wanted) ?? null
}

export function findVariant(model: ModelEntry, id: string | undefined): ModelVariant | null {
  if (!id) return null
  const wanted = id.toLowerCase()
  return model.variants.find((v) => v.id.toLowerCase() === wanted) ?? null
}

/**
 * First environment variable that carries a key for the provider. An
 * explicit `HALIS_API_KEY` beats the catalog's own names, matching the
 * preset behavior the cli shipped with.
 */
export function apiKeyFor(provider: ProviderEntry): string | undefined {
  if (process.env.HALIS_API_KEY?.trim()) return process.env.HALIS_API_KEY.trim()
  for (const name of provider.env) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

/** Case-insensitive free-text search across provider and model names. */
export function searchCatalog(catalog: ModelCatalog, query: string, limit = 20): ModelRef[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const hits: Array<{ ref: ModelRef; score: number }> = []
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      const haystack = `${provider.id} ${provider.name} ${model.id} ${model.name}`.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (!haystack.includes(term)) {
          score = -1
          break
        }
        score += model.id.toLowerCase().startsWith(term) || provider.id.toLowerCase().startsWith(term) ? 2 : 1
      }
      if (score > 0) hits.push({ ref: { provider, model }, score })
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.ref.provider.id.localeCompare(b.ref.provider.id) ||
      a.ref.model.id.localeCompare(b.ref.model.id)
  )
  return hits.slice(0, limit).map((h) => h.ref)
}

/**
 * A popular, cheap first pick per well-known provider — the picker shows
 * these before the alphabetical flood when no query is typed. Entries that
 * drift out of the catalog fall back to the newest tool-calling models.
 */
const FAVORITE_MODEL_IDS: Record<string, string[]> = {
  zai: ['glm-4.7', 'glm-4.7-flash', 'glm-4.6'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'],
  openai: ['gpt-6.1-sol', 'gpt-6.1-sol-fast', 'gpt-6-sol'],
  'openai-chatgpt': ['gpt-6.1-sol'],
  deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
  moonshotai: ['kimi-k3', 'kimi-k2.7-code'],
  google: ['gemini-4-argon', 'gemini-3.8-flash'],
  'google-vertex': ['gemini-4-argon'],
  xai: ['grok-4.7', 'grok-build-0.1'],
  minimax: ['MiniMax-M2']
}

/**
 * Favorite models of a provider that actually exist in the catalog, in
 * display order — the top rows of an empty picker query.
 */
export function favoriteModels(provider: ProviderEntry): ModelEntry[] {
  const favorites = FAVORITE_MODEL_IDS[provider.id] ?? []
  const picks: ModelEntry[] = []
  for (const id of favorites) {
    const model = findModel(provider, id)
    if (model) picks.push(model)
  }
  if (picks.length === 0) {
    // No curated list (or it drifted): the newest tool-calling models are the
    // sensible default rows.
    picks.push(...[...provider.models].filter((m) => m.toolCall).sort((a, b) => b.released - a.released).slice(0, 5))
  }
  return picks
}

/** Providers a terminal user is most likely to want, in picker order. */
const FAVORITE_PROVIDER_IDS = [
  'zai',
  'anthropic',
  'openai',
  'openai-chatgpt',
  'google',
  'deepseek',
  'moonshotai',
  'xai',
  'alibaba-coding-plan',
  'alibaba',
  'minimax',
  'groq',
  'mistral',
  'openrouter',
  'azure'
]

export function favoriteProviders(catalog: ModelCatalog): ProviderEntry[] {
  const byId = new Map(catalog.providers.map((p) => [p.id, p]))
  const picks: ProviderEntry[] = []
  for (const id of FAVORITE_PROVIDER_IDS) {
    const provider = byId.get(id)
    if (provider) picks.push(provider)
  }
  return picks
}

/** Endpoint resolution that also reports the failure mode as text. */
export function describeEndpoint(provider: ProviderEntry, _model?: ModelEntry): string {
  const resolution = resolveEndpoint(provider, _model?.providerApi ?? provider.api)
  if (resolution.kind === 'ok') return resolution.endpoint.base
  if (resolution.kind === 'missing-env') return `unreachable — set ${resolution.variable}`
  return 'unreachable — no api base known for this provider'
}
