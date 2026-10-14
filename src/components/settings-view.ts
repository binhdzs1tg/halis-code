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
  { keys: 'Ctrl+J', description: 'Toggle the agent chat panel' },
  { keys: 'Ctrl+`', description: 'Toggle the terminal' },
  { keys: 'Ctrl+S', description: 'Save the active file' },
  { keys: 'Enter / Shift+Enter', description: 'Send / newline in the chat composer' }
]

/**
 * Settings sidebar view: app + workspace facts, model providers, API key
 * management and the keyboard map. Keys themselves never render here —
 * only their source badge does.
 */
export function mountSettingsView(container: HTMLElement): void {
  const view = el('div', 'settings-view')
  container.appendChild(view)

  renderAppSection(view)
  renderAgentSection(view)
  renderWorkspaceSection(view)
  renderModelsSection(view)
  renderKeysSection(view)
  renderShortcutsSection(view)
}

function section(title: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('div', 'settings-section')
  root.appendChild(el('div', 'settings-title', title))
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

function renderAppSection(view: HTMLElement): void {
  const { root, body } = section('Application')
  const info = store.get().appInfo
  body.appendChild(factRow('Name', info?.name ?? 'halis-code'))
  body.appendChild(factRow('Version', info ? `v${info.version}` : 'v0.1.0'))
  body.appendChild(factRow('Electron', info?.electron ?? '—'))
  body.appendChild(factRow('Platform', info?.platform ?? '—'))
  view.appendChild(root)
}

function renderAgentSection(view: HTMLElement): void {
  const { root, body } = section('Agent')

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

  const hint = el('div', 'settings-hint')
  hint.textContent =
    '"Ask first" shows a prompt whenever the agent runs a command that looks destructive. "Full access" runs everything without asking.'
  body.appendChild(hint)
  view.appendChild(root)
}

function renderWorkspaceSection(view: HTMLElement): void {
  const { root, body } = section('Workspace')
  const rootPath = store.get().workspaceRoot
  body.appendChild(factRow('Folder', rootPath ?? 'No folder opened'))

  const actions = el('div', 'settings-actions')
  const openBtn = el('button', 'btn', rootPath ? 'Switch folder' : 'Open folder') as HTMLButtonElement
  openBtn.type = 'button'
  openBtn.addEventListener('click', async () => {
    const next = await window.halis.pickWorkspace()
    if (next) {
      store.update({ workspaceRoot: next })
    }
  })
  actions.appendChild(openBtn)
  body.appendChild(actions)
  view.appendChild(root)
}

function renderModelsSection(view: HTMLElement): void {
  const { root, body } = section('Models')
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
  const refreshBtn = el('button', 'btn', 'Refresh catalog') as HTMLButtonElement
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

  const hint = el('div', 'settings-hint')
  hint.textContent =
    'Models come from the models.dev catalog. Pick one in the agent panel; reasoning variants and favorites are stored locally.'
  body.appendChild(hint)
  view.appendChild(root)
}

function renderKeysSection(view: HTMLElement): void {
  const { root, body } = section('API keys')
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
          'No provider keys yet. Select a model in the agent panel and use the API key chip, or press "Add a key" below.'
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
    removeBtn.appendChild(svg(icons.trash, 12))
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
  const addBtn = el('button', 'btn', 'Add a key') as HTMLButtonElement
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
  view.appendChild(root)
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

function renderShortcutsSection(view: HTMLElement): void {
  const { root, body } = section('Shortcuts')
  for (const shortcut of SHORTCUTS) {
    const row = el('div', 'settings-row')
    const keys = el('kbd', 'settings-kbd', shortcut.keys)
    const description = el('span', 'settings-value', shortcut.description)
    row.append(keys, description)
    body.appendChild(row)
  }
  view.appendChild(root)
}
