import { el, svg } from '../app/dom'
import { icons } from '../app/icons'

export function mountTitlebar(): HTMLElement {
  const bar = el('header', 'titlebar')

  const brand = el('div', 'brand')
  const logo = el('span', 'logo')
  logo.appendChild(svg(icons.logo, 17))
  brand.append(logo, el('span', undefined, 'Halis Code'))

  const spacer = el('div', 'spacer')

  const controls = el('div', 'window-controls')

  const minBtn = el('button')
  minBtn.title = 'Minimize'
  minBtn.appendChild(svg(icons.minus, 15))
  minBtn.addEventListener('click', () => window.halis.minimize())

  const maxBtn = el('button')
  maxBtn.title = 'Maximize'
  const maxIcon = svg(icons.maximize, 13)
  maxBtn.appendChild(maxIcon)
  maxBtn.addEventListener('click', () => {
    window.halis.maximize()
  })
  // The icon follows the real window state, so OS-driven maximize/unmaximize
  // (double-click on the taskbar, aero snap, fullscreen) stays in sync.
  window.halis.onWindowState((maximized) => {
    maxBtn.title = maximized ? 'Restore' : 'Maximize'
    maxIcon.replaceWith(svg(maximized ? icons.restore : icons.maximize, 13))
  })

  const closeBtn = el('button', 'close')
  closeBtn.title = 'Close'
  closeBtn.appendChild(svg(icons.close, 14))
  closeBtn.addEventListener('click', () => window.halis.close())

  controls.append(minBtn, maxBtn, closeBtn)
  bar.append(brand, spacer, controls)
  return bar
}
