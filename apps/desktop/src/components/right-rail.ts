import { clear, el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store, type RailTab } from '../app/store'
import { mountFileTree } from './explorer/file-tree'
import { mountSearchView } from './search-view'
import { mountEditorArea } from './editor-area'
import { mountTerminalPanel } from './terminal-panel'

const TABS: Array<{ id: RailTab; label: string; icon: string }> = [
  { id: 'files', label: 'Files', icon: icons.folder },
  { id: 'search', label: 'Search', icon: icons.search },
  { id: 'editor', label: 'Editor', icon: icons.file },
  { id: 'terminal', label: 'Terminal', icon: icons.terminal }
]

/**
 * Right column: a tab strip above the files / search / editor / terminal
 * panels. Opening a file from the tree or a search hit flips to the Editor
 * tab so the document is always one click from where it was referenced.
 */
export function mountWorkspaceRail(): HTMLElement {
  const rail = el('div', 'rail')

  const tabstrip = el('div', 'rail-tabstrip')
  const tabButtons = new Map<RailTab, HTMLButtonElement>()

  for (const tab of TABS) {
    const btn = el('button', 'rail-tab') as HTMLButtonElement
    btn.type = 'button'
    btn.title = tab.label
    btn.appendChild(svg(tab.icon, 14))
    btn.appendChild(el('span', undefined, tab.label))
    btn.addEventListener('click', () => {
      store.update({ railTab: tab.id })
    })
    tabButtons.set(tab.id, btn)
    tabstrip.appendChild(btn)
  }

  const railActions = el('div', 'rail-actions')
  const collapseBtn = el('button', 'icon-btn') as HTMLButtonElement
  collapseBtn.type = 'button'
  collapseBtn.title = 'Hide panel'
  collapseBtn.appendChild(svg(icons.close, 15))
  collapseBtn.addEventListener('click', () => {
    store.update({ railVisible: false })
  })
  railActions.appendChild(collapseBtn)
  tabstrip.appendChild(railActions)
  rail.appendChild(tabstrip)

  const body = el('div', 'rail-body')

  const filesPanel = el('div', 'rail-panel')
  mountFileTree(filesPanel)
  const searchPanel = el('div', 'rail-panel')
  mountSearchView(searchPanel)
  const editorPanel = el('div', 'rail-panel')
  editorPanel.appendChild(mountEditorArea())
  const terminalPanel = el('div', 'rail-panel')
  terminalPanel.appendChild(mountTerminalPanel())

  body.append(filesPanel, searchPanel, editorPanel, terminalPanel)
  rail.appendChild(body)

  const panels = new Map<RailTab, HTMLElement>([
    ['files', filesPanel],
    ['search', searchPanel],
    ['editor', editorPanel],
    ['terminal', terminalPanel]
  ])

  const paint = (): void => {
    const state = store.get()
    // The editor tab only exists while a file is open — the preview panel
    // appears when there is something to show.
    const editorTab = tabButtons.get('editor')
    if (editorTab) {
      editorTab.hidden = state.openFiles.length === 0
    }
    let active = state.railTab
    if (active === 'editor' && state.openFiles.length === 0) {
      active = 'files'
    }
    for (const [id, btn] of tabButtons) {
      btn.classList.toggle('active', id === active)
    }
    for (const [id, panel] of panels) {
      panel.hidden = id !== active
    }
  }
  paint()

  store.subscribe((state, prev) => {
    if (
      state.railTab !== prev.railTab ||
      state.openFiles.length !== prev.openFiles.length ||
      state.openFile !== prev.openFile
    ) {
      paint()
    }
    // Opening a file (tree click, search hit, agent reference) surfaces the
    // editor right away.
    if (state.openFile && state.openFile !== prev.openFile && state.railTab !== 'terminal') {
      store.update({ railTab: 'editor' })
    }
  })

  // Terminal panel keeps its own visibility sync (railTab based); paint once.
  return rail
}

/** Shared helper: clear + mount, kept from the old sidebar view plumbing. */
export function clearPanel(panel: HTMLElement): void {
  clear(panel)
}

/** The folder icon used by the rail tab strip lives here for reuse. */
export const railIcons = { folder: icons.folderOpen }
