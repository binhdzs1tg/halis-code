import { clear, el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import * as catalog from '../core/models/catalog'
import { keyStatusOf, refreshKeyStatuses } from '../core/keys'
import { openKeyDialog } from './key-dialog'
import type { ProviderKeyStatus } from '../../electron/shared/types'

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

type SettingsPage = 'general' | 'agent' | 'models' | 'keys' | 'shortcuts'

const PAGES: Array<{ id: SettingsPage; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: icons.settings },
  { id: 'agent', label: 'Agent', icon: icons.terminal },
  { id: 'models', label: 'Models', icon: icons.folder },
  { id: 'keys', label: 'API keys', icon: icons.key },
  { id: 'shortcuts', label: 'Shortcuts', icon: icons.todo }
]

/**
 * Settings as a modal panel, ported from the DeepSeek Harness settings
 * surface: an 800px dialog with a left nav (General / Agent / Models / …)
 * and fact cards on the right.
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
    else if (currentPage === 'models') renderModels(content)
    else if (currentPage === 'keys') renderKeys(content)
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
  openBtn.addEventListener('click', async () => {
    const next = await window.halis.pickWorkspace()
    if (next) {
      store.update({ workspaceRoot: next })
    }
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
  })
  fullBtn.addEventListener('click', () => {
    void window.halis
      .setAgentSettings({ commandApproval: 'fullAccess' })
      .then((settings) => paint(settings.commandApproval))
  })

  void window.halis.getAgentSettings().then((settings) => paint(settings.commandApproval))
  content.appendChild(root)

  const hint = el('div', 'settings-hint')
  hint.textContent =
    '"Ask first" shows a prompt whenever the agent runs a command that looks destructive. "Full access" runs everything without asking.'
  content.appendChild(hint)
}

function renderModels(content: HTMLElement): void {
  pageTitle(content, 'Models', 'Providers and models come from the models.dev catalog.')
  const { root, body } = card()
  const facts = el('div', 'settings-row')
  const label = el('span', 'settings-label', 'Catalog')
  const value = el('span', 'settings-value', 'loading…')
  facts.append(label, value)
  body.appendChild(facts)

  const paint = (): void => {
    const providers = catalog.providers()
    const models = providers.reduce((sum, provider) => sum + provider.models.length, 0)
    value.textContent =
      providers.length > 0
        ? `${providers.length} providers · ${models} models`
        : 'unavailable — try refreshing'
  }
  void catalog.ensureCatalog().then(paint)
  window.halis.onModelsUpdated(() => {
    catalog.invalidate()
    void catalog.ensureCatalog().then(paint)
  })

  const actions = el('div', 'settings-actions')
  actions.style.padding = '0 16px 12px'
  const refreshBtn = el('button', 'btn ghost', 'Refresh catalog') as HTMLButtonElement
  refreshBtn.type = 'button'
  refreshBtn.title = 'Re-fetch the models.dev catalog'
  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true
    window.halis
      .refreshModels()
      .then(() => catalog.ensureCatalog())
      .then(paint)
      .finally(() => {
        refreshBtn.disabled = false
      })
  })
  actions.appendChild(refreshBtn)
  body.appendChild(actions)
  content.appendChild(root)
}

function renderKeys(content: HTMLElement): void {
  pageTitle(content, 'API keys', 'Provider keys live in the app vault; they never leave this machine.')
  const { root, body } = card()
  const list = el('div', 'key-list')
  body.appendChild(list)

  const paint = (): void => {
    clear(list)
    const configured = currentStatuses()
    if (configured.length === 0) {
      list.appendChild(
        el(
          'div',
          'settings-hint',
          'No provider keys yet. Select a model and use the API key chip in the composer, or press "Add a key" below.'
        )
      )
    }
    for (const [providerId, status] of configured) {
      list.appendChild(keyRow(providerId, status))
    }
  }

  const keyRow = (providerId: string, status: ProviderKeyStatus): HTMLElement => {
    const row = el('div', 'key-entry')
    const name = el('span', 'key-provider', providerName(providerId))
    const badge = el(
      'span',
      `key-badge ${status.source}`,
      status.source === 'env' ? `env · ${status.envVar ?? ''}` : 'vault'
    )
    badge.title =
      status.source === 'env'
        ? 'Read from the environment; restart to pick up changes'
        : 'Stored in the app key vault'

    const removeBtn = el('button', 'key-remove-btn') as HTMLButtonElement
    removeBtn.type = 'button'
    removeBtn.title = 'Remove stored key'
    removeBtn.appendChild(svg(icons.trash, 13))
    removeBtn.addEventListener('click', () => {
      removeBtn.disabled = true
      window.halis
        .removeProviderKey(providerId)
        .then(() => refreshKeyStatuses())
        .then(paint)
        .catch(() => {
          removeBtn.disabled = false
        })
    })

    row.append(name, badge, removeBtn)
    return row
  }

  const actions = el('div', 'settings-actions')
  actions.style.padding = '0 16px 12px'
  const addBtn = el('button', 'btn ghost', 'Add a key') as HTMLButtonElement
  addBtn.type = 'button'
  addBtn.addEventListener('click', () => {
    openKeyDialog()
  })
  actions.appendChild(addBtn)
  body.appendChild(actions)

  void refreshKeyStatuses().then(paint)
  window.halis.onKeysChanged(() => {
    void refreshKeyStatuses().then(paint)
  })
  content.appendChild(root)
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

function currentStatuses(): Array<[string, ProviderKeyStatus]> {
  const out: Array<[string, ProviderKeyStatus]> = []
  for (const provider of catalog.providers()) {
    const status = keyStatusOf(provider.id)
    if (status) {
      out.push([provider.id, status])
    }
  }
  return out
}

function providerName(providerId: string): string {
  return catalog.providers().find((provider) => provider.id === providerId)?.name ?? providerId
}
