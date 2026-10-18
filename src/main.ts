import './styles/base.css'
import './styles/layout.css'
import './styles/sidebar.css'
import './styles/chat.css'
import './styles/workspace.css'
import './styles/overlays.css'

import { el } from './app/dom'
import { store } from './app/store'
import { loadConfig, saveConfig } from './core/config/config-service'
import { installBridgeStub } from './core/bridge-stub'

import { mountCaption } from './components/caption'
import { mountSidebar } from './components/sidebar'
import { mountConversation } from './components/conversation'
import { mountWorkspaceRail } from './components/right-rail'

/* Column geometry defaults. */
const SIDEBAR_DEFAULT = 280
const RAIL_DEFAULT = 420
const SIDEBAR_MIN = 264
const SIDEBAR_MAX = 420
const RAIL_MIN = 320
const RAIL_MAX = 640

interface FrameSizes {
  sidebar: number
  rail: number
}

function loadSizes(): FrameSizes {
  try {
    const raw = localStorage.getItem('halis.frame-sizes')
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FrameSizes>
      const sidebar = Number(parsed.sidebar)
      const rail = Number(parsed.rail)
      return {
        // A corrupted entry could hold anything; NaN would poison the grid
        // template and persist across restarts.
        sidebar: clamp(Number.isFinite(sidebar) ? sidebar : SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
        rail: clamp(Number.isFinite(rail) ? rail : RAIL_DEFAULT, RAIL_MIN, RAIL_MAX)
      }
    }
  } catch {
    // fall through to defaults
  }
  return { sidebar: SIDEBAR_DEFAULT, rail: RAIL_DEFAULT }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function saveSizes(sizes: FrameSizes): void {
  try {
    localStorage.setItem('halis.frame-sizes', JSON.stringify(sizes))
  } catch {
    // storage unavailable — sizes just do not persist
  }
}

function buildShell(): void {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) {
    throw new Error('#app container missing')
  }

  const frame = el('div', 'frame')
  const isMac = document.body.classList.contains('is-mac')
  if (!isMac) {
    frame.appendChild(mountCaption())
  }

  const shell = el('div', 'shell')
  shell.dataset.sidebarOpen = ''
  shell.dataset.railOpen = ''

  const sidebarCol = el('aside', 'sidebar-col')
  sidebarCol.appendChild(mountSidebar())

  const centerCol = el('main', 'center-col')
  centerCol.appendChild(mountConversation())

  const railCol = el('div', 'rail-col')
  railCol.appendChild(mountWorkspaceRail())

  shell.append(sidebarCol, centerCol, railCol)
  frame.appendChild(shell)
  root.appendChild(frame)

  const sizes = loadSizes()

  const paint = (): void => {
    const state = store.get()
    const sidebarWidth = state.sidebarVisible ? sizes.sidebar : 0
    const railWidth = state.railVisible ? sizes.rail : 0
    shell.style.gridTemplateColumns = `${sidebarWidth}px minmax(0, 1fr) ${railWidth}px`
    if (state.sidebarVisible) {
      shell.dataset.sidebarOpen = ''
    } else {
      delete shell.dataset.sidebarOpen
    }
    if (state.railVisible) {
      shell.dataset.railOpen = ''
    } else {
      delete shell.dataset.railOpen
    }
  }
  paint()

  // Only a discrete collapse/expand toggle eases the tracks; steady-state
  // drags land instantly.
  let animatingTimer = 0
  const animateOnce = (): void => {
    shell.dataset.animating = ''
    window.clearTimeout(animatingTimer)
    animatingTimer = window.setTimeout(() => {
      delete shell.dataset.animating
    }, 320)
  }

  let prevSidebar = store.get().sidebarVisible
  let prevRail = store.get().railVisible
  store.subscribe((state) => {
    if (state.sidebarVisible !== prevSidebar || state.railVisible !== prevRail) {
      prevSidebar = state.sidebarVisible
      prevRail = state.railVisible
      animateOnce()
    }
    paint()
  })

  // ---- drag handles ---------------------------------------------------
  const leftHandle = el('div', 'handle handle-left')
  const rightHandle = el('div', 'handle handle-right')
  shell.append(leftHandle, rightHandle)

  const positionHandles = (): void => {
    const state = store.get()
    leftHandle.style.left = state.sidebarVisible ? `${sizes.sidebar - 4}px` : '-100px'
    leftHandle.style.display = state.sidebarVisible ? '' : 'none'
    rightHandle.style.right = state.railVisible ? `${sizes.rail - 4}px` : '-100px'
    rightHandle.style.display = state.railVisible ? '' : 'none'
  }
  positionHandles()
  store.subscribe(positionHandles)

  let dragging = false
  const drag = (
    handle: HTMLElement,
    pick: () => number,
    apply: (start: number, dx: number) => void
  ): void => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      // A second pointer (touch palm, another mouse) must not start a
      // competing drag with its own listener pair.
      if (dragging) return
      dragging = true
      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      const origin = event.clientX
      const start = pick()
      shell.dataset.dragging = ''
      const move = (moveEvent: PointerEvent): void => {
        apply(start, moveEvent.clientX - origin)
        paint()
        positionHandles()
      }
      const up = (): void => {
        dragging = false
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
        delete shell.dataset.dragging
        saveSizes(sizes)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    })
  }

  drag(
    leftHandle,
    () => sizes.sidebar,
    (_start, dx) => {
      sizes.sidebar = clamp(_start + dx, SIDEBAR_MIN, SIDEBAR_MAX)
    }
  )
  drag(
    rightHandle,
    () => sizes.rail,
    (_start, dx) => {
      sizes.rail = clamp(_start - dx, RAIL_MIN, RAIL_MAX)
    }
  )
}

function mountSplash(): HTMLElement {
  const splash = el('div', 'splash')
  const brand = el('span', 'splash-brand')
  const tagline = el('p', 'splash-tagline')
  tagline.append('Your desktop coding ', el('em', undefined, 'agent'))
  splash.append(brand, tagline)
  return splash
}

async function boot(): Promise<void> {
  // Without the preload bridge the renderer must still come up — the stub
  // keeps every window.halis access alive instead of dying on the first one.
  if (typeof window.halis === 'undefined') {
    installBridgeStub()
  }

  const splash = mountSplash()
  document.body.appendChild(splash)

  // Theme follows the system.
  const palette = window.matchMedia('(prefers-color-scheme: dark)')
  const syncTheme = (): void => {
    document.body.toggleAttribute('data-halis-dark-theme', palette.matches)
  }
  syncTheme()
  palette.addEventListener('change', syncTheme)

  try {
    const info = await window.halis.getInfo()
    store.update({ appInfo: info })
    if (info.platform === 'darwin') {
      document.body.classList.add('is-mac')
    }
  } catch {
    // bridge not available (e.g. opened outside electron) — keep going with defaults
  }

  buildShell()

  // restore the last workspace if it still exists
  const config = loadConfig()
  if (config.lastWorkspace) {
    try {
      const opened = await window.halis.openWorkspace(config.lastWorkspace)
      if (opened) {
        store.update({ workspaceRoot: opened })
      }
    } catch {
      // bridge unavailable — start without a workspace
    }
  }

  store.subscribe((state, prev) => {
    if (state.workspaceRoot !== prev.workspaceRoot && state.workspaceRoot) {
      saveConfig({ lastWorkspace: state.workspaceRoot })
    }
  })

  // The agent or the user edits files; fan the change out through the store
  // so the tree and any open editor stay in sync.
  window.halis.onWorkspaceChanged((event) => {
    const previous = store.get().lastTouchedFile
    store.update({
      lastTouchedFile: {
        path: event.path,
        seq: (previous?.seq ?? 0) + 1,
        ...(event.change !== undefined ? { change: event.change } : {}),
        ...(event.from !== undefined ? { from: event.from } : {})
      }
    })
  })

  installKeymap()

  // Commands arriving from the native application menu.
  window.halis.onMenuCommand((command) => {
    if (command === 'open-workspace') {
      void window.halis.pickWorkspace().then((root) => {
        if (root) {
          store.update({ workspaceRoot: root })
        }
      }).catch(() => undefined)
    } else if (command === 'toggle-sidebar') {
      store.update({ sidebarVisible: !store.get().sidebarVisible })
    } else if (command === 'toggle-terminal') {
      toggleTerminal()
    } else if (command === 'toggle-chat') {
      store.update({ railVisible: !store.get().railVisible })
    }
  })

  window.setTimeout(() => {
    splash.dataset.leaving = ''
    window.setTimeout(() => splash.remove(), 320)
  }, 450)
}

function toggleTerminal(): void {
  const state = store.get()
  if (state.railVisible && state.railTab === 'terminal') {
    store.update({ railTab: 'files' })
  } else {
    store.update({ railVisible: true, railTab: 'terminal' })
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function installKeymap(): void {
  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return
    // OS key repeat would fire the toggle per tick and flip panels wildly.
    if (event.repeat) return
    if (event.key === '`') {
      event.preventDefault()
      toggleTerminal()
      return
    }
    // Ctrl+B / Ctrl+J / Ctrl+N are live readline keys in the terminal input
    // and ordinary typing aids elsewhere — inside an editable surface the
    // keystroke belongs to the text, not to the panels.
    if (isEditableTarget(event.target)) return

    if (event.key.toLowerCase() === 'b') {
      event.preventDefault()
      store.update({ sidebarVisible: !store.get().sidebarVisible })
    } else if (event.key.toLowerCase() === 'j') {
      event.preventDefault()
      store.update({ railVisible: !store.get().railVisible })
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      window.dispatchEvent(new CustomEvent('halis:new-session'))
    }
  })
}

void boot()
