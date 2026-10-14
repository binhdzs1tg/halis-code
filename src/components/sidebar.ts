import { clear, el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import { mountFileTree } from './explorer/file-tree'
import { mountSearchView } from './search-view'
import { mountSettingsView } from './settings-view'

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  settings: 'Settings'
}

export function mountSidebar(): HTMLElement {
  const panel = el('aside', 'sidebar')

  const header = el('div', 'panel-header')
  const title = el('span', undefined, TITLES.explorer)
  header.appendChild(title)

  const actions = el('div', 'panel-actions')
  const openBtn = el('button')
  openBtn.title = 'Open folder'
  openBtn.appendChild(svg(icons.folder, 14))
  openBtn.addEventListener('click', () => void pickWorkspace())
  actions.appendChild(openBtn)
  header.appendChild(actions)

  const body = el('div', 'view-body')
  panel.append(header, body)

  async function pickWorkspace(): Promise<void> {
    const root = await window.halis.pickWorkspace()
    if (root) {
      store.update({ workspaceRoot: root })
    }
  }

  store.subscribe((state, prev) => {
    if (state.sidebarView !== prev.sidebarView) {
      title.textContent = TITLES[state.sidebarView] ?? state.sidebarView
      renderView(state.sidebarView, body)
    }
  })

  renderView(store.get().sidebarView, body)
  return panel
}

function renderView(view: string, body: HTMLElement): void {
  clear(body)
  if (view === 'explorer') {
    renderExplorer(body)
  } else if (view === 'search') {
    mountSearchView(body)
  } else {
    mountSettingsView(body)
  }
}

function renderExplorer(body: HTMLElement): void {
  const state = store.get()
  if (!state.workspaceRoot) {
    const empty = el('div', 'empty-state')
    const iconWrap = el('div')
    iconWrap.appendChild(svg(icons.folder, 34))
    empty.appendChild(iconWrap)
    empty.appendChild(el('p', undefined, 'No folder opened yet.\nOpen a folder to start working with Halis.'))
    const btn = el('button', 'btn', 'Open Folder')
    btn.addEventListener('click', async () => {
      const root = await window.halis.pickWorkspace()
      if (root) {
        store.update({ workspaceRoot: root })
      }
    })
    empty.appendChild(btn)
    body.appendChild(empty)
    return
  }

  mountFileTree(body)
}
