/**
 * Web fetch tool, ported from opencode's webfetch and the harness's
 * web_fetch: pull one http(s) URL and hand the page to the model as
 * Markdown, plain text or raw HTML. Bodies are bounded, only textual
 * content types pass, and private-network hosts are refused — an agent
 * must not be a free proxy into the intranet.
 */
import dns from 'node:dns/promises'
import net from 'node:net'
import { htmlToMarkdown, htmlToText } from './html-to-markdown'
import type { ToolOutcome } from './tools'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_BODY_BYTES = 5 * 1024 * 1024
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
  try {
    await guardPrivateNetwork(url.hostname)
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }

  const format = input.format === 'text' || input.format === 'html' ? input.format : 'markdown'
  const timeout = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1_000, numberOr(input.timeout_ms, DEFAULT_TIMEOUT_MS))
  )

  const fetchOnce = async (ua: string): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5'
        }
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  let response: Response
  try {
    response = await fetchOnce(BROWSER_UA)
    // Some hosts 403 unknown-looking browsers; one retry as the plain
    // client we actually are, opencode's Cloudflare dance in miniature.
    if (response.status === 403) {
      response = await fetchOnce(PLAIN_UA)
    }
  } catch (err) {
    if (signal.aborted) return { ok: false, output: 'cancelled' }
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, output: `Could not reach ${url.host}: ${reason}` }
  }

  const type = response.headers.get('content-type') ?? ''
  if (!TEXTUAL_TYPES.some((pattern) => pattern.test(type))) {
    return {
      ok: false,
      output: `Refusing to fetch "${type || 'unknown content type'}" — web_fetch reads text pages, not binaries or images.`
    }
  }

  const { bytes, truncated } = await readBounded(response)
  const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? sniffCharset(bytes)
  let body: string
  try {
    body = new TextDecoder(charset?.toLowerCase() === 'utf-8' || charset === undefined ? 'utf-8' : charset).decode(bytes)
  } catch {
    body = new TextDecoder('utf-8').decode(bytes)
  }

  const statusNote = response.ok ? '' : `HTTP ${response.status} ${response.statusText || ''}`.trim() + '\n\n'
  if (format === 'html' || !isHtml(type, bytes)) {
    return { ok: response.ok, output: statusNote + body }
  }
  if (format === 'text') {
    return { ok: response.ok, output: statusNote + htmlToText(body) }
  }
  return { ok: response.ok, output: statusNote + htmlToMarkdown(body) + tailNotes(response, url, truncated) }
}

function tailNotes(response: Response, requested: URL, truncated: boolean): string {
  const notes: string[] = []
  if (response.url && response.url !== requested.toString()) {
    notes.push(`Final URL after redirects: ${response.url}`)
  }
  if (truncated) {
    notes.push('Body truncated at 5 MB.')
  }
  return notes.length > 0 ? `\n\n(${notes.join(' ')})` : ''
}

/** Read at most MAX_BODY_BYTES; the rest of the stream is discarded. */
async function readBounded(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { bytes: new Uint8Array(0), truncated: true }
  }
  const reader = response.body?.getReader()
  if (!reader) {
    return { bytes: new Uint8Array(0), truncated: false }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
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
 * just as refused.
 */
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
