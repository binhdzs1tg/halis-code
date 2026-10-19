/**
 * String-edit core for the edit_file tool, matching tiers: exact first,
 * then a line-based match that forgives
 * trailing whitespace, smart quotes and exotic dashes. Pure logic so the
 * smoke tests can run it in plain Node.
 */
import { normalizeForMatch } from './patch-format'

export interface EditResult {
  content: string
  /** How the match was found, when it needed the forgiving tier. */
  note?: string
  /** Replacements made; > 1 only with replaceAll. */
  count: number
}

/**
 * Keep the file's line endings when the replacement text carries the other
 * kind — an exact match inside a CRLF file must not write lone \n lines into
 * it (mixed endings, git churn). The match context decides, falling back to
 * the file when old_text has no newline of its own.
 */
function withLocalEndings(content: string, oldText: string, newText: string): string {
  if (!newText.includes('\n')) return newText
  const sample = oldText.includes('\n') ? oldText : content
  if (sample.includes('\r\n')) return newText.replace(/\r?\n/g, '\r\n')
  if (!sample.includes('\r')) return newText.replace(/\r?\n/g, '\n')
  return newText
}

/**
 * Replace oldText with newText. Without replaceAll the old text must match
 * exactly once (or once after normalization); with it, every exact
 * occurrence goes. Errors carry the remediation the model needs.
 */
export function applyEditText(content: string, oldText: string, newText: string, replaceAll: boolean): EditResult {
  if (oldText === newText) {
    throw new Error('old_text and new_text are identical — nothing to do.')
  }
  const exactCount = countOccurrences(content, oldText)
  if (exactCount > 0 && replaceAll) {
    return { content: content.split(oldText).join(withLocalEndings(content, oldText, newText)), count: exactCount }
  }
  if (exactCount === 1) {
    const index = content.indexOf(oldText)
    return {
      content: content.slice(0, index) + withLocalEndings(content, oldText, newText) + content.slice(index + oldText.length),
      count: 1
    }
  }
  if (exactCount > 1) {
    throw new Error(
      `old_text appears ${exactCount} times. Add surrounding lines to make it unique, or pass replace_all=true.`
    )
  }
  if (replaceAll) {
    throw new Error('old_text was not found (replace_all needs exact matches). Re-read the file and match the text exactly.')
  }

  // Forgiving tier: compare line windows with whitespace trimmed and
  // typographic punctuation folded — the rescue for patches written in
  // rich editors. Like the exact tier, an ambiguous window is refused
  // rather than silently edited at the first match.
  //
  // A trailing "\n" yields a phantom '' element that stands for the final
  // newline, not a content line. Pop it on all three sides or a window can
  // "match" the last real line plus the phantom — eating the file's final
  // newline and, on CRLF files, re-encoding it into a stray \r line.
  const hadFinalNewline = content.endsWith('\n')
  const contentLines = content.split('\n')
  if (hadFinalNewline) contentLines.pop()
  const oldLines = oldText.split('\n')
  if (oldLines.length > 1 && oldText.endsWith('\n')) oldLines.pop()
  const newLines = newText === '' ? [] : newText.split('\n')
  if (newLines.length > 1 && newText.endsWith('\n')) newLines.pop()
  const windowCount = oldLines.length
  if (windowCount === 0 || windowCount > contentLines.length) {
    throw notFound()
  }
  const windowMatches = (start: number): boolean => {
    for (let i = 0; i < windowCount; i += 1) {
      const left = contentLines[start + i] ?? ''
      const right = oldLines[i] ?? ''
      if (normalizeForMatch(left.trim()) !== normalizeForMatch(right.trim())) {
        return false
      }
    }
    return true
  }
  let matchCount = 0
  let start = -1
  for (let offset = 0; offset <= contentLines.length - windowCount; offset += 1) {
    if (!windowMatches(offset)) continue
    matchCount += 1
    if (start === -1) start = offset
  }
  if (matchCount === 0) throw notFound()
  if (matchCount > 1) {
    throw new Error(
      `old_text matches ${matchCount} places after normalizing whitespace and punctuation. ` +
        'Add surrounding lines to make it unique.'
    )
  }
  // The replacement text arrives with \n; the matched window may carry the
  // file's \r — keep the endings the file already uses.
  const first = contentLines[start] ?? ''
  const replacement = first.endsWith('\r')
    ? newLines.map((line) => (line.endsWith('\r') ? line : `${line}\r`))
    : newLines
  contentLines.splice(start, windowCount, ...replacement)
  let result = contentLines.join('\n')
  // The popped phantom was the final newline; put it back exactly once.
  if (hadFinalNewline) result += '\n'
  return {
    content: result,
    note: 'Matched after normalizing whitespace and punctuation; re-read the file before further edits.',
    count: 1
  }
}

function notFound(): Error {
  return new Error('old_text was not found in the file. Re-read it and match the text exactly.')
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = content.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = content.indexOf(needle, index + needle.length)
  }
  return count
}
