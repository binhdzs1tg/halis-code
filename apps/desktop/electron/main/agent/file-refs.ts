/**
 * `@path` file references: tokens the user explicitly pointed at are read and attached to
 * the prompt, so the model argues about real file contents instead of
 * guessing what the user has in front of them.
 */
import fs from 'node:fs'
import { resolveInWorkspace } from '../workspace'
import { observeRead } from './observation'

/**
 * `@path` or `@"quoted path"`, optionally with a `:line` suffix that is
 * dropped here but keeps the token out of ordinary prose. Paths with
 * spaces need the quoted form.
 */
const FILE_REF = /(^|[\s(])@(?:"([^"\n]+)"|([^\s,;)\]}'"@]+))/g

/** Refs beyond this count are ignored — a few files carry real context. */
const MAX_FILES = 8

/** Per-file and total budget for attached contents. */
const MAX_FILE_CHARS = 24_000
const MAX_TOTAL_CHARS = 64_000

export interface FileReference {
  /** Path exactly as the user typed it (without the @). */
  raw: string
  /** Path relative to the workspace root. */
  path: string
  content: string | null
  note: string | null
}

/** Extract @-references from the prompt text; prose is left untouched. */
export function extractFileRefs(prompt: string): string[] {
  const paths: string[] = []
  for (const match of prompt.matchAll(FILE_REF)) {
    const raw = (match[2] ?? match[3] ?? '').replace(/:\d+$/, '')
    if (!raw || raw.includes('..')) continue
    if (!paths.includes(raw)) paths.push(raw)
  }
  return paths.slice(0, MAX_FILES)
}

function readRef(raw: string): FileReference {
  let absolute: string
  try {
    absolute = resolveInWorkspace(raw)
  } catch {
    return { raw, path: raw, content: null, note: 'no workspace is open' }
  }
  try {
    const stat = fs.statSync(absolute)
    if (!stat.isFile()) {
      return { raw, path: raw, content: null, note: 'not a regular file' }
    }
    // The pre-read stat is the CAS basis the edit gate compares against;
    // capturing it after the bytes were read would bless a concurrent
    // external write instead of failing the gate.
    const basis = { mtimeMs: stat.mtimeMs, size: stat.size }
    let text = fs.readFileSync(absolute, 'utf8')
    if (text.includes('\u0000')) {
      // A binary file was never shown to the model — it must not count as
      // read for the edit gate, or a blind patch could corrupt it.
      return { raw, path: raw, content: null, note: 'binary file' }
    }
    // A referenced file the model has now seen counts as read for the
    // edit gate — but only the part the attachment actually showed. A
    // truncated read does not cover the unseen rest of the file.
    if (text.length > MAX_FILE_CHARS) {
      text = `${text.slice(0, MAX_FILE_CHARS)}\n… (truncated at ${MAX_FILE_CHARS} characters — read_file for more)`
    } else {
      observeRead(absolute, basis)
    }
    return { raw, path: raw, content: text, note: null }
  } catch {
    return { raw, path: raw, content: null, note: 'not found in the workspace' }
  }
}

/**
 * Build the attachment block for a prompt's file references, or null when
 * the prompt references nothing. Referenced paths are user-intended
 * context, nothing more.
 */
export function buildFileRefBlock(prompt: string): string | null {
  const roots = extractFileRefs(prompt)
  if (roots.length === 0) return null

  const refs: FileReference[] = []
  let total = 0
  for (const raw of roots) {
    const ref = readRef(raw)
    if (ref.content) {
      if (total + ref.content.length > MAX_TOTAL_CHARS) {
        refs.push({ ...ref, content: null, note: 'skipped — the attachment budget is used up' })
        continue
      }
      total += ref.content.length
    }
    refs.push(ref)
  }
  // Type discrimination, not truthiness: an empty file reads as content
  // '' and still counts as a successfully attached reference.
  if (refs.every((ref) => ref.content === null && !ref.note)) return null

  const lines = [
    '<system-reminder>',
    'Tokens prefixed with @ in the user\u2019s message are paths the user explicitly referenced. ' +
      'Their contents follow when they could be read. Do not claim to have inspected a referenced ' +
      'file beyond what is shown here.',
    ''
  ]
  for (const ref of refs) {
    if (ref.content !== null) {
      lines.push(`<file path="${ref.path}">`, ref.content, '</file>', '')
    } else {
      lines.push(`<file path="${ref.path}" unavailable="${ref.note ?? 'unreadable'}" />`, '')
    }
  }
  lines.push('</system-reminder>')
  return lines.join('\n')
}
