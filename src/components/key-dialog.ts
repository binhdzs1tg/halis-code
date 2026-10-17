import { el } from '../app/dom'
import { store } from '../app/store'
import * as catalog from '../core/models/catalog'
import { keyStatusOf, refreshKeyStatuses } from '../core/keys'

/**
 * The provider key dialog: picking a model whose provider has no key yet
 * (or hitting a rejected key) pops this over the chat. Keys never travel
 * back to the renderer — only the status does.
 *
 * `onSaved` fires once after a key lands, so a deferred send can continue;
 * `onCancelled` fires when the dialog closes without one.
 */
export function openKeyDialog(onSaved?: () => void, onCancelled?: () => void): void {
  if (document.querySelector('.key-overlay')) {
    // One dialog at a time. A deferred send must not lose its text: treat
    // this request as "not saved" so the composer gets it back.
    onCancelled?.()
    return
  }

  const selection = store.get().selectedModel
  const found = selection ? catalog.findModel(selection) : null

  const overlay = el('div', 'overlay key-overlay')
  const dialog = el('div', 'key-dialog')
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  let saved = false
  // Bound on the document: focus can sit on the body (nothing focused yet),
  // and a keydown there never reaches the dialog.
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  document.addEventListener('keydown', onKeydown)
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })
  const close = (): void => {
    document.removeEventListener('keydown', onKeydown)
    overlay.remove()
    if (saved) onSaved?.()
    else onCancelled?.()
  }

  if (!found) {
    dialog.appendChild(el('div', 'dialog-title', 'API key'))
    const emptyBody = el('div', 'key-body', 'Select a model first — its provider decides which key is used.')
    emptyBody.style.paddingBottom = '20px'
    dialog.appendChild(emptyBody)
    return
  }

  const provider = found.provider
  dialog.appendChild(el('div', 'dialog-title', `${provider.name} API key`))
  dialog.appendChild(
    el('div', 'key-subtitle', `This model needs a key from ${provider.name}. Paste it below to start using it.`)
  )

  const status = el('div', 'key-status')
  const body = el('div', 'key-body')

  const input = el('input', 'key-input') as HTMLInputElement
  input.type = 'password'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.placeholder = 'Paste an API key'

  const save = el('button', 'btn small key-save', 'Save') as HTMLButtonElement
  save.type = 'button'

  const remove = el('button', 'btn small ghost key-remove', 'Remove') as HTMLButtonElement
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
      saved = true
      close()
    } catch (err) {
      status.classList.remove('ok')
      status.classList.add('missing')
      status.textContent = `Could not save the key: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      save.disabled = false
    }
  }

  const removeKey = async (): Promise<void> => {
    remove.disabled = true
    try {
      await window.halis.removeProviderKey(provider.id)
      await refreshKeyStatuses()
      close()
    } catch (err) {
      status.classList.remove('ok')
      status.classList.add('missing')
      status.textContent = `Could not remove the key: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      remove.disabled = false
    }
  }

  save.addEventListener('click', () => void saveKey())
  remove.addEventListener('click', () => void removeKey())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
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
    const link = el('a', undefined, `Get a key from ${provider.name}`) as HTMLAnchorElement
    link.href = provider.doc
    link.target = '_blank'
    link.rel = 'noreferrer'
    doc.appendChild(link)
    body.appendChild(doc)
  }

  paintStatus()
  input.focus()
}
