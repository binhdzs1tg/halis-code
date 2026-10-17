/**
 * Web fetch tool: pull one http(s) URL and hand the page to the model as
 * Markdown, plain text or raw HTML. Bodies are bounded, only textual
 * content types pass, and private-network hosts are refused — an agent
 * must not be a free proxy into the intranet. Redirects are followed by
 * hand so every hop passes the private-network guard, not just the URL
 * the model asked for.
 */
import dns from 'node:dns/promises'
import net from 'node:net'
import { htmlToMarkdown, htmlToText } from './html-to-markdown'
import type { ToolOutcome } from './tools'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Textual content types worth feeding to a model; everything else is a binary refusal. */
const TEXTUAL_TYPES = [/^text\//i, /^application\/json/i, /^application\/xml/i, /^application\/xhtml/i, /\+(json|xml)$/i]
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const PLAIN_UA = 'halis-code/0.1 (+https://github.com/binhdzs1tg/halis-code)'

export const WEB_FETCH_TOOL_SPEC = {
  name: 'web_fetch',
  description:
    'Fetch a single http(s) URL and return the page as Markdown (default), ' +
    'plain text or raw HTML. Scripts, styles and other non-content markup are ' +
    'stripped; the body is capped and the final URL after redirects is reported.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html'],
        description: 'How to return HTML pages (default markdown; non-HTML types always come back raw)'
      },
      timeout_ms: { type: 'integer', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` }
    },
    required: ['url']
  }
} as const

/** Guard refusals travel distinctly so the tool reports them as refusals, not as network failures. */
class RefusedError extends Error {}

interface FetchSession {
  response: Response
  finalUrl: URL
  /** Restart the inactivity timer — call it as each body chunk arrives. */
  arm: () => void
  /** Clear the timer and drop the run-signal listener. */
  release: () => void
}

export async function webFetchTool(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
  const raw = typeof input.url === 'string' ? input.url.trim() : ''
  if (raw.length === 0) {
    throw new Error('Parameter "url" must be a non-empty string.')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be fetched.')
  }

  const format = input.format === 'text' || input.format === 'html' ? input.format : 'markdown'
  const timeout = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1_000, numberOr(input.timeout_ms, DEFAULT_TIMEOUT_MS))
  )

  /**
   * Fetch one URL with `redirect: 'manual'` and walk Location headers
   * ourselves. A public URL that redirects into the intranet is refused at
   * the hop, exactly like a direct request for it would be.
   */
  const follow = async (ua: string): Promise<FetchSession> => {
    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), timeout)
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), timeout)
    }
    const release = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    let current = url
    try {
      for (let redirects = 0; ; redirects += 1) {
        await requirePublicHost(current.hostname)
        const response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': ua,
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5'
          }
        })
        if (!REDIRECT_STATUSES.has(response.status)) {
          return { response, finalUrl: current, arm, release }
        }
        void response.body?.cancel().catch(() => {})
        const location = response.headers.get('location')
        if (location === null) {
          throw new Error(`Redirect ${response.status} without a Location header.`)
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects fetching ${url.host}.`)
        }
        const next = new URL(location, current)
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error(`Refusing to follow a redirect to ${next.protocol} — only http and https are fetchable.`)
        }
        current = next
      }
    } catch (err) {
      release()
      if (!(signal.aborted || err instanceof RefusedError) && controller.signal.aborted) {
        throw new Error(`Timed out after ${Math.round(timeout / 1000)}s`)
      }
      throw err
    }
  }

  let session: FetchSession
  try {
    session = await follow(BROWSER_UA)
    // Some hosts 403 unknown-looking browsers; one retry as the plain
    // client we actually are.
    if (session.response.status === 403) {
      const first = session
      try {
        session = await follow(PLAIN_UA)
      } catch (err) {
        first.release()
        void first.response.body?.cancel().catch(() => {})
        throw err
      }
      first.release()
      void first.response.body?.cancel().catch(() => {})
    }
  } catch (err) {
    if (err instanceof RefusedError) return { ok: false, output: err.message }
    if (signal.aborted) return { ok: false, output: 'cancelled' }
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, output: `Could not reach ${url.host}: ${reason}` }
  }

  try {
    const type = session.response.headers.get('content-type') ?? ''
    if (!TEXTUAL_TYPES.some((pattern) => pattern.test(type))) {
      // Release the socket: an unconsumed body of a big binary would hold
      // the connection (and its buffers) open for nothing.
      void session.response.body?.cancel().catch(() => {})
      return {
        ok: false,
        output: `Refusing to fetch "${type || 'unknown content type'}" — web_fetch reads text pages, not binaries or images.`
      }
    }

    const { bytes, truncated } = await readBounded(session)
    const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? sniffCharset(bytes)
    let body: string
    try {
      body = new TextDecoder(charset?.toLowerCase() === 'utf-8' || charset === undefined ? 'utf-8' : charset).decode(bytes)
    } catch {
      body = new TextDecoder('utf-8').decode(bytes)
    }

    const statusNote = session.response.ok
      ? ''
      : `HTTP ${session.response.status} ${session.response.statusText || ''}`.trim() + '\n\n'
    if (format === 'html' || !isHtml(type, bytes)) {
      return { ok: session.response.ok, output: statusNote + body }
    }
    if (format === 'text') {
      return { ok: session.response.ok, output: statusNote + htmlToText(body) }
    }
    return {
      ok: session.response.ok,
      output: statusNote + htmlToMarkdown(body) + tailNotes(session.response, url, session.finalUrl, truncated)
    }
  } catch (err) {
    if (signal.aborted) return { ok: false, output: 'cancelled' }
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, output: `Could not read ${url.host}: ${reason}` }
  } finally {
    session.release()
  }
}

function tailNotes(response: Response, requested: URL, finalUrl: URL, truncated: boolean): string {
  const notes: string[] = []
  if (finalUrl.toString() !== requested.toString()) {
    notes.push(`Final URL after redirects: ${response.url || finalUrl.toString()}`)
  }
  if (truncated) {
    notes.push('Body truncated at 5 MB.')
  }
  return notes.length > 0 ? `\n\n(${notes.join(' ')})` : ''
}

/** Read at most MAX_BODY_BYTES; the rest of the stream is discarded.
 *  The inactivity timer keeps running through the body so a slow-drip
 *  response cannot park the run, and a run cancel aborts the read. */
async function readBounded(session: FetchSession): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const declared = Number(session.response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { bytes: new Uint8Array(0), truncated: true }
  }
  const reader = session.response.body?.getReader()
  if (!reader) {
    return { bytes: new Uint8Array(0), truncated: false }
  }
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    for (;;) {
      session.arm()
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.length
        if (total <= MAX_BODY_BYTES) {
          chunks.push(value)
        } else if (!truncated) {
          truncated = true
        }
      }
    }
    const bytes = new Uint8Array(Math.min(total, MAX_BODY_BYTES))
    let offset = 0
    for (const chunk of chunks) {
      if (offset >= bytes.length) break
      const slice = chunk.subarray(0, bytes.length - offset)
      bytes.set(slice, offset)
      offset += slice.length
    }
    return { bytes, truncated }
  } finally {
    session.release()
    void reader.cancel().catch(() => {})
  }
}

function isHtml(contentType: string, bytes: Uint8Array): boolean {
  if (/html/i.test(contentType)) return true
  if (contentType.length > 0) return false
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512))
  return /<html|<!doctype html/i.test(head)
}

/** <meta charset> in the first 512 bytes when the header stayed silent. */
function sniffCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512))
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
}

/**
 * SSRF guard: refuse loopback, private, link-local and unique-local hosts
 * before any request leaves the machine. IP literals are checked directly
 * (all IPv6 spellings canonicalized first); names are resolved once — a DNS
 * name that points inside the perimeter is just as refused. Applied to every
 * redirect hop, not only the first URL.
 *
 * Residual risk: fetch() resolves the name a second time on its own, so a
 * DNS name alternating public/private answers could slip past this check
 * (classic rebinding TOCTOU). Pinning the validated address would need a
 * custom connection dispatcher; the guard here is still the strong gate
 * for literals and steady DNS, which covers the realistic cases.
 */
async function requirePublicHost(hostname: string): Promise<void> {
  try {
    await guardPrivateNetwork(hostname)
  } catch (err) {
    throw new RefusedError(err instanceof Error ? err.message : String(err))
  }
}

async function guardPrivateNetwork(hostname: string): Promise<void> {
  const literal = hostname.replace(/^\[|\]$/g, '')
  if (isPrivateAddress(literal)) {
    throw new Error(`Refusing to fetch private network address ${hostname}.`)
  }
  if (net.isIP(literal)) return
  if (literal === 'localhost' || literal.endsWith('.localhost') || literal.endsWith('.internal')) {
    throw new Error(`Refusing to fetch internal host ${hostname}.`)
  }
  try {
    const records = await dns.lookup(literal, { all: true })
    for (const record of records) {
      if (isPrivateAddress(record.address)) {
        throw new Error(`Refusing to fetch ${hostname} — it resolves to private address ${record.address}.`)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing')) throw err
    // DNS failures surface as a fetch failure later; nothing to add here.
  }
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    return isPrivateIpv4(address)
  }
  if (net.isIPv6(address)) {
    return isPrivateIpv6(address)
  }
  return false
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  const a = parts[0] ?? 0
  const b = parts[1] ?? 0
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  // Carrier-grade NAT — many intranet edges live behind 100.64.0.0/10.
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * Expand any IPv6 spelling to its eight 16-bit groups. Every way of writing
 * an IPv4-mapped address — "::ffff:192.168.0.1", "::ffff:c0a8:1",
 * "0:0:0:0:0:ffff:c0a8:1" — collapses onto the same eight numbers, so the
 * prefix checks below cannot be dodged by spelling a literal differently.
 */
function expandIpv6(address: string): number[] | null {
  let rest = address
  const zone = rest.indexOf('%')
  if (zone >= 0) rest = rest.slice(0, zone)

  // Embedded dotted-quad tail ("::ffff:192.0.2.1").
  let tail: number[] | null = null
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(rest)
  if (v4) {
    const quadText = v4[1] ?? ''
    const head = rest.slice(0, rest.length - quadText.length)
    if (!head.endsWith(':')) return null
    const quad = quadText.split('.').map(Number)
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null
    }
    tail = [((quad[0] ?? 0) << 8) | (quad[1] ?? 0), ((quad[2] ?? 0) << 8) | (quad[3] ?? 0)]
    rest = head.slice(0, -1)
  }

  const double = rest.split('::')
  if (double.length > 2) return null
  const parseGroups = (text: string): number[] | null => {
    if (text === '') return []
    const parsed: number[] = []
    for (const group of text.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      parsed.push(parseInt(group, 16))
    }
    return parsed
  }
  const left = parseGroups(double[0] ?? '')
  const right = double.length === 2 ? parseGroups(double[1] ?? '') : []
  if (left === null || right === null) return null

  let groups: number[]
  if (double.length === 2) {
    const missing = 8 - left.length - right.length - (tail !== null ? 2 : 0)
    if (missing < 0) return null
    groups = [...left, ...Array<number>(missing).fill(0), ...right]
  } else {
    groups = [...left]
  }
  if (tail) groups.push(tail[0] ?? 0, tail[1] ?? 0)
  if (groups.length !== 8) return null
  return groups
}

function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address)
  // Unparseable literals never pass as public — fail closed.
  if (!groups) return true
  const g0 = groups[0] ?? 0
  const g1 = groups[1] ?? 0
  const g2 = groups[2] ?? 0
  const g3 = groups[3] ?? 0
  const g4 = groups[4] ?? 0
  const g5 = groups[5] ?? 0
  const g6 = groups[6] ?? 0
  const g7 = groups[7] ?? 0
  const embedded = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`
  // The all-zeros prefix holds :: (unspecified), ::1 (loopback), the
  // deprecated IPv4-compatible range and the IPv4-mapped range — all of
  // them route to, or stand for, the embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0 || g5 === 0xffff) return isPrivateIpv4(embedded)
    return true // other all-zeros-middle forms: fail closed
  }
  // Unique-local fc00::/7 and link-local fe80::/10.
  if ((g0 & 0xfe00) === 0xfc00) return true
  if ((g0 & 0xffc0) === 0xfe80) return true
  // Multicast and reserved-for-routing ranges are never fetchable.
  if ((g0 & 0xff00) === 0xff00) return true
  if (g0 === 0x2001 && g1 === 0) return true // Teredo tunneling range
  // 6to4 (2002::/16) embeds the routable IPv4 side in groups 1-2.
  if (g0 === 0x2002) {
    const v4 = `${(g1 >> 8) & 0xff}.${g1 & 0xff}.${(g2 >> 8) & 0xff}.${g2 & 0xff}`
    return isPrivateIpv4(v4)
  }
  return false
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
