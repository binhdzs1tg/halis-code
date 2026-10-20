import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.cache',
  'vendor',
])

export async function* walk(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const queue: string[] = [root]
  const visited = new Set<string>()
  let seen = 0
  while (queue.length > 0) {
    if (signal?.aborted) return
    const dir = queue.shift()
    if (!dir) return
    if (visited.has(dir)) continue // symlink cycles must not spin forever
    visited.add(dir)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++seen > 20000) return
      if (entry.name.startsWith('.') && entry.name !== '.halis') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full)
        continue
      }
      if (entry.isFile()) yield full
      if (entry.isSymbolicLink()) {
        // A link to a directory joins the walk; a link to a file is a hit.
        // The visited set plus the entry cap keep cycles bounded.
        try {
          const target = await stat(full)
          if (target.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) queue.push(full)
          } else if (target.isFile()) {
            yield full
          }
        } catch {
          // dangling symlink — nothing to yield
        }
      }
    }
  }
}

/** Compile a glob pattern (*, **, ?) into a RegExp over POSIX-style paths.
 *  Pass ignoreCase where the filesystem under the search does not care
 *  about case (windows always, macos by default) so README.md finds
 *  readme.md the way the platform's own tools would. */
export function globToRegExp(pattern: string, options: { ignoreCase?: boolean } = {}): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === undefined) break
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          // `**/` crosses any number of directories, or none at all —
          // a/**/b must match a/b and a/x/y/b but not ab or axb.
          re += '(?:.*/)?'
          i++
        } else {
          re += '(?:.*)'
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  return new RegExp(`(?:^|/)${re}$`, options.ignoreCase === true ? 'i' : '')
}

/** True where the filesystem matches names without caring about case —
 *  windows always, macos by default (case-preserving HFS+/APFS). */
export function fsIgnoresCase(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

export function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n… [+${omitted} chars omitted] …\n${text.slice(text.length - tail)}`
}

export function truncateLine(text: string, max: number): string {
  const line = text.replace(/\t/g, '  ')
  return line.length <= max ? line : `${line.slice(0, max)}…`
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count++
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    const s = await stat(target)
    return s.isFile()
  } catch {
    return false
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
