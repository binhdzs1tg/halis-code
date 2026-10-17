import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'

/**
 * Windows/linux caption strip: a 40px drag row with custom min/max/close
 * controls. macOS hides the
 * row entirely — traffic lights sit in the sidebar top strip instead.
 */
export function mountCaption(): HTMLElement {
  const bar = el('header', 'caption')

  const title = el('span', 'caption-caption-title', 'Halis Code')
  bar.appendChild(title)

  const syncTitle = (): void => {
    const root = store.get().workspaceRoot
    title.textContent = root ? `${fileName(root)} — Halis Code` : 'Halis Code'
  }
  syncTitle()
  store.subscribe((state, prev) => {
    if (state.workspaceRoot !== prev.workspaceRoot) syncTitle()
  })

  const minBtn = el('button', 'caption-btn') as HTMLButtonElement
  minBtn.type = 'button'
  minBtn.title = 'Minimize'
  minBtn.appendChild(svg(icons.minus, 14))
  minBtn.addEventListener('click', () => window.halis.minimize())

  const maxBtn = el('button', 'caption-btn') as HTMLButtonElement
  maxBtn.type = 'button'
  maxBtn.title = 'Maximize'
  maxBtn.appendChild(svg(icons.maximize, 12))
  maxBtn.addEventListener('click', () => window.halis.maximize())
  window.halis.onWindowState((maximized) => {
    maxBtn.title = maximized ? 'Restore' : 'Maximize'
    maxBtn.replaceChildren(svg(maximized ? icons.restore : icons.maximize, 12))
  })

  const closeBtn = el('button', 'caption-btn close') as HTMLButtonElement
  closeBtn.type = 'button'
  closeBtn.title = 'Close'
  closeBtn.appendChild(svg(icons.close, 13))
  closeBtn.addEventListener('click', () => window.halis.close())

  bar.append(minBtn, maxBtn, closeBtn)
  return bar
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}
