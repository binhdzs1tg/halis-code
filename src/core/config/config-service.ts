const STORAGE_KEY = 'halis.config'

export interface HalisConfig {
  lastWorkspace: string | null
}

/**
 * Minimal app config persisted in localStorage.
 * Model credentials / API keys are intentionally NOT handled here yet;
 * they will live in a dedicated secure store in a later phase.
 */
export function loadConfig(): HalisConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { lastWorkspace: null }
    }
    const parsed = JSON.parse(raw) as Partial<HalisConfig>
    return {
      lastWorkspace: typeof parsed.lastWorkspace === 'string' ? parsed.lastWorkspace : null
    }
  } catch {
    return { lastWorkspace: null }
  }
}

export function saveConfig(patch: Partial<HalisConfig>): void {
  const next = { ...loadConfig(), ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (err) {
    // Quota or privacy mode: the app keeps running on the in-memory value,
    // only the "last workspace" convenience is lost.
    console.warn('config: could not persist', err)
  }
}
