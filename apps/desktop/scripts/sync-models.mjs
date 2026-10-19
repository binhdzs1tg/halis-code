/**
 * Regenerate the bundled models.dev snapshot.
 *
 * Fetches the public catalog from https://models.dev/api.json, validates it
 * has enough real providers to be genuine, and writes it as the snapshot the
 * main process ships as its offline floor. Run with `npm run sync-models`.
 */
import { rename, unlink, writeFile } from 'node:fs/promises'

const SOURCE_URL = 'https://models.dev/api.json'
const TARGET = 'electron/main/models-dev/snapshot.json'
const MIN_PROVIDERS = 100

try {
  const response = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'halis-code-sync' },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    console.error(`models.dev returned ${response.status}`)
    process.exit(1)
  }

  const catalog = await response.json()
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    console.error('catalog is not a JSON object, keeping the current snapshot')
    process.exit(1)
  }
  // Count providers the app would actually keep: a string or array of the
  // right size passes a key count while yielding zero usable providers.
  const providers = Object.values(catalog).filter(
    (provider) => provider && typeof provider === 'object' && provider.id && provider.models
  )
  if (providers.length < MIN_PROVIDERS) {
    console.error(`catalog looks truncated (${providers.length} usable providers), keeping the current snapshot`)
    process.exit(1)
  }

  const payload = `${JSON.stringify(catalog)}\n`
  // Write through a temp file: a crash or full disk mid-write must not leave
  // a half-written snapshot as the committed offline floor.
  const temp = `${TARGET}.tmp`
  try {
    await writeFile(temp, payload)
    await rename(temp, TARGET)
  } catch (err) {
    await unlink(temp).catch(() => {})
    throw err
  }
  const models = providers.reduce((total, provider) => total + Object.keys(provider.models ?? {}).length, 0)
  console.log(`snapshot updated: ${providers.length} providers, ${models} models -> ${TARGET}`)
} catch (err) {
  console.error(`sync failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
