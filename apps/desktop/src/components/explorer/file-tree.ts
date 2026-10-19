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
  // Bumps on every render; an older async render that finishes late must
  // not paint stale entries on top of the fresh listing.
  let renderGen = 0
  /** What the user is editing right now, so an agent-triggered re-render
   *  (workspace:changed fires constantly mid-run) can rebuild the input
   *  instead of silently destroying everything typed so far. */
  let editing: {
    kind: 'create' | 'rename'
    /** Rename: path of the row; create: parent path or null for root. */
    anchor: string | null
    entryKind: WorkspaceEntryKind
    /** Rename: the name being replaced. */
    originalName: string | null
    value: string
    /** Present once snapshotEditing captured a live input. */
    caretStart?: number
    caretEnd?: number
  } | null = null
  /** Workspace root the edit started in; a root switch invalidates it. */
  let editingRoot: string | null = null

  /** Live editing snapshot taken just before a re-render clears the tree. */
  function snapshotEditing(): typeof editing {
    if (!editing) return null
    const input = tree.querySelector<HTMLInputElement>('.tree-name-input')
    if (!input || !input.isConnected) return { ...editing }
    return {
      ...editing,
      value: input.value,
      caretStart: input.selectionStart ?? input.value.length,
      caretEnd: input.selectionEnd ?? input.value.length
    }
  }

  /** Rebuild the create/rename row a re-render wiped out. */
  function restoreEditing(snapshot: NonNullable<typeof editing>): void {
    editing = null
    if (snapshot.kind === 'create') {
      const parent = snapshot.anchor
        ? ({
            name: snapshot.anchor.split('/').pop() ?? snapshot.anchor,
            path: snapshot.anchor,
            kind: 'directory'
          } as WorkspaceEntry)
        : null
      beginCreate(snapshot.entryKind, parent)
    } else {
      beginRename({
        name: snapshot.originalName ?? '',
        path: snapshot.anchor ?? '',
        kind: snapshot.entryKind
      })
    }
    const input = tree.querySelector<HTMLInputElement>('.tree-name-input')
    if (!input) return
    input.value = snapshot.value
    // Restore the caret exactly where the re-render interrupted it — a
    // blanket select-all would make the next keystroke wipe the typed text.
    input.setSelectionRange(
      snapshot.caretStart ?? snapshot.value.length,
      snapshot.caretEnd ?? snapshot.value.length
    )
  }

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

  /** Directories currently expanded, so a re-render can restore them. */
  function collectExpanded(): string[] {
    const out: string[] = []
    tree.querySelectorAll<HTMLElement>('.tree-item.dir[data-expanded="1"]').forEach((row) => {
      if (row.dataset.path) out.push(row.dataset.path)
    })
    return out
  }

  /** Re-open the stored directories; parents restore before their children. */
  async function restoreExpanded(gen: number, paths: string[]): Promise<void> {
    for (const path of paths) {
      const row = tree.querySelector<HTMLElement>(`.tree-item.dir[data-path="${CSS.escape(path)}"]`)
      if (!row || gen !== renderGen) continue
      row.dataset.expanded = '1'
      row.dataset.loaded = '1'
      row.querySelector('.twist')?.classList.add('open')
      try {
        const children = await window.halis.readDir(path)
        // The user may have collapsed it during the read, or a newer render
        // replaced the whole listing — neither may receive ghost children.
        if (gen !== renderGen || !row.isConnected || row.dataset.expanded !== '1') {
          if (row.isConnected && row.dataset.expanded !== '1') delete row.dataset.loaded
          continue
        }
        let anchor: HTMLElement = row
        for (const child of children) {
          const node = renderEntry(child, depthOf(path) + 1)
          anchor.insertAdjacentElement('afterend', node)
          anchor = node
        }
      } catch {
        // The folder is gone (or unreadable): fall back to a clean collapsed
        // row so the next click refetches instead of trusting loaded='1'.
        if (row.isConnected && gen === renderGen) {
          row.dataset.expanded = '0'
          delete row.dataset.loaded
          row.querySelector('.twist')?.classList.remove('open')
        }
      }
    }
  }

  async function renderRoot(): Promise<void> {
    const gen = (renderGen += 1)
    const expanded = collectExpanded()
    const root = store.get().workspaceRoot
    // A root switch invalidates the edit — its path points into the old
    // tree; drop it instead of resurrecting it on a later switch back.
    if (editing && editingRoot !== root) editing = null
    // Workspace switches make any in-progress edit stale; a same-root
    // refresh gets the edit rebuilt.
    const pendingEdit = editing && editingRoot === root ? snapshotEditing() : null
    clear(tree)
    if (!root) return

    try {
      const entries = await window.halis.readDir('')
      if (gen !== renderGen) return
      if (entries.length === 0) {
        if (pendingEdit) restoreEditing(pendingEdit)
        const empty = el('div', 'tree-empty', 'This folder is empty.\nUse the buttons above to create files.')
        tree.appendChild(empty)
        return
      }
      for (const entry of entries) {
        tree.appendChild(renderEntry(entry, 0))
      }
      if (pendingEdit) restoreEditing(pendingEdit)
      await restoreExpanded(gen, expanded)
    } catch (err) {
      if (gen !== renderGen) return
      tree.appendChild(el('div', 'planned', `Cannot read workspace: ${errText(err)}`))
    }
  }

  function renderEntry(entry: WorkspaceEntry, depth: number): HTMLElement {
    const row = el('button', `tree-item ${entry.kind === 'directory' ? 'dir' : 'file'}`)
    row.style.paddingLeft = `${10 + depth * INDENT}px`
    row.dataset.path = entry.path

    const twist = el('span', 'twist')
    if (entry.kind === 'directory') {
      twist.appendChild(svg(icons.chevronRight, 12))
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
      const gen = renderGen
      try {
        const children = await window.halis.readDir(entry.path)
        // A re-render (or a collapse during the read) makes this row stale —
        // the same guard restoreExpanded applies before inserting children.
        if (gen !== renderGen || !row.isConnected || row.dataset.expanded !== '1') {
          // Collapsed mid-read: forget the load so the next expand refetches
          // instead of showing an empty folder. A detached row belongs to an
          // older render, which refetches on its own.
          if (row.isConnected && row.dataset.expanded !== '1') delete row.dataset.loaded
          return
        }
        let anchor: HTMLElement = row
        for (const child of children) {
          const node = renderEntry(child, depth + 1)
          anchor.insertAdjacentElement('afterend', node)
          anchor = node
        }
      } catch (err) {
        // Reset the row the same way restoreExpanded does, or the folder
        // stays marked loaded with no children and never refetches.
        if (row.isConnected && gen === renderGen) {
          row.dataset.expanded = '0'
          delete row.dataset.loaded
          twist?.classList.remove('open')
        }
        tree.appendChild(el('div', 'planned', `Cannot read folder: ${errText(err)}`))
      }
      return
    }

    // toggle visibility of the rows that follow until the next row
    // at the same or lower depth. `expanded` is the state before the click:
    // collapsing (true) hides the subtree, re-opening shows it again —
    // except under a descendant folder that is itself collapsed.
    let next = row.nextElementSibling as HTMLElement | null
    let collapsedFrom: number | null = null
    while (next && next.classList.contains('tree-item')) {
      const nextDepth = Number(next.style.paddingLeft.replace('px', ''))
      if (nextDepth <= 10 + depth * INDENT) break
      if (collapsedFrom !== null && nextDepth > collapsedFrom) {
        next.style.display = 'none'
      } else {
        collapsedFrom = null
        next.style.display = expanded ? 'none' : ''
        if (next.classList.contains('dir') && next.dataset.expanded !== '1') {
          collapsedFrom = nextDepth
        }
      }
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

    // Tracked so a re-render (workspace:changed arrives constantly while
    // the agent works) rebuilds the row instead of destroying the input.
    editing = { kind: 'create', anchor: parent?.path ?? null, entryKind: kind, originalName: null, value: '' }
    editingRoot = store.get().workspaceRoot

    const cancel = (): void => {
      // A re-render already detached this row and rebuilt it elsewhere;
      // only the live row's cancel may drop the tracking.
      if (!row.isConnected) return
      row.remove()
      editing = null
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
        return
      }
      // An IME composition commit arrives as Enter — it is not a name yet.
      if (event.key !== 'Enter' || event.isComposing) return
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
          // The create reply always loses to the workspace:changed render
          // that already detached this row — clear the tracking before the
          // guarded cancel, or a phantom create input re-opens.
          editing = null
          cancel()
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

    // Clicks inside the input must not reach the row's own click handler —
    // rows are buttons, and a caret reposition would open the file (or
    // toggle the folder) mid-rename.
    input.addEventListener('click', (event) => event.stopPropagation())

    // Tracked so a re-render rebuilds the input instead of killing the rename.
    editing = { kind: 'rename', anchor: entry.path, entryKind: entry.kind, originalName: entry.name, value: entry.name }
    editingRoot = store.get().workspaceRoot

    const cancel = (): void => {
      // Same detached-row rule as create: a re-render already rebuilt this
      // input elsewhere, so the stale cancel must not clear its tracking.
      if (!input.isConnected) return
      input.replaceWith(el('span', 'label', entry.name))
      editing = null
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
        return
      }
      // Same IME rule as create: the commit keystroke is not a rename.
      if (event.key !== 'Enter' || event.isComposing) return
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
        .then(() => {
          editing = null
          cancel()
        })
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

    const closeOnOutside = (mouseEvent: MouseEvent): void => {
      if (!(mouseEvent.target instanceof Element) || !menu.contains(mouseEvent.target)) {
        closeContextMenu()
      } else {
        window.addEventListener('mousedown', closeOnOutside, { once: true })
      }
    }
    const closeOnEscape = (keyboardEvent: KeyboardEvent): void => {
      if (keyboardEvent.key === 'Escape') {
        closeContextMenu()
      } else {
        window.addEventListener('keydown', closeOnEscape, { once: true })
      }
    }
    menuCleanup = (): void => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('blur', closeContextMenu)
    }
    window.setTimeout(() => {
      window.addEventListener('mousedown', closeOnOutside, { once: true })
      window.addEventListener('keydown', closeOnEscape, { once: true })
      window.addEventListener('blur', closeContextMenu)
    })
  }

  function closeContextMenu(): void {
    document.querySelector('.context-menu')?.remove()
    // Drop the once-listeners too; they re-arm otherwise and pile up.
    menuCleanup?.()
    menuCleanup = null
  }

  let menuCleanup: (() => void) | null = null

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
