import { clear, el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'

interface ShortcutRow {
  keys: string
  description: string
}

const SHORTCUTS: ShortcutRow[] = [
  { keys: 'Ctrl+B', description: 'Toggle the sidebar' },
  { keys: 'Ctrl+J', description: 'Toggle the workspace panel' },
  { keys: 'Ctrl+`', description: 'Toggle the terminal' },
  { keys: 'Ctrl+N', description: 'Start a new session' },
  { keys: 'Ctrl+S', description: 'Save the active file' },
  { keys: 'Enter / Shift+Enter', description: 'Send / newline in the chat composer' }
]

type SettingsPage = 'general' | 'agent' | 'shortcuts'

const PAGES: Array<{ id: SettingsPage; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: icons.settings },
  { id: 'agent', label: 'Agent', icon: icons.terminal },
  { id: 'shortcuts', label: 'Shortcuts', icon: icons.todo }
]

/**
 * Settings as a modal panel: an 800px dialog with a left nav
 * (General / Agent / Shortcuts)
 * and fact cards on the right. Models and keys live in the chat flow — the
 * model pill and the key dialog that pops when a provider needs one.
 */
export function openSettingsModal(): void {
  if (document.querySelector('.settings-overlay')) return

  const overlay = el('div', 'overlay settings-overlay')
  const panel = el('div', 'settings-panel')

  const nav = el('div', 'settings-nav')
  nav.appendChild(el('h2', 'settings-nav-title', 'Settings'))
  const content = el('div', 'settings-content')

  let currentPage: SettingsPage = 'general'
  const navButtons = new Map<SettingsPage, HTMLButtonElement>()

  const paintPage = (): void => {
    clear(content)
    if (currentPage === 'general') renderGeneral(content)
    else if (currentPage === 'agent') renderAgent(content)
    else renderShortcuts(content)
  }

  for (const page of PAGES) {
    const btn = el('button', 'settings-nav-item') as HTMLButtonElement
    btn.type = 'button'
    const iconWrap = el('span', 'nav-icon')
    iconWrap.appendChild(svg(page.icon, 16))
    btn.append(iconWrap, el('span', undefined, page.label))
    btn.addEventListener('click', () => {
      currentPage = page.id
      for (const [id, node] of navButtons) {
        node.classList.toggle('active', id === currentPage)
      }
      paintPage()
    })
    navButtons.set(page.id, btn)
    nav.appendChild(btn)
  }
  navButtons.get('general')?.classList.add('active')

  panel.append(nav, content)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const close = (): void => overlay.remove()
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })
  document.addEventListener('keydown', function onKey(event) {
    if (!document.body.contains(overlay)) {
      document.removeEventListener('keydown', onKey)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })

  paintPage()
}

function pageTitle(content: HTMLElement, title: string, description: string): void {
  content.appendChild(el('h3', 'settings-page-title', title))
  content.appendChild(el('p', 'settings-page-desc', description))
}

function card(): { root: HTMLElement; body: HTMLElement } {
  const root = el('div', 'settings-card')
  const body = el('div', 'settings-body')
  root.appendChild(body)
  return { root, body }
}

function factRow(label: string, value: string): HTMLElement {
  const row = el('div', 'settings-row')
  row.appendChild(el('span', 'settings-label', label))
  const valueNode = el('span', 'settings-value', value)
  valueNode.title = value
  row.appendChild(valueNode)
  return row
}

function renderGeneral(content: HTMLElement): void {
  pageTitle(content, 'General', 'How Halis Code presents itself on this machine.')
  const { root, body } = card()
  const info = store.get().appInfo
  body.appendChild(factRow('Name', info?.name ?? 'halis-code'))
  body.appendChild(factRow('Version', info ? `v${info.version}` : 'v0.1.0'))
  body.appendChild(factRow('Electron', info?.electron ?? '—'))
  body.appendChild(factRow('Platform', info?.platform ?? '—'))
  body.appendChild(factRow('Appearance', 'Follows the system theme'))
  content.appendChild(root)

  const workspace = card()
  const rootPath = store.get().workspaceRoot
  workspace.body.appendChild(factRow('Folder', rootPath ?? 'No folder opened'))
  const actions = el('div', 'settings-actions')
  actions.style.padding = '0 16px 12px'
  const openBtn = el('button', 'btn ghost', rootPath ? 'Switch folder' : 'Open folder') as HTMLButtonElement
  openBtn.type = 'button'
  openBtn.addEventListener('click', () => {
    void window.halis
      .pickWorkspace()
      .then((next) => {
        if (next) {
          store.update({ workspaceRoot: next })
        }
      })
      .catch(() => undefined)
  })
  actions.appendChild(openBtn)
  workspace.body.appendChild(actions)
  content.appendChild(workspace.root)
}

function renderAgent(content: HTMLElement): void {
  pageTitle(content, 'Agent', 'How much freedom the coding agent has in your workspace.')
  const { root, body } = card()

  const row = el('div', 'settings-row')
  row.appendChild(el('span', 'settings-label', 'Command approval'))
  const toggle = el('div', 'settings-actions segmented')
  const askBtn = el('button', 'btn') as HTMLButtonElement
  const fullBtn = el('button', 'btn') as HTMLButtonElement
  askBtn.type = 'button'
  fullBtn.type = 'button'
  toggle.append(askBtn, fullBtn)
  row.appendChild(toggle)
  body.appendChild(row)

  const paint = (mode: 'ask' | 'fullAccess'): void => {
    askBtn.textContent = 'Ask first'
    fullBtn.textContent = 'Full access'
    askBtn.classList.toggle('active', mode === 'ask')
    fullBtn.classList.toggle('active', mode === 'fullAccess')
  }

  askBtn.addEventListener('click', () => {
    void window.halis
      .setAgentSettings({ commandApproval: 'ask' })
      .then((settings) => paint(settings.commandApproval))
      .catch(() => undefined)
  })
  fullBtn.addEventListener('click', () => {
    void window.halis
      .setAgentSettings({ commandApproval: 'fullAccess' })
      .then((settings) => paint(settings.commandApproval))
      .catch(() => undefined)
  })

  void window.halis
    .getAgentSettings()
    .then((settings) => paint(settings.commandApproval))
    .catch(() => undefined)
  content.appendChild(root)

  const hint = el('div', 'settings-hint')
  hint.textContent =
    '"Ask first" shows a prompt whenever the agent runs a command that looks destructive. "Full access" runs everything without asking.'
  content.appendChild(hint)
}

function renderShortcuts(content: HTMLElement): void {
  pageTitle(content, 'Shortcuts', 'The keyboard map, matching the desktop conventions.')
  const { root, body } = card()
  for (const shortcut of SHORTCUTS) {
    const row = el('div', 'settings-row')
    const keys = el('kbd', 'settings-kbd', shortcut.keys)
    const description = el('span', 'settings-value', shortcut.description)
    row.append(keys, description)
    body.appendChild(row)
  }
  content.appendChild(root)
}
