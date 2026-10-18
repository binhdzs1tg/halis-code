import path from 'node:path'
import fs from 'node:fs'
import type { SearchHit, SearchResponse, WorkspaceEntry, WorkspaceEntryKind } from '../shared/types'

let workspaceRoot: string | null = null

const IGNORED = new Set(['node_modules', '.git', 'dist', 'out'])

/** Shared with the agent tools and the search endpoint. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.next', '.cache', 'target'
])

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tgz',
  '.tar', '.7z', '.wasm', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.mp3', '.mp4', '.wav', '.ogg', '.avi', '.mov', '.sqlite', '.db', '.lock'
])

export function getWorkspaceRoot(): string | null {
  return workspaceRoot
}

export function setWorkspaceRoot(root: string | null): void {
  workspaceRoot = root
}

/** Resolve a workspace-relative path and make sure it stays inside the root. */
export function resolveInWorkspace(relPath: string): string {
  if (!workspaceRoot) {
    throw new Error('No workspace open')
  }
  const target = path.resolve(workspaceRoot, relPath)
  const prefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep
  if (target !== workspaceRoot && !target.startsWith(prefix)) {
    throw new Error('Path escapes the workspace')
  }
  // The lexical check stops `..`; symlinks need the real path. Probe the
  // deepest existing ancestor so `link/newfile` (link -> /etc) is caught too.
  const real = realPathDeepest(target)
  const root = realPathDeepest(workspaceRoot)
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep
  if (real !== root && real !== workspaceRoot && !real.startsWith(rootPrefix)) {
    throw new Error('Path escapes the workspace')
  }
  // The ancestor probe cannot see a symlink in the final component: a
  // dangling link dereferences on first write. Check the leaf explicitly.
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      let leaf: string
      try {
        leaf = fs.realpathSync(target)
      } catch {
        // The link dangles; resolve what it points at from its real parent,
        // following chained links a bounded number of times.
        leaf = path.resolve(fs.realpathSync(path.dirname(target)), fs.readlinkSync(target))
        for (let hops = 0; hops < 8; hops += 1) {
          let next: string
          try {
            next = fs.readlinkSync(leaf)
          } catch {
            break
          }
          leaf = path.resolve(path.dirname(leaf), next)
        }
      }
      if (leaf !== root && leaf !== workspaceRoot && !leaf.startsWith(rootPrefix)) {
        throw new Error('Path escapes the workspace')
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Path escapes the workspace') throw err
    // Does not exist (yet), or is unreadable: write/create paths proceed.
  }
  return target
}

/** realpath of the deepest existing ancestor; falls back to the input. */
function realPathDeepest(target: string): string {
  let probe = target
  for (;;) {
    try {
      const real = fs.realpathSync(probe)
      // Re-attach the part below the existing ancestor.
      return probe === target ? real : real + target.slice(probe.length)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return target
      probe = parent
    }
  }
}

export function openWorkspaceByPath(absolutePath: string): string | null {
  if (typeof absolutePath !== 'string' || absolutePath.trim().length === 0) {
    return null
  }
  try {
    const resolved = path.resolve(absolutePath)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      workspaceRoot = resolved
      return resolved
    }
  } catch {
    // fall through
  }
  return null
}

export function listDir(relPath: string): WorkspaceEntry[] {
  const target = resolveInWorkspace(relPath)
  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => !IGNORED.has(entry.name) && !entry.name.startsWith('.'))
    .map<WorkspaceEntry>((entry) => ({
      name: entry.name,
      path: relPath ? `${relPath}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file'
    }))

  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

const MAX_READ_SIZE = 1024 * 1024

export function readFileContent(relPath: string): string {
  const target = resolveInWorkspace(relPath)
  const stat = fs.statSync(target)
  if (!stat.isFile()) {
    throw new Error('Not a regular file')
  }
  if (stat.size > MAX_READ_SIZE) {
    throw new Error('File is too large to preview (max 1 MB)')
  }
  const content = fs.readFileSync(target, 'utf8')
  // Same binary test the search and file-reference paths use: NUL bytes
  // never appear in text worth previewing, and decoding them as utf8
  // only produces mojibake for the editor and the model.
  if (content.includes('\u0000')) {
    throw new Error('This file looks binary and cannot be previewed as text')
  }
  return content
}

/** Read cap, mirrored on write so a runaway renderer cannot stream a
 *  gigabyte string into the main process or fill the disk in one call. */
const MAX_WRITE_CHARS = 4 * 1024 * 1024

/** Create missing parents and write a file inside the workspace. */
export function writeFileContent(relPath: string, content: string): void {
  if (content.length > MAX_WRITE_CHARS) {
    throw new Error(`Refusing to write ${content.length} characters — the editor caps writes at ${MAX_WRITE_CHARS}.`)
  }
  const target = resolveInWorkspace(relPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

/** Create an empty file or a folder (with parents) inside the workspace. */
export function createEntry(relPath: string, kind: WorkspaceEntryKind): void {
  const target = resolveInWorkspace(relPath)
  if (fs.existsSync(target)) {
    throw new Error(`"${relPath}" already exists`)
  }
  if (kind === 'directory') {
    fs.mkdirSync(target, { recursive: true })
    return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '', 'utf8')
}

export function renameEntry(from: string, to: string): void {
  const source = resolveInWorkspace(from)
  const target = resolveInWorkspace(to)
  if (!fs.existsSync(source)) {
    throw new Error(`"${from}" does not exist`)
  }
  if (fs.existsSync(target)) {
    throw new Error(`"${to}" already exists`)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(source, target)
}

/** Validate a delete target and return its absolute path for the caller to trash. */
export function resolveForDelete(relPath: string): string {
  const target = resolveInWorkspace(relPath)
  if (!workspaceRoot || target === workspaceRoot) {
    throw new Error('The workspace root cannot be deleted')
  }
  if (!fs.existsSync(target)) {
    throw new Error(`"${relPath}" does not exist`)
  }
  return target
}

/* ---------- workspace search ---------- */

const MAX_SEARCH_HITS = 200
const MAX_SEARCH_FILE_SIZE = 512 * 1024
const MAX_SEARCH_DEPTH = 12

export function searchWorkspace(
  query: string,
  options: { scope?: string; caseSensitive?: boolean } = {}
): SearchResponse {
  // A trailing separator would glue into 'src//a.ts' paths downstream.
  const scope = (options.scope ?? '').replace(/\/+$/, '')
  const caseSensitive = options.caseSensitive ?? false
  const root = resolveInWorkspace(scope)
  const needle = caseSensitive ? query : query.toLowerCase()

  const hits: SearchHit[] = []
  let truncated = false

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > MAX_SEARCH_DEPTH) return
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
        walk(childAbs, childRel, depth + 1)
        continue
      }
      if (!entry.isFile() || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue

      let stat: fs.Stats
      try {
        stat = fs.statSync(childAbs)
      } catch {
        continue
      }
      if (stat.size > MAX_SEARCH_FILE_SIZE) continue

      let text: string
      try {
        text = fs.readFileSync(childAbs, 'utf8')
      } catch {
        continue
      }
      if (text.includes('\u0000')) continue // binary in disguise

      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (line === undefined) continue
        const haystack = caseSensitive ? line : line.toLowerCase()
        if (!haystack.includes(needle)) continue
        if (hits.length >= MAX_SEARCH_HITS) {
          truncated = true
          return
        }
        hits.push({ path: childRel, line: i + 1, text: line.trim().slice(0, 240) })
      }
    }
  }

  if (query.length > 0) {
    walk(root, scope, 0)
  }
  return { hits, truncated }
}
