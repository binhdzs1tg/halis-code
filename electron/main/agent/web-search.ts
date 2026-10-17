/**
 * Web search tool. The keyless provider — DuckDuckGo's lite endpoints —
 * needs no key, which keeps the tool useful out of the box. Swap in a
 * keyed provider later by editing fetchSearchResults only.
 */
import { htmlToText } from './html-to-markdown'
import type { ToolOutcome } from './tools'

const DEFAULT_MAX_RESULTS = 8
const MAX_RESULTS = 10
const SEARCH_TIMEOUT_MS = 25_000
/** Scrape endpoints are small; a huge body means an anomaly or an attack. */
const MAX_RESPONSE_CHARS = 2_000_000
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export const WEB_SEARCH_TOOL_SPEC = {
  name: 'web_search',
  description:
    'Search the web and get titled results with snippets. Use it when the ' +
    'task needs facts, documentation or current state beyond the workspace; ' +
    'then web_fetch the promising URLs for full content.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query, keywords work better than sentences' },
      max_results: { type: 'integer', description: `Maximum number of results (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS})` }
    },
    required: ['query']
  }
} as const

export async function webSearchTool(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query.length === 0) {
    throw new Error('Parameter "query" must be a non-empty string.')
  }
  const maxResults = Math.min(
    MAX_RESULTS,
    Math.max(1, typeof input.max_results === 'number' && Number.isFinite(input.max_results) ? Math.trunc(input.max_results) : DEFAULT_MAX_RESULTS)
  )

  let results: SearchResult[]
  try {
    results = await fetchSearchResults(query, maxResults, signal)
  } catch (err) {
    if (signal.aborted) return { ok: false, output: 'cancelled' }
    return { ok: false, output: `Web search is unavailable right now: ${errorText(err)}` }
  }
  if (results.length === 0) {
    return { ok: true, output: `No results for "${query}".` }
  }

  // One headed link per result, snippet below.
  const blocks = results.map((result) => `## [${result.title}](${result.url})\n${result.snippet}`)
  return { ok: true, output: `${results.length} results for "${query}":\n\n${blocks.join('\n\n')}` }
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * DuckDuckGo lite first, the classic HTML endpoint next, and the Instant
 * Answer JSON API as the last resort — scrapers get blocked on some
 * networks, the API never has full web results, and the chain degrades
 * gracefully instead of failing outright.
 */
async function fetchSearchResults(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]> {
  let lastError = 'no endpoint answered'
  const scrapeEndpoints = [
    { url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, parse: parseLiteResults },
    { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parse: parseHtmlResults }
  ]
  for (const endpoint of scrapeEndpoints) {
    try {
      const page = await fetchText(endpoint.url, signal)
      if (!page.ok) {
        lastError = `HTTP ${page.status}`
        continue
      }
      const results = endpoint.parse(page.text).slice(0, maxResults)
      if (results.length > 0) {
        return results
      }
    } catch (err) {
      if (signal.aborted) throw err
      lastError = errorText(err)
    }
  }
  try {
    const page = await fetchText(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      signal
    )
    if (page.ok) {
      const results = parseInstantAnswer(page.text).slice(0, maxResults)
      if (results.length > 0) {
        return results
      }
    }
    lastError = `HTTP ${page.status}`
  } catch (err) {
    if (signal.aborted) throw err
    lastError = errorText(err)
  }
  throw new Error(lastError)
}

/** One deadline covers headers AND body, and the run signal stays wired
 *  through the body read so a cancel cannot be ignored. */
async function fetchText(url: string, signal: AbortSignal): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/json' }
    })
    const text = await readBoundedText(response)
    return { ok: response.ok, status: response.status, text }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** Read the body with a hard char cap; a bloated or hostile response must
 *  not buffer unbounded memory in the main process. */
async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder('utf-8')
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        text += decoder.decode(value, { stream: true })
        if (text.length > MAX_RESPONSE_CHARS) {
          void reader.cancel().catch(() => {})
          return `${text.slice(0, MAX_RESPONSE_CHARS)}\n(response truncated)`
        }
      }
    }
    text += decoder.decode()
    return text
  } catch (err) {
    void reader.cancel().catch(() => {})
    throw err
  }
}

function parseLiteResults(html: string): SearchResult[] {
  // lite.duckduckgo.com lays results out as table rows: an anchor with
  // class result-link, then a snippet cell.
  return collectResults(
    html,
    /<a[^>]*class=["']?result-link["']?[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    /<td[^>]*class=["']?result-snippet["']?[^>]*>([\s\S]*?)<\/td>/gi
  )
}

function parseHtmlResults(html: string): SearchResult[] {
  return collectResults(
    html,
    /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
  )
}

/**
 * The Instant Answer API: an abstract when the query maps to a topic, plus
 * related links. Category pages (duckduckgo.com/c/…) are dropped — they are
 * navigation, not results.
 */
function parseInstantAnswer(json: string): SearchResult[] {
  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    return []
  }
  const data = payload as Record<string, unknown>
  const results: SearchResult[] = []
  const heading = typeof data.Heading === 'string' ? data.Heading : ''
  const abstractText = typeof data.AbstractText === 'string' ? data.AbstractText : ''
  const abstractUrl = typeof data.AbstractURL === 'string' ? data.AbstractURL : ''
  if (heading.length > 0 && abstractText.length > 0 && abstractUrl.length > 0) {
    results.push({ title: heading, url: abstractUrl, snippet: abstractText })
  }
  const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : []
  for (const topic of topics) {
    const entry = topic as Record<string, unknown>
    const url = typeof entry.FirstURL === 'string' ? entry.FirstURL : ''
    const text = typeof entry.Text === 'string' ? entry.Text : ''
    if (url.length > 0 && text.length > 0 && !url.includes('duckduckgo.com/c/')) {
      results.push({ title: text.split(' - ')[0] ?? text, url, snippet: text })
    }
  }
  return results
}

function collectResults(html: string, anchorPattern: RegExp, snippetPattern: RegExp): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  const anchors = matchAll(html, anchorPattern)
  const snippets = matchAll(html, snippetPattern)
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i]
    if (!anchor) continue
    const href = anchor[1] ?? ''
    const url = resolveDuckUrl(href)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    // Pair positionally in the document: the snippet cell that follows this
    // anchor and precedes the next one. Zipping two parallel lists would
    // hand every later result the previous result's snippet as soon as one
    // result ships without a cell.
    const matchStart = anchor.index ?? 0
    const nextStart = i + 1 < anchors.length ? anchors[i + 1]?.index ?? html.length : html.length
    let snippetText = ''
    for (const snippet of snippets) {
      const at = snippet.index ?? -1
      if (at > matchStart && at < nextStart) {
        snippetText = snippet[1] ?? ''
        break
      }
    }
    const title = htmlToText(anchor[2] ?? '').trim()
    const snippet = htmlToText(snippetText).trim()
    if (title.length === 0) continue
    results.push({ title, url, snippet })
  }
  return results
}

function matchAll(text: string, pattern: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = []
  const regex = new RegExp(pattern.source, pattern.flags)
  for (;;) {
    const match = regex.exec(text)
    if (!match) break
    out.push(match)
  }
  return out
}

/** undici wraps transport failures in a generic "fetch failed"; the cause says why. */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message
  }
  return String(err)
}

/** unwrap /l/?uddg=<encoded> redirects the html endpoint wraps results in. */
function resolveDuckUrl(href: string): string {
  if (href.startsWith('//')) href = `https:${href}`
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const wrapped = url.searchParams.get('uddg')
    if (wrapped) return wrapped
    return url.toString()
  } catch {
    return href
  }
}
