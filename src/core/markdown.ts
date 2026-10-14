/**
 * Minimal Markdown renderer for chat messages.
 *
 * No dependencies, and intentionally no raw HTML passthrough: the block
 * parser runs on the raw source and every piece of text is HTML-escaped at
 * the last moment before it lands in markup. Covers what model replies
 * actually use day to day — fenced code blocks, inline code, emphasis,
 * headings, lists, quotes, links and rules. Fenced blocks get lightweight
 * syntax highlighting from ./highlight.
 */

import { highlightCode } from './highlight'

export function renderMarkdown(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []

  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] = []
  let code: { lang: string; lines: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
      paragraph = []
    }
  }
  const flushList = (): void => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`)
      list = null
    }
  }
  const flushQuote = (): void => {
    if (quote.length > 0) {
      out.push(`<blockquote>${quote.map((line) => inline(line)).join('<br>')}</blockquote>`)
      quote = []
    }
  }
  const flushAll = (): void => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const line of lines) {
    if (code) {
      // Only a bare fence line closes a block; anything else is code.
      if (/^\s*```\s*$/.test(line)) {
        out.push(renderCode(code.lang, code.lines, true))
        code = null
      } else {
        code.lines.push(line)
      }
      continue
    }
    if (/^\s*```/.test(line)) {
      flushAll()
      code = { lang: line.trim().slice(3).trim(), lines: [] }
      continue
    }

    if (line.trim() === '') {
      flushAll()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushAll()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushAll()
      out.push('<hr>')
      continue
    }

    // Quotes are matched on the raw line; inline() escapes the payload.
    const quoteLine = line.match(/^>\s?(.*)$/)
    if (quoteLine) {
      flushParagraph()
      flushList()
      quote.push(quoteLine[1])
      continue
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || ordered) {
      flushParagraph()
      flushQuote()
      const item = (bullet ?? ordered)![1]
      const wanted = Boolean(ordered)
      if (!list || list.ordered !== wanted) {
        flushList()
        list = { ordered: wanted, items: [] }
      }
      list.items.push(item)
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line)
  }

  flushAll()
  if (code) {
    // Stream cut off in the middle of a code block.
    out.push(renderCode(code.lang, code.lines, false))
  }
  return out.join('')
}

function renderCode(lang: string, lines: string[], closed: boolean): string {
  const label = escapeHtml(lang || 'text')
  const body = highlightCode(lines.join('\n'), lang)
  return (
    `<div class="code-block${closed ? '' : ' open'}">` +
    `<div class="code-head"><span>${label}</span><button class="copy-code" type="button">Copy</button></div>` +
    `<pre><code>${body}</code></pre>` +
    '</div>'
  )
}

/** Inline spans: code, bold, italic, strike, links. Escape first, then build. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n][^*]*?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
