import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { headTail } from '../util.js'

const TIMEOUT_MS = 15_000
const MAX_BYTES = 2_000_000

/** Hosts a fetch tool must never touch: loopback, link-local and RFC1918 space. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true
  }
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  return false
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|tr|table|h[1-6]|blockquote|pre|section|article|header|footer|nav|hr)[^>]*>/gi

/** HTML to readable plain text — headings and paragraphs become lines, tags go away. */
export function htmlToText(html: string): string {
  let text = html
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  text = text.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
  text = text.replace(BLOCK_TAGS, '\n')
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (title) {
    const heading = decodeEntities(title[1] ?? '').replace(/\s+/g, ' ').trim()
    if (heading) text = `${heading}\n\n${text}`
  }
  return text
}

export const webFetchTool: Tool = {
  spec: {
    name: 'web_fetch',
    description:
      'Fetch one http(s) URL and return its body as plain text (HTML is converted). ' +
      'Good for docs, changelogs, raw files and API responses. Binary content and ' +
      'private/loopback addresses are refused. Media links, logins and paywalls will not work.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
      },
      required: ['url'],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const raw = typeof input.url === 'string' ? input.url.trim() : ''
    if (!raw) return { output: 'error: url is required', ok: false }
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return { output: `error: not a valid url: ${raw}`, ok: false }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { output: `error: only http and https are supported, got ${url.protocol}`, ok: false }
    }
    if (isBlockedHost(url.hostname)) {
      return { output: `error: refused to fetch a private address: ${url.hostname}`, ok: false }
    }

    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const signal = AbortSignal.any([ctx.signal, timeout])
    let res: Response
    try {
      res = await fetch(url, {
        redirect: 'follow',
        headers: { accept: 'text/html,text/plain,application/json,text/*;q=0.8,*/*;q=0.5' },
        signal,
      })
    } catch (err) {
      if (ctx.signal.aborted) return { output: 'error: fetch aborted', ok: false }
      return { output: `error: fetch failed: ${err instanceof Error ? err.message : String(err)}`, ok: false }
    }
    if (!res.ok) {
      return { output: `error: http ${res.status} ${res.statusText} for ${url}`, ok: false }
    }

    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    const looksBinary =
      type.includes('image/') ||
      type.includes('audio/') ||
      type.includes('video/') ||
      type.includes('font') ||
      type.includes('octet-stream') ||
      type.includes('pdf') ||
      type.includes('zip')
    if (looksBinary) {
      return { output: `error: ${url} serves binary content (${type.split(';')[0]}) — nothing to read`, ok: false }
    }

    const buffer = await res.arrayBuffer()
    if (buffer.byteLength > MAX_BYTES) {
      return {
        output: `error: body too large (${(buffer.byteLength / 1_048_576).toFixed(1)} MB, cap ${(MAX_BYTES / 1_048_576).toFixed(0)} MB)`,
        ok: false,
      }
    }
    let body = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    if (type.includes('html')) body = htmlToText(body)
    const text = headTail(body.trim(), 8_000, 2_000)
    if (!text) return { output: `no readable text at ${url}`, ok: true }
    return {
      output: `${url}\n(content-type: ${type.split(';')[0] || 'unknown'}, ${buffer.byteLength} bytes)\n\n${text}`,
      ok: true,
    }
  },
}
