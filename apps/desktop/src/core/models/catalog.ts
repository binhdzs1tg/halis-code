import type { ModelCatalog, ModelEntry, ModelSelection, ProviderEntry } from '../../../electron/shared/models'
import { DEFAULT_MODEL } from '../../../electron/shared/models'

const PREFS_KEY = 'halis.model-prefs'
const RECENT_LIMIT = 10

/**
 * Renderer-side model preferences: recents (max 10), favorites, and the
 * reasoning variant picked per model.
 */
export interface ModelPrefs {
  recent: ModelSelection[]
  favorites: ModelSelection[]
  variants: Record<string, string>
}

let catalog: ModelCatalog | null = null
let pending: Promise<ModelCatalog> | null = null
let prefsCache: ModelPrefs | null = null
/** Bumped by invalidate(); an in-flight fetch from before it must not land. */
let generation = 0

export function keyOf(selection: ModelSelection): string {
  return `${selection.providerID}/${selection.modelID}`
}

export async function ensureCatalog(): Promise<ModelCatalog> {
  if (catalog) return catalog
  if (!pending) {
    const current = (generation += 1)
    pending = window.halis
      .getModels()
      .then((next) => {
        // Only the newest fetch may fill the cache; an older one that was
        // invalidated mid-flight would otherwise resurrect stale data.
        if (current === generation) catalog = next
        return next
      })
      .finally(() => {
        if (current === generation) pending = null
      })
  }
  return pending
}

export function invalidate(): void {
  generation += 1
  catalog = null
  pending = null
}

/** Drop selections that no longer exist in the catalog. */
export function isValid(selection: ModelSelection | null): boolean {
  return Boolean(selection && findModel(selection))
}

export function findModel(selection: ModelSelection): { model: ModelEntry; provider: ProviderEntry } | null {
  const provider = catalog?.providers.find((item) => item.id === selection.providerID)
  if (!provider) return null
  const model = provider.models.find((item) => item.id === selection.modelID)
  if (!model) return null
  return { model, provider }
}

export function providers(): ProviderEntry[] {
  return [...(catalog?.providers ?? [])].sort((a, b) => a.name.localeCompare(b.name))
}

/** Free-first, newest-first ordering within a provider, like models.dev's picker. */
export function sortModels(models: ModelEntry[]): ModelEntry[] {
  return [...models].sort((a, b) => {
    const free = Number(isFree(b)) - Number(isFree(a))
    if (free !== 0) return free
    const newest = b.released - a.released
    if (newest !== 0) return newest
    return a.name.localeCompare(b.name)
  })
}

export function isFree(model: ModelEntry): boolean {
  const tieredFree = (model.cost.tiers ?? []).every((tier) => tier.input === 0)
  return model.cost.input === 0 && tieredFree
}

export function loadPrefs(): ModelPrefs {
  if (prefsCache) return prefsCache
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ModelPrefs>
      prefsCache = {
        recent: Array.isArray(parsed.recent) ? parsed.recent.filter(isShape) : [],
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter(isShape) : [],
        variants: parsed.variants && typeof parsed.variants === 'object' ? parsed.variants : {}
      }
      return prefsCache
    }
  } catch {
    // fall through to defaults
  }
  prefsCache = { recent: [], favorites: [], variants: {} }
  return prefsCache
}

function isShape(value: unknown): value is ModelSelection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModelSelection).providerID === 'string' &&
    typeof (value as ModelSelection).modelID === 'string'
  )
}

function savePrefs(): void {
  if (!prefsCache) return
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefsCache))
  } catch {
    // Quota or privacy mode: prefs stay in memory for this session only.
  }
}

export function rememberSelection(selection: ModelSelection): void {
  const prefs = loadPrefs()
  const key = keyOf(selection)
  prefs.recent = [selection, ...prefs.recent.filter((item) => keyOf(item) !== key)].slice(0, RECENT_LIMIT)
  if (selection.variant) {
    prefs.variants[key] = selection.variant
  } else {
    delete prefs.variants[key]
  }
  savePrefs()
}

export function isFavorite(selection: ModelSelection): boolean {
  const key = keyOf(selection)
  return loadPrefs().favorites.some((item) => keyOf(item) === key)
}

export function toggleFavorite(selection: ModelSelection): void {
  const prefs = loadPrefs()
  const key = keyOf(selection)
  if (prefs.favorites.some((item) => keyOf(item) === key)) {
    prefs.favorites = prefs.favorites.filter((item) => keyOf(item) !== key)
  } else {
    prefs.favorites = [selection, ...prefs.favorites]
  }
  savePrefs()
}

export function variantFor(selection: ModelSelection): string | undefined {
  return loadPrefs().variants[keyOf(selection)]
}

/**
 * Fallback chain: last used model, else the built-in free default, else the
 * top of the sorted catalog.
 */
export function defaultSelection(): ModelSelection | null {
  const prefs = loadPrefs()
  for (const candidate of prefs.recent) {
    if (isValid(candidate)) {
      const variant = variantFor(candidate)
      return variant === undefined ? candidate : { ...candidate, variant }
    }
  }
  if (isValid(DEFAULT_MODEL)) {
    const variant = variantFor(DEFAULT_MODEL)
    return variant === undefined ? { ...DEFAULT_MODEL } : { ...DEFAULT_MODEL, variant }
  }
  for (const provider of providers()) {
    const [model] = sortModels(provider.models)
    if (model) {
      const base = { providerID: provider.id, modelID: model.id }
      const variant = variantFor(base)
      return variant === undefined ? base : { ...base, variant }
    }
  }
  return null
}

/** Label pieces for the composer: `model · provider`. */
export function selectionLabel(selection: ModelSelection): string {
  const found = findModel(selection)
  return found ? found.model.name : selection.modelID
}

export function providerLabel(selection: ModelSelection): string {
  const found = findModel(selection)
  return found ? found.provider.name : selection.providerID
}
