import { resolveEndpoint, isUnsupported } from './endpoints'
import { apiKeyFor, findModel, findProvider, findVariant, favoriteProviders, favoriteModels } from './search'
import { modelProtocol, providerNeedsKey } from './types'
import type { ModelCatalog, ModelEntry, ModelVariant, ProviderEntry } from './types'

/**
 * Resolve a user-facing model spec into a runnable target: provider entry,
 * model entry, reasoning variant, api key and endpoint. The spec grammar is
 * `model`, `model#variant`, `provider/model`, `provider/model#variant` —
 * the same shape opencode made familiar, so `/model deepseek/deepseek-chat`
 * and `-m anthropic/claude-sonnet-4-5#high` both work.
 */
export interface ResolvedTarget {
  provider: ProviderEntry
  model: ModelEntry
  variant: ModelVariant | null
  apiKey?: string
  baseUrl: string
  protocol: 'openai' | 'anthropic'
  unsupported: boolean
  needsKey: boolean
}

export interface SpecError {
  error: string
}

export function parseModelSpec(spec: string): { provider?: string; model: string; variant?: string } {
  const hashAt = spec.indexOf('#')
  const withoutVariant = hashAt === -1 ? spec : spec.slice(0, hashAt)
  const variant = hashAt === -1 ? undefined : spec.slice(hashAt + 1)
  const slash = withoutVariant.indexOf('/')
  if (slash > 0) {
    return {
      provider: withoutVariant.slice(0, slash),
      model: withoutVariant.slice(slash + 1),
      ...(variant ? { variant } : {}),
    }
  }
  return { model: withoutVariant, ...(variant ? { variant } : {}) }
}

/**
 * Resolve a spec against the catalog. An explicit provider id wins;
 * otherwise the model id is searched across the favorite providers first
 * and the whole catalog second.
 */
export function resolveTarget(catalog: ModelCatalog, spec: string): ResolvedTarget | SpecError {
  const { provider: providerId, model: modelId, variant: variantId } = parseModelSpec(spec.trim())
  if (!modelId) return { error: 'empty model spec' }

  let provider: ProviderEntry | null = null
  let model: ModelEntry | null = null

  if (providerId) {
    provider = findProvider(catalog, providerId)
    if (!provider) return { error: `unknown provider "${providerId}"` }
    model = findModel(provider, modelId)
    if (!model) return { error: `provider "${provider.id}" has no model "${modelId}"` }
  } else {
    for (const candidate of favoriteProviders(catalog)) {
      model = findModel(candidate, modelId)
      if (model) {
        provider = candidate
        break
      }
    }
    if (!model) {
      for (const candidate of catalog.providers) {
        model = findModel(candidate, modelId)
        if (model) {
          provider = candidate
          break
        }
      }
    }
    if (!model || !provider) return { error: `no provider in the catalog carries "${modelId}"` }
  }

  const variant = findVariant(model, variantId)
  if (variantId && !variant) {
    const known = model.variants.map((v) => v.id).join(', ')
    return { error: `model "${model.id}" has no variant "${variantId}"${known ? ` (variants: ${known})` : ''}` }
  }

  const endpoint = resolveEndpoint(provider, model.providerApi ?? provider.api)
  if (endpoint.kind === 'missing-env') {
    return { error: `${provider.name} needs the ${endpoint.variable} environment variable` }
  }
  if (endpoint.kind === 'unknown') {
    return { error: `no api endpoint is known for ${provider.name}` }
  }

  const key = apiKeyFor(provider)
  return {
    provider,
    model,
    variant,
    ...(key ? { apiKey: key } : {}),
    baseUrl: endpoint.endpoint.base,
    protocol: modelProtocol(provider, model) === 'anthropic-messages' ? 'anthropic' : 'openai',
    unsupported: isUnsupported(provider.id),
    needsKey: providerNeedsKey(provider),
  }
}

/** Provider rows for the picker: favorites first, the rest after. */
export function pickerProviders(catalog: ModelCatalog): ProviderEntry[] {
  const favorites = favoriteProviders(catalog)
  const favoriteIds = new Set(favorites.map((p) => p.id))
  return [...favorites, ...catalog.providers.filter((p) => !favoriteIds.has(p.id))]
}

export { favoriteModels, favoriteProviders, findModel, findProvider, findVariant, apiKeyFor }
