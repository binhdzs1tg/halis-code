import { clear, el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import { mountShimmer } from '../app/shimmer'

interface SessionMeta {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

/**
 * Left column, ported from the DeepSeek Harness sidebar: a brand row with the
 * collapse toggle, the New Session bar, an expandable search over the session
 * list, the workspace + session rows, and the settings foot.
 */
export function mountSidebar(): HTMLElement {
  const sidebar = el('aside', 'sidebar')

  /* ---------- top strip (mac traffic lights) ---------- */
  const topStrip = el('div', 'top-strip')
  if (document.body.classList.contains('is-mac')) {
    const toggle = buildToggle()
    topStrip.appendChild(toggle)
    sidebar.appendChild(topStrip)
  }

  /* ---------- logo row ---------- */
  const logoRow = el('div', 'logo-row')

  const brand = el('button', 'brand') as HTMLButtonElement
  brand.type = 'button'
  brand.title = 'New session'
  const identity = el('span', 'brand-identity')
  const mark = el('span', 'brand-mark')
  const nameImg = el('span', 'brand-name-img')
  identity.append(mark, nameImg)
  brand.appendChild(identity)
  logoRow.appendChild(brand)

  if (!document.body.classList.contains('is-mac')) {
    logoRow.appendChild(buildToggle())
  }

  sidebar.appendChild(logoRow)

  /* ---------- new session bar ---------- */
  const newSession = el('button', 'new-session') as HTMLButtonElement
  newSession.type = 'button'
  newSession.title = 'New session'
  const nsContent = el('span', 'new-session-content')
  nsContent.appendChild(svg(icons.newChat, 14))
  nsContent.appendChild(el('span', 'new-session-label', 'New Session'))
  const shortcut = el('span', 'new-session-shortcut')
  shortcut.append(...shortcutKeys('N'))
  nsContent.appendChild(shortcut)
  newSession.appendChild(nsContent)
  newSession.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('halis:new-session'))
  })
  sidebar.appendChild(newSession)

  /* ---------- region: search + sessions ---------- */
  const region = el('div', 'region-area')

  const sectionHeader = el('div', 'section-header')
  const sectionLabel = el('span', 'section-label', 'Sessions')

  const searchSlot = el('div', 'search-slot')
  const search = el('div', 'search')
  const searchButton = el('button', 'search-button') as HTMLButtonElement
  searchButton.type = 'button'
  searchButton.title = 'Search sessions'
  searchButton.appendChild(svg(icons.search, 14))
  const searchInput = el('input', 'search-input') as HTMLInputElement
  searchInput.type = 'text'
  searchInput.placeholder = 'Search session names'
  searchInput.spellcheck = false
  const clearButton = el('button', 'clear-button') as HTMLButtonElement
  clearButton.type = 'button'
  clearButton.title = 'Clear'
  clearButton.appendChild(svg(icons.close, 12))
  search.append(searchButton, searchInput, clearButton)
  searchSlot.appendChild(search)
  sectionHeader.append(sectionLabel, searchSlot)
  region.appendChild(sectionHeader)

  let searchExpanded = false
  const setSearch = (next: boolean): void => {
    searchExpanded = next
    if (next) {
      search.dataset.expanded = ''
      searchSlot.dataset.expanded = ''
      sectionLabel.dataset.hidden = ''
      searchInput.focus()
    } else {
      delete search.dataset.expanded
      delete searchSlot.dataset.expanded
      delete sectionLabel.dataset.hidden
      searchInput.value = ''
      void renderList()
    }
  }
  searchButton.addEventListener('click', () => {
    if (!searchExpanded) setSearch(true)
    else searchInput.focus()
  })
  clearButton.addEventListener('click', (event) => {
    event.stopPropagation()
    if (searchInput.value) setSearch(false)
    else searchInput.focus()
  })
  search.addEventListener('click', () => {
    if (!searchExpanded) setSearch(true)
  })
  searchInput.addEventListener('input', () => {
    void renderList()
  })
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setSearch(false)
    }
  })

  const listArea = el('div', 'list-area')
  region.appendChild(listArea)
  sidebar.appendChild(region)

  let sessionMetas: SessionMeta[] = []
  let currentSessionId: string | null = null
  let openSession: ((id: string) => Promise<void>) | null = null

  const filteredMetas = (): SessionMeta[] => {
    const query = searchInput.value.trim().toLowerCase()
    if (!query) return sessionMetas
    return sessionMetas.filter((meta) => meta.title.toLowerCase().includes(query))
  }

  async function renderList(): Promise<void> {
    clear(listArea)
    const workspaceRoot = store.get().workspaceRoot

    // workspace row: folder + name + open action, as in the harness browser
    const projectRow = el('div', 'project-row')
    projectRow.title = workspaceRoot ?? 'Open a folder'
    const folderSlot = el('span', 'slot')
    folderSlot.appendChild(svg(workspaceRoot ? icons.folderOpen : icons.folder, 14))
    if (workspaceRoot) folderSlot.classList.add('folder-active')
    const projectText = el('span', 'title', workspaceRoot ? fileName(workspaceRoot) : 'Open folder')
    const projectActions = el('span', 'row-actions')
    const openBtn = el('button', 'icon-btn') as HTMLButtonElement
    openBtn.type = 'button'
    openBtn.title = 'Open folder'
    openBtn.appendChild(svg(icons.folderPlus, 14))
    openBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      void window.halis.pickWorkspace().then((root) => {
        if (root) store.update({ workspaceRoot: root })
      })
    })
    projectActions.appendChild(openBtn)
    projectRow.append(folderSlot, projectText, projectActions)
    projectRow.addEventListener('click', () => {
      void window.halis.pickWorkspace().then((root) => {
        if (root) store.update({ workspaceRoot: root })
      })
    })
    listArea.appendChild(projectRow)

    const metas = filteredMetas()
    if (metas.length === 0) {
      const empty = el('div', 'list-empty')
      if (searchInput.value.trim()) {
        empty.textContent = 'No sessions match the search.'
      } else {
        empty.textContent = 'No sessions yet.\nStart one with the bar above.'
      }
      listArea.appendChild(empty)
      return
    }

    for (const meta of metas) {
      listArea.appendChild(renderSessionRow(meta))
    }
  }

  function renderSessionRow(meta: SessionMeta): HTMLElement {
    const row = el('div', `session-row${meta.id === currentSessionId ? ' selected' : ''}`)
    row.dataset.id = meta.id

    const title = el('span', 'title', meta.title)
    const time = el('span', 'time', formatSessionDate(meta.updatedAt))
    const actions = el('span', 'row-actions')
    const del = el('button', 'icon-btn danger') as HTMLButtonElement
    del.type = 'button'
    del.title = 'Delete session'
    del.appendChild(svg(icons.trash, 14))
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      void window.halis.deleteSession(meta.id).then(() => {
        store.update({ sessionsVersion: store.get().sessionsVersion + 1 })
      })
    })
    actions.appendChild(del)

    row.append(title, time, actions)
    row.addEventListener('click', () => {
      void openSession?.(meta.id)
    })
    return row
  }

  async function refreshSessions(): Promise<void> {
    const metas = await window.halis.listSessions().catch(() => [])
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    sessionMetas = metas
    await renderList()
  }

  window.addEventListener('halis:session-opened', (event) => {
    const id = (event as CustomEvent<string>).detail
    currentSessionId = id
    for (const row of listArea.querySelectorAll<HTMLElement>('.session-row')) {
      row.classList.toggle('selected', row.dataset.id === id)
    }
  })

  store.subscribe((state, prev) => {
    if (state.sessionsVersion !== prev.sessionsVersion || state.workspaceRoot !== prev.workspaceRoot) {
      void refreshSessions()
    }
    if (state.agentStatus !== prev.agentStatus) {
      paintStatus()
    }
  })

  /* ---------- foot: agent status + settings ---------- */
  const foot = el('div', 'foot-area')

  const status = el('div', 'footer-status')
  const statusText = el('span', undefined, 'Agent is idle')
  status.append(el('span', 'state-dot'), statusText)
  foot.appendChild(status)

  function paintStatus(): void {
    const value = store.get().agentStatus
    const dot = status.querySelector<HTMLElement>('.state-dot')
    if (!dot) return
    dot.className = 'state-dot'
    if (value === 'idle') {
      statusText.textContent = 'Agent is idle'
    } else if (value === 'thinking' || value === 'working') {
      dot.classList.add('busy')
      statusText.textContent = 'Agent is working…'
    } else {
      dot.classList.add('error')
      statusText.textContent = 'Agent hit an error'
    }
  }
  paintStatus()

  const settingsRow = el('div', 'settings-row')
  const settingsTrigger = el('button', 'settings-trigger') as HTMLButtonElement
  settingsTrigger.type = 'button'
  settingsTrigger.appendChild(svg(icons.settings, 16))
  settingsTrigger.appendChild(el('span', 'trigger-label', 'Settings'))
  settingsTrigger.addEventListener('click', () => {
    void import('./settings-view').then((module) => module.openSettingsModal())
  })
  settingsRow.appendChild(settingsTrigger)
  foot.appendChild(settingsRow)
  sidebar.appendChild(foot)

  void refreshSessions()

  // The conversation registers its session opener through this hook.
  window.addEventListener('halis:register-session-opener', (event) => {
    openSession = (event as CustomEvent<(id: string) => Promise<void>>).detail
  })

  return sidebar
}

function buildToggle(): HTMLButtonElement {
  const toggle = el('button', 'icon-btn') as HTMLButtonElement
  toggle.type = 'button'
  toggle.title = 'Collapse sidebar'
  toggle.appendChild(svg(icons.panelLeft, 16))
  toggle.addEventListener('click', () => {
    store.update({ sidebarVisible: false })
  })
  return toggle
}

/** "⌘ N" / "Ctrl N" chips, styled like the harness ShortcutKeys. */
function shortcutKeys(key: string): HTMLElement[] {
  const mod = document.body.classList.contains('is-mac') ? '⌘' : 'Ctrl'
  return [el('span', undefined, mod), el('span', undefined, key)]
}

function formatSessionDate(timestamp: number): string {
  const date = new Date(timestamp)
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

/** Kept for symmetry with the harness: shimmer lives here if needed later. */
export function sidebarShimmer(text: string): HTMLElement {
  return mountShimmer(text).root
}
