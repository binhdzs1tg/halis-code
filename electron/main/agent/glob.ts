/**
 * Glob tool: find files by pattern instead of content. The walk reuses the
 * SKIP_DIRS discipline the rest of the app already uses, so nothing extra
 * has to ship with the app.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveInWorkspace, SKIP_DIRS } from '../workspace'
import type { ToolOutcome } from './tools'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
/** Walk guard for pathological trees; beyond this the pattern is the problem. */
const MAX_VISITED = 50_000
/** `{a,b,{c,d}}` can explode combinatorially; stop well short of that. */
const MAX_EXPANSION = 64

/* ---------- pattern matching (pure; unit-tested in smoke.ts) ---------- */

/**
 * Expand `{a,b}` alternatives into plain patterns. Nested braces expand
 * recursively; a pattern without braces comes back as itself.
 */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  let depth = 0
  let close = -1
  for (let i = open; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return [pattern]
  const body = pattern.slice(open + 1, close)
  const head = pattern.slice(0, open)
  const tail = pattern.slice(close + 1)
  const out: string[] = []
  for (const alternative of splitTopLevel(body)) {
    for (const rest of expandBraces(`${head}${alternative}${tail}`)) {
      out.push(rest)
      if (out.length > MAX_EXPANSION) return out.slice(0, MAX_EXPANSION)
    }
  }
  return out
}

/** Split on commas that are not inside a nested brace pair. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of body) {
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

/**
 * Compile one brace-free glob into a RegExp over workspace-relative paths.
 * `*` and `?` stay inside a single segment; a whole `**` segment spans any
 * number of directories, and a trailing slash reads as "everything below".
 */
export function globToRegExp(pattern: string): RegExp {
  let normalized = pattern.replace(/\/+$/, '')
  if (normalized === '') normalized = '**'
  else if (normalized !== pattern) normalized += '/**'
  const segments = normalized.split('/')
  let source = '^'
  // A `**` owns its separators: it carries the slash before it (unless it
  // leads or follows another `**`) and swallows the one after it, so
  // `**/*.ts` still matches a root-level `main.ts`.
  let afterDoubleStar = false
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      const lead = index > 0 && !afterDoubleStar ? '/' : ''
      if (last) {
        source += `${lead}[^/]+(?:/[^/]+)*`
      } else {
        source += `${lead}(?:[^/]+/)*`
        afterDoubleStar = true
      }
      return
    }
    if (index > 0 && !afterDoubleStar) source += '/'
    afterDoubleStar = false
    // A literal segment: escape regex specials, then let the escaped
    // wildcards back in as path-safe classes.
    const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    source += escaped.replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '[^/]')
  })
  return new RegExp(`${source}$`)
}

/** True when a path relative to the search root matches the pattern. */
export function matchGlob(pattern: string, relPath: string): boolean {
  return expandBraces(pattern).some((candidate) => globToRegExp(candidate).test(relPath))
}

/* ---------- walking ---------- */

export interface GlobResult {
  paths: string[]
  truncated: boolean
}

/**
 * Every file under the scope that matches, newest first. The mtime sort
 * puts the file the user touched last first — the one the model most
 * likely wants. The whole tree is walked
 * (bounded by MAX_VISITED) so the limit keeps the newest N, not the first
 * N in walk order.
 */
export function globFiles(pattern: string, scope: string, limit: number): GlobResult {
  const root = resolveInWorkspace(scope)
  // A trailing separator would glue into 'src//a.ts' downstream; drop it once, here.
  const normalizedScope = scope.replace(/\/+$/, '')
  const regexes = expandBraces(pattern).map((candidate) => globToRegExp(candidate))
  const hits: { rel: string; mtime: number }[] = []
  let visited = 0

  const walk = (dir: string, rel: string): void => {
    if (visited > MAX_VISITED) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited > MAX_VISITED) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const childAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(childAbs, childRel)
        continue
      }
      if (!entry.isFile()) continue
      visited += 1
      // The pattern is relative to the search folder: with a scope, the
      // scope-relative remainder matches too ('*.ts' finds src/a.ts).
      const remainder =
        normalizedScope && childRel.startsWith(`${normalizedScope}/`)
          ? childRel.slice(normalizedScope.length + 1)
          : childRel
      if (!regexes.some((regex) => regex.test(childRel) || regex.test(remainder))) continue
      let mtime = 0
      try {
        mtime = fs.statSync(childAbs).mtimeMs
      } catch {
        // Unreadable stat still matches; it just sorts as the oldest.
      }
      hits.push({ rel: childRel, mtime })
    }
  }
  walk(root, normalizedScope)

  hits.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel))
  const truncated = hits.length > limit
  return { paths: hits.slice(0, limit).map((hit) => hit.rel), truncated }
}

/* ---------- tool ---------- */

export const GLOB_TOOL_SPEC = {
  name: 'glob',
  description:
    'Find files by glob pattern instead of content: * and ? match within one ' +
    'segment, ** spans directories, and {a,b} alternates. Results are workspace ' +
    'paths sorted newest first; dotfiles and dependency folders are skipped.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Pattern relative to the search folder, e.g. "**/*.ts" or "src/{lib,cmd}/*.go"'
      },
      path: {
        type: 'string',
        description: 'Folder to search in, relative to the workspace root. Defaults to the whole workspace.'
      },
      limit: { type: 'integer', description: `Maximum number of paths to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` }
    },
    required: ['pattern']
  }
} as const

export function globTool(input: Record<string, unknown>): ToolOutcome {
  const pattern = requirePattern(input.pattern)
  const scope = typeof input.path === 'string' && input.path.length > 0 ? input.path : ''
  const limit = clampInt(input.limit, DEFAULT_LIMIT, MAX_LIMIT)
  const { paths, truncated } = globFiles(pattern, scope, limit)
  if (paths.length === 0) {
    return { ok: true, output: `No files match "${pattern}"${scope ? ` in ${scope}` : ''}.` }
  }
  let output = `${paths.length} file${paths.length === 1 ? '' : 's'} matching "${pattern}":\n${paths.join('\n')}`
  if (truncated) {
    output += `\n… (result list capped at ${limit} — narrow the pattern or the scope)`
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
