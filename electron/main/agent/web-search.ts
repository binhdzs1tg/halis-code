/**
 * Web search tool, ported from opencode's websearch. The tool shape and the
 * result formatting are theirs; this port ships with the keyless provider
 * pattern opencode demonstrated with its built-in provider — DuckDuckGo's
 * lite endpoints need no key, which keeps the tool useful out of the box.
 * Swap in a keyed provider later by editing fetchSearchResults only.
 */
import { htmlToText } from './html-to-markdown'
import type { ToolOutcome } from './tools'

const DEFAULT_MAX_RESULTS = 8
const MAX_RESULTS = 10
const SEARCH_TIMEOUT_MS = 25_000
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

  // opencode's block format: one headed link per result, snippet below.
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
    let html: string
    try {
      const response = await fetchWithTimeout(endpoint.url, signal)
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }
      html = await response.text()
    } catch (err) {
      if (signal.aborted) throw err
      lastError = errorText(err)
      continue
    }
    const results = endpoint.parse(html).slice(0, maxResults)
    if (results.length > 0) {
      return results
    }
  }
  try {
    const response = await fetchWithTimeout(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      signal
    )
    if (response.ok) {
      const results = parseInstantAnswer(await response.text()).slice(0, maxResults)
      if (results.length > 0) {
        return results
      }
    }
    lastError = `HTTP ${response.status}`
  } catch (err) {
    if (signal.aborted) throw err
    lastError = errorText(err)
  }
  throw new Error(lastError)
}

async function fetchWithTimeout(url: string, signal: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/json' }
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function parseLiteResults(html: string): SearchResult[] {
  // lite.duckduckgo.com lays results out as table rows: an anchor with
  // class result-link, then a snippet cell.
  const anchors = matchAll(html, /<a[^>]*class=["']?result-link["']?[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)
  const snippets = matchAll(html, /<td[^>]*class=["']?result-snippet["']?[^>]*>([\s\S]*?)<\/td>/gi)
  return dedupeAndClean(anchors, snippets.map((match) => match[1] ?? ''))
}

function parseHtmlResults(html: string): SearchResult[] {
  const anchors = matchAll(html, /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)
  const snippets = matchAll(html, /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)
  return dedupeAndClean(anchors, snippets.map((match) => match[1] ?? ''))
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

function dedupeAndClean(anchors: RegExpExecArray[], snippetTexts: string[]): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i]
    if (!anchor) continue
    const href = anchor[1] ?? ''
    const url = resolveDuckUrl(href)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    const title = htmlToText(anchor[2] ?? '').trim()
    const snippet = htmlToText(snippetTexts[i] ?? '').trim()
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
