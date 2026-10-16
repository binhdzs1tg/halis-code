import { BrowserWindow, app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { IpcChannel } from '../../shared/ipc-channels'
import type {
  ModelCatalog,
  ModelCost,
  ModelEntry,
  ModelVariant,
  ProviderEntry,
  RawCatalog,
  RawCost,
  ReasoningOption,
  SourceModel,
  SourceProvider
} from '../../shared/models'

const SOURCE_URL = 'https://models.dev/api.json'
const USER_AGENT = 'halis-code/0.1.0'
const REFRESH_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const MIN_PROVIDERS = 100
const CACHE_FILE = 'models-dev-cache.json'

/**
 * Output cap for models whose catalog metadata reports zero — the harness
 * cannot build any request without one. Same spirit as Codex's unknown-model
 * fallback metadata.
 */
const DEFAULT_OUTPUT_LIMIT = 32_768

/** Bedrock entries that only work through inference profiles. */
const BEDROCK_PROFILE_ONLY_IDS = new Set([
  'amazon.nova-2-lite-v1:0',
  'anthropic.claude-fable-5',
  'anthropic.claude-fable-5-1',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
  'anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-opus-4-7',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-5',
  'deepseek.r1-v1:0',
  'mistral.pixtral-large-2502-v1:0'
])

/**
 * Deprecated aliases replaced by canonical Azure / Google Vertex providers.
 * `opencode` is Halis's own former catalog source, dropped now that the
 * catalog comes from models.dev directly; 302.AI is an aggregator
 * middleman Halis refuses to surface at all.
 */
const EXCLUDED_PROVIDERS = new Set([
  'azure-cognitive-services',
  'google-vertex-anthropic',
  '302ai',
  'opencode'
])

interface CacheFile {
  updatedAt: number
  /** Last ETag seen on upstream, sent back as If-None-Match. */
  etag?: string
  catalog: RawCatalog
}

let loaded: ModelCatalog | null = null
let loading: Promise<ModelCatalog> | null = null
let lastRefresh = 0
let etag: string | null = null
let refreshing: Promise<void> | null = null

/** Load the catalog, preferring the disk cache over the bundled snapshot. */
export async function list(): Promise<ModelCatalog> {
  if (loaded) return loaded
  if (!loading) {
    loading = ensure().catch((err) => {
      loading = null
      throw err
    })
  }
  return loading
}

/**
 * Refresh from models.dev. No-op within the TTL unless forced.
 * Offline or invalid responses keep whatever is currently loaded.
 */
export async function refresh(force = false): Promise<ModelCatalog> {
  await list()
  if (!force && loaded && loaded.source === 'network' && Date.now() - lastRefresh < REFRESH_TTL_MS) {
    return loaded
  }
  if (!refreshing) {
    refreshing = fetchLatest()
      .catch((err) => {
        console.warn('[models-dev] refresh failed:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        refreshing = null
      })
  }
  await refreshing
  return list()
}

async function ensure(): Promise<ModelCatalog> {
  const cached = await readCache()
  if (cached) {
    loaded = cached.catalog
    lastRefresh = cached.updatedAt
    etag = cached.etag ?? null
  } else {
    const snapshot = readBundledSnapshot()
    if (!snapshot) {
      throw new Error('bundled models.dev snapshot is missing')
    }
    loaded = build(snapshot, Date.now(), 'snapshot')
    lastRefresh = 0
  }
  // Catch up with upstream in the background; the snapshot is just the floor.
  void refresh()
  return loaded
}

async function fetchLatest(): Promise<void> {
  // ETag round-trip like Codex's models manager: an unchanged upstream
  // costs one HEAD-sized 304 instead of the multi-megabyte catalog.
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
  if (etag) headers['If-None-Match'] = etag
  const response = await fetch(SOURCE_URL, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (response.status === 304 && loaded) {
    lastRefresh = Date.now()
    await writeCache(loaded.source, Date.now())
    return
  }
  if (!response.ok) {
    throw new Error(`unexpected status ${response.status}`)
  }
  const text = await response.text()
  const catalog = JSON.parse(text) as RawCatalog
  if (!catalog || typeof catalog !== 'object' || Object.keys(catalog).length < MIN_PROVIDERS) {
    throw new Error('catalog looks truncated, ignoring')
  }
  const updatedAt = Date.now()
  // Build first: normalize() is the real shape validation, and a payload that
  // cannot be built must never reach the disk cache.
  const next = build(catalog, updatedAt, 'network')
  etag = response.headers.get('etag')
  await writeCache('network', updatedAt, catalog)
  loaded = next
  lastRefresh = updatedAt
  broadcast()
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.ModelsUpdated)
    }
  }
}

/**
 * The disk cache, validated by actually building it — a payload that fails
 * normalization is treated as absent so the bundled snapshot takes over.
 */
async function readCache(): Promise<{ catalog: ModelCatalog; updatedAt: number; etag: string | null } | null> {
  try {
    const file = path.join(app.getPath('userData'), CACHE_FILE)
    if (!existsSync(file)) return null
    const raw = JSON.parse(await readFile(file, 'utf8')) as CacheFile
    if (!raw || typeof raw.catalog !== 'object' || Object.keys(raw.catalog).length < MIN_PROVIDERS) {
      return null
    }
    return {
      catalog: build(raw.catalog, raw.updatedAt, 'cache'),
      updatedAt: raw.updatedAt,
      etag: raw.etag ?? null
    }
  } catch {
    return null
  }
}

/** Persist the raw upstream catalog, or just refresh metadata on a 304. */
async function writeCache(source: ModelCatalog['source'], updatedAt: number, catalog?: RawCatalog): Promise<void> {
  try {
    const dir = app.getPath('userData')
    await mkdir(dir, { recursive: true })
    if (!catalog && loaded && source === 'network') {
      // A 304 leaves the payload untouched; only the freshness stamp moves.
      const file = path.join(dir, CACHE_FILE)
      const raw = JSON.parse(await readFile(file, 'utf8')) as CacheFile
      await writeFile(path.join(dir, CACHE_FILE), JSON.stringify({ ...raw, updatedAt }))
      return
    }
    if (!catalog) return
    const entry: CacheFile = { updatedAt, catalog, ...(etag ? { etag } : {}) }
    await writeFile(path.join(dir, CACHE_FILE), JSON.stringify(entry))
  } catch (err) {
    console.warn('[models-dev] cache write failed:', err instanceof Error ? err.message : err)
  }
}

function readBundledSnapshot(): RawCatalog | null {
  try {
    const file = path.join(__dirname, 'models-dev', 'snapshot.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8')) as RawCatalog
  } catch (err) {
    console.warn('[models-dev] bundled snapshot unreadable:', err instanceof Error ? err.message : err)
    return null
  }
}

function build(catalog: RawCatalog, updatedAt: number, source: ModelCatalog['source']): ModelCatalog {
  return { providers: normalize(catalog), updatedAt, source }
}

function normalize(catalog: RawCatalog): ProviderEntry[] {
  return available(
    Object.values(catalog)
      .filter((item): item is SourceProvider => Boolean(item?.id && item?.models))
      .map((item) => ({
        id: item.id,
        name: item.name,
        env: [...(item.env ?? [])],
        npm: item.npm,
        ...(item.api !== undefined ? { api: item.api } : {}),
        ...(item.doc !== undefined ? { doc: item.doc } : {}),
        models: expandModels(item)
      }))
  )
}

function expandModels(provider: SourceProvider): ModelEntry[] {
  const models: ModelEntry[] = []
  for (const raw of Object.values(provider.models ?? {})) {
    if (!raw?.id || !raw.limit) continue
    const base = toEntry(provider, raw, raw.id, raw.name)
    base.variants = resolveVariants(base, readSupports(raw))
    models.push(base)
    // Experimental modes become standalone model entries, like models.dev
    // surfaces them upstream.
    for (const [mode, options] of Object.entries(raw.experimental?.modes ?? {})) {
      const entry = toEntry(provider, raw, `${raw.id}-${mode}`, modeName(raw.name, mode))
      entry.cost = mergeCost(base.cost, readCost(options.cost))
      entry.variants = base.variants
      if (options.provider?.body) entry.modeBody = { ...options.provider.body }
      if (options.provider?.headers) entry.modeHeaders = { ...options.provider.headers }
      models.push(entry)
    }
  }
  return models
}

function toEntry(provider: SourceProvider, raw: SourceModel, id: string, name: string): ModelEntry {
  const entry: ModelEntry = {
    id,
    providerID: provider.id,
    name,
    released: parseDate(raw.release_date),
    reasoning: raw.reasoning,
    attachment: raw.attachment,
    toolCall: raw.tool_call,
    status: raw.status ?? 'active',
    limit: {
      context: raw.limit.context,
      ...(raw.limit.input !== undefined ? { input: raw.limit.input } : {}),
      // Wrapper providers and media models sometimes publish a zero cap;
      // a chat request needs a real one, so unknown falls back.
      output: raw.limit.output > 0 ? raw.limit.output : DEFAULT_OUTPUT_LIMIT
    },
    cost: readCost(raw.cost),
    modalities: {
      input: [...(raw.modalities?.input ?? [])],
      output: [...(raw.modalities?.output ?? [])]
    },
    variants: [],
    npm: raw.provider?.npm ?? provider.npm
  }
  if (raw.family !== undefined) entry.family = raw.family
  if (raw.description !== undefined) entry.description = raw.description
  if (raw.temperature !== undefined) entry.temperature = raw.temperature
  if (raw.structured_output !== undefined) entry.structuredOutput = raw.structured_output
  if (raw.open_weights !== undefined) entry.openWeights = raw.open_weights
  if (raw.knowledge !== undefined) entry.knowledge = raw.knowledge
  if (raw.provider?.api !== undefined) entry.providerApi = raw.provider.api
  if (raw.provider?.shape !== undefined) entry.shape = raw.provider.shape
  return entry
}

function available(providers: ProviderEntry[]): ProviderEntry[] {
  return providers
    .filter((provider) => !EXCLUDED_PROVIDERS.has(provider.id))
    .map((provider) => ({
      ...provider,
      models: provider.models.filter(
        (model) =>
          model.status !== 'deprecated' &&
          supportsText(model) &&
          producesText(model) &&
          !(provider.id === 'amazon-bedrock' && BEDROCK_PROFILE_ONLY_IDS.has(model.id))
      )
    }))
    .filter((provider) => provider.models.length > 0)
}

function supportsText(model: ModelEntry): boolean {
  return model.modalities.input.includes('text')
}

/** The harness reads only text back, so video/image/audio-only output is unusable. */
function producesText(model: ModelEntry): boolean {
  return model.modalities.output.includes('text')
}

function readSupports(raw: SourceModel): ReasoningOption[] {
  return (raw.reasoning_options ?? []).map((option): ReasoningOption => {
    if (option.type !== 'effort') return option
    // "default" is the provider's own sentinel, not a requestable level;
    // stripping every value leaves the standard trio from resolveVariants.
    const values = (option.values ?? []).filter(
      (value): value is string => value !== null && value !== 'null' && value !== 'default'
    )
    return values.length > 0 ? { type: 'effort', values } : { type: 'effort' }
  })
}

/**
 * Derive reasoning variants from the catalog's reasoning_options:
 * toggle -> none/thinking, effort -> one variant per effort level,
 * budget_tokens -> high/max derived from the output limit.
 */
function resolveVariants(model: ModelEntry, supports: ReasoningOption[]): ModelVariant[] {
  const variants: ModelVariant[] = []
  const push = (id: string, patch: Omit<ModelVariant, 'id' | 'label'>): void => {
    if (!variants.some((variant) => variant.id === id)) {
      variants.push({ id, label: variantLabel(id), ...patch })
    }
  }
  if (supports.some((option) => option.type === 'toggle')) {
    push('none', { thinking: false })
    push('thinking', { thinking: true })
  }
  const effort = supports.find((option): option is Extract<ReasoningOption, { type: 'effort' }> => option.type === 'effort')
  const budget = supports.find(
    (option): option is Extract<ReasoningOption, { type: 'budget_tokens' }> => option.type === 'budget_tokens'
  )
  if (effort) {
    for (const value of effort.values ?? ['low', 'medium', 'high']) {
      push(value, { reasoningEffort: value })
    }
  } else if (budget) {
    const maximum = Math.min(budget.max ?? model.limit.output - 1, model.limit.output - 1)
    if (maximum > 0) {
      const high = Math.min(Math.max(budget.min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
      push('high', { budgetTokens: high })
      push('max', { budgetTokens: maximum })
    }
  }
  return variants
}

function variantLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

function modeName(name: string, mode: string): string {
  return `${name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`
}

function parseDate(date: string): number {
  const time = Date.parse(date)
  return Number.isFinite(time) ? time : 0
}

function readCost(raw: RawCost | undefined): ModelCost {
  const cost: ModelCost = {
    input: raw?.input ?? 0,
    output: raw?.output ?? 0,
    cacheRead: raw?.cache_read ?? 0,
    cacheWrite: raw?.cache_write ?? 0
  }
  if (raw?.tiers?.length) {
    cost.tiers = raw.tiers.map((tier) => ({
      size: tier.tier?.size ?? 0,
      input: tier.input ?? cost.input,
      output: tier.output ?? cost.output,
      cacheRead: tier.cache_read ?? cost.cacheRead,
      cacheWrite: tier.cache_write ?? cost.cacheWrite
    }))
  }
  return cost
}

function mergeCost(base: ModelCost, override: ModelCost): ModelCost {
  const tiers = override.tiers ?? base.tiers
  return {
    input: override.input || base.input,
    output: override.output || base.output,
    cacheRead: override.cacheRead || base.cacheRead,
    cacheWrite: override.cacheWrite || base.cacheWrite,
    ...(tiers ? { tiers } : {})
  }
}
