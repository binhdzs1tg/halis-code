/**
 * Streaming markdown without full re-renders.
 *
 * Re-rendering the whole message on every chunk is quadratic; instead the
 * message is split into top-level blocks and everything but the last few is
 * frozen — their elements are appended once and never touched again, while
 * only the unstable tail is re-rendered each frame. The idea and the freeze
 * window come from DeepSeek Harness's `IncrementalMarkdownParser`; the DOM
 * shape here is flattened to what a vanilla renderer needs.
 *
 * The block splitter runs on the same grammar the full renderer uses (fences
 * override everything, headings and rules stand alone, blank lines separate
 * the rest), and the settled message gets one full pass at the end, which
 * self-heals any boundary disagreement.
 */
import { renderMarkdown } from './markdown'

/** How many trailing blocks stay live and re-rendered per frame. */
const TAIL_BLOCKS = 2

interface Block {
  /** Block text including the trailing newline, as it sits in the source. */
  text: string
}

/**
 * Split source into top-level blocks. Fenced code wins over blank-line rules;
 * headings and horizontal rules are one-line blocks; everything else groups
 * consecutive non-blank lines.
 */
export function splitBlocks(source: string): Block[] {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let current: string[] = []

  const flush = (): void => {
    if (current.length > 0) {
      blocks.push({ text: current.join('\n') + '\n' })
      current = []
    }
  }

  let fence = false
  for (const line of lines) {
    if (fence) {
      current.push(line)
      if (/^\s*```\s*$/.test(line)) fence = false
      continue
    }
    if (/^\s*```/.test(line)) {
      flush()
      current.push(line)
      fence = true
      continue
    }
    if (/^#{1,6}\s+/.test(line) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flush()
      blocks.push({ text: line + '\n' })
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  if (fence) {
    // Stream cut off inside an open fence: it is its own block and stays in
    // the tail until it closes.
    flush()
  }
  return blocks
}

function renderBlock(text: string): HTMLElement {
  const host = document.createElement('div')
  host.className = 'md-block'
  host.innerHTML = renderMarkdown(text.replace(/\n$/, ''))
  return host
}

export class StreamingMarkdown {
  private readonly container: HTMLElement
  private readonly tailHost: HTMLElement
  private frozen = 0
  private previous = ''

  constructor(container: HTMLElement) {
    this.container = container
    this.tailHost = document.createElement('div')
    this.tailHost.className = 'md-tail'
    container.appendChild(this.tailHost)
  }

  /**
   * Feed the accumulated source. Appends freeze settled blocks once and
   * re-render only the tail; non-appending input rebuilds everything.
   */
  update(source: string): void {
    if (source.length === 0) return
    if (!source.startsWith(this.previous)) this.reset()
    this.previous = source

    const blocks = splitBlocks(source)
    const settleCount = Math.max(0, blocks.length - TAIL_BLOCKS)

    if (settleCount > this.frozen) {
      // Newly settled blocks render once, straight into the container ahead
      // of the tail host.
      const anchor = this.container.querySelector('.md-tail')
      for (let i = this.frozen; i < settleCount; i += 1) {
        anchor?.before(renderBlock(blocks[i].text))
      }
      this.frozen = settleCount
    }

    const tailText = blocks
      .slice(settleCount)
      .map((block) => block.text)
      .join('')
      .replace(/\n$/, '')
    this.tailHost.innerHTML = renderMarkdown(tailText)
  }

  /**
   * Final full render; replaces the whole stream output so the settled
   * message is exactly what a plain renderMarkdown pass would produce.
   */
  settle(source: string): void {
    this.reset()
    this.container.innerHTML = renderMarkdown(source)
  }

  reset(): void {
    this.container.replaceChildren(this.tailHost)
    this.frozen = 0
    this.previous = ''
  }
}
