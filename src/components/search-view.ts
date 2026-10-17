import { clear, el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import type { SearchResponse } from '../../electron/shared/types'

const DEBOUNCE_MS = 250
const PREVIEW_LENGTH = 160

/**
 * Workspace-wide text search. Queries run in the main process; results group
 * by file and each hit jumps straight to its line in the editor.
 */
export function mountSearchView(container: HTMLElement): void {
  const view = el('div', 'search-view')

  const toolbar = el('div', 'search-toolbar')
  const input = el('input', 'search-input') as HTMLInputElement
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = 'Search in workspace…'

  const caseBtn = el('button', 'case-toggle') as HTMLButtonElement
  caseBtn.type = 'button'
  caseBtn.title = 'Match case'
  caseBtn.textContent = 'Aa'

  toolbar.append(input, caseBtn)
  view.appendChild(toolbar)

  const summary = el('div', 'search-summary')
  view.appendChild(summary)

  const results = el('div', 'search-results')
  view.appendChild(results)
  container.appendChild(view)

  let caseSensitive = false
  let token = 0
  let lastQuery: string | null = null
  let debounceTimer = 0

  const paintCase = (): void => {
    caseBtn.classList.toggle('on', caseSensitive)
  }

  const summaryText = (response: SearchResponse): string => {
    const files = new Set(response.hits.map((hit) => hit.path)).size
    const base = `${response.hits.length} result${response.hits.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`
    return response.truncated ? `${base} — showing the first ones` : base
  }

  const openHit = (path: string, line: number): void => {
    const state = store.get()
    store.update({
      openFiles: state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path],
      openFile: path,
      openFileLine: line
    })
  }

  const renderResults = (query: string, response: SearchResponse): void => {
    clear(results)
    summary.textContent = summaryText(response)

    if (response.hits.length === 0) {
      results.appendChild(el('div', 'search-empty', `No results for "${query}".`))
      return
    }

    let group: { path: string; hits: typeof response.hits } | null = null
    const groups: Array<{ path: string; hits: typeof response.hits }> = []
    for (const hit of response.hits) {
      if (!group || group.path !== hit.path) {
        group = { path: hit.path, hits: [] }
        groups.push(group)
      }
      group.hits.push(hit)
    }

    for (const item of groups) {
      const header = el('button', 'search-file') as HTMLButtonElement
      header.type = 'button'
      header.appendChild(svg(icons.file, 13))
      header.appendChild(el('span', 'search-file-name', fileName(item.path)))
      header.appendChild(el('span', 'search-file-count', String(item.hits.length)))
      header.title = item.path
      header.addEventListener('click', () => openHit(item.path, item.hits[0]?.line ?? 1))
      results.appendChild(header)

      for (const hit of item.hits) {
        const row = el('button', 'search-hit') as HTMLButtonElement
        row.type = 'button'
        const lineNo = el('span', 'search-line', String(hit.line))
        const text = el('span', 'search-text', preview(hit.text))
        row.append(lineNo, text)
        row.title = `${item.path}:${hit.line}`
        row.addEventListener('click', () => openHit(item.path, hit.line))
        results.appendChild(row)
      }
    }
  }

  const search = async (): Promise<void> => {
    const query = input.value
    const queryKey = `${caseSensitive ? 'c:' : ''}${query}`
    if (queryKey === lastQuery) return
    lastQuery = queryKey
    const current = (token += 1)

    if (!store.get().workspaceRoot || query.trim().length === 0) {
      summary.textContent = ''
      clear(results)
      if (!store.get().workspaceRoot) {
        results.appendChild(el('div', 'search-empty', 'Open a folder to search in it.'))
      } else {
        results.appendChild(el('div', 'search-empty', 'Type to search across every file.'))
      }
      return
    }

    summary.textContent = 'Searching…'
    try {
      const response = await window.halis.searchWorkspace(query, { caseSensitive })
      if (current !== token) return // a newer query superseded this one
      renderResults(query, response)
    } catch (err) {
      if (current !== token) return
      // A failed query must be re-runnable: keeping the key would make the
      // next Enter a silent no-op until the text changes.
      lastQuery = null
      summary.textContent = ''
      clear(results)
      results.appendChild(
        el('div', 'search-empty', `Search failed: ${err instanceof Error ? err.message : String(err)}`)
      )
    }
  }

  const schedule = (): void => {
    window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => void search(), DEBOUNCE_MS)
  }

  input.addEventListener('input', schedule)
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      window.clearTimeout(debounceTimer)
      void search()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      input.value = ''
      lastQuery = null
      window.clearTimeout(debounceTimer)
      void search()
    }
  })
  caseBtn.addEventListener('click', () => {
    caseSensitive = !caseSensitive
    paintCase()
    lastQuery = null
    void search()
  })

  // a different folder means different results
  store.subscribe((state, prev) => {
    if (state.workspaceRoot !== prev.workspaceRoot) {
      lastQuery = null
      void search()
    }
  })

  paintCase()
  results.appendChild(el('div', 'search-empty', 'Type to search across every file.'))
  input.focus()
}

function preview(text: string): string {
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text
}

function fileName(path: string): string {
  return path.split('/').pop() || path
}
