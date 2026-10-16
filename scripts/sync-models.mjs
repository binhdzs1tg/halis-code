/**
 * Regenerate the bundled models.dev snapshot.
 *
 * Fetches the public catalog from https://models.dev/api.json, validates it
 * has enough providers to be real, and writes it as the snapshot the main
 * process ships as its offline floor. Run with `npm run sync-models`.
 */
import { writeFile } from 'node:fs/promises'

const SOURCE_URL = 'https://models.dev/api.json'
const TARGET = 'electron/main/models-dev/snapshot.json'
const MIN_PROVIDERS = 100

const response = await fetch(SOURCE_URL, {
  headers: { 'User-Agent': 'halis-code-sync' },
  signal: AbortSignal.timeout(30_000)
})
if (!response.ok) {
  console.error(`models.dev returned ${response.status}`)
  process.exit(1)
}

const catalog = await response.json()
const providers = Object.keys(catalog ?? {})
if (providers.length < MIN_PROVIDERS) {
  console.error(`catalog looks truncated (${providers.length} providers), keeping the current snapshot`)
  process.exit(1)
}

const payload = `${JSON.stringify(catalog)}\n`
await writeFile(TARGET, payload)
const models = Object.values(catalog).reduce((total, provider) => total + Object.keys(provider.models ?? {}).length, 0)
console.log(`snapshot updated: ${providers.length} providers, ${models} models -> ${TARGET}`)
