import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import type { ChatMessage } from '../../electron/shared/types'
import { agentService, AgentNotReadyError } from '../core/agent/agent-service'
import * as catalog from '../core/models/catalog'
import { openModelDialog } from './model-picker'

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
  panel.appendChild(header)

  const list = el('div', 'message-list')
  panel.appendChild(list)

  const messages: ChatMessage[] = []

  renderEmptyState(list)

  const composer = buildComposer(async (text) => {
    const userMsg = makeMessage('user', text)
    messages.push(userMsg)
    list.appendChild(renderMessage(userMsg))
    list.scrollTop = list.scrollHeight

    store.update({ agentStatus: 'thinking' })

    try {
      const response = await agentService.run({
        prompt: text,
        history: [...messages],
        model: store.get().selectedModel ?? undefined
      })
      const reply = makeMessage('assistant', response.message)
      messages.push(reply)
      list.appendChild(renderMessage(reply))
    } catch (err) {
      if (err instanceof AgentNotReadyError) {
        const note = makeMessage(
          'system',
          'The agent runtime is not wired to a model yet.\nModel providers and API keys arrive in the next phase.'
        )
        messages.push(note)
        list.appendChild(renderMessage(note))
      } else {
        const note = makeMessage('system', `Something went wrong: ${err instanceof Error ? err.message : String(err)}`)
        messages.push(note)
        list.appendChild(renderMessage(note))
        store.update({ agentStatus: 'error' })
      }
    } finally {
      if (store.get().agentStatus !== 'error') {
        store.update({ agentStatus: 'idle' })
      }
      list.scrollTop = list.scrollHeight
    }
  })

  panel.appendChild(composer)
  return panel
}

function buildComposer(onSend: (text: string) => Promise<void>): HTMLElement {
  const composer = el('div', 'composer')

  const inputBox = el('div', 'input-box')
  const textarea = el('textarea') as HTMLTextAreaElement
  textarea.rows = 1
  textarea.placeholder = 'Ask Halis to code something…'
  textarea.spellcheck = false

  const sendBtn = el('button', 'send')
  sendBtn.title = 'Send'
  sendBtn.innerHTML = svg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>',
    14
  ).outerHTML

  const submit = (): void => {
    const text = textarea.value.trim()
    if (!text || sendBtn.disabled) return
    textarea.value = ''
    autoGrow()
    void onSend(text)
  }

  sendBtn.addEventListener('click', submit)
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

  return composer
}

function renderEmptyState(list: HTMLElement): void {
  const empty = el('div', 'chat-empty')
  const logo = el('div', 'logo')
  logo.appendChild(svg(icons.logo, 30))
  empty.appendChild(logo)
  empty.appendChild(
    el('div', undefined, 'Plan, explore and edit code with the Halis agent.\nThe runtime hooks land in the next phase.')
  )
  list.appendChild(empty)
}

function renderMessage(message: ChatMessage): HTMLElement {
  const wrap = el('div', `msg ${message.role}`)
  const bubble = el('div', 'bubble selectable', message.content)
  wrap.appendChild(bubble)
  wrap.appendChild(el('div', 'meta', formatTime(message.createdAt)))
  return wrap
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
