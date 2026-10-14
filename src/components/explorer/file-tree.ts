import { clear, el, svg } from '../../app/dom'
import { icons } from '../../app/icons'
import { store } from '../../app/store'
import type { WorkspaceEntry } from '../../../electron/shared/types'

export function mountFileTree(container: HTMLElement): void {
  const tree = el('div', 'file-tree')
  container.appendChild(tree)

  async function renderRoot(): Promise<void> {
    clear(tree)
    const root = store.get().workspaceRoot
    if (!root) return

    try {
      const entries = await window.halis.readDir('')
      for (const entry of entries) {
        tree.appendChild(renderEntry(entry, 0))
      }
    } catch (err) {
      const note = el('div', 'planned', `Cannot read workspace: ${errText(err)}`)
      tree.appendChild(note)
    }
  }

  function renderEntry(entry: WorkspaceEntry, depth: number): HTMLElement {
    const row = el('button', `tree-item ${entry.kind === 'directory' ? 'dir' : 'file'}`)
    row.style.paddingLeft = `${10 + depth * 14}px`

    if (entry.kind === 'directory') {
      const twist = el('span', 'twist')
      twist.appendChild(svg(icons.chevron, 12))
      row.appendChild(twist)

      const iconWrap = el('span', 'kind-icon')
      iconWrap.appendChild(svg(icons.folder, 14))
      row.appendChild(iconWrap)

      row.appendChild(el('span', 'label', entry.name))

      let expanded = false
      let childrenLoaded = false

      row.addEventListener('click', async () => {
        expanded = !expanded
        twist.classList.toggle('open', expanded)

        if (!childrenLoaded) {
          childrenLoaded = true
          try {
            const children = await window.halis.readDir(entry.path)
            const siblings: HTMLElement[] = []
            for (const child of children) {
              const node = renderEntry(child, depth + 1)
              siblings.push(node)
            }
            // keep tree order stable: re-append right after this row
            let anchor: HTMLElement = row
            for (const node of siblings) {
              anchor.insertAdjacentElement('afterend', node)
              anchor = node
            }
          } catch (err) {
            const note = el('div', 'planned', `Cannot read folder: ${errText(err)}`)
            row.insertAdjacentElement('afterend', note)
          }
          return
        }

        // toggle visibility of the rows that follow until the next row
        // at the same or lower depth
        let next = row.nextElementSibling as HTMLElement | null
        while (next && next.classList.contains('tree-item')) {
          const nextDepth = Number(next.style.paddingLeft.replace('px', ''))
          if (nextDepth <= 10 + depth * 14) break
          next.style.display = expanded ? '' : 'none'
          next = next.nextElementSibling as HTMLElement | null
        }
      })

      return row
    }

    const spacer = el('span', 'twist')
    row.appendChild(spacer)

    const iconWrap = el('span', 'kind-icon')
    iconWrap.appendChild(svg(icons.file, 14))
    row.appendChild(iconWrap)

    row.appendChild(el('span', 'label', entry.name))

    if (entry.path === store.get().openFile) {
      row.classList.add('active')
    }

    row.addEventListener('click', () => {
      const state = store.get()
      store.update({
        openFiles: state.openFiles.includes(entry.path) ? state.openFiles : [...state.openFiles, entry.path],
        openFile: entry.path,
        openFileLine: null
      })
      tree.querySelectorAll('.tree-item.active').forEach((n) => n.classList.remove('active'))
      row.classList.add('active')
    })

    return row
  }

  store.subscribe((state, prev) => {
    if (state.workspaceRoot !== prev.workspaceRoot) {
      void renderRoot()
    }
    // Files created or edited by the agent need a fresh listing.
    if (state.lastTouchedFile !== prev.lastTouchedFile) {
      void renderRoot()
    }
  })

  void renderRoot()
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
