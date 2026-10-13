import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import type { ChatMessage } from '../../electron/shared/types'
import { agentService, AgentNotReadyError } from '../core/agent/agent-service'

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
      const response = await agentService.run({ prompt: text, history: [...messages] })
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
  composer.appendChild(el('div', 'hint', 'Enter to send · Shift+Enter for a new line'))

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
