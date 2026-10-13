import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import type { ChatMessage } from '../../electron/shared/types'
import { agentService, AgentError } from '../core/agent/agent-service'
import * as catalog from '../core/models/catalog'
import { keyStatusOf, refreshKeyStatuses } from '../core/keys'
import { renderMarkdown } from '../core/markdown'
import { openModelDialog } from './model-picker'
import { openKeyDialog } from './key-dialog'

let counter = 0

function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  counter += 1
  return {
    id: `local-${Date.now()}-${counter}`,
    role,
    content,
    createdAt: Date.now()
  }
}

export function mountChatPanel(): HTMLElement {
  const panel = el('aside', 'chat-panel')

  const header = el('div', 'panel-header')
  header.appendChild(el('span', undefined, 'Agent'))
  header.appendChild(buildKeyChip())
  panel.appendChild(header)

  const list = el('div', 'message-list')
  panel.appendChild(list)

  const messages: ChatMessage[] = []
  renderEmptyState(list)

  // Copy buttons rendered inside markdown code blocks.
  list.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('.copy-code') : null
    if (!target) return
    const code = target.closest('.code-block')?.querySelector('code')?.textContent
    if (code === null || code === undefined) return
    void navigator.clipboard.writeText(code).then(() => {
      target.textContent = 'Copied'
      window.setTimeout(() => {
        target.textContent = 'Copy'
      }, 1200)
    })
  })

  let running = false

  const composer = buildComposer({
    onSubmit: (text) => void send(text),
    onStop: () => agentService.cancel()
  })

  const send = async (text: string): Promise<void> => {
    if (running) return
    list.querySelector('.chat-empty')?.remove()

    const userMsg = makeMessage('user', text)
    messages.push(userMsg)
    list.appendChild(renderMessage(userMsg))
    scrollToBottom(list, true)

    const selection = store.get().selectedModel
    if (!selection || !catalog.isValid(selection)) {
      appendSystemNote('No model selected yet — pick one to start.', {
        label: 'Select model',
        onClick: () => openModelDialog()
      })
      return
    }

    running = true
    composer.setRunning(true)
    store.update({ agentStatus: 'thinking' })

    const history = [...messages]
    const assistant = makeMessage('assistant', '')
    const node = renderMessage(assistant)
    node.querySelector('.bubble')?.classList.add('streaming')
    messages.push(assistant)
    list.appendChild(node)

    let buffered = ''
    let frame = 0
    const paint = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const bubble = node.querySelector('.bubble')
        if (bubble) bubble.innerHTML = renderMarkdown(buffered)
        scrollToBottom(list)
      })
    }

    try {
      const full = await agentService.run(
        { prompt: text, history, model: selection },
        {
          onDelta: (chunk) => {
            buffered += chunk
            paint()
          }
        }
      )
      assistant.content = full
      node.replaceWith(renderMessage(assistant))
    } catch (err) {
      // Drop the placeholder; a partial, if any, is re-rendered below.
      node.remove()
      messages.pop()
      const agentErr = err instanceof AgentError ? err : null
      if (agentErr && agentErr.partial.trim()) {
        const partial = makeMessage('assistant', agentErr.partial)
        messages.push(partial)
        list.appendChild(renderMessage(partial))
      }
      if (agentErr?.code === 'missing-key') {
        appendSystemNote(agentErr.message, { label: 'Add API key', onClick: () => openKeyDialog() })
      } else if (agentErr?.code === 'invalid-model') {
        appendSystemNote(agentErr.message, { label: 'Select model', onClick: () => openModelDialog() })
      } else {
        appendSystemNote(agentErr ? agentErr.message : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`)
        store.update({ agentStatus: 'error' })
      }
    } finally {
      if (frame) cancelAnimationFrame(frame)
      running = false
      composer.setRunning(false)
      if (store.get().agentStatus !== 'error') {
        store.update({ agentStatus: 'idle' })
      }
      scrollToBottom(list)
    }
  }

  const appendSystemNote = (text: string, action?: { label: string; onClick: () => void }): void => {
    const message = makeMessage('system', text)
    messages.push(message)
    const node = renderMessage(message)
    if (action) {
      const btn = el('button', 'note-action') as HTMLButtonElement
      btn.type = 'button'
      btn.textContent = action.label
      btn.addEventListener('click', action.onClick)
      node.querySelector('.bubble')?.appendChild(btn)
    }
    list.appendChild(node)
    scrollToBottom(list, true)
  }

  panel.appendChild(composer.root)
  return panel
}

function buildKeyChip(): HTMLElement {
  const chip = el('button', 'key-chip') as HTMLButtonElement
  chip.type = 'button'
  const dot = el('span', 'key-dot')
  chip.append(dot, svg(icons.key, 12), el('span', 'key-label', 'API key'))
  chip.addEventListener('click', () => openKeyDialog())

  const refresh = (): void => {
    const selection = store.get().selectedModel
    const status = keyStatusOf(selection?.providerID)
    const found = selection ? catalog.findModel(selection) : null
    if (!selection || !found) {
      chip.className = 'key-chip unknown'
      chip.title = 'Select a model to manage its API key'
      return
    }
    if (status) {
      chip.className = 'key-chip ok'
      chip.title =
        status.source === 'env'
          ? `Using ${status.envVar} from the environment`
          : `${found.provider.name} key stored in the app vault`
    } else {
      chip.className = 'key-chip missing'
      chip.title = `No API key for ${found.provider.name} yet`
    }
  }

  store.subscribe((state, prev) => {
    if (state.selectedModel !== prev.selectedModel) refresh()
  })
  window.halis.onKeysChanged(() => {
    void refreshKeyStatuses().then(refresh)
  })
  void refreshKeyStatuses().then(refresh)
  void catalog.ensureCatalog().then(refresh)

  return chip
}

interface ComposerHandlers {
  onSubmit(text: string): void
  onStop(): void
}

function buildComposer(handlers: ComposerHandlers): { root: HTMLElement; setRunning(running: boolean): void } {
  const composer = el('div', 'composer')

  const inputBox = el('div', 'input-box')
  const textarea = el('textarea') as HTMLTextAreaElement
  textarea.rows = 1
  textarea.placeholder = 'Ask Halis to code something…'
  textarea.spellcheck = false

  const sendBtn = el('button', 'send') as HTMLButtonElement
  sendBtn.type = 'button'

  let running = false
  const paintButton = (): void => {
    sendBtn.title = running ? 'Stop' : 'Send'
    sendBtn.className = running ? 'send stop' : 'send'
    sendBtn.replaceChildren(svg(running ? icons.stop : icons.arrowUp, 14))
  }

  const submit = (): void => {
    if (running) return
    const text = textarea.value.trim()
    if (!text) return
    textarea.value = ''
    autoGrow()
    handlers.onSubmit(text)
  }

  sendBtn.addEventListener('click', () => {
    if (running) {
      handlers.onStop()
    } else {
      submit()
    }
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  })

  function autoGrow(): void {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
  }

  textarea.addEventListener('input', autoGrow)

  inputBox.append(textarea, sendBtn)
  composer.appendChild(inputBox)

  // Model row under the input, mirroring opencode's `model · provider` metadata.
  const modelBtn = el('button', 'model-button') as HTMLButtonElement
  modelBtn.type = 'button'
  modelBtn.title = 'Select model'
  const modelLabel = el('span', 'model-label', 'Loading models…')
  modelBtn.append(modelLabel, svg(icons.chevronDown, 12))
  modelBtn.addEventListener('click', () => {
    openModelDialog()
  })

  const hint = el('div', 'hint', 'Enter to send · Shift+Enter for a new line')
  const bar = el('div', 'composer-bar')
  bar.append(modelBtn, hint)
  composer.appendChild(bar)

  const refreshModelButton = (): void => {
    const selection = store.get().selectedModel
    if (!selection || !catalog.isValid(selection)) {
      modelLabel.textContent = 'Select model'
      return
    }
    const variant = selection.variant
    const parts = [catalog.selectionLabel(selection), catalog.providerLabel(selection)]
    modelLabel.textContent = variant ? `${parts.join(' · ')} · ${variant}` : parts.join(' · ')
  }
  refreshModelButton()
  store.subscribe(refreshModelButton)

  void catalog.ensureCatalog().then(() => {
    if (!store.get().selectedModel) {
      const fallback = catalog.defaultSelection()
      if (fallback) store.update({ selectedModel: fallback })
    }
    refreshModelButton()
  })

  window.halis.onModelsUpdated(() => {
    catalog.invalidate()
    void catalog.ensureCatalog().then(() => {
      const selection = store.get().selectedModel
      if (!catalog.isValid(selection)) {
        const fallback = catalog.defaultSelection()
        if (fallback) store.update({ selectedModel: fallback })
      }
      refreshModelButton()
    })
  })

  paintButton()
  return {
    root: composer,
    setRunning(value: boolean): void {
      running = value
      paintButton()
    }
  }
}

function renderEmptyState(list: HTMLElement): void {
  const empty = el('div', 'chat-empty')
  const logo = el('div', 'logo')
  logo.appendChild(svg(icons.logo, 30))
  empty.appendChild(logo)
  empty.appendChild(
    el(
      'div',
      undefined,
      'Plan, explore and edit code with the Halis agent.\nPick a model below and add its API key to get going.'
    )
  )
  list.appendChild(empty)
}

function renderMessage(message: ChatMessage): HTMLElement {
  const wrap = el('div', `msg ${message.role}`)

  if (message.role === 'assistant') {
    const bubble = el('div', 'bubble md selectable')
    bubble.innerHTML = renderMarkdown(message.content)
    const meta = el('div', 'meta')
    meta.appendChild(el('span', undefined, formatTime(message.createdAt)))

    const copy = el('button', 'copy-msg') as HTMLButtonElement
    copy.type = 'button'
    copy.title = 'Copy message'
    copy.appendChild(svg(icons.copy, 12))
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(message.content).then(() => {
        copy.replaceChildren(svg(icons.check, 12))
        window.setTimeout(() => copy.replaceChildren(svg(icons.copy, 12)), 1200)
      })
    })
    meta.appendChild(copy)

    wrap.append(bubble, meta)
    return wrap
  }

  wrap.appendChild(el('div', 'bubble selectable', message.content))
  wrap.appendChild(el('div', 'meta', formatTime(message.createdAt)))
  return wrap
}

/** Only follow the stream while the user hasn't scrolled away from the bottom. */
function scrollToBottom(list: HTMLElement, force = false): void {
  const distance = list.scrollHeight - list.scrollTop - list.clientHeight
  if (force || distance < 48) {
    list.scrollTop = list.scrollHeight
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
