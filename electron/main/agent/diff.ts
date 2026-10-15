/**
 * Hunk-level file diffs, ported from DeepSeek Harness's tool-fs diff:
 * write and edit results carry structured hunks (context included) instead
 * of raw before/after text, so the chat can render a faithful diff card
 * and replay it later from the persisted trace.
 */
import type { DiffLine, FileDiff } from '../../shared/types'

const CONTEXT = 3

/** Beyond this many cells the LCS table gets too big — fall back to a whole-file hunk. */
const MAX_TABLE_CELLS = 8_000_000

export interface Hunk {
  lines: DiffLine[]
  added: number
  removed: number
}

/** Split into compared lines, dropping only the trailing newline remainder. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

/** Longest-common-subsequence table as a flat Int32Array. */
function lcsTable(a: string[], b: string[]): Int32Array {
  const width = b.length + 1
  const table = new Int32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const left = a[i]
    if (left === undefined) continue
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const right = b[j]
      if (right === undefined) continue
      const diagonal = table[(i + 1) * width + j + 1] ?? 0
      const down = table[(i + 1) * width + j] ?? 0
      const next = table[i * width + j + 1] ?? 0
      table[i * width + j] = left === right ? diagonal + 1 : Math.max(down, next)
    }
  }
  return table
}

/** Walk the table into the full annotated line sequence. */
function editScript(a: string[], b: string[]): DiffLine[] {
  const script: DiffLine[] = []
  const table = lcsTable(a, b)
  const width = b.length + 1
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const left = a[i]
    const right = b[j]
    if (left === undefined || right === undefined) break
    if (left === right) {
      script.push({ kind: 'ctx', text: left })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      script.push({ kind: 'del', text: left })
      i += 1
    } else {
      script.push({ kind: 'add', text: right })
      j += 1
    }
  }
  while (i < a.length) {
    const left = a[i]
    if (left === undefined) break
    script.push({ kind: 'del', text: left })
    i += 1
  }
  while (j < b.length) {
    const right = b[j]
    if (right === undefined) break
    script.push({ kind: 'add', text: right })
    j += 1
  }
  return script
}

/** Group an edit script into hunks padded with CONTEXT lines on each side. */
function groupHunks(script: DiffLine[]): Hunk[] {
  const changed = script.reduce(
    (acc, line, index) => (line.kind === 'ctx' ? acc : (acc.push(index), acc)),
    [] as number[]
  )
  if (changed.length === 0) return []

  // Ranges of changed indices padded with context, merged when they touch.
  const ranges: Array<[number, number]> = []
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT)
    const end = Math.min(script.length - 1, index + CONTEXT)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end)
    } else {
      ranges.push([start, end])
    }
  }

  return ranges.map(([start, end]) => {
    const lines = script.slice(start, end + 1)
    const added = lines.filter((line) => line.kind === 'add').length
    const removed = lines.filter((line) => line.kind === 'del').length
    return { lines, added, removed }
  })
}

/** Whole-file fallback for pairs too large to diff precisely. */
function wholeFileDiff(oldLines: string[], newLines: string[]): Hunk[] {
  const lines: DiffLine[] = [
    ...oldLines.map((text): DiffLine => ({ kind: 'del', text })),
    ...newLines.map((text): DiffLine => ({ kind: 'add', text }))
  ]
  return [
    {
      lines,
      added: newLines.length,
      removed: oldLines.length
    }
  ]
}

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const before = splitLines(oldText)
  const after = splitLines(newText)
  if (before.length * after.length > MAX_TABLE_CELLS) {
    return wholeFileDiff(before, after)
  }
  const script = editScript(before, after)
  const hunks = groupHunks(script)
  if (hunks.length > 0) return hunks
  // Identical text: still surface a minimal hunk so the card is not empty.
  if (before.length === 0 && after.length === 0) return []
  return wholeFileDiff(before, after)
}

/**
 * Diffs for one file mutation: creates render as pure additions, updates
 * as real hunks against the previous content.
 */
export function fileDiff(path: string, before: string | null, after: string): FileDiff | null {
  if (before === null) {
    const lines = splitLines(after).map((text): DiffLine => ({ kind: 'add', text }))
    if (lines.length === 0) return null
    return { path, op: 'create', lines, added: lines.length, removed: 0 }
  }
  const hunks = computeHunks(before, after)
  if (hunks.length === 0) return null
  const merged = hunks.flatMap((hunk) => hunk.lines)
  return {
    path,
    op: 'update',
    lines: merged,
    added: hunks.reduce((sum, hunk) => sum + hunk.added, 0),
    removed: hunks.reduce((sum, hunk) => sum + hunk.removed, 0)
  }
}
