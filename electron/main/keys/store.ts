import { BrowserWindow, app, safeStorage } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
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
/** Set when the store could not be parsed/read and its bytes are not yet safe. */
let blocked = false
/** All persists queue behind each other: interleaved writes on one path can tear. */
let persistQueue: Promise<void> = Promise.resolve()

export interface ResolvedKey {
  value: string
  source: 'user' | 'env'
  envVar?: string
}

function keysPath(): string {
  return path.join(app.getPath('userData'), KEYS_FILE)
}

function freshFile(): KeyFile {
  // Null prototype: a renderer-supplied provider id like "__proto__" must
  // never reach the object's prototype slot.
  return Object.create(null) as KeyFile
}

async function load(): Promise<KeyFile> {
  if (cache) return cache
  let raw: string
  try {
    raw = await readFile(keysPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First run; nothing stored yet.
      cache = freshFile()
      return cache
    }
    // Unreadable for another reason (permissions, IO): start empty but
    // refuse to persist — writing would replace every stored key with the
    // one new entry and the originals would be gone.
    console.warn('keys: could not read the key store; saving new keys stays blocked until it can be read', err)
    blocked = true
    cache = freshFile()
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as KeyFile
    cache = freshFile()
    for (const [providerId, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.value === 'string') {
        cache[providerId] = { value: entry.value, encrypted: Boolean(entry.encrypted) }
      }
    }
    blocked = false
  } catch (err) {
    // Corrupt store (torn write after a force-quit): quarantine the bytes
    // so the next persist cannot silently destroy them, then start empty.
    const quarantine = `${keysPath()}.corrupt-${Date.now()}`
    console.warn(`keys: the key store is not valid JSON — moved aside to ${quarantine}`, err)
    cache = freshFile()
    blocked = true
    try {
      await rename(keysPath(), quarantine)
      blocked = false
    } catch (err) {
      // A second racing load() may have quarantined it first — that counts
      // as success; anything else keeps persist blocked rather than overwrite.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') blocked = false
    }
  }
  return cache
}

async function persist(): Promise<void> {
  if (blocked) {
    throw new Error(
      'The stored key file could not be read; fix or remove provider-keys.json before saving new keys.'
    )
  }
  const file = keysPath()
  const run = persistQueue.then(async () => {
    // Atomic replace: a crash mid-write must not leave torn JSON behind —
    // that is exactly the corruption this store has to survive.
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify({ ...cache }, null, 2), { mode: 0o600 })
    await rename(tmp, file)
  })
  persistQueue = run.catch(() => undefined)
  await run
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
