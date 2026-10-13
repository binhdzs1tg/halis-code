import { clear, el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'

export function mountEditorArea(): HTMLElement {
  const area = el('section', 'editor-area')
  let currentFile: string | null = null

  store.subscribe((state, prev) => {
    if (state.openFile !== prev.openFile) {
      currentFile = state.openFile
      void render(area, currentFile)
    }
  })

  void render(area, currentFile)
  return area
}

async function render(area: HTMLElement, file: string | null): Promise<void> {
  clear(area)

  if (!file) {
    renderWelcome(area)
    return
  }

  // tab bar
  const tabbar = el('div', 'tabbar')
  const tab = el('div', 'tab active')
  const tabIcon = el('span')
  tabIcon.appendChild(svg(icons.file, 13))
  const closeBtn = el('button', 'close')
  closeBtn.title = 'Close file'
  closeBtn.appendChild(svg(icons.close, 12))
  closeBtn.addEventListener('click', () => {
    store.update({ openFile: null })
  })
  tab.append(tabIcon, el('span', undefined, fileName(file)), closeBtn)
  tabbar.appendChild(tab)

  area.appendChild(tabbar)

  // content
  try {
    const content = await window.halis.readFile(file)
    // bail out if the user closed the tab while we were reading
    if (store.get().openFile !== file) return

    const view = el('div', 'code-view')
    const lines = content.split('\n')
    const gutter = el('div', 'gutter', lines.map((_, i) => String(i + 1)).join('\n'))
    const code = el('pre', 'code selectable')
    code.textContent = content
    view.append(gutter, code)
    area.appendChild(view)
  } catch (err) {
    const note = el('div', 'notice selectable', err instanceof Error ? err.message : String(err))
    area.appendChild(note)
  }
}

function renderWelcome(area: HTMLElement): void {
  const welcome = el('div', 'welcome')

  const logo = el('div', 'logo-big')
  logo.appendChild(svg(icons.logo, 52))

  welcome.appendChild(logo)
  welcome.appendChild(el('h1', undefined, 'Halis Code'))
  welcome.appendChild(el('div', 'tagline', 'Your desktop coding agent — skeleton build'))

  const hints = el('div', 'hints')
  const rows: Array<[string, string]> = [
    ['Open a folder', 'from the Explorer or the status bar'],
    ['Chat with the agent', 'panel on the right'],
    ['Toggle terminal / sidebar', 'Ctrl+` / Ctrl+B']
  ]
  for (const [key, desc] of rows) {
    const row = el('div', 'row')
    row.appendChild(el('kbd', undefined, key))
    row.appendChild(el('span', undefined, desc))
    hints.appendChild(row)
  }
  welcome.appendChild(hints)

  const version = el('div', 'version')
  const info = store.get().appInfo
  version.textContent = info ? `v${info.version} · electron ${info.electron}` : 'v0.1.0'

  welcome.appendChild(version)
  area.appendChild(welcome)
}

function fileName(path: string): string {
  return path.split('/').pop() || path
}
