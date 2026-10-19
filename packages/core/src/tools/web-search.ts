/**
 * Web search tool. The keyless provider — DuckDuckGo's lite endpoints —
 * needs no key, which keeps the tool useful out of the box. Swap in a
 * keyed provider later by editing fetchSearchResults only.
 */
import type { Tool, ToolOutcome } from '../types.js'
import { htmlToText, isBlockedHost } from './web-fetch.js'

const DEFAULT_MAX_RESULTS = 8
const MAX_RESULTS = 10
const SEARCH_TIMEOUT_MS = 25_000
/** Scrape endpoints are small; a huge body means an anomaly or an attack. */
const MAX_RESPONSE_CHARS = 2_000_000
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

interface SearchResult {
  title: string
  url: string
  snippet: string
}

export const webSearchTool: Tool = {
  spec: {
    name: 'web_search',
    description:
      'Search the web and get titled results with snippets. Use it when the task needs facts, ' +
      'documentation or current state beyond the workspace; then web_fetch the promising URLs ' +
      'for full content.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, keywords work better than sentences' },
        max_results: {
          type: 'number',
          description: `Maximum number of results (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS})`,
        },
      },
      required: ['query'],
    },
  },
  async run(input, ctx): Promise<ToolOutcome> {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (query.length === 0) return { output: 'error: query is required', ok: false }
    const maxResults = Math.min(
      MAX_RESULTS,
      Math.max(
        1,
        typeof input.max_results === 'number' && Number.isFinite(input.max_results)
          ? Math.trunc(input.max_results)
          : DEFAULT_MAX_RESULTS,
      ),
    )

    let results: SearchResult[]
    try {
      results = await fetchSearchResults(query, maxResults, ctx.signal)
    } catch (err) {
      if (ctx.signal.aborted) return { output: 'error: search aborted', ok: false }
      return { output: `error: search failed: ${err instanceof Error ? err.message : String(err)}`, ok: false }
    }
    if (results.length === 0) return { output: `No results for "${query}".`, ok: true }

    const lines = [`Web results for "${query}"`, '']
    results.forEach((result, i) => {
      lines.push(`[${i + 1}] ${result.title}`)
      lines.push(`    ${result.url}`)
      if (result.snippet) lines.push(`    ${result.snippet}`)
      lines.push('')
    })
    lines.push('Fetch a URL with web_fetch when the snippet is not enough.')
    return { output: lines.join('\n'), ok: true }
  },
}

/** DuckDuckGo's html endpoint, parsed by hand — no API key, no SDK. */
async function fetchSearchResults(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: 'wt-wt' })
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': BROWSER_UA,
      accept: 'text/html',
    },
    body: body.toString(),
    signal: AbortSignal.any([signal, timeout]),
  })
  if (!res.ok) throw new Error(`http ${res.status} ${res.statusText}`)
  const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS)
  return parseDdgHtml(text, maxResults)
}

/** Pull result links out of the html endpoint's stable markup. */
export function parseDdgHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippet = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  for (const match of html.matchAll(snippet)) snippets.push(cleanText(match[1] ?? ''))
  let index = 0
  for (const match of html.matchAll(link)) {
    const rawUrl = match[1] ?? ''
    const title = cleanText(match[2] ?? '')
    const url = unwrapRedirect(rawUrl)
    if (!url || !title) continue
    if (isBlockedHost(hostOf(url))) continue
    results.push({ title, url, snippet: snippets[index] ?? '' })
    index += 1
    if (results.length >= maxResults) break
  }
  return results
}

/** The html endpoint wraps targets in a uddg= redirect; pull the real one out. */
function unwrapRedirect(raw: string): string | null {
  let url = raw.replace(/&amp;/g, '&')
  const redirect = url.match(/[?&]uddg=([^&]+)/)
  if (redirect?.[1]) url = decodeURIComponent(redirect[1])
  return url.startsWith('http://') || url.startsWith('https://') ? url : null
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function cleanText(html: string): string {
  return htmlToText(html)
    .replace(/\s+/g, ' ')
    .trim()
}
