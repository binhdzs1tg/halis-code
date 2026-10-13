import './styles/base.css'
import './styles/layout.css'
import './styles/components.css'

import { el } from './app/dom'
import { store } from './app/store'
import { loadConfig, saveConfig } from './core/config/config-service'

import { mountTitlebar } from './components/titlebar'
import { mountActivityBar } from './components/activity-bar'
import { mountSidebar } from './components/sidebar'
import { mountEditorArea } from './components/editor-area'
import { mountTerminalPanel } from './components/terminal-panel'
import { mountChatPanel } from './components/chat-panel'
import { mountStatusBar } from './components/status-bar'

function buildShell(): HTMLElement {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) {
    throw new Error('#app container missing')
  }

  const shell = el('div', 'shell')

  const body = el('div', 'shell-body')
  const workbench = el('div', 'workbench')

  body.append(
    mountActivityBar(),
    mountSidebar(),
    workbench
  )

  workbench.append(mountEditorArea(), mountTerminalPanel())
  body.appendChild(mountChatPanel())

  shell.append(mountTitlebar(), body, mountStatusBar())
  root.appendChild(shell)

  store.subscribe((state, prev) => {
    if (state.sidebarVisible !== prev.sidebarVisible) {
      body.classList.toggle('no-sidebar', !state.sidebarVisible)
    }
    if (state.chatOpen !== prev.chatOpen) {
      body.classList.toggle('no-chat', !state.chatOpen)
    }
  })

  return shell
}

async function boot(): Promise<void> {
  buildShell()

  try {
    const info = await window.halis.getInfo()
    store.update({ appInfo: info })
    if (info.platform === 'darwin') {
      document.body.classList.add('is-mac')
    }
  } catch {
    // bridge not available (e.g. opened outside electron) — keep going with defaults
  }

  // restore the last workspace if it still exists
  const config = loadConfig()
  if (config.lastWorkspace) {
    const opened = await window.halis.openWorkspace(config.lastWorkspace)
    if (opened) {
      store.update({ workspaceRoot: opened })
    }
  }

  store.subscribe((state, prev) => {
    if (state.workspaceRoot !== prev.workspaceRoot && state.workspaceRoot) {
      saveConfig({ lastWorkspace: state.workspaceRoot })
    }
  })

  installKeymap()
}

function installKeymap(): void {
  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return

    if (event.key === '`') {
      event.preventDefault()
      store.update({ terminalOpen: !store.get().terminalOpen })
    } else if (event.key.toLowerCase() === 'b') {
      event.preventDefault()
      store.update({ sidebarVisible: !store.get().sidebarVisible })
    } else if (event.key.toLowerCase() === 'j') {
      event.preventDefault()
      store.update({ chatOpen: !store.get().chatOpen })
    }
  })
}

void boot()
