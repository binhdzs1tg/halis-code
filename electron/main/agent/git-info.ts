/**
 * Git state for the environment context: the branch and short commit of the open workspace, captured
 * with bounded parallel calls and cached so the agent loop does not shell
 * out to git on every turn. Pure Node so the smoke tests can run it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** How long a captured snapshot stays fresh. */
const CACHE_TTL_MS = 60_000

/** Git is given this long before the snapshot gives up. */
const GIT_TIMEOUT_MS = 5_000

export interface GitInfo {
  branch: string
  /** Short commit hash. */
  commit: string
}

interface CacheEntry {
  at: number
  info: GitInfo | null
}

const cache = new Map<string, CacheEntry>()

/** Test seam: drop the cached snapshots. */
export function clearGitInfoCache(): void {
  cache.clear()
}

async function git(args: string[], root: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true
    })
    const value = stdout.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Branch and short commit of the repository at `root`, or null outside one. */
export async function getGitInfo(root: string): Promise<GitInfo | null> {
  const cached = cache.get(root)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.info
  const [branch, commit] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    git(['rev-parse', '--short', 'HEAD'], root)
  ])
  // A detached HEAD reports as "HEAD" — noise, not information.
  const info = branch && commit && branch !== 'HEAD' ? { branch, commit } : null
  cache.set(root, { at: Date.now(), info })
  return info
}
