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
    // icon flips between maximize/restore; cheap and good enough for now
    maxIcon.replaceWith(svg(maxBtn.classList.contains('restored') ? icons.maximize : icons.restore, 13))
    maxBtn.classList.toggle('restored')
  })

  const closeBtn = el('button', 'close')
  closeBtn.title = 'Close'
  closeBtn.appendChild(svg(icons.close, 14))
  closeBtn.addEventListener('click', () => window.halis.close())

  controls.append(minBtn, maxBtn, closeBtn)
  bar.append(brand, spacer, controls)
  return bar
}
