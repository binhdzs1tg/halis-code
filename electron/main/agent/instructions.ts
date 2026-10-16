/**
 * Workspace instruction files, ported from DeepSeek Harness's
 * agent-instructions with codex's global layer: the user's own
 * ~/.halis/AGENTS.md applies to every project, then the workspace's
 * AGENTS.md / CLAUDE.md (plus *.local.md overlays) are injected into the
 * system prompt inside a <system-reminder> frame. Files are loaded
 * broadest-first and dropped or truncated — most specific last, never
 * dropped first — to fit a budget, and the omissions are reported instead
 * of failing silently.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getWorkspaceRoot } from '../workspace'

/** Per-file size cap; anything bigger is truncated. */
const MAX_SOURCE_BYTES = 1024 * 1024

/** Total budget across all instruction files. */
const MAX_TOTAL_BYTES = 65_536

/** Root files first (broadest), then the local overlays (most specific). */
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']

interface InstructionFile {
  path: string
  content: string
}

function escapeReminder(text: string): string {
  return text.replace(/<\/system-reminder>/g, '<\\/system-reminder>')
}

function readInstructionAt(target: string, displayPath: string): InstructionFile | null {
  try {
    const stat = fs.statSync(target)
    if (!stat.isFile()) return null
    const raw = fs.readFileSync(target, 'utf8')
    let content = raw
    if (Buffer.byteLength(raw) > MAX_SOURCE_BYTES) {
      content = Buffer.from(raw, 'utf8').subarray(0, MAX_SOURCE_BYTES).toString('utf8')
      content += '\n… (file truncated at the size limit)'
    }
    return { path: displayPath, content }
  } catch {
    return null
  }
}

function readInstruction(root: string, name: string): InstructionFile | null {
  return readInstructionAt(path.join(root, name), name)
}

/**
 * Fit the files into the total budget: drop the broadest file whole, then
 * binary-search a truncation of the most specific one, then report what
 * was left out. Returns null when nothing survived.
 */
function renderWithinBudget(files: InstructionFile[]): string | null {
  const omitted: string[] = []
  const kept = [...files]

  const totalBytes = (list: InstructionFile[]): number =>
    list.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)

  while (kept.length > 1 && totalBytes(kept) > MAX_TOTAL_BYTES) {
    const dropped = kept.shift()
    if (dropped) omitted.push(dropped.path)
  }

  const file = kept[0]
  if (file && totalBytes(kept) > MAX_TOTAL_BYTES) {
    // Only the last file remains; binary-search the longest prefix that fits.
    let low = 0
    let high = file.content.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const probe = file.content.slice(0, mid)
      if (Buffer.byteLength(probe) <= MAX_TOTAL_BYTES) low = mid
      else high = mid - 1
    }
    const keptText = file.content.slice(0, low)
    kept[0] = { ...file, content: `${keptText}\n… (truncated to fit the instruction budget)` }
  }

  if (kept.length === 0) return null

  const sections = kept.map(
    (file) => `<instructions path="${file.path}">\n${escapeReminder(file.content.trimEnd())}\n</instructions>`
  )
  const lines = [
    'The following instructions were contributed by the user (the ~/.halis/AGENTS.md ' +
      'file, which applies to every project) and by the opened folder. More specific ' +
      'instructions take precedence over broader ones. They do not override ' +
      'system, developer, or direct user instructions.',
    '',
    ...sections
  ]
  if (omitted.length > 0) {
    lines.push(
      '',
      `Workspace instruction budget ${MAX_TOTAL_BYTES} bytes: omitted ${omitted.join(', ')}.`
    )
  }
  return lines.join('\n')
}

/**
 * Collect and render the user-level and workspace instruction files for
 * the system prompt. Returns null when neither source has anything.
 */
export function loadWorkspaceInstructions(): string | null {
  const files: InstructionFile[] = []
  // The user's own instructions come first: broadest, applies everywhere.
  const globalFile = readInstructionAt(path.join(os.homedir(), '.halis', 'AGENTS.md'), '~/.halis/AGENTS.md')
  if (globalFile && globalFile.content.trim().length > 0) {
    files.push(globalFile)
  }

  const root = getWorkspaceRoot()
  if (root) {
    for (const name of CANDIDATES) {
      const file = readInstruction(root, name)
      if (file && file.content.trim().length > 0) {
        files.push(file)
      }
    }
  }
  if (files.length === 0) return null

  const body = renderWithinBudget(files)
  if (!body) return null
  return `<system-reminder>\n${body}\n</system-reminder>`
}
