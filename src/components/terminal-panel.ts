import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'

export function mountTerminalPanel(): HTMLElement {
  const panel = el('section', 'terminal-panel hidden-panel')

  const header = el('div', 'panel-header')
  header.appendChild(svg(icons.terminal, 13))
  header.appendChild(el('span', undefined, 'Terminal'))
  header.appendChild(el('span', 'tab-hint', 'shell integration — planned'))

  const dismiss = el('button', 'dismiss')
  dismiss.title = 'Close panel'
  dismiss.appendChild(svg(icons.close, 12))
  dismiss.addEventListener('click', () => {
    store.update({ terminalOpen: false })
  })
  header.appendChild(dismiss)

  const body = el('div', 'term-body')
  body.appendChild(buildLine('halis-code v0.1.0 — terminal integration ships in a later milestone'))
  body.appendChild(buildLine('', true))

  panel.append(header, body)

  store.subscribe((state) => {
    panel.classList.toggle('hidden-panel', !state.terminalOpen)
  })

  return panel
}

function buildLine(text: string, withPrompt = false): HTMLElement {
  const line = el('div', 'line')
  if (withPrompt) {
    line.appendChild(el('span', 'prompt', '~/ $ '))
    line.appendChild(el('span', 'caret'))
  } else {
    line.textContent = text
  }
  return line
}
