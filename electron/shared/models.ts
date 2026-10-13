/**
 * Model catalog types, ported from opencode's models.dev integration
 * (https://models.opencode.ai/api.json).
 *
 * The `Source*` shapes mirror the upstream snapshot one to one so new fields
 * keep flowing through without code changes; `ProviderEntry` / `ModelEntry`
 * are the normalized, renderer-facing views of the same data.
 */

export type ModelModality = 'text' | 'audio' | 'image' | 'video' | 'pdf'

export type ModelStatus = 'alpha' | 'beta' | 'deprecated' | 'active'

export type ReasoningOption =
  | { type: 'effort'; values?: readonly (string | null)[] }
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
  readonly reasoning_options?: readonly ReasoningOption[]
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

/** USD per million tokens, zero-defaulted like opencode does. */
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
  status: Exclude<ModelStatus, 'deprecated'>
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
