import { el } from '../app/dom'
import { store } from '../app/store'
import * as catalog from '../core/models/catalog'
import { keyStatusOf, refreshKeyStatuses } from '../core/keys'

/**
 * Small dialog to manage the API key of the currently selected model's
 * provider. Keys never travel back to the renderer — only this status.
 */
export function openKeyDialog(): void {
  if (document.querySelector('.key-overlay')) return

  const selection = store.get().selectedModel
  const found = selection ? catalog.findModel(selection) : null

  const overlay = el('div', 'key-overlay')
  const dialog = el('div', 'key-dialog')
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  const close = (): void => overlay.remove()
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })

  if (!found) {
    dialog.appendChild(el('div', 'dialog-title', 'API key'))
    dialog.appendChild(el('div', 'key-body', 'Select a model first — its provider decides which key is used.'))
    return
  }

  const provider = found.provider
  dialog.appendChild(el('div', 'dialog-title', `${provider.name} API key`))

  const status = el('div', 'key-status')
  const body = el('div', 'key-body')

  const input = el('input', 'key-input') as HTMLInputElement
  input.type = 'password'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.placeholder = 'Paste an API key'

  const save = el('button', 'key-save', 'Save') as HTMLButtonElement
  save.type = 'button'

  const remove = el('button', 'key-remove', 'Remove') as HTMLButtonElement
  remove.type = 'button'

  const actions = el('div', 'key-actions')
  actions.append(remove, save)

  const inputRow = el('div', 'key-row')
  inputRow.append(input, save)
  body.append(status, inputRow, actions)
  dialog.appendChild(body)

  const paintStatus = (): void => {
    const current = keyStatusOf(provider.id)
    status.className = 'key-status'
    if (!current) {
      status.classList.add('missing')
      status.textContent = 'No key set for this provider yet.'
      remove.style.display = 'none'
      return
    }
    status.classList.add('ok')
    status.textContent =
      current.source === 'env'
        ? `Using ${current.envVar} from the environment.`
        : 'A key is stored in the app vault.'
    remove.style.display = current.source === 'user' ? '' : 'none'
  }

  const saveKey = async (): Promise<void> => {
    const value = input.value
    if (!value.trim()) {
      input.focus()
      return
    }
    save.disabled = true
    try {
      await window.halis.setProviderKey(provider.id, value)
      await refreshKeyStatuses()
      input.value = ''
      paintStatus()
    } finally {
      save.disabled = false
    }
  }

  const removeKey = async (): Promise<void> => {
    remove.disabled = true
    try {
      await window.halis.removeProviderKey(provider.id)
      await refreshKeyStatuses()
      paintStatus()
    } finally {
      remove.disabled = false
    }
  }

  save.addEventListener('click', () => void saveKey())
  remove.addEventListener('click', () => void removeKey())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void saveKey()
    }
  })

  if (provider.env.length > 0) {
    const hint = el(
      'div',
      'key-hint',
      `Shell alternative: export ${provider.env[0]}=… and restart Halis.`
    )
    body.appendChild(hint)
  }
  if (provider.doc) {
    const doc = el('div', 'key-hint')
    const link = el('a', undefined, 'Provider documentation') as HTMLAnchorElement
    link.href = provider.doc
    link.target = '_blank'
    link.rel = 'noreferrer'
    doc.appendChild(link)
    body.appendChild(doc)
  }

  paintStatus()
  input.focus()
}
