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
      return {
        ok: false,
        output: `Refusing to fetch "${type || 'unknown content type'}" — web_fetch reads text pages, not binaries or images.`
      }
    }

    const { bytes, truncated } = await readBounded(session)
    const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? sniffCharset(bytes)
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
 * before any request leaves the machine. IP literals are checked directly;
 * names are resolved once — a DNS name that points inside the perimeter is
 * just as refused. Applied to every redirect hop, not only the first URL.
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
    const parts = address.split('.').map(Number)
    const a = parts[0] ?? 0
    const b = parts[1] ?? 0
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1') return true
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
    // IPv4-mapped private ranges.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
    if (mapped) return isPrivateAddress(mapped[1] ?? '')
    return false
  }
  return false
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
