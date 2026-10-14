import { clear, el, svg } from '../../app/dom'
import { icons } from '../../app/icons'
import { store } from '../../app/store'
import type { WorkspaceEntry, WorkspaceEntryKind } from '../../../electron/shared/types'

const INDENT = 14

/**
 * Explorer tree with file management: inline creation, rename and delete
 * (to the OS trash) from a context menu. Mutations go through the main
 * process and come back as workspace:changed events that re-render the tree.
 */
export function mountFileTree(container: HTMLElement): void {
  const toolbar = el('div', 'tree-toolbar')

  const newFileBtn = toolButton('New file', icons.filePlus)
  const newFolderBtn = toolButton('New folder', icons.folderPlus)
  const refreshBtn = toolButton('Refresh', icons.refresh)

  toolbar.append(newFileBtn, newFolderBtn, refreshBtn)

  const tree = el('div', 'file-tree')
  const errorNote = el('div', 'tree-error hidden')
  container.append(toolbar, errorNote, tree)

  let errorTimer = 0

  function showError(message: string): void {
    errorNote.textContent = message
    errorNote.classList.remove('hidden')
    window.clearTimeout(errorTimer)
    errorTimer = window.setTimeout(() => {
      errorNote.classList.add('hidden')
    }, 4000)
  }

  function toolButton(title: string, icon: string): HTMLButtonElement {
    const btn = el('button', 'tree-tool') as HTMLButtonElement
    btn.type = 'button'
    btn.title = title
    btn.appendChild(svg(icon, 14))
    return btn
  }

  async function renderRoot(): Promise<void> {
    clear(tree)
    const root = store.get().workspaceRoot
    if (!root) return

    try {
      const entries = await window.halis.readDir('')
      if (entries.length === 0) {
        const empty = el('div', 'tree-empty', 'This folder is empty.\nUse the buttons above to create files.')
        tree.appendChild(empty)
        return
      }
      for (const entry of entries) {
        tree.appendChild(renderEntry(entry, 0))
      }
    } catch (err) {
      tree.appendChild(el('div', 'planned', `Cannot read workspace: ${errText(err)}`))
    }
  }

  function renderEntry(entry: WorkspaceEntry, depth: number): HTMLElement {
    const row = el('button', `tree-item ${entry.kind === 'directory' ? 'dir' : 'file'}`)
    row.style.paddingLeft = `${10 + depth * INDENT}px`
    row.dataset.path = entry.path

    const twist = el('span', 'twist')
    if (entry.kind === 'directory') {
      twist.appendChild(svg(icons.chevron, 12))
    }
    row.appendChild(twist)

    const iconWrap = el('span', 'kind-icon')
    iconWrap.appendChild(svg(entry.kind === 'directory' ? icons.folder : icons.file, 14))
    row.appendChild(iconWrap)

    row.appendChild(el('span', 'label', entry.name))

    if (entry.path === store.get().openFile) {
      row.classList.add('active')
    }

    if (entry.kind === 'directory') {
      row.addEventListener('click', () => void toggleDir(row, entry, depth))
    } else {
      row.addEventListener('click', () => openInEditor(entry))
    }

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      openContextMenu(event, entry)
    })

    return row
  }

  function openInEditor(entry: WorkspaceEntry): void {
    const state = store.get()
    store.update({
      openFiles: state.openFiles.includes(entry.path)
        ? state.openFiles
        : [...state.openFiles, entry.path],
      openFile: entry.path,
      openFileLine: null
    })
    tree.querySelectorAll('.tree-item.active').forEach((node) => node.classList.remove('active'))
    tree.querySelector(`.tree-item[data-path="${CSS.escape(entry.path)}"]`)?.classList.add('active')
  }

  async function toggleDir(row: HTMLElement, entry: WorkspaceEntry, depth: number): Promise<void> {
    const twist = row.querySelector('.twist')
    const expanded = row.dataset.expanded === '1'
    row.dataset.expanded = expanded ? '0' : '1'
    twist?.classList.toggle('open', !expanded)

    if (!expanded && row.dataset.loaded !== '1') {
      row.dataset.loaded = '1'
      try {
        const children = await window.halis.readDir(entry.path)
        let anchor: HTMLElement = row
        for (const child of children) {
          const node = renderEntry(child, depth + 1)
          anchor.insertAdjacentElement('afterend', node)
          anchor = node
        }
      } catch (err) {
        tree.appendChild(el('div', 'planned', `Cannot read folder: ${errText(err)}`))
      }
      return
    }

    // toggle visibility of the rows that follow until the next row
    // at the same or lower depth
    let next = row.nextElementSibling as HTMLElement | null
    while (next && next.classList.contains('tree-item')) {
      const nextDepth = Number(next.style.paddingLeft.replace('px', ''))
      if (nextDepth <= 10 + depth * INDENT) break
      next.style.display = expanded ? '' : 'none'
      next = next.nextElementSibling as HTMLElement | null
    }
  }

  // ---- mutations ----

  const validName = (name: string): string | null => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
      return null
    }
    return trimmed
  }

  function beginCreate(kind: WorkspaceEntryKind, parent: WorkspaceEntry | null): void {
    // one creation row at a time
    tree.querySelector('.tree-creating')?.remove()

    const row = el('div', 'tree-item tree-creating')
    const depth = parent ? depthOf(parent.path) + 1 : 0
    row.style.paddingLeft = `${10 + depth * INDENT}px`

    const iconWrap = el('span', 'kind-icon')
    iconWrap.appendChild(svg(kind === 'directory' ? icons.folder : icons.file, 14))
    row.appendChild(iconWrap)

    const input = el('input', 'tree-name-input') as HTMLInputElement
    input.type = 'text'
    input.spellcheck = false
    input.placeholder = kind === 'directory' ? 'folder-name' : 'file-name.ts'
    row.appendChild(input)

    if (parent) {
      const anchor = tree.querySelector(`.tree-item[data-path="${CSS.escape(parent.path)}"]`)
      anchor?.insertAdjacentElement('afterend', row)
    } else {
      tree.prepend(row)
    }
    input.focus()

    const cancel = (): void => {
      row.remove()
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
        return
      }
      if (event.key !== 'Enter') return
      event.preventDefault()
      const name = validName(input.value)
      if (!name) {
        input.classList.add('invalid')
        return
      }
      const relPath = parent ? `${parent.path}/${name}` : name
      window.halis
        .createEntry(relPath, kind)
        .then(() => {
          cancel()
          // tree re-renders through workspace:changed
        })
        .catch((err) => {
          showError(errText(err))
          input.classList.add('invalid')
        })
    })
    input.addEventListener('blur', cancel)
  }

  function beginRename(entry: WorkspaceEntry): void {
    const row = tree.querySelector<HTMLElement>(
      `.tree-item[data-path="${CSS.escape(entry.path)}"]`
    )
    if (!row) return
    const label = row.querySelector('.label')
    if (!label) return

    const input = el('input', 'tree-name-input') as HTMLInputElement
    input.type = 'text'
    input.spellcheck = false
    input.value = entry.name
    label.replaceWith(input)
    input.focus()
    input.select()

    const cancel = (): void => {
      input.replaceWith(el('span', 'label', entry.name))
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
        return
      }
      if (event.key !== 'Enter') return
      event.preventDefault()
      const name = validName(input.value)
      if (!name || name === entry.name) {
        cancel()
        return
      }
      const parent = entry.path.includes('/')
        ? entry.path.slice(0, entry.path.lastIndexOf('/'))
        : ''
      const to = parent ? `${parent}/${name}` : name
      window.halis
        .renameEntry(entry.path, to)
        .then(cancel)
        .catch((err) => {
          showError(errText(err))
          cancel()
        })
    })
    input.addEventListener('blur', cancel)
  }

  function remove(entry: WorkspaceEntry): void {
    window.halis.deleteEntry(entry.path).catch((err) => {
      showError(errText(err))
    })
  }

  // ---- context menu ----

  function openContextMenu(event: MouseEvent, entry: WorkspaceEntry): void {
    closeContextMenu()

    const menu = el('div', 'context-menu')
    const parent = entry.kind === 'directory' ? entry : null

    const addItem = (label: string, onClick: () => void, danger = false): void => {
      const item = el('button', `context-item${danger ? ' danger' : ''}`) as HTMLButtonElement
      item.type = 'button'
      item.textContent = label
      item.addEventListener('click', () => {
        closeContextMenu()
        onClick()
      })
      menu.appendChild(item)
    }

    if (entry.kind === 'directory') {
      addItem('New file', () => beginCreate('file', parent))
      addItem('New folder', () => beginCreate('directory', parent))
      menu.appendChild(el('div', 'context-sep'))
    }
    addItem('Rename', () => beginRename(entry))
    addItem('Delete', () => remove(entry), true)

    document.body.appendChild(menu)

    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - rect.height - 8)}px`

    window.setTimeout(() => {
      window.addEventListener('mousedown', closeOnOutside, { once: true })
      window.addEventListener('keydown', closeOnEscape, { once: true })
      window.addEventListener('blur', closeContextMenu, { once: true })
    })

    function closeOnOutside(mouseEvent: MouseEvent): void {
      if (!(mouseEvent.target instanceof Element) || !menu.contains(mouseEvent.target)) {
        closeContextMenu()
      } else {
        window.addEventListener('mousedown', closeOnOutside, { once: true })
      }
    }
    function closeOnEscape(keyboardEvent: KeyboardEvent): void {
      if (keyboardEvent.key === 'Escape') {
        closeContextMenu()
      } else {
        window.addEventListener('keydown', closeOnEscape, { once: true })
      }
    }
  }

  function closeContextMenu(): void {
    document.querySelector('.context-menu')?.remove()
  }

  // ---- toolbar wiring ----

  newFileBtn.addEventListener('click', () => beginCreate('file', null))
  newFolderBtn.addEventListener('click', () => beginCreate('directory', null))
  refreshBtn.addEventListener('click', () => void renderRoot())

  // ---- store wiring ----

  store.subscribe((state, prev) => {
    if (state.workspaceRoot !== prev.workspaceRoot) {
      void renderRoot()
      return
    }
    // Files created, edited or deleted anywhere need a fresh listing.
    if (state.lastTouchedFile !== prev.lastTouchedFile) {
      void renderRoot()
    }
  })

  void renderRoot()
}

function depthOf(path: string): number {
  return path.split('/').length - 1
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
