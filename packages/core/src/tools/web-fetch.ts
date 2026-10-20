import { lookup } from 'node:dns/promises'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { headTail } from '../util.js'

const TIMEOUT_MS = 15_000
const MAX_BYTES = 2_000_000
const MAX_REDIRECTS = 8

/** Parse the numeric forms inet_aton accepts (dotted quad, a.b, a.b.c, plain
 *  or hex integer like `2130706433` / `0x7f000001` / `127.1`) into a 32-bit
 *  value, or null when the string is not an IPv4 literal. Without this a URL
 *  like http://2130706433/ dodges the dotted-quad private-range check while
 *  still resolving to loopback. */
export function parseIpv4Literal(host: string): number | null {
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return null
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null
  const parts = host.split('.')
  if (parts.length > 4) return null
  const nums: number[] = []
  for (const part of parts) {
    let n: number
    if (/^0[xX]/.test(part)) {
      if (part.length <= 2) return null
      n = Number.parseInt(part.slice(2), 16)
    } else if (part.length > 1 && part.startsWith('0')) {
      n = Number.parseInt(part.slice(1), 8)
    } else {
      n = Number.parseInt(part, 10)
    }
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null
    nums.push(n)
  }
  const tail = nums.at(-1)
  if (tail === undefined) return null
  const head = nums.slice(0, -1)
  for (const h of head) if (h > 255) return null
  const tailBits = 8 * (4 - head.length)
  if (tail >= 2 ** tailBits) return null
  let value = head.reduce((acc, h) => (acc << 8) | h, 0)
  value = (value << tailBits) | tail
  return value >>> 0
}

function isPrivateIpv4(value: number): boolean {
  const a = (value >>> 24) & 255
  const b = (value >>> 16) & 255
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a >= 224) return true // multicast + reserved
  return false
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  // IPv4-mapped and v4-compatible spellings in both dotted and hex form:
  // ::ffff:127.0.0.1, ::127.0.0.1, ::ffff:7f00:1, ::7f00:1 — all reach
  // loopback on connect, so all must read as private here.
  const embedded = h.match(/^::(?:ffff:)?([0-9.]+)$/)
  if (embedded?.[1]) {
    const v4 = parseIpv4Literal(embedded[1])
    if (v4 !== null) return isPrivateIpv4(v4)
  }
  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  const compatV4 = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  const pair = hexMapped ?? compatV4
  if (pair?.[1] !== undefined && pair[2] !== undefined) {
    const hi = Number.parseInt(pair[1], 16)
    const lo = Number.parseInt(pair[2], 16)
    if (Number.isInteger(hi) && Number.isInteger(lo)) {
      return isPrivateIpv4(((hi << 16) | lo) >>> 0)
    }
  }
  if (h === '::' || h === '::1') return true
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true // fc00::/7 ULA
  return false
}

/** Whether `address` (a resolved IP literal) points at private space. */
export function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) return isPrivateIpv6(address)
  const v4 = parseIpv4Literal(address)
  return v4 !== null ? isPrivateIpv4(v4) : false
}

/** Hosts a fetch tool must never touch: loopback, link-local and RFC1918 space. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true
  }
  if (host.includes(':')) return isPrivateIpv6(host)
  const v4 = parseIpv4Literal(host)
  if (v4 !== null) return isPrivateIpv4(v4)
  return false
}

/** Resolve the host and refuse when any resolved address lands in private
 *  space — closes the DNS-rebinding / nip.io hole the hostname-only check
 *  leaves open. Resolution trouble is left to fetch: an unresolvable host
 *  fails the request with its own ENOTFOUND instead of a misleading
 *  "private address" refusal. */
async function resolvedAddressIsBlocked(hostname: string): Promise<boolean> {
  // URL.hostname keeps the brackets on an IPv6 literal; dns.lookup wants
  // the bare address.
  const bare = hostname.replace(/^\[|\]$/g, '')
  try {
    const addrs = await lookup(bare, { all: true, verbatim: true })
    if (addrs.length === 0) return true
    return addrs.some((a) => isPrivateAddress(a.address))
  } catch {
    return false
  }
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

function safeCodePoint(code: number): string | null {
  // Out-of-range values (> 0x10ffff) and lone surrogates make
  // String.fromCodePoint throw a RangeError, which would take the whole
  // turn down over one malformed entity.
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null
  if (code >= 0xd800 && code <= 0xdfff) return null
  return String.fromCodePoint(code)
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return safeCodePoint(code) ?? whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return safeCodePoint(code) ?? whole
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

async function readResponse(res: Response, url: URL, ctx: ToolContext): Promise<ToolOutcome> {
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
    void res.body?.cancel().catch(() => {})
    return { output: `error: ${url} serves binary content (${type.split(';')[0]}) — nothing to read`, ok: false }
  }

  // Stream the body under the byte cap instead of buffering it whole —
  // a hostile or runaway server otherwise gets to fill memory up to the
  // 15 s timeout before the size check ever runs.
  let buffer: Uint8Array
  if (!res.body) {
    buffer = new Uint8Array(0)
  } else {
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let overCap = false
    while (true) {
      let step
      try {
        step = await reader.read()
      } catch (err) {
        if (ctx.signal.aborted) return { output: 'error: fetch aborted', ok: false }
        return { output: `error: read failed: ${err instanceof Error ? err.message : String(err)}`, ok: false }
      }
      if (step.done) break
      const value = step.value
      if (!value) continue
      total += value.byteLength
      if (total > MAX_BYTES) {
        overCap = true
        void reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
    }
    if (overCap) {
      return {
        output: `error: body too large (over ${(MAX_BYTES / 1_048_576).toFixed(0)} MB, cap reached while reading)`,
        ok: false,
      }
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    buffer = out
  }
  let body = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (type.includes('html')) body = htmlToText(body)
  const text = headTail(body.trim(), 8_000, 2_000)
  if (!text) return { output: `no readable text at ${url}`, ok: true }
  return {
    output: `${url}\n(content-type: ${type.split(';')[0] || 'unknown'}, ${buffer.byteLength} bytes)\n\n${text}`,
    ok: true,
  }
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

    const refused = (host: string): ToolOutcome => ({
      output: `error: refused to fetch a private address: ${host}`,
      ok: false,
    })

    // Walk redirects by hand: 'follow' would connect to whatever the final
    // Location points at without re-checking it, so a public URL could 302
    // the fetch into loopback or the cloud metadata endpoint.
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (isBlockedHost(current.hostname)) return refused(current.hostname)
      if (await resolvedAddressIsBlocked(current.hostname)) return refused(current.hostname)

      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const signal = AbortSignal.any([ctx.signal, timeout])
      let res: Response
      try {
        res = await fetch(current, {
          redirect: 'manual',
          headers: { accept: 'text/html,text/plain,application/json,text/*;q=0.8,*/*;q=0.5' },
          signal,
        })
      } catch (err) {
        if (ctx.signal.aborted) return { output: 'error: fetch aborted', ok: false }
        return { output: `error: fetch failed: ${err instanceof Error ? err.message : String(err)}`, ok: false }
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location')
        void res.body?.cancel().catch(() => {})
        if (!location) {
          return { output: `error: http ${res.status} without a location header for ${current}`, ok: false }
        }
        try {
          const next = new URL(location, current)
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return { output: `error: redirect to a non-http(s) url: ${next.protocol}`, ok: false }
          }
          current = next
          continue
        } catch {
          return { output: `error: redirect to an invalid url: ${location}`, ok: false }
        }
      }
      return await readResponse(res, current, ctx)
    }
    return { output: `error: too many redirects (more than ${MAX_REDIRECTS})`, ok: false }
  },
}
