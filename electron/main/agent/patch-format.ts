/**
 * Parser and applier for the multi-file patch format. Pure string logic —
 * no fs, no Electron — so the
 * smoke tests can exercise it in plain Node. The tool wrapper in patch.ts
 * owns the filesystem side effects.
 *
 * The format, in short:
 *
 *   *** Begin Patch
 *   *** Add File: <path>        followed by '+' lines (the new content)
 *   *** Delete File: <path>     nothing follows
 *   *** Update File: <path>     hunks; optional '*** Move to: <path>'
 *   @@ <context>                optional fuzzy context before the hunk
 *    context line               leading space
 *   -old line / +new line       minus/plus
 *   *** End of File             anchors the hunk to the file's tail
 *   *** End Patch
 */

export interface UpdateFileChunk {
  oldLines: string[]
  newLines: string[]
  changeContext?: string
  endOfFile?: boolean
}

export type PatchHunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: UpdateFileChunk[] }

/** UTF-8 BOM handling. */
function splitBom(text: string): { text: string; bom: boolean } {
  const bom = text.charCodeAt(0) === 0xfeff
  return { text: bom ? text.slice(1) : text, bom }
}

function joinBom(text: string, bom: boolean): string {
  return bom ? `\uFEFF${text}` : text
}

/**
 * Parse a full patch. Throws with a line-numbered message on malformed
 * input so the model can correct the patch and try again.
 */
export function parsePatch(patchText: string): PatchHunk[] {
  const lines = stripHeredoc(patchText.trim())
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if (lines[0]?.trim() !== '*** Begin Patch') {
    throw new Error("The first line of the patch must be '*** Begin Patch'.")
  }
  const end = lines.length - 1
  if (lines[end]?.trim() !== '*** End Patch') {
    throw new Error("The last line of the patch must be '*** End Patch'.")
  }
  if (end === 0) {
    throw new Error('The patch contains no file sections.')
  }

  const hunks: PatchHunk[] = []
  let index = 1
  while (index < end) {
    const header = lines[index]?.trim() ?? ''
    if (index === 1 && header.startsWith('*** Environment ID:')) {
      index += 1
      continue
    }
    if (header.startsWith('*** Add File: ')) {
      const path = header.slice('*** Add File: '.length).trim()
      if (!path) throw new Error('Add File header needs a path.')
      const parsed = parseAdd(lines, index + 1, end, path)
      hunks.push({ type: 'add', path, contents: parsed.content })
      index = parsed.next
      continue
    }
    if (header.startsWith('*** Delete File: ')) {
      const path = header.slice('*** Delete File: '.length).trim()
      if (!path) throw new Error('Delete File header needs a path.')
      const next = index + 1 < end ? lines[index + 1]?.trim() : undefined
      if (next !== undefined && next !== '' && !isBoundary(next)) {
        throw new Error(
          `Invalid hunk at line ${index + 2}: Delete hunks do not contain body lines.`
        )
      }
      hunks.push({ type: 'delete', path })
      index += 1
      continue
    }
    if (header.startsWith('*** Update File: ')) {
      const path = header.slice('*** Update File: '.length).trim()
      if (!path) throw new Error('Update File header needs a path.')
      let next = index + 1
      let movePath: string | undefined
      // Markers before the body still anchor the hunk to the file's tail —
      // dropping them would let an ambiguous hunk apply at the first
      // occurrence instead of the end the model asked for.
      let pendingEndOfFile = false
      while (lines[next]?.trimEnd() === '*** End of File') {
        pendingEndOfFile = true
        next += 1
      }
      const move = lines[next]?.trimEnd()
      if (move === '*** Move to:' || move?.startsWith('*** Move to: ')) {
        movePath = (move ?? '').slice('*** Move to: '.length).trim()
        if (!movePath) {
          throw new Error(`Move destination for '${path}' must not be empty.`)
        }
        next += 1
      }
      const parsed = parseUpdate(lines, next, end, path, index, pendingEndOfFile)
      hunks.push({ type: 'update', path, ...(movePath ? { movePath } : {}), chunks: parsed.chunks })
      index = parsed.next
      continue
    }
    throw new Error(
      `Invalid hunk at line ${index + 1}: '${header}' is not a valid hunk header. ` +
        "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'."
    )
  }
  return hunks
}

/** Patches wrapped in a heredoc or code fence still carry their markers. */
function stripHeredoc(input: string): string {
  const heredoc = /^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/.exec(input)
  if (heredoc?.[3]) return heredoc[3]
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/.exec(input)
  if (fenced?.[1]) return fenced[1]
  return input
}

function parseAdd(
  lines: string[],
  start: number,
  end: number,
  path: string
): { content: string; next: number } {
  const content: string[] = []
  let index = start
  while (index < end && !isBoundary(lines[index]?.trim() ?? '')) {
    const line = lines[index] ?? ''
    if (!line.startsWith('+')) {
      throw new Error(
        `Invalid Add File line for '${path}' at line ${index + 1}: expected a line starting with '+'.`
      )
    }
    content.push(line.slice(1))
    index += 1
  }
  return { content: content.join('\n'), next: index }
}

function parseUpdate(
  lines: string[],
  start: number,
  end: number,
  path: string,
  hunkStart: number,
  pendingEndOfFile = false
): { chunks: UpdateFileChunk[]; next: number } {
  const chunks: UpdateFileChunk[] = []
  let index = start
  let afterEndOfFile = false
  while (index < end) {
    const line = lines[index] ?? ''
    const updateLine = line.trimEnd()
    if (afterEndOfFile) {
      if (updateLine === '') {
        index += 1
        continue
      }
      if (updateLine === '@@' || updateLine.startsWith('@@ ')) {
        afterEndOfFile = false
      } else if (isBoundary(updateLine)) {
        break
      } else {
        throw new Error(
          `Invalid hunk at line ${index + 1}: expected '@@' context marker, got '${line}'.`
        )
      }
    }
    if (updateLine === '*** End of File') {
      const chunk = chunks[chunks.length - 1]
      if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
        throw new Error(`Invalid hunk at line ${index + 1}: Update hunk does not contain any lines.`)
      }
      if (chunk) {
        chunk.endOfFile = true
        afterEndOfFile = true
      }
      index += 1
      continue
    }
    if (isBoundary(updateLine)) break
    if (updateLine === '@@' || updateLine.startsWith('@@ ')) {
      const previous = chunks[chunks.length - 1]
      if (previous && previous.oldLines.length === 0 && previous.newLines.length === 0) {
        throw new Error(
          `Invalid hunk at line ${index + 1}: every line should start with ' ' (context), '+' (added) or '-' (removed).`
        )
      }
      chunks.push({
        oldLines: [],
        newLines: [],
        ...(updateLine === '@@' ? {} : { changeContext: updateLine.slice('@@ '.length) })
      })
      index += 1
      continue
    }
    if (chunks.length === 0) {
      chunks.push({ oldLines: [], newLines: [] })
    }
    const chunk = chunks[chunks.length - 1]
    if (!chunk) throw new Error(`Invalid hunk at line ${index + 1}.`)
    if (line === '') {
      // A bare newline counts as an empty context line.
      chunk.oldLines.push('')
      chunk.newLines.push('')
      index += 1
      continue
    }
    if (line.startsWith(' ')) {
      chunk.oldLines.push(line.slice(1))
      chunk.newLines.push(line.slice(1))
      index += 1
      continue
    }
    if (line.startsWith('-')) {
      chunk.oldLines.push(line.slice(1))
      index += 1
      continue
    }
    if (line.startsWith('+')) {
      chunk.newLines.push(line.slice(1))
      index += 1
      continue
    }
    throw new Error(
      `Invalid hunk at line ${index + 1}: '${line}' — every line should start with ' ' (context), '+' (added) or '-' (removed).`
    )
  }
  if (chunks.length === 0) {
    throw new Error(`Update file hunk for path '${path}' is empty.`)
  }
  const last = chunks[chunks.length - 1]
  if (last && last.oldLines.length === 0 && last.newLines.length === 0) {
    throw new Error(`Invalid hunk at line ${hunkStart + 1}: Update hunk does not contain any lines.`)
  }
  // A marker that sat before the body anchors the hunk it precedes.
  if (pendingEndOfFile) {
    const first = chunks[0]
    if (first) first.endOfFile = true
  }
  return { chunks, next: index }
}

function isBoundary(line: string): boolean {
  return (
    line === '*** End Patch' ||
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  )
}

/* ---------- applying ---------- */

/**
 * Derive the updated content of a file from its chunks. Line matching runs
 * in four tiers — exact, trailing-whitespace-insensitive, trim, and
 * unicode-normalized — so a patch survives smart quotes and NBSP noise the
 * way the matching tiers are tuned.
 */
export function applyUpdate(path: string, chunks: UpdateFileChunk[], original: string): string {
  const source = splitBom(original)
  const lines = source.text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const replacements = computeReplacements(lines, path, chunks)
  // Splice from the back so earlier offsets stay valid.
  for (const [start, remove, insert] of replacements.reverse()) {
    lines.splice(start, remove, ...insert)
  }
  // Patches always normalize to a trailing newline — the smoke suite
  // asserts this convention.
  if (lines[lines.length - 1] !== '') lines.push('')
  return joinBom(lines.join('\n'), source.bom)
}

function computeReplacements(
  lines: string[],
  path: string,
  chunks: UpdateFileChunk[]
): Array<[start: number, remove: number, insert: string[]]> {
  const replacements: Array<[number, number, string[]]> = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const context = seek(lines, [chunk.changeContext], lineIndex, false)
      if (context === -1) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}.`)
      }
      lineIndex = context + 1
    }
    if (chunk.oldLines.length === 0) {
      // Pure insertion: right after the located context when one was
      // given, otherwise append at the end of the file.
      const at = chunk.changeContext !== undefined ? lineIndex : lines.length
      const anchor = chunk.changeContext !== undefined ? lines[lineIndex - 1] : lines[lines.length - 1]
      replacements.push([at, 0, withLocalEndings(chunk.newLines, anchor)])
      continue
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let found = seek(lines, oldLines, lineIndex, chunk.endOfFile === true)
    if (found === -1 && oldLines[oldLines.length - 1] === '') {
      oldLines = oldLines.slice(0, -1)
      if (newLines[newLines.length - 1] === '') {
        newLines = newLines.slice(0, -1)
      }
      found = seek(lines, oldLines, lineIndex, chunk.endOfFile === true)
    }
    if (found === -1 && chunk.oldLines.every((line) => line === '')) {
      const expected =
        chunk.oldLines.length === 1 ? 'an expected blank line' : `${chunk.oldLines.length} consecutive blank lines`
      throw new Error(`Failed to find ${expected} in ${path}.`)
    }
    if (found === -1) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`)
    }
    replacements.push([found, oldLines.length, withLocalEndings(newLines, lines[found])])
    lineIndex = found + oldLines.length
  }
  return replacements.sort((left, right) => left[0] - right[0])
}

/** Patch hunks are LF; the file may be CRLF. Re-encode inserted lines with
 *  the endings of the text they replace or follow so a patch never mixes
 *  line endings inside one file. */
function withLocalEndings(insert: string[], anchor: string | undefined): string[] {
  if (anchor === undefined || !anchor.endsWith('\r')) return insert
  return insert.map((line) => (line.endsWith('\r') ? line : `${line}\r`))
}

function seek(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (pattern.length === 0) return -1
  if (eof) {
    const offset = lines.length - pattern.length
    if (offset < start) return -1
    for (const compare of [exact, rstrip, trim, normalized]) {
      if (matches(lines, pattern, offset, compare)) return offset
    }
    return -1
  }
  for (const compare of [exact, rstrip, trim, normalized]) {
    for (let offset = start; offset <= lines.length - pattern.length; offset += 1) {
      if (matches(lines, pattern, offset, compare)) return offset
    }
  }
  return -1
}

function matches(
  lines: string[],
  pattern: string[],
  offset: number,
  compare: (left: string, right: string) => boolean
): boolean {
  // A pattern line past the end of the file is a miss, never a match —
  // comparing against a synthesized '' let hunks whose trailing context is
  // a blank line apply past EOF and insert a line the model never asked
  // for.
  return pattern.every((line, index) => {
    const actual = lines[offset + index]
    if (actual === undefined) return false
    return compare(actual, line)
  })
}

const exact = (left: string, right: string): boolean => left === right
const rstrip = (left: string, right: string): boolean => left.trimEnd() === right.trimEnd()
const trim = (left: string, right: string): boolean => left.trim() === right.trim()
const normalized = (left: string, right: string): boolean => normalizeForMatch(left.trim()) === normalizeForMatch(right.trim())

/**
 * Typographic quotes, unicode dashes and exotic spaces fold to their ASCII
 * look-alikes — the tier that rescues patches written in rich editors.
 */
export function normalizeForMatch(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
}
