/**
 * Spill store for oversized tool output: when a result cannot fit the
 * inline budget, the full text is saved under ~/.halis/tool-output and the
 * model gets a bounded head/tail preview plus a pointer it can page through
 * with the read tool. Nothing is lost to a silent truncation.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** Root lives under the halis home folder once resolved. */
let spillBase: string | null = null

/** Spill files older than this are swept on startup. */
const RETENTION_MS = 7 * 24 * 60 * 60_000

/** The most a single spill file keeps; beyond this the tail is dropped. */
const MAX_SPILL_CHARS = 10_000_000

/** Characters a single line may keep before the rest is folded away. */
const MAX_LINE_CHARS = 2_000

export function spillDir(): string {
  return process.env.HALIS_SPILL_DIR ?? path.join(process.env.HALIS_HOME ?? path.join(os.homedir(), '.halis'), 'tool-output')
}

/** Resolve the store and drop anything past retention. Called lazily. */
function ensureBase(): string | null {
  if (!spillBase) {
    spillBase = spillDir()
    try {
      fs.mkdirSync(spillBase, { recursive: true, mode: 0o700 })
      const cutoff = Date.now() - RETENTION_MS
      for (const entry of fs.readdirSync(spillBase)) {
        const target = path.join(spillBase, entry)
        try {
          const stat = fs.statSync(target)
          if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(target)
        } catch {
          // unreadable entries are none of our business
        }
      }
    } catch {
      return null
    }
  }
  return spillBase
}

/** Test seam: point the store somewhere temporary. */
export function setSpillBaseForTests(dir: string): void {
  spillBase = dir
}

/** A filename-safe tool name, so the store stays listable by eye. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)
  return cleaned.length > 0 ? cleaned : 'tool'
}

/**
 * Save the full text and return its absolute path, or null when storage
 * failed — a spill failure must never turn a successful tool call into an
 * error, it degrades to inline truncation instead.
 */
export function saveSpill(toolName: string, callId: string, content: string): string | null {
  const base = ensureBase()
  if (!base) return null
  let body = content
  if (content.length > MAX_SPILL_CHARS) {
    body = `${content.slice(0, MAX_SPILL_CHARS)}\n… (spill capped at ${MAX_SPILL_CHARS} characters)`
  }
  const file = path.join(base, `${safeSegment(toolName)}-${safeSegment(callId)}-${randomBytes(4).toString('hex')}.txt`)
  try {
    fs.writeFileSync(file, body, 'utf8')
    return file
  } catch {
    return null
  }
}

/** True when the path points inside the store — the read tool's escape hatch. */
export function isSpillPath(target: string): boolean {
  const base = ensureBase()
  if (!base) return false
  const resolved = path.resolve(target)
  const prefix = base.endsWith(path.sep) ? base : base + path.sep
  return resolved.startsWith(prefix)
}

/**
 * Read a file from the store, or null when the path is outside it, missing
 * or unreadable. Size-capped like the workspace reader so a runaway file
 * cannot flood the model in one call.
 */
export function readSpill(target: string): string | null {
  if (!isSpillPath(target)) return null
  try {
    const stat = fs.statSync(target)
    if (!stat.isFile() || stat.size > MAX_SPILL_CHARS * 4) return null
    const content = fs.readFileSync(target, 'utf8')
    if (content.includes('\u0000')) return null
    return content.length > MAX_SPILL_CHARS
      ? `${content.slice(0, MAX_SPILL_CHARS)}\n… (spill read capped at ${MAX_SPILL_CHARS} characters)`
      : content
  } catch {
    return null
  }
}

/** Cap every line in place first — a single 3 MB minified JSON line becomes
 *  readable long before spilling is considered. Pure, surrogate-safe. */
export function truncateLongLines(text: string, maxLineChars: number = MAX_LINE_CHARS): string {
  if (!text.includes('\n') && text.length <= maxLineChars) return text
  const lines = text.split('\n')
  let touched = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line !== undefined && line.length > maxLineChars) {
      lines[i] = `${cutSafe(line, 0, maxLineChars)}[... line truncated]`
      touched = true
    }
  }
  return touched ? lines.join('\n') : text
}

/** Cut without splitting a surrogate pair in half. */
function cutSafe(text: string, start: number, end: number): string {
  let to = end
  if (to < text.length) {
    const code = text.charCodeAt(to - 1)
    if (code >= 0xd800 && code <= 0xdbff) to -= 1
  }
  return text.slice(start, to)
}

/** Inline budget before the store takes over. */
export const SPILL_THRESHOLD = 50_000

/**
 * The one entry point the loop calls: normalize long lines, and when the
 * output still dwarfs the budget, spill the whole thing and hand back a
 * readable head/tail with the path. Otherwise the (possibly line-capped)
 * text goes through as-is.
 */
export function fitToolOutput(toolName: string, callId: string, output: string): string {
  const capped = truncateLongLines(output)
  if (capped.length <= SPILL_THRESHOLD) return capped
  const file = saveSpill(toolName, callId, capped)
  if (!file) {
    // Storage failed — degrade to a hard inline truncation.
    return `${capped.slice(0, SPILL_THRESHOLD)}\n\n[output truncated at ${SPILL_THRESHOLD} characters — full text kept nowhere]`
  }
  const head = capped.slice(0, 4_000)
  const tail = capped.slice(-1_000)
  return [
    head,
    '',
    `[… ${capped.length - 5_000} characters omitted …]`,
    '',
    tail,
    '',
    `Full output saved to ${file} — read that file for more, in pages if it is long.`,
  ].join('\n')
}
