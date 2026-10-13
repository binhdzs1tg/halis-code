import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store, type SidebarView } from '../app/store'

interface Item {
  view: SidebarView
  title: string
  icon: string
}

const ITEMS: Item[] = [
  { view: 'explorer', title: 'Explorer', icon: icons.folder },
  { view: 'search', title: 'Search', icon: icons.search },
  { view: 'settings', title: 'Settings', icon: icons.sliders }
]

export function mountActivityBar(): HTMLElement {
  const bar = el('nav', 'activity-bar')
  const buttons = new Map<SidebarView, HTMLButtonElement>()

  for (const item of ITEMS) {
    const btn = el('button')
    btn.title = item.title
    btn.appendChild(svg(item.icon, 19))

    btn.addEventListener('click', () => {
      const state = store.get()
      if (state.sidebarView === item.view && state.sidebarVisible) {
        store.update({ sidebarVisible: false })
        return
      }
      store.update({ sidebarView: item.view, sidebarVisible: true })
    })

    buttons.set(item.view, btn)
    bar.appendChild(btn)
  }

  const flex = el('div', 'flex')

  const chatBtn = el('button')
  chatBtn.title = 'Toggle agent chat'
  chatBtn.appendChild(svg(icons.chat, 19))
  chatBtn.addEventListener('click', () => {
    store.update({ chatOpen: !store.get().chatOpen })
  })

  bar.append(flex, chatBtn)

  store.subscribe((state) => {
    for (const [view, btn] of buttons) {
      btn.classList.toggle('active', state.sidebarVisible && state.sidebarView === view)
    }
  })

  return bar
}
