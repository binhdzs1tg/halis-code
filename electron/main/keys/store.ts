import { BrowserWindow, app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { IpcChannel } from '../../shared/ipc-channels'
import type { ProviderKeyStatus, ProviderKeyStatuses } from '../../shared/types'
import type { ProviderEntry } from '../../shared/models'

const KEYS_FILE = 'provider-keys.json'

interface StoredKey {
  /** base64 payload, ciphertext when `encrypted` is true. */
  value: string
  encrypted: boolean
}

type KeyFile = Record<string, StoredKey>

let cache: KeyFile | null = null

export interface ResolvedKey {
  value: string
  source: 'user' | 'env'
  envVar?: string
}

function keysPath(): string {
  return path.join(app.getPath('userData'), KEYS_FILE)
}

async function load(): Promise<KeyFile> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await readFile(keysPath(), 'utf8')) as KeyFile
    // Null prototype: a renderer-supplied provider id like "__proto__" must
    // never reach the object's prototype slot.
    cache = Object.create(null) as KeyFile
    for (const [providerId, entry] of Object.entries(raw)) {
      if (entry && typeof entry.value === 'string') {
        cache[providerId] = { value: entry.value, encrypted: Boolean(entry.encrypted) }
      }
    }
  } catch {
    cache = Object.create(null) as KeyFile
  }
  return cache
}

async function persist(): Promise<void> {
  const file = keysPath()
  await writeFile(file, JSON.stringify({ ...cache }, null, 2), { mode: 0o600 })
  broadcast()
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.KeysChanged)
    }
  }
}

function decode(entry: StoredKey): string | null {
  try {
    const buffer = Buffer.from(entry.value, 'base64')
    return entry.encrypted ? safeStorage.decryptString(buffer) : buffer.toString('utf8')
  } catch {
    // Ciphertext from another OS keychain or a wiped store; drop it.
    return null
  }
}

/** Look up the env var the provider documents for its key, e.g. ANTHROPIC_API_KEY. */
function fromEnv(provider: ProviderEntry): ResolvedKey | null {
  for (const name of provider.env) {
    const value = process.env[name]
    if (value && value.trim()) {
      return { value: value.trim(), source: 'env', envVar: name }
    }
  }
  return null
}

/**
 * Key resolution for a provider: a vault entry wins over the environment so
 * users can override a stale env var without leaving the app.
 */
export async function resolve(provider: ProviderEntry): Promise<ResolvedKey | null> {
  const stored = (await load())[provider.id]
  if (stored) {
    const value = decode(stored)
    if (value) return { value, source: 'user' }
  }
  return fromEnv(provider)
}

/** Status map for the renderer; only providers with a usable key are listed. */
export async function statuses(providers: ProviderEntry[]): Promise<ProviderKeyStatuses> {
  const out: ProviderKeyStatuses = {}
  for (const provider of providers) {
    const resolved = await resolve(provider)
    if (resolved) {
      const status: ProviderKeyStatus = { source: resolved.source }
      if (resolved.envVar) status.envVar = resolved.envVar
      out[provider.id] = status
    }
  }
  return out
}

export async function set(providerId: string, value: string): Promise<void> {
  const trimmed = value.trim()
  const file = await load()
  if (!trimmed) {
    delete file[providerId]
  } else if (safeStorage.isEncryptionAvailable()) {
    file[providerId] = {
      value: safeStorage.encryptString(trimmed).toString('base64'),
      encrypted: true
    }
  } else {
    // No OS keychain (common on bare Linux); fall back to a plaintext file
    // with owner-only permissions rather than refusing to work.
    file[providerId] = {
      value: Buffer.from(trimmed, 'utf8').toString('base64'),
      encrypted: false
    }
  }
  await persist()
}

export async function remove(providerId: string): Promise<void> {
  const file = await load()
  delete file[providerId]
  await persist()
}
