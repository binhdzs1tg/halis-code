import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'

export function mountStatusBar(): HTMLElement {
  const bar = el('footer', 'statusbar')

  // left: agent status
  const agentItem = el('div', 'item')
  const dot = el('span', 'agent-dot idle')
  const agentLabel = el('span', undefined, 'Agent: idle')
  agentItem.append(dot, agentLabel)

  const folderItem = el('button', 'item')
  folderItem.title = 'Open folder'
  const folderIcon = el('span')
  folderIcon.appendChild(svg(icons.folder, 13))
  const folderLabel = el('span', undefined, 'Open folder…')
  folderItem.append(folderIcon, folderLabel)
  folderItem.addEventListener('click', async () => {
    const root = await window.halis.pickWorkspace()
    if (root) {
      store.update({ workspaceRoot: root })
    }
  })

  const flex = el('div', 'flex')

  // right: runtime info
  const platformItem = el('div', 'item')
  const versionItem = el('div', 'item')

  bar.append(agentItem, folderItem, flex, platformItem, versionItem)

  store.subscribe((state) => {
    dot.className = `agent-dot ${state.agentStatus}`
    agentLabel.textContent = `Agent: ${state.agentStatus}`

    const root = state.workspaceRoot
    folderLabel.textContent = root ? root.split(/[\\/]/).pop() || root : 'Open folder…'

    const info = state.appInfo
    if (info) {
      platformItem.textContent = info.platform
      versionItem.textContent = `v${info.version}`
    }
  })

  return bar
}
