/**
 * Dependency-free HTML to Markdown/text conversion. It keeps the behavior
 * that matters for feeding pages to a model: script/style stripping, code
 * fence sizing against backtick runs, GFM tables, link and image syntax and
 * entity decoding — in plain TS so nothing extra ships with the app.
 */

/* ---------- entities ---------- */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', copy: '©', reg: '®', trade: '™', deg: '°',
  middot: '·', bull: '•', dagger: '†', euro: '€', pound: '£', yen: '¥',
  cent: '¢', sect: '§', para: '¶', laquo: '«', raquo: '»', times: '×',
  divide: '÷', plusmn: '±', sup2: '²', sup3: '³', frac12: '½', frac14: '¼',
  frac34: '¾', check: '✓', star: '★', infin: '∞', minus: '−', prime: '′'
}

/** One pass, so a decoded '&amp;#38;' cannot turn into another entity. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return safeCodePoint(parseInt(body.slice(2), 16))
    }
    if (body.startsWith('#')) {
      return safeCodePoint(parseInt(body.slice(1), 10))
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/* ---------- tokenizer ---------- */

interface TagToken {
  kind: 'tag'
  name: string
  closing: boolean
  selfClosing: boolean
  attrs: Record<string, string>
}

interface TextToken {
  kind: 'text'
  text: string
}

type Token = TagToken | TextToken

const VOID_TAGS = new Set([
  'br', 'hr', 'img', 'input', 'meta', 'link', 'base', 'area', 'col', 'embed',
  'source', 'track', 'wbr', 'param'
])

/** Tags whose content is never page content worth reading. */
const STRIPPED_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg'
])

/** Raw-text elements: their content cannot nest (spec), so a skip ends at
 *  the first close tag of the name instead of counting open tags. */
const RAW_TEXT_TAGS = new Set(['script', 'style'])

/** Guard rails against degenerate markup; beyond these the page wins. */
const MAX_TOKENS = 200_000
const MAX_DEPTH = 512

function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const pushText = (text: string): void => {
    if (text.length > 0) tokens.push({ kind: 'text', text })
  }
  while (i < html.length && tokens.length < MAX_TOKENS) {
    const open = html.indexOf('<', i)
    if (open === -1) {
      pushText(html.slice(i))
      break
    }
    if (open > i) {
      pushText(html.slice(i, open))
    }
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', open) || html.startsWith('<?', open)) {
      const end = html.indexOf('>', open)
      i = end === -1 ? html.length : end + 1
      continue
    }
    if (html.startsWith('</', open)) {
      const end = html.indexOf('>', open + 2)
      const name = html.slice(open + 2, end === -1 ? undefined : end).trim().toLowerCase()
      i = end === -1 ? html.length : end + 1
      if (name.length > 0) {
        tokens.push({ kind: 'tag', name, closing: true, selfClosing: false, attrs: {} })
      }
      continue
    }
    // A tag lead must be a letter; '<3' and stray '<' are page text.
    const lead = html[open + 1]
    if (!lead || !/[a-zA-Z]/.test(lead)) {
      pushText('<')
      i = open + 1
      continue
    }
    const parsed = parseOpenTag(html, open)
    i = parsed.next
    tokens.push(parsed.token)
  }
  return tokens
}

function parseOpenTag(html: string, start: number): { token: TagToken; next: number } {
  let i = start + 1
  let name = ''
  while (i < html.length && /[a-zA-Z0-9:-]/.test(html[i] ?? '')) {
    name += html[i]
    i += 1
  }
  const attrs: Record<string, string> = {}
  let selfClosing = false
  for (;;) {
    while (i < html.length && /\s/.test(html[i] ?? '')) i += 1
    if (i >= html.length) break
    if (html[i] === '>') {
      i += 1
      break
    }
    if (html[i] === '/') {
      selfClosing = true
      i += 1
      continue
    }
    let key = ''
    while (i < html.length && !/[\s=/>]/.test(html[i] ?? '')) {
      key += html[i]
      i += 1
    }
    if (key.length === 0) {
      i += 1
      continue
    }
    while (i < html.length && /\s/.test(html[i] ?? '')) i += 1
    if (html[i] !== '=') {
      attrs[key.toLowerCase()] = ''
      continue
    }
    i += 1
    while (i < html.length && /\s/.test(html[i] ?? '')) i += 1
    const quote = html[i]
    if (quote === '"' || quote === "'") {
      const end = html.indexOf(quote, i + 1)
      attrs[key.toLowerCase()] = decodeEntities(html.slice(i + 1, end === -1 ? undefined : end))
      i = end === -1 ? html.length : end + 1
    } else {
      let value = ''
      while (i < html.length && !/[\s>]/.test(html[i] ?? '')) {
        value += html[i]
        i += 1
      }
      attrs[key.toLowerCase()] = decodeEntities(value)
    }
  }
  return {
    token: { kind: 'tag', name: name.toLowerCase(), closing: false, selfClosing: selfClosing || VOID_TAGS.has(name.toLowerCase()), attrs },
    next: i
  }
}

/* ---------- renderer ---------- */

type Mode = 'markdown' | 'text'

interface Frame {
  tag: string
  /** Length of the inline buffer when the frame opened; close rewinds to it. */
  mark: number
  attrs: Record<string, string>
}

interface ListFrame {
  ordered: boolean
  index: number
  lines: string[]
}

interface TableFrame {
  rows: string[][]
  headerFlags: boolean[]
  row: string[] | null
  rowHeader: boolean[]
  /** colspan-1 padding owed by each closed cell, in order. */
  colspanPad: number[]
  /** Cell text parked while a nested table holds the cell; restored on
   *  the nested table's close so the surrounding cell keeps it. */
  cellStash: string
  /** Whether this table currently has an open cell. */
  cellOpen: boolean
}

const BLOCKISH = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main',
  'address', 'fieldset', 'figure', 'figcaption', 'form', 'legend', 'hgroup',
  'video', 'audio', 'picture', 'canvas', 'map'
])
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }

/** Frames that may sit between an anchor (or heading) and its replacement. */
const INLINE_FRAMES = new Set([
  'a', 'code', 'kbd', 'samp', 'strong', 'b', 'em', 'i', 'del', 's', 'strike'
])

interface SiblingRule {
  /** Tag names an open frame of which this start tag implicitly closes. */
  match: Set<string>
  /** Structural frames that shield the match: a nested list shields the
   *  outer item, a nested table the outer row. */
  shield?: Set<string>
  /** When set, only these frames may sit in between; anything else shields. */
  through?: Set<string>
}

/**
 * Start tags whose end tag HTML5 makes optional before a sibling. Real pages
 * omit these closes constantly; without the implicit close `<li>one<li>two`
 * drops "one" on the floor and `<td>a<tr>` corrupts the table.
 */
const SIBLING_CLOSES: Record<string, SiblingRule> = {
  li: { match: new Set(['li']), shield: new Set(['ul', 'ol', 'table', 'td', 'th', 'caption']) },
  tr: { match: new Set(['tr']), shield: new Set(['table', 'thead', 'tbody', 'tfoot']) },
  td: { match: new Set(['td', 'th']), shield: new Set(['table', 'thead', 'tbody', 'tfoot']) },
  th: { match: new Set(['td', 'th']), shield: new Set(['table', 'thead', 'tbody', 'tfoot']) },
  a: { match: new Set(['a']), through: INLINE_FRAMES }
}
for (const heading of Object.keys(HEADINGS)) {
  // Any heading start tag closes an open heading, whatever its level.
  SIBLING_CLOSES[heading] = { match: new Set(Object.keys(HEADINGS)), through: INLINE_FRAMES }
}

export function htmlToMarkdown(html: string): string {
  return render(html, 'markdown')
}

export function htmlToText(html: string): string {
  return render(html, 'text')
}

/** Tags pass through the tokenizer; render only keeps the structure. */
function render(html: string, mode: Mode): string {
  const blocks: string[] = []
  const inline: string[] = []
  const stack: Frame[] = []
  const lists: ListFrame[] = []
  /** Open tables, innermost last; nested tables stack instead of clobbering. */
  const tables: TableFrame[] = []
  /** Open <li> frames, innermost last; nested lists attach to the top. */
  const openItems: { text: string; blocks: string[] }[] = []
  let quoteDepth = 0
  // While set, everything until the matching close tag is dropped.
  let skipTag: string | null = null
  let skipDepth = 0
  // Raw text accumulation inside <pre>.
  let preFrame: Frame | null = null
  let preText = ''
  let preLanguage = ''

  const currentList = (): ListFrame | null => lists[lists.length - 1] ?? null

  const currentTable = (): TableFrame | null => tables[tables.length - 1] ?? null

  /** Inside the open cell of the innermost table. */
  const inCell = (): boolean => currentTable()?.cellOpen === true

  const pushInline = (text: string): void => {
    if (mode === 'markdown' && !inCell()) {
      inline.push(escapeMarkdown(text, inCode()))
    } else if (inCell()) {
      inline.push(escapeCell(text))
    } else {
      inline.push(text)
    }
  }

  const inCode = (): boolean => stack.some((frame) => frame.tag === 'code' || frame.tag === 'kbd' || frame.tag === 'samp')

  const flushInline = (): string => {
    const text = inline
      .join('')
      // Whitespace collapses first, then hard-break markers (a page cannot
      // put a NUL in the buffer — it is stripped at token intake).
      .replace(/\s+/g, ' ')
      .replace(/\u0000/g, '\n')
      .trim()
    inline.length = 0
    return text
  }

  const emitBlock = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const prefix = '>'.repeat(quoteDepth)
    if (prefix.length === 0) {
      blocks.push(trimmed)
      return
    }
    blocks.push(trimmed.split('\n').map((line) => `${prefix} ${line}`).join('\n'))
  }

  // Inside a list item or table cell, block tags only break the line —
  // the item/cell is the block that gets emitted.
  const endInlineBlock = (): void => {
    if (inCell() || currentList()) {
      inline.push('\n')
      return
    }
    emitBlock(flushInline())
  }

  const wrapMarked = (frame: Frame, wrap: (content: string) => string): void => {
    const content = inline.slice(frame.mark).join('')
    inline.length = frame.mark
    inline.push(wrap(content))
  }

  const openList = (ordered: boolean): void => {
    lists.push({ ordered, index: 0, lines: [] })
  }

  const closeList = (): void => {
    const frame = lists.pop()
    if (!frame) return
    const block = frame.lines.join('\n')
    // A list nested inside an open <li> belongs to that item, not to the
    // parent list's line stream — that is what keeps "- two\n  - nested".
    const item = openItems[openItems.length - 1]
    if (item) {
      item.blocks.push(block)
      return
    }
    const parent = currentList()
    if (parent) {
      parent.lines.push(block)
      return
    }
    emitBlock(block)
  }

  const closeItem = (): void => {
    const list = currentList()
    if (!list) {
      openItems.pop()
      return
    }
    list.index += 1
    const rest = flushInline()
    const item = openItems.pop() ?? null
    const marker = list.ordered ? `${list.index}. ` : '- '
    const indent = '  '.repeat(Math.max(0, lists.length - 1))
    const text = item ? `${item.text} ${rest}`.trim() : rest
    const lines = text.length > 0 ? text.split('\n') : []
    const first = lines.length > 0 ? `${indent}${marker}${lines[0]}` : `${indent}${marker}`
    const tail = [first]
    for (const line of lines.slice(1)) {
      tail.push(`${indent}  ${line}`)
    }
    for (const block of item?.blocks ?? []) {
      tail.push(block)
    }
    list.lines.push(tail.join('\n'))
  }

  const renderTable = (frame: TableFrame): void => {
    const rows = frame.rows
    if (rows.length === 0) return
    if (mode === 'text') {
      for (const row of rows) {
        emitBlock(row.join(' | '))
      }
      return
    }
    const hasHeader = frame.headerFlags[0] === true
    const lines: string[] = []
    const toLine = (row: string[]): string => `| ${row.join(' | ')} |`
    if (hasHeader) {
      lines.push(toLine(rows[0] ?? []))
      const width = (rows[0] ?? []).length
      lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
      for (const row of rows.slice(1)) lines.push(toLine(row))
    } else {
      for (const row of rows) lines.push(toLine(row))
    }
    emitBlock(lines.join('\n'))
  }

  const closeCell = (header: boolean): void => {
    const frame = currentTable()
    if (!frame || frame.row === null) return
    // A <br> inside a cell becomes a space — a newline would break the
    // pipe row it lands in.
    const text = flushInline().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
    frame.row.push(text)
    frame.rowHeader.push(header)
    const pad = frame.colspanPad.shift() ?? 0
    for (let i = 0; i < pad; i += 1) {
      frame.row.push('')
    }
  }

  for (const token of tokenize(html)) {
    if (skipTag) {
      if (RAW_TEXT_TAGS.has(skipTag)) {
        // script/style bodies are raw text: a literal "<script>" inside the
        // JS must not raise the depth and swallow real page content, so the
        // first close of the name ends the skip.
        if (token.kind === 'tag' && token.closing && token.name === skipTag) {
          skipTag = null
        }
      } else if (token.kind === 'tag' && token.name === skipTag) {
        if (token.closing) {
          skipDepth -= 1
          if (skipDepth === 0) skipTag = null
        } else if (!token.selfClosing) {
          skipDepth += 1
        }
      }
      continue
    }
    if (preFrame) {
      if (token.kind === 'text') {
        // Entities decode inside <pre> just like everywhere else — browsers
        // render &lt; as < in code blocks too.
        preText += decodeEntities(token.text)
        continue
      }
      if (token.kind === 'tag' && token.name === 'br') {
        // A <br> is a newline inside the code block, not something to drop.
        preText += '\n'
        continue
      }
      if (token.kind === 'tag' && token.name === 'code' && !token.closing && preLanguage === '') {
        const klass = token.attrs['class'] ?? ''
        const match = /(?:^|\s)(?:language|lang)-([a-zA-Z0-9+#._-]+)/.exec(klass)
        preLanguage = match?.[1] ?? ''
        continue
      }
      if (token.kind === 'tag' && token.closing && token.name === 'pre') {
        flushPre()
        continue
      }
      continue
    }

    if (token.kind === 'text') {
      pushInline(decodeEntities(token.text).replace(/\u0000/g, ''))
      continue
    }

    const { name, closing } = token

    if (STRIPPED_TAGS.has(name)) {
      if (closing || token.selfClosing) continue
      skipTag = name
      skipDepth = 1
      continue
    }

    if (name === 'pre') {
      if (closing) continue
      preFrame = { tag: 'pre', mark: inline.length, attrs: token.attrs }
      preText = ''
      preLanguage = ''
      continue
    }

    if (name === 'br') {
      // Marker rides through flushInline's whitespace collapse; page text
      // cannot contain NUL, so this is unambiguous.
      inline.push('\u0000')
      continue
    }
    if (name === 'hr') {
      endInlineBlock()
      if (mode === 'markdown' && !currentList() && !inCell()) emitBlock('---')
      continue
    }
    if (name === 'img') {
      const alt = (token.attrs['alt'] ?? '').replace(/[\[\]]/g, '')
      const src = token.attrs['src'] ?? token.attrs['data-src'] ?? ''
      if (mode === 'markdown' && src) {
        const title = token.attrs['title'] ?? ''
        inline.push(`![${alt}](${src}${title ? ` "${title}"` : ''})`)
      } else if (alt) {
        inline.push(alt)
      }
      continue
    }

    if (closing) {
      closeTag(name)
      continue
    }

    openTag(name, token)
  }
  // Close whatever the page left open so trailing content still flushes.
  while (stack.length > 0) {
    closeTag(stack[stack.length - 1]?.tag ?? '')
  }
  if (currentList()) {
    while (lists.length > 0) closeList()
  }
  // A page truncated inside <pre> (bounded fetches) or markup that never
  // closes it must not silently drop everything it held.
  if (preFrame) flushPre()
  emitBlock(flushInline())

  const joined = blocks.join('\n\n')
  return joined.replace(/\n{3,}/g, '\n\n').trim()

  /* ---- tag open/close, hoisted for the loop's readability ---- */

  function flushPre(): void {
    if (!preFrame) return
    // Fence sizing: never collide with a backtick run in the content.
    const runs = preText.match(/`+/g) ?? []
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
    const fence = '`'.repeat(Math.max(3, longest + 1))
    const body = preText.replace(/^\n/, '').replace(/\n$/, '')
    if (mode === 'markdown') {
      emitBlock(`${fence}${preLanguage}\n${body}\n${fence}`)
    } else {
      emitBlock(body)
    }
    preFrame = null
    preText = ''
    preLanguage = ''
  }

  function openTag(name: string, token: TagToken): void {
    if (stack.length > MAX_DEPTH) return
    // Commit the element this start tag implicitly closes before pushing
    // the new frame — closeTag must find the sibling, not this token.
    implicitCloseSibling(name)
    const frame: Frame = { tag: name, mark: inline.length, attrs: token.attrs }
    if (name === 'a' || HEADINGS[name] !== undefined || BLOCKISH.has(name) || name === 'blockquote' ||
        name === 'code' || name === 'kbd' || name === 'samp' || name === 'strong' || name === 'b' ||
        name === 'em' || name === 'i' || name === 'del' || name === 's' || name === 'strike' ||
        name === 'li' || name === 'ul' || name === 'ol' || name === 'dl' || name === 'dt' || name === 'dd' ||
        name === 'table' || name === 'tr' || name === 'td' || name === 'th' || name === 'thead' ||
        name === 'tbody' || name === 'tfoot' || name === 'summary' || name === 'details' || name === 'caption') {
      stack.push(frame)
    }
    if (name === 'a') return
    if (HEADINGS[name] !== undefined) return
    if (name === 'blockquote') {
      quoteDepth = Math.min(8, quoteDepth + 1)
      return
    }
    if (name === 'ul' || name === 'ol') {
      const item = openItems[openItems.length - 1]
      if (item) {
        // Text before the nested list belongs to the open item.
        item.text = `${item.text} ${flushInline()}`.trim()
      } else {
        endInlineBlock()
      }
      openList(name === 'ol')
      return
    }
    if (name === 'li') {
      flushInline()
      openItems.push({ text: '', blocks: [] })
      return
    }
    if (name === 'table') {
      const parent = currentTable()
      if (parent?.cellOpen) {
        // A nested table parks the surrounding cell's text and hands it
        // back on close; the cell keeps its content instead of losing it.
        parent.cellStash = `${parent.cellStash} ${flushInline()}`.trim()
      } else {
        endInlineBlock()
      }
      tables.push({ rows: [], headerFlags: [], row: null, rowHeader: [], colspanPad: [], cellStash: '', cellOpen: false })
      return
    }
    if (name === 'tr') {
      const frame = currentTable()
      if (frame) {
        frame.row = []
        frame.rowHeader = []
      }
      return
    }
    if (name === 'td' || name === 'th') {
      // An unclosed previous cell was committed by the sibling rule above;
      // this branch only opens the new one.
      const frame = currentTable()
      if (frame) frame.cellOpen = true
      flushInline()
      return
    }
    if (name === 'thead') return
    if (name === 'strong' || name === 'b') {
      if (mode === 'markdown') inline.push('**')
      return
    }
    if (name === 'em' || name === 'i') {
      if (mode === 'markdown') inline.push('*')
      return
    }
    if (name === 'del' || name === 's' || name === 'strike') {
      if (mode === 'markdown') inline.push('~~')
      return
    }
    if (name === 'code' || name === 'kbd' || name === 'samp') {
      if (mode === 'markdown' && !inCell()) inline.push('`')
      return
    }
    if (name === 'dt' || name === 'dd' || name === 'summary' || name === 'caption' || name === 'figcaption') {
      endInlineBlock()
      return
    }
    if (BLOCKISH.has(name)) {
      endInlineBlock()
    }
  }

  /** Run the optional-end-tag rules for one incoming start tag. */
  function implicitCloseSibling(name: string): void {
    const rule = SIBLING_CLOSES[name]
    if (!rule) return
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const tag = stack[i]?.tag
      if (!tag) continue
      if (rule.match.has(tag)) {
        closeTag(tag)
        return
      }
      const blocked = rule.through ? !rule.through.has(tag) : rule.shield?.has(tag) === true
      if (blocked) return
    }
  }

  function closeTag(name: string): void {
    // Find the frame this close belongs to; everything above it was left
    // open by sloppy markup and closes with it.
    let index = -1
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]?.tag === name) {
        index = i
        break
      }
    }
    if (index === -1) return
    const frame = stack[index]
    if (!frame) return
    const framesAbove = stack.splice(index + 1)
    stack.pop()
    for (const open of framesAbove.reverse()) {
      applyClose(open.tag, open, true)
    }
    applyClose(name, frame, false)
  }

  function applyClose(name: string, frame: Frame, implicit: boolean): void {
    if (name === 'a') {
      const href = frame.attrs['href'] ?? ''
      wrapMarked(frame, (content) => {
        const text = content.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim()
        if (mode !== 'markdown' || !href || !/^https?:/i.test(href)) return text
        return text.length > 0 ? `[${text}](${href})` : ''
      })
      return
    }
    if (HEADINGS[name] !== undefined) {
      const level = HEADINGS[name] ?? 1
      const content = flushInline()
      if (currentList() || inCell()) {
        inline.push(content)
        return
      }
      if (mode === 'markdown') {
        emitBlock(`${'#'.repeat(Math.min(6, level))} ${content}`)
      } else {
        emitBlock(content)
      }
      return
    }
    if (name === 'blockquote') {
      quoteDepth = Math.max(0, quoteDepth - 1)
      return
    }
    if (name === 'ul' || name === 'ol') {
      closeList()
      return
    }
    if (name === 'li') {
      closeItem()
      return
    }
    if (name === 'table') {
      const frame = tables.pop()
      if (frame) {
        if (frame.row) {
          frame.rows.push(frame.row)
          frame.headerFlags.push(frame.rowHeader.some(Boolean))
          frame.row = null
        }
        renderTable(frame)
        // The surrounding cell, if any, resumes with the text it parked
        // when this nested table opened.
        const parent = currentTable()
        if (parent?.cellOpen && parent.cellStash) {
          inline.push(parent.cellStash)
          parent.cellStash = ''
        }
      }
      return
    }
    if (name === 'tr') {
      const frame = currentTable()
      if (frame?.row) {
        frame.rows.push(frame.row)
        frame.headerFlags.push(frame.rowHeader.some(Boolean))
        frame.row = null
      }
      return
    }
    if (name === 'td' || name === 'th') {
      const open = currentTable()
      if (open) {
        open.cellOpen = false
        // A colspan pads the row so the pipe columns still line up.
        // The cap keeps a hostile attribute from ballooning the row.
        const span = Math.min(64, Math.max(1, Math.trunc(Number(frame.attrs['colspan'] ?? '1')) || 1))
        open.colspanPad.push(span - 1)
      }
      closeCell(name === 'th')
      return
    }
    if (name === 'strong' || name === 'b') {
      if (mode === 'markdown') inline.push('**')
      return
    }
    if (name === 'em' || name === 'i') {
      if (mode === 'markdown') inline.push('*')
      return
    }
    if (name === 'del' || name === 's' || name === 'strike') {
      if (mode === 'markdown') inline.push('~~')
      return
    }
    if (name === 'code' || name === 'kbd' || name === 'samp') {
      if (mode === 'markdown' && !inCell()) inline.push('`')
      return
    }
    if (name === 'dt' || name === 'dd' || name === 'summary' || name === 'caption' || name === 'figcaption') {
      const content = flushInline()
      if (mode === 'markdown' && name === 'dt') {
        emitBlock(`**${content}**`)
      } else if (mode === 'markdown' && name === 'summary') {
        emitBlock(`**${content}**`)
      } else {
        emitBlock(name === 'dd' ? `  ${content}` : content)
      }
      return
    }
    if (BLOCKISH.has(name) || name === 'details' || name === 'dl') {
      endInlineBlock()
      if (implicit) return
    }
  }
}

/* ---------- escaping ---------- */

/** Keep page text from smuggling markdown structure into the output. */
function escapeMarkdown(text: string, inCode: boolean): string {
  if (inCode) return text.replace(/`/g, '')
  return text
    .replace(/([\\`*_[\]])/g, '\\$1')
    .replace(/^(\s*)([#>+\-*]|\d+[.)])(\s)/, '$1\\$2$3')
}

/** Cell text cannot break the pipe table it lands in. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}
