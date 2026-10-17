/**
 * Grep tool: regular expression or literal search over file contents with
 * an include filter. The scan reuses the app's walker and plain RegExp so
 * no extra binary ships with the app. The scan itself runs in a worker
 * thread: the model can send any pattern, and a catastrophic-backtracking
 * regex must be terminable instead of freezing the main process.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { BINARY_EXTENSIONS, resolveInWorkspace, SKIP_DIRS } from '../workspace'
import { matchGlob } from './glob'
import type { ToolOutcome } from './tools'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_FILE_SIZE = 512 * 1024
const MAX_LINE_PREVIEW = 240
/** A file that takes longer than this to scan abandons the search, partial results intact. */
const SCAN_IDLE_TIMEOUT_MS = 5_000

/* ---------- pattern helpers (pure; unit-tested in smoke.ts) ---------- */

export interface GrepOptions {
  literal: boolean
  caseSensitive: boolean
}

/**
 * Compile the model's pattern into a line RegExp. Literal patterns are
 * escaped so metacharacters match themselves, and invalid regexes surface
 * as a readable error the model can act on.
 */
export function compileLineRegex(pattern: string, options: GrepOptions): RegExp {
  const body = options.literal ? escapeRegex(pattern) : pattern
  try {
    return new RegExp(body, options.caseSensitive ? '' : 'i')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Invalid regular expression: ${detail}. Pass literal=true to match the text as-is.`
    )
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a file path passes the include filter. A filter without a slash
 * matches the file name at any depth (gitignore-style, like ripgrep's
 * --glob); with a slash it matches the whole relative path.
 */
export function matchesInclude(include: string, relPath: string): boolean {
  if (include.includes('/')) {
    return matchGlob(include, relPath)
  }
  const base = relPath.split('/').pop() ?? relPath
  return matchGlob(include, base)
}

/** Validate the include filter: one positive glob, no lists, no negation. */
export function validateInclude(include: string): void {
  const trimmed = include.trim()
  if (trimmed.startsWith('!')) {
    throw new Error('Parameter "include" cannot be a negated glob; run the search and read the matches instead.')
  }
  if (trimmed.includes(',')) {
    throw new Error('Parameter "include" takes a single glob such as "*.ts"; chain searches to combine filters.')
  }
}

/* ---------- walking ---------- */

export interface GrepHit {
  path: string
  line: number
  text: string
}

export interface GrepResult {
  hits: GrepHit[]
  truncated: boolean
}

export async function grepWorkspace(
  pattern: string,
  options: { scope?: string; include?: string; literal?: boolean; caseSensitive?: boolean; limit?: number } = {}
): Promise<GrepResult> {
  // A trailing separator would glue into 'src//a.ts' paths and break the
  // include filter; normalize once, here.
  const scope = (options.scope ?? '').replace(/\/+$/, '')
  const root = resolveInWorkspace(scope)
  const regex = compileLineRegex(pattern, {
    literal: options.literal ?? false,
    caseSensitive: options.caseSensitive ?? true
  })
  const include = options.include?.trim() || null
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)

  // A file target scans just that file, like pointing rg at one path.
  let rootStat: fs.Stats
  try {
    rootStat = fs.statSync(root)
  } catch {
    throw new Error(`"${scope}" does not exist in the workspace.`)
  }
  if (rootStat.isFile()) {
    if (include && !matchesInclude(include, path.basename(scope))) {
      return { hits: [], truncated: false }
    }
    const outcome = await scanWithWorker([{ abs: root, rel: scope }], regex, limit)
    return { hits: outcome.hits, truncated: outcome.truncated || outcome.stopped }
  }

  const targets: Array<{ abs: string; rel: string }> = []
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const childAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(childAbs, childRel)
        continue
      }
      if (!entry.isFile() || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      // Include globs are relative to the search root, the way ripgrep
      // resolves them — "src/**" means the scope's src, not the workspace's.
      const includeRel = scope ? childRel.slice(scope.length + 1) : childRel
      if (include && !matchesInclude(include, includeRel)) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(childAbs)
      } catch {
        continue
      }
      if (stat.size > MAX_FILE_SIZE) continue
      targets.push({ abs: childAbs, rel: childRel })
    }
  }
  walk(root, scope)
  const outcome = await scanWithWorker(targets, regex, limit)
  return { hits: outcome.hits, truncated: outcome.truncated || outcome.stopped }
}

/** The scan runs out-of-process: the pattern is model input, and a
 *  catastrophic-backtracking regex must be terminable, not a freeze. The
 *  worker reports per file, so a timeout keeps the hits gathered so far. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
parentPort.on('message', (job) => {
  const regex = new RegExp(job.pattern, job.flags)
  for (const target of job.targets) {
    const hits = []
    try {
      const text = readFileSync(target.abs, 'utf8')
      if (!text.includes('\\u0000')) {
        const lines = text.split('\\n')
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]
          if (line !== undefined && regex.test(line)) {
            hits.push({ path: target.rel, line: i + 1, text: line.trim().slice(0, ${MAX_LINE_PREVIEW}) })
          }
        }
      }
    } catch {
      // unreadable file: no hits
    }
    parentPort.postMessage({ hits })
  }
  parentPort.postMessage({ done: true })
})
`

interface WorkerScanOutcome {
  hits: GrepHit[]
  truncated: boolean
  stopped: boolean
}

async function scanWithWorker(
  targets: Array<{ abs: string; rel: string }>,
  regex: RegExp,
  limit: number
): Promise<WorkerScanOutcome> {
  if (targets.length === 0) return { hits: [], truncated: false, stopped: false }
  return await new Promise<WorkerScanOutcome>((resolve) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true })
    const hits: GrepHit[] = []
    let truncated = false
    let settled = false
    const settle = (stopped: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      void worker.terminate()
      resolve({ hits, truncated, stopped })
    }
    let idle = setTimeout(() => settle(true), SCAN_IDLE_TIMEOUT_MS)
    const resetIdle = (): void => {
      clearTimeout(idle)
      idle = setTimeout(() => settle(true), SCAN_IDLE_TIMEOUT_MS)
    }
    worker.on('message', (message: { hits?: GrepHit[]; done?: boolean }) => {
      resetIdle()
      if (message.done) {
        settle(false)
        return
      }
      for (const hit of message.hits ?? []) {
        if (hits.length >= limit) {
          truncated = true
          settle(false)
          return
        }
        hits.push(hit)
      }
    })
    worker.on('error', () => settle(true))
    worker.on('messageerror', () => settle(true))
    void worker.postMessage({
      pattern: regex.source,
      flags: regex.flags,
      targets: targets.map((target) => ({ abs: target.abs, rel: target.rel }))
    })
  })
}

/* ---------- tool ---------- */

export const GREP_TOOL_SPEC = {
  name: 'grep',
  description:
    'Search file contents with a regular expression (or literal text with ' +
    'literal=true), optionally filtered by an include glob such as "*.ts". ' +
    'Returns matches grouped per file as "line N: text". Case-sensitive by ' +
    'default; use case_sensitive=false to ignore case. For plain-text finds ' +
    'the search tool is the lighter option.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to match on each line (or literal text with literal=true)' },
      path: { type: 'string', description: 'Folder or file to search in, relative to the workspace root. Defaults to the whole workspace.' },
      include: { type: 'string', description: 'Single glob filter for file paths, e.g. "*.ts" or "src/**/*.json"' },
      literal: { type: 'boolean', description: 'Match the pattern as plain text instead of a regular expression (default false)' },
      case_sensitive: { type: 'boolean', description: 'Match case exactly (default true)' },
      limit: { type: 'integer', description: `Maximum number of matching lines to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` }
    },
    required: ['pattern']
  }
} as const

export async function grepTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const pattern = requirePattern(input.pattern)
  const scope = typeof input.path === 'string' && input.path.length > 0 ? input.path : ''
  const include = typeof input.include === 'string' && input.include.trim().length > 0 ? input.include : null
  if (include) {
    validateInclude(include)
  }
  if (scope && BINARY_EXTENSIONS.has(path.extname(scope).toLowerCase())) {
    throw new Error(`"${scope}" is a binary file; grep searches text only.`)
  }
  const { hits, truncated } = await grepWorkspace(pattern, {
    scope,
    ...(include ? { include } : {}),
    literal: input.literal === true,
    caseSensitive: input.case_sensitive !== false,
    limit: clampInt(input.limit, DEFAULT_LIMIT, MAX_LIMIT)
  })
  if (hits.length === 0) {
    return { ok: true, output: `No matches for /${pattern}/${scope ? ` in ${scope}` : ''}.` }
  }
  // Grouped by file so a dozen hits in one file read as one block, not
  // twelve repeated paths.
  const blocks: string[] = []
  let currentPath = ''
  for (const hit of hits) {
    if (hit.path !== currentPath) {
      currentPath = hit.path
      blocks.push(currentPath)
    }
    blocks.push(`  line ${hit.line}: ${hit.text}`)
  }
  let output = `${hits.length} match${hits.length === 1 ? '' : 'es'} for /${pattern}/:\n${blocks.join('\n')}`
  if (truncated) {
    output += '\n… (result list capped — narrow the pattern, the scope or the include filter)'
  }
  return { ok: true, output }
}

function requirePattern(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Parameter "pattern" must be a non-empty string.')
  }
  return value.trim()
}

function clampInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(value)))
}
