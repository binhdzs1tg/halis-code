/**
 * Read-before-mutate observation policy, ported from DeepSeek Harness's
 * fs-observation-policy: the model must have read a file in this app
 * session before it may edit or overwrite it, and the edit carries the
 * observed version as a compare-and-swap basis — a file that changed on
 * disk since the read fails with a remedy instead of silently clobbering
 * the new content. Pure fs logic, smoke-tested in plain Node.
 */
import fs from 'node:fs'
import { getWorkspaceRoot } from '../workspace'

interface Observation {
  mtimeMs: number
  size: number
}

/** Keyed by absolute path; observations are per workspace and per session. */
let observations = new Map<string, Observation>()
let observedRoot: string | null = null

/** Swap in fresh state — also the seam the smoke tests use. */
export function resetObservations(): void {
  observations = new Map()
  observedRoot = getWorkspaceRoot()
}

/**
 * Observations never outlive their workspace: switching folders starts a
 * clean slate so paths from one project cannot authorize edits in another.
 */
function syncRoot(): void {
  const root = getWorkspaceRoot()
  if (root !== observedRoot) {
    observations = new Map()
    observedRoot = root
  }
}

function snapshot(target: string): Observation | null {
  try {
    const stat = fs.statSync(target)
    if (!stat.isFile()) return null
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

/** Record an authoritative read: this is what the model has actually seen. */
export function observeRead(target: string): void {
  syncRoot()
  const stat = snapshot(target)
  if (stat) observations.set(target, stat)
  else observations.delete(target)
}

/** Record the version a write just produced, so follow-up edits pass. */
export function recordWrite(target: string): void {
  syncRoot()
  observeRead(target)
}

/**
 * The edit gate. Throws with the remediation the model needs when the file
 * was never read in this session, or when it changed on disk since. A file
 * that does not exist is a create and sails through.
 */
export function assertEditable(target: string, displayPath: string): void {
  syncRoot()
  const current = snapshot(target)
  if (!current) return
  const observed = observations.get(target)
  if (!observed) {
    throw new Error(`cannot modify "${displayPath}" — read the file first, then retry`)
  }
  if (observed.mtimeMs !== current.mtimeMs || observed.size !== current.size) {
    throw new Error(
      `"${displayPath}" changed on disk since it was read — re-read the file, then retry the edit`
    )
  }
}
