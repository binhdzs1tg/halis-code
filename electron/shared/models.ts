/**
 * Model catalog types for the models.dev integration
 * (https://models.dev/api.json).
 *
 * The `Source*` shapes mirror the upstream snapshot one to one so new fields
 * keep flowing through without code changes; `ProviderEntry` / `ModelEntry`
 * are the normalized, renderer-facing views of the same data.
 */

export type ModelModality = 'text' | 'audio' | 'image' | 'video' | 'pdf'

export type ModelStatus = 'alpha' | 'beta' | 'deprecated' | 'active'

/** As it appears in the upstream snapshot. */
export type RawReasoningOption =
  | { type: 'effort'; values?: readonly (string | null)[] }
  | { type: 'toggle' }
  | { type: 'budget_tokens'; min?: number; max?: number }

/** After null values are stripped. */
export type ReasoningOption =
  | { type: 'effort'; values?: readonly string[] }
  | { type: 'toggle' }
  | { type: 'budget_tokens'; min?: number; max?: number }

export interface RawCostTier {
  tier?: { type: 'context'; size: number }
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}

export interface RawCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tiers?: readonly RawCostTier[]
}

export interface RawMode {
  cost?: RawCost
  provider?: {
    body?: Record<string, unknown>
    headers?: Readonly<Record<string, string>>
  }
}

export interface SourceModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly family?: string
  readonly release_date: string
  readonly attachment: boolean
  readonly reasoning: boolean
  readonly reasoning_options?: readonly RawReasoningOption[]
  readonly temperature?: boolean
  readonly tool_call: boolean
  readonly interleaved?: boolean | string | { field: string }
  readonly structured_output?: boolean
  readonly open_weights?: boolean
  readonly knowledge?: string
  readonly cost?: RawCost
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
  readonly modalities?: {
    readonly input: readonly ModelModality[]
    readonly output: readonly ModelModality[]
  }
  readonly experimental?: { readonly modes?: Readonly<Record<string, RawMode>> }
  readonly status?: 'alpha' | 'beta' | 'deprecated'
  readonly provider?: {
    readonly npm?: string
    readonly api?: string
    readonly shape?: 'responses' | 'completions'
  }
}

export interface SourceProvider {
  readonly id: string
  readonly name: string
  readonly env: readonly string[]
  readonly npm: string
  readonly api?: string
  readonly doc?: string
  readonly models: Readonly<Record<string, SourceModel>>
}

export type RawCatalog = Record<string, SourceProvider>

export interface ModelCostTier {
  size: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** USD per million tokens, zero-defaulted. */
export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tiers?: ModelCostTier[]
}

export interface ModelVariant {
  id: string
  label: string
  reasoningEffort?: string
  thinking?: boolean
  budgetTokens?: number
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

export interface ModelEntry {
  id: string
  providerID: string
  name: string
  family?: string
  description?: string
  /** Epoch ms of `release_date`, 0 when unknown. */
  released: number
  reasoning: boolean
  attachment: boolean
  toolCall: boolean
  temperature?: boolean
  structuredOutput?: boolean
  openWeights?: boolean
  knowledge?: string
  status: ModelStatus
  limit: { context: number; input?: number; output: number }
  cost: ModelCost
  modalities: { input: string[]; output: string[] }
  variants: ModelVariant[]
  /** Provider SDK package backing this model, e.g. `@ai-sdk/anthropic`. */
  npm: string
  /** Per-model provider overrides ported from the catalog. */
  providerApi?: string
  shape?: 'responses' | 'completions'
  modeBody?: Record<string, unknown>
  modeHeaders?: Record<string, string>
}

export interface ProviderEntry {
  id: string
  name: string
  /** Environment variables the provider reads its key from. */
  env: string[]
  npm: string
  api?: string
  doc?: string
  models: ModelEntry[]
}

export interface ModelCatalog {
  providers: ProviderEntry[]
  updatedAt: number
  /** Where the current catalog came from. */
  source: 'snapshot' | 'cache' | 'network'
}

export interface ModelSelection {
  providerID: string
  modelID: string
  variant?: string
}

/**
 * Local inference servers that answer unauthenticated requests — models from
 * these providers run with no API key at all.
 */
const KEYLESS_PROVIDERS = new Set(['lmstudio', 'ollama', 'vllm', 'jan', 'llama-cpp'])

/**
 * Whether a provider gatekeeps its models behind an API key. Everything with
 * documented env credentials does; local servers and the like do not.
 */
export function providerNeedsKey(provider: Pick<ProviderEntry, 'id' | 'env'>): boolean {
  return !KEYLESS_PROVIDERS.has(provider.id) && provider.env.length > 0
}

/**
 * The wire protocol a model speaks. Providers shipping an Anthropic SDK
 * package expect Anthropic content blocks on `/messages`; everything else
 * takes OpenAI-style chat completions — the same protocol split the
 * DeepSeek Harness draws with its `openai-completions` / `anthropic-messages`
 * adapters, derived from catalog data instead of a hand-listed table.
 */
export type ModelProtocol = 'openai-completions' | 'anthropic-messages'

export function modelProtocol(
  provider: Pick<ProviderEntry, 'id' | 'npm'>,
  model: Pick<ModelEntry, 'npm'>
): ModelProtocol {
  return (model.npm || provider.npm) === '@ai-sdk/anthropic' ? 'anthropic-messages' : 'openai-completions'
}

/**
 * Out-of-the-box pick from the models.dev catalog: a strong model with a
 * free tier, so a single key unlocks the first chat. Applies whenever the
 * user has not chosen a model yet.
 */
export const DEFAULT_MODEL: ModelSelection = {
  providerID: 'zai',
  modelID: 'glm-4.7-flash'
}
