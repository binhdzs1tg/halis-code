/**
 * ANSI terminal output rendering, no dependencies.
 *
 * This parser keeps the
 * useful subset — SGR colors, bold/dim/italic/underline, 256-color and
 * truecolor — and builds DOM spans directly with `textContent`, so raw bytes
 * never become HTML. The writer is stateful across chunks: escape sequences
 * split mid-sequence by a stream boundary are held until complete.
 *
 * Everything else (cursor movement, OSC titles, other escapes) is stripped.
 */

const ESC = '\x1b'
const BEL = '\x07'

/** A partial escape held longer than this is binary noise, not a split sequence. */
const MAX_PENDING_ESCAPE = 1024

const PALETTE_16 = [
  '#414855', '#ec6a88', '#3fdaa4', '#f9c859', '#6d95f1', '#d175d1', '#56c8d8', '#c5cbd8',
  '#6c7480', '#f08484', '#6ce8b1', '#ffd98e', '#93b3ff', '#e8a3e8', '#7cdce4', '#f0f2f5'
]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

/** Clamp to the valid 0-255 range; malformed SGR passes garbage in. */
function channel(value: number): number {
  return Math.min(255, Math.max(0, Math.trunc(value)))
}

/** CSS color for a 256-color index. */
function color256(rawIndex: number): string {
  const index = channel(rawIndex)
  if (index < 16) return PALETTE_16[index] ?? '#c5cbd8'
  if (index < 232) {
    const n = index - 16
    const r = CUBE_LEVELS[Math.floor(n / 36)]
    const g = CUBE_LEVELS[Math.floor((n % 36) / 6)]
    const b = CUBE_LEVELS[n % 6]
    return `rgb(${r}, ${g}, ${b})`
  }
  const gray = 8 + (index - 232) * 10
  return `rgb(${gray}, ${gray}, ${gray})`
}

interface AnsiStyle {
  /** Palette index 0-255, or -1 when a computed `fgValue` is set. */
  fg: number | null
  bg: number | null
  fgValue?: string
  bgValue?: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

function defaultStyle(): AnsiStyle {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false }
}

function styleKey(style: AnsiStyle): string {
  return `${style.fg}|${style.fgValue ?? ''}|${style.bg}|${style.bgValue ?? ''}|${
    style.bold ? 1 : 0
  }${style.dim ? 1 : 0}${style.italic ? 1 : 0}${style.underline ? 1 : 0}`
}

function applySgr(style: AnsiStyle, codes: number[]): void {
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]
    if (code === undefined) break
    if (code === 0) {
      delete style.fgValue
      delete style.bgValue
      Object.assign(style, defaultStyle())
    } else if (code === 1) {
      style.bold = true
    } else if (code === 2) {
      style.dim = true
    } else if (code === 3) {
      style.italic = true
    } else if (code === 4) {
      style.underline = true
    } else if (code === 22) {
      style.bold = false
      style.dim = false
    } else if (code === 23) {
      style.italic = false
    } else if (code === 24) {
      style.underline = false
    } else if (code >= 30 && code <= 37) {
      style.fg = code - 30
    } else if (code === 39) {
      style.fg = null
    } else if (code >= 40 && code <= 47) {
      style.bg = code - 40
    } else if (code === 49) {
      style.bg = null
    } else if (code >= 90 && code <= 97) {
      style.fg = code - 90 + 8
    } else if (code >= 100 && code <= 107) {
      style.bg = code - 100 + 8
    } else if (code === 38 || code === 48) {
      // extended color: 38;5;<index> or 38;2;<r>;<g>;<b>
      const mode = codes[i + 1]
      const assign = (value: string): void => {
        if (code === 38) {
          style.fg = -1
          style.fgValue = value
        } else {
          style.bg = -1
          style.bgValue = value
        }
      }
      if (mode === 5 && codes.length >= i + 3) {
        assign(color256(codes[i + 2] ?? 0))
        i += 2
      } else if (mode === 2 && codes.length >= i + 5) {
        const r = channel(codes[i + 2] ?? 0)
        const g = channel(codes[i + 3] ?? 0)
        const b = channel(codes[i + 4] ?? 0)
        assign(`rgb(${r}, ${g}, ${b})`)
        i += 4
      } else {
        break // incomplete sequence; stop consuming
      }
    }
  }
}

/**
 * Parse an SGR parameter body ("1;32", "" for reset, "38;5;208") into codes;
 * an empty body means a single reset, exactly like a bare ESC[m.
 */
function parseSgr(body: string): number[] {
  if (body.length === 0) return [0]
  const codes = body.split(';').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
  // ESC[;m is ESC[0;m — an empty slot resets, per the spec.
  if (codes.length === 1 && body.trim() === '') return [0]
  return codes
}

function paint(style: AnsiStyle, span: HTMLElement): void {
  if (style.bold) span.classList.add('ansi-bold')
  if (style.dim) span.classList.add('ansi-dim')
  if (style.italic) span.classList.add('ansi-italic')
  if (style.underline) span.classList.add('ansi-underline')
  if (style.fg !== null) {
    if (style.fg === -1) span.style.color = style.fgValue ?? ''
    else if (style.fg < 16) span.classList.add(`ansi-fg${style.fg}`)
    else span.style.color = color256(style.fg)
  }
  if (style.bg !== null) {
    if (style.bg === -1) span.style.backgroundColor = style.bgValue ?? ''
    else if (style.bg < 16) span.classList.add(`ansi-bg${style.bg}`)
    else span.style.backgroundColor = color256(style.bg)
  }
}

function isIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f
}

function isFinalByte(code: number): boolean {
  return code >= 0x30 && code <= 0x7e
}

export class AnsiWriter {
  private readonly target: HTMLElement
  private current: HTMLElement | null = null
  private currentKey = ''
  private style: AnsiStyle = defaultStyle()
  /** Incomplete escape sequence carried over from the previous chunk. */
  private pending = ''
  /** Characters of visible text written since the last reset. */
  written = 0

  constructor(target: HTMLElement) {
    this.target = target
  }

  write(chunk: string): void {
    const data = this.pending + chunk
    this.pending = ''
    let text = ''
    let i = 0

    const flush = (): void => {
      if (text.length === 0) return
      this.pushText(text)
      text = ''
    }

    while (i < data.length) {
      const ch = data[i]
      if (ch !== ESC) {
        text += ch
        i += 1
        continue
      }
      const next = data[i + 1]
      if (next === '[') {
        // CSI: parameters and one final byte in @..~
        const end = this.findCsiEnd(data, i + 2)
        if (end === -1) {
          flush()
          const rest = data.slice(i)
          if (rest.length > MAX_PENDING_ESCAPE) {
            // Never completes: binary output, not a sequence split by the
            // stream boundary. Drop it so the terminal keeps flowing.
            this.pending = ''
            return
          }
          this.pending = rest
          return
        }
        flush()
        const body = data.slice(i + 2, end)
        if (data[end] === 'm') {
          applySgr(this.style, parseSgr(body))
          this.current = null // next text re-opens a span with the new style
        }
        i = end + 1
        continue
      }
      if (next === ']') {
        // OSC: terminated by BEL or ESC backslash
        const bel = data.indexOf(BEL, i + 2)
        const st = data.indexOf(`${ESC}\\`, i + 2)
        if (bel === -1 && st === -1) {
          flush()
          const rest = data.slice(i)
          if (rest.length > MAX_PENDING_ESCAPE) {
            this.pending = ''
            return
          }
          this.pending = rest
          return
        }
        flush()
        if (bel !== -1 && (st === -1 || bel < st)) i = bel + 1
        else i = st + 2
        continue
      }
      // A chunk ending right at ESC: hold it like the CSI/OSC cases hold
      // their open sequences, or the next chunk's continuation leaks as
      // visible text ("[31mRED") instead of color.
      if (next === undefined) {
        flush()
        this.pending = ch
        return
      }
      // ESC followed by intermediate bytes (0x20-0x2F) runs to one final
      // byte (0x30-0x7E): "ESC ( B" designating a charset is three bytes,
      // so consuming only two would leak the final byte as visible text.
      if (isIntermediate(data.charCodeAt(i + 1))) {
        flush()
        let j = i + 1
        while (j < data.length && isIntermediate(data.charCodeAt(j))) j += 1
        if (j >= data.length) {
          // Split mid-sequence; hold the intermediates like the CSI/OSC
          // cases hold their open sequences.
          const rest = data.slice(i)
          if (rest.length > MAX_PENDING_ESCAPE) {
            this.pending = ''
            return
          }
          this.pending = rest
          return
        }
        i = isFinalByte(data.charCodeAt(j)) ? j + 1 : j
        continue
      }
      // any other escape: consume both characters
      flush()
      i += 2
    }
    flush()
  }

  /** Drop everything, including a half-received escape sequence. */
  reset(): void {
    this.target.replaceChildren()
    this.current = null
    this.currentKey = ''
    this.style = defaultStyle()
    this.pending = ''
    this.written = 0
  }

  /** Trim the oldest output once more than `max` visible chars are kept. */
  trim(max: number): void {
    while (this.written > max && this.target.firstChild) {
      const first = this.target.firstChild as HTMLElement | Text
      // Echo rows appended outside the writer carry no budgeted bytes, so
      // removing one must not push `written` down (the cap would under-fire
      // from then on).
      const echo = first instanceof HTMLElement && first.dataset.echo === 'true'
      const length = echo ? 0 : (first.textContent ?? '').length
      // The live span can be the oldest node once one run of plain text
      // outgrows the cap; drop the cursor with it or every later chunk
      // keeps flowing into a detached node nobody renders.
      if (first === this.current) {
        this.current = null
        this.currentKey = ''
      }
      this.written = Math.max(0, this.written - length)
      first.remove()
    }
  }

  private findCsiEnd(data: string, from: number): number {
    for (let i = from; i < data.length; i += 1) {
      const code = data.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return i
    }
    return -1
  }

  private pushText(text: string): void {
    this.written += text.length
    const key = styleKey(this.style)
    if (!this.current || key !== this.currentKey) {
      this.current = document.createElement('span')
      this.currentKey = key
      paint(this.style, this.current)
      this.target.appendChild(this.current)
    }
    this.current.appendChild(document.createTextNode(text))
  }
}

/** Remove every escape sequence; for plain-text surfaces like tool rows. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // ESC + intermediates + final byte, e.g. "ESC ( B" — the generic rule
    // below would leave the final byte behind as text.
    .replace(/\x1b[ -/]+[\x30-\x7e]/g, '')
    .replace(/\x1b./g, '')
}
