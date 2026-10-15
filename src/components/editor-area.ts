import { clear, el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store, type TouchedFile } from '../app/store'

/**
 * Tabbed, editable code view. Edits buffer in memory until Ctrl+S; the agent
 * can still rewrite the file underneath, in which case a clean buffer reloads
 * and a dirty one keeps the user's edits.
 */

/** Unsaved contents keyed by workspace path. */
const unsaved = new Map<string, string>()

let textarea: HTMLTextAreaElement | null = null
let gutter: HTMLElement | null = null
let saveStatus: HTMLElement | null = null
let statusTimer = 0

export function mountEditorArea(): HTMLElement {
  const area = el('section', 'editor-area')

  store.subscribe((state, prev) => {
    if (
      state.openFile !== prev.openFile ||
      state.openFiles !== prev.openFiles ||
      state.workspaceRoot !== prev.workspaceRoot
    ) {
      render(area)
      return
    }
    const touched = state.lastTouchedFile
    if (touched && touched !== prev.lastTouchedFile) {
      reconcile(area, touched)
    }
  })

  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveActive()
    }
  })

  render(area)
  return area
}

function render(area: HTMLElement): void {
  clear(area)
  textarea = null
  gutter = null

  const { openFiles, openFile } = store.get()
  if (openFile === null) {
    if (openFiles.length === 0) {
      renderWelcome(area)
      return
    }
    // fall through: tabs survive with no active tab; show welcome-ish body
  }

  const tabbar = el('div', 'tabbar')
  for (const path of openFiles) {
    tabbar.appendChild(renderTab(path, path === openFile))
  }
  const status = el('span', 'save-status')
  saveStatus = status
  tabbar.appendChild(status)
  area.appendChild(tabbar)

  if (openFile === null) {
    const body = el('div', 'code-view')
    body.appendChild(el('div', 'notice', 'Select a tab to start editing.'))
    area.appendChild(body)
    return
  }

  const body = el('div', 'code-view')
  const lines = el('div', 'gutter')
  const input = el('textarea', 'editor-input') as HTMLTextAreaElement
  input.spellcheck = false
  input.wrap = 'off'
  input.autocapitalize = 'off'
  input.autocomplete = 'off'
  gutter = lines
  textarea = input

  void loadInto(input, openFile, lines)

  input.addEventListener('input', () => {
    const path = store.get().openFile
    if (!path || textarea === null) return
    unsaved.set(path, textarea.value)
    paintGutter(lines, textarea.value)
    markDirty(path, true)
  })
  input.addEventListener('scroll', () => {
    if (gutter && textarea) {
      gutter.scrollTop = textarea.scrollTop
    }
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault()
      input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end')
      input.dispatchEvent(new Event('input'))
    }
  })

  body.append(lines, input)
  area.appendChild(body)
}

function renderTab(path: string, active: boolean): HTMLElement {
  const tab = el('div', `tab${active ? ' active' : ''}`)
  tab.title = path
  tab.dataset.path = path

  const iconWrap = el('span')
  iconWrap.appendChild(svg(icons.file, 13))
  tab.appendChild(iconWrap)

  const label = el('span', undefined, fileName(path))
  tab.appendChild(label)

  if (unsaved.has(path)) {
    tab.appendChild(el('span', 'dirty'))
  }

  const closeBtn = el('button', 'close') as HTMLButtonElement
  closeBtn.type = 'button'
  closeBtn.title = 'Close'
  closeBtn.appendChild(svg(icons.close, 12))
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    closeTab(path)
  })
  tab.appendChild(closeBtn)

  tab.addEventListener('click', () => {
    if (store.get().openFile !== path) {
      store.update({ openFile: path, openFileLine: null })
    }
  })
  return tab
}

/** Toggle the unsaved dot on a tab without rebuilding the editor. */
function markDirty(path: string, dirty: boolean): void {
  const tab = document.querySelector<HTMLElement>(`.editor-area .tab[data-path="${CSS.escape(path)}"]`)
  if (!tab) return
  const has = Boolean(tab.querySelector('.dirty'))
  if (dirty === has) return
  if (dirty) {
    tab.insertBefore(el('span', 'dirty'), tab.querySelector('.close'))
  } else {
    tab.querySelector('.dirty')?.remove()
  }
}

export function closeTab(path: string, dropUnsaved = false): void {
  const state = store.get()
  const index = state.openFiles.indexOf(path)
  const next = state.openFiles.filter((item) => item !== path)
  if (dropUnsaved) {
    unsaved.delete(path)
  }

  let active = state.openFile
  if (active === path) {
    active = next[Math.min(index, next.length - 1)] ?? null
  }
  store.update({ openFiles: next, openFile: active, openFileLine: null })
}

async function loadInto(input: HTMLTextAreaElement, path: string, lines: HTMLElement): Promise<void> {
  const dirty = unsaved.get(path)
  if (dirty !== undefined) {
    input.value = dirty
    paintGutter(lines, dirty)
    revealPendingLine(input)
    return
  }
  try {
    const content = await window.halis.readFile(path)
    // the user may have switched tabs while the file was being read
    if (store.get().openFile !== path) return
    input.value = content
    paintGutter(lines, content)
    revealPendingLine(input)
  } catch (err) {
    input.value = ''
    input.disabled = true
    input.placeholder = err instanceof Error ? err.message : String(err)
  }
}

function revealPendingLine(input: HTMLTextAreaElement): void {
  const line = store.get().openFileLine
  if (!line || line <= 1) return
  // one rendered line is 1.6em of the 12.5px mono font
  input.scrollTop = Math.max(0, (line - 4) * 20)
}

function paintGutter(node: HTMLElement, content: string): void {
  const count = content.split('\n').length
  const parts: string[] = []
  for (let i = 1; i <= count; i += 1) {
    parts.push(String(i))
  }
  node.textContent = parts.join('\n')
}

async function saveActive(): Promise<void> {
  const path = store.get().openFile
  if (!path) return
  const content = unsaved.get(path)
  if (content === undefined) return

  showStatus('Saving…')
  try {
    await window.halis.writeFile(path, content)
    unsaved.delete(path)
    showStatus('Saved')
    markDirty(path, false)
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), true)
  }
}

function showStatus(text: string, isError = false): void {
  if (!saveStatus) return
  window.clearTimeout(statusTimer)
  saveStatus.className = `save-status${isError ? ' error' : ''}`
  saveStatus.textContent = text
  if (text && !isError) {
    statusTimer = window.setTimeout(() => {
      if (saveStatus) {
        saveStatus.textContent = ''
      }
    }, 1600)
  }
}

/**
 * Fan out agent/user-side file changes: rename or delete open tabs, and reload
 * the on-screen file when it was rewritten elsewhere (e.g. by the agent).
 */
function reconcile(area: HTMLElement, touched: TouchedFile): void {
  void area
  const state = store.get()

  if (touched.change === 'rename' && touched.from) {
    if (state.openFiles.includes(touched.from)) {
      const openFiles = state.openFiles.map((item) => (item === touched.from ? touched.path : item))
      if (unsaved.has(touched.from)) {
        unsaved.set(touched.path, unsaved.get(touched.from) as string)
        unsaved.delete(touched.from)
      }
      store.update({
        openFiles,
        openFile: state.openFile === touched.from ? touched.path : state.openFile
      })
      return
    }
  }

  if (touched.change === 'delete' && state.openFiles.includes(touched.path)) {
    closeTab(touched.path, true)
    return
  }

  // A rewritten file that is on screen and clean: reload it in place.
  if (
    touched.path === state.openFile &&
    !unsaved.has(touched.path) &&
    textarea &&
    gutter &&
    !textarea.disabled
  ) {
    void window.halis
      .readFile(touched.path)
      .then((content) => {
        if (textarea && textarea.value !== content) {
          textarea.value = content
          if (gutter) paintGutter(gutter, content)
        }
      })
      .catch(() => undefined)
  }
}

function renderWelcome(area: HTMLElement): void {
  const welcome = el('div', 'editor-empty')

  const mark = el('span', 'empty-mark')
  welcome.appendChild(mark)
  welcome.appendChild(el('div', 'empty-title', 'No file open'))
  welcome.appendChild(
    el('div', 'empty-hint', 'Pick a file from the Files tab, or let the agent open one for you.')
  )

  area.appendChild(welcome)
}

function fileName(path: string): string {
  return path.split('/').pop() || path
}
