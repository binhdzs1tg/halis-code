/**
 * Grep tool, ported from opencode's and the harness's grep: regular
 * expression or literal search over file contents with an include filter.
 * Upstreams delegate to ripgrep; this port reuses the app's walker and plain
 * RegExp so no binary ships with the app.
 */
import fs from 'node:fs'
import path from 'node:path'
import { BINARY_EXTENSIONS, resolveInWorkspace, SKIP_DIRS } from '../workspace'
import { matchGlob } from './glob'
import type { ToolOutcome } from './tools'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_FILE_SIZE = 512 * 1024
const MAX_LINE_PREVIEW = 240

/* ---------- pattern helpers (pure; unit-tested in smoke.ts) ---------- */

export interface GrepOptions {
  literal: boolean
  caseSensitive: boolean
}

/**
 * Compile the model's pattern into a line RegExp. Literal patterns are
 * escaped so metacharacters match themselves, and invalid regexes surface
 * as a readable error the model can act on — the harness's
 * SEARCH_INVALID_PATTERN discipline.
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

export function grepWorkspace(
  pattern: string,
  options: { scope?: string; include?: string; literal?: boolean; caseSensitive?: boolean; limit?: number } = {}
): GrepResult {
  const scope = options.scope ?? ''
  const root = resolveInWorkspace(scope)
  const regex = compileLineRegex(pattern, {
    literal: options.literal ?? false,
    caseSensitive: options.caseSensitive ?? true
  })
  const include = options.include?.trim() || null
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)
  const hits: GrepHit[] = []
  let truncated = false

  // A file target scans just that file, like pointing rg at one path.
  let rootStat: fs.Stats
  try {
    rootStat = fs.statSync(root)
  } catch {
    throw new Error(`"${scope}" does not exist in the workspace.`)
  }
  if (rootStat.isFile()) {
    const relFromRoot = scope
    if (!include || matchesInclude(include, path.basename(relFromRoot))) {
      truncated = !scanFile(root, relFromRoot, regex, hits, limit)
    }
    return { hits, truncated }
  }

  const walk = (dir: string, rel: string): void => {
    if (truncated) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
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
      if (!scanFile(childAbs, childRel, regex, hits, limit)) {
        truncated = true
        return
      }
    }
  }
  walk(root, scope)
  return { hits, truncated }
}

/**
 * Scan one file; returns false when the hit budget filled up. Binary in
 * disguise (NUL byte) reads as no matches — same test the search tool uses.
 */
function scanFile(abs: string, rel: string, regex: RegExp, hits: GrepHit[], limit: number): boolean {
  let text: string
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    return true
  }
  if (text.includes('\u0000')) return true
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined || !regex.test(line)) continue
    if (hits.length >= limit) {
      return false
    }
    hits.push({ path: rel, line: i + 1, text: line.trim().slice(0, MAX_LINE_PREVIEW) })
  }
  return true
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

export function grepTool(input: Record<string, unknown>): ToolOutcome {
  const pattern = requirePattern(input.pattern)
  const scope = typeof input.path === 'string' && input.path.length > 0 ? input.path : ''
  const include = typeof input.include === 'string' && input.include.trim().length > 0 ? input.include : null
  if (include) {
    validateInclude(include)
  }
  if (scope && BINARY_EXTENSIONS.has(path.extname(scope).toLowerCase())) {
    throw new Error(`"${scope}" is a binary file; grep searches text only.`)
  }
  const { hits, truncated } = grepWorkspace(pattern, {
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
  // twelve repeated paths — the harness's format.
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
