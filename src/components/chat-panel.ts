import { el, svg, clear } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import type { ChatMessage, TodoItem, ToolTrace } from '../../electron/shared/types'
import { agentService, AgentError } from '../core/agent/agent-service'
import * as catalog from '../core/models/catalog'
import { keyStatusOf, refreshKeyStatuses } from '../core/keys'
import { renderMarkdown } from '../core/markdown'
import { StreamingMarkdown } from '../core/markdown-stream'
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
  const newChatBtn = buildIconButton(icons.plus, 'New chat')
  const historyBtn = buildIconButton(icons.history, 'Chat history')
  const actions = el('div', 'panel-actions')
  actions.append(buildKeyChip(), newChatBtn, historyBtn)
  header.appendChild(actions)
  panel.appendChild(header)

  const list = el('div', 'message-list')
  panel.appendChild(list)

  // Back-to-bottom pill: appears once the reader scrolls away from the tail
  // while the conversation keeps moving, as in DeepSeek Harness's chat.
  const jump = el('button', 'chat-jump') as HTMLButtonElement
  jump.type = 'button'
  jump.title = 'Jump to latest'
  jump.appendChild(svg(icons.chevronDown, 13))
  jump.hidden = true
  jump.addEventListener('click', () => {
    scrollToBottom(list, true)
  })
  panel.appendChild(jump)
  list.addEventListener('scroll', () => {
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight
    jump.hidden = distance < 240
  })

  const messages: ChatMessage[] = []
  renderEmptyState(list)

  // History dropdown, filled on demand from the saved sessions.
  const pop = el('div', 'session-pop')
  pop.hidden = true
  panel.appendChild(pop)

  // The conversation currently on screen; null until its first save.
  let sessionId: string | null = null

  const persist = async (): Promise<void> => {
    if (messages.length === 0) return
    try {
      const meta = await window.halis.saveSession({
        id: sessionId,
        title: sessionTitle(messages),
        createdAt: messages[0]?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        workspaceRoot: store.get().workspaceRoot,
        model: store.get().selectedModel,
        messages: [...messages]
      })
      sessionId = meta.id
    } catch {
      // Persistence is best effort; the chat keeps working without it.
    }
  }

  const togglePop = async (show?: boolean): Promise<void> => {
    const next = show ?? (pop.hidden === true)
    if (next) {
      await renderSessionList(pop, sessionId, () => sessionId)
    }
    pop.hidden = !next
    historyBtn.classList.toggle('active', next)
  }

  newChatBtn.addEventListener('click', () => {
    void newChat()
  })
  historyBtn.addEventListener('click', () => {
    void togglePop()
  })

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

  // Clicking anywhere in the conversation closes the history dropdown.
  list.addEventListener('click', () => {
    if (!pop.hidden) void togglePop(false)
  })

  let running = false
  let stoppedManually = false

  const newChat = async (): Promise<void> => {
    if (running) {
      appendSystemNote('Stop the agent before starting a new chat.')
      return
    }
    if (messages.length === 0) return
    await persist()
    sessionId = null
    messages.splice(0, messages.length)
    queue.splice(0, queue.length)
    paintQueue()
    clear(list)
    renderEmptyState(list)
    await togglePop(false)
  }

  const openSession = async (id: string): Promise<void> => {
    if (running) {
      appendSystemNote('Stop the agent before switching chats.')
      return
    }
    try {
      const session = await window.halis.loadSession(id)
      if (sessionId !== id) {
        await persist()
      }
      sessionId = session.id
      messages.splice(0, messages.length, ...session.messages)
      clear(list)
      for (const message of messages) {
        list.appendChild(renderMessage(message))
      }
      scrollToBottom(list, true)
      if (session.model && catalog.isValid(session.model)) {
        store.update({ selectedModel: session.model })
      }
      await togglePop(false)
    } catch (err) {
      appendSystemNote(err instanceof Error ? err.message : String(err))
    }
  }

  // Rows in the history dropdown open through this hook.
  sessionOpener = openSession

  const composer = buildComposer({
    onSubmit: (text) => void send(text),
    onStop: () => {
      // A manual stop also holds the queue back; the user decides what runs next.
      stoppedManually = true
      agentService.cancel()
    }
  })

  /* ---------- queued sends (while a run is in flight) ---------- */

  const queue: string[] = []
  const queueBox = el('div', 'queue-box')
  queueBox.hidden = true

  const paintQueue = (): void => {
    clear(queueBox)
    queueBox.hidden = queue.length === 0
    if (queue.length === 0) return
    for (let i = 0; i < queue.length; i += 1) {
      const row = el('div', 'queue-row')
      row.appendChild(el('span', 'queue-label', 'Queued'))
      row.appendChild(el('span', 'queue-text', queue[i]))
      const del = el('button', 'queue-del') as HTMLButtonElement
      del.type = 'button'
      del.title = 'Remove'
      del.appendChild(svg(icons.close, 10))
      del.addEventListener('click', () => {
        queue.splice(i, 1)
        paintQueue()
      })
      row.appendChild(del)
      queueBox.appendChild(row)
    }
  }

  panel.appendChild(queueBox)

  const send = async (text: string): Promise<void> => {
    if (running) {
      // Like a queue dock: typing while the agent runs parks the message
      // instead of dropping it, and it is sent when the run settles.
      queue.push(text)
      paintQueue()
      return
    }
    stoppedManually = false
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

    // Live feed of tool calls made while this answer streams in.
    const traces: ToolTrace[] = []
    const toolLog = el('div', 'tool-log')
    const liveRows = new Map<string, HTMLElement>()
    const traceOf = new Map<string, ToolTrace>()
    node.insertBefore(toolLog, node.querySelector('.bubble'))

    // Live plan card, replaced wholesale on every todo_write snapshot.
    let liveTodos: TodoItem[] = []
    let todoCard: HTMLElement | null = null
    const paintTodos = (): void => {
      if (liveTodos.length === 0) return
      const next = renderTodoCard(liveTodos)
      if (todoCard) todoCard.replaceWith(next)
      else node.insertBefore(next, toolLog)
      todoCard = next
    }

    let buffered = ''
    let frame = 0
    // Only the unstable tail re-renders per frame; settled blocks freeze.
    const streamHost = node.querySelector<HTMLElement>('.bubble')
    let stream: StreamingMarkdown | null = null
    if (streamHost) {
      streamHost.classList.add('streaming-md')
      stream = new StreamingMarkdown(streamHost)
    }
    const paint = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        stream?.update(buffered)
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
          },
          onTool: (event) => {
            if (event.phase === 'start') {
              const trace: ToolTrace = {
                name: event.name,
                input: event.input ?? {},
                output: '',
                ok: true,
                durationMs: 0
              }
              traces.push(trace)
              traceOf.set(event.callId, trace)
              const row = renderToolRow(trace, true)
              liveRows.set(event.callId, row)
              toolLog.appendChild(row)
              store.update({ agentStatus: 'working' })
            } else {
              const trace = traceOf.get(event.callId)
              if (!trace) return
              trace.output = event.output ?? ''
              trace.ok = event.ok ?? true
              trace.durationMs = event.durationMs ?? 0
              const row = liveRows.get(event.callId)
              if (row) row.replaceWith(renderToolRow(trace, false))
            }
            scrollToBottom(list)
          },
          onTodo: (event) => {
            liveTodos = event.todos
            paintTodos()
          }
        }
      )
      assistant.content = full
      if (traces.length > 0) assistant.tools = [...traces]
      if (liveTodos.length > 0) assistant.todos = [...liveTodos]
      node.replaceWith(renderMessage(assistant))
      void persist()

      // A settled run pulls the next queued message, unless the run was
      // stopped by hand — then the queue waits for an explicit go.
      if (!stoppedManually && queue.length > 0) {
        const next = queue.shift()
        paintQueue()
        if (next) {
          window.setTimeout(() => void send(next), 30)
        }
      }
    } catch (err) {
      // Drop the placeholder; a partial, if any, is re-rendered below.
      node.remove()
      messages.pop()
      const agentErr = err instanceof AgentError ? err : null
      if (agentErr && (agentErr.partial.trim() || traces.length > 0)) {
        const partial = makeMessage('assistant', agentErr.partial)
        if (traces.length > 0) partial.tools = [...traces]
        if (liveTodos.length > 0) partial.todos = [...liveTodos]
        messages.push(partial)
        list.appendChild(renderMessage(partial))
        void persist()
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

/** Small square header button for chat-level actions. */
function buildIconButton(icon: string, title: string): HTMLButtonElement {
  const btn = el('button', 'icon-btn') as HTMLButtonElement
  btn.type = 'button'
  btn.title = title
  btn.appendChild(svg(icon, 14))
  return btn
}

/** First user message, collapsed onto one line, as the session title. */
function sessionTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user')
  const raw = (first?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return 'Chat'
  return raw.length > 48 ? `${raw.slice(0, 45)}…` : raw
}

/** Fill the history dropdown from the saved sessions. */
async function renderSessionList(
  pop: HTMLElement,
  currentId: string | null,
  getCurrentId: () => string | null
): Promise<void> {
  clear(pop)
  const metas = await window.halis.listSessions().catch(() => [])
  if (metas.length === 0) {
    pop.appendChild(el('div', 'session-empty', 'No saved chats yet.'))
    return
  }
  for (const meta of metas) {
    const row = el('div', `session-row${meta.id === currentId || meta.id === getCurrentId() ? ' current' : ''}`)
    const main = el('button', 'session-main') as HTMLButtonElement
    main.type = 'button'
    main.append(
      el('span', 'session-title', meta.title),
      el('span', 'session-sub', `${formatSessionDate(meta.updatedAt)} · ${meta.messageCount} message${meta.messageCount === 1 ? '' : 's'}`)
    )
    main.addEventListener('click', () => {
      void openSessionFromRow(meta.id)
    })
    const del = el('button', 'session-del') as HTMLButtonElement
    del.type = 'button'
    del.title = 'Delete chat'
    del.appendChild(svg(icons.trash, 12))
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      void window.halis.deleteSession(meta.id).then(() => renderSessionList(pop, currentId, getCurrentId))
    })
    row.append(main, del)
    pop.appendChild(row)
  }
}

/** Placeholder wired below; the real opener lives in the panel closure. */
let sessionOpener: ((id: string) => Promise<void>) | null = null

async function openSessionFromRow(id: string): Promise<void> {
  await sessionOpener?.(id)
}

function formatSessionDate(timestamp: number): string {
  const date = new Date(timestamp)
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
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
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {
      // ignore
    }
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
      return
    }
    // Escape stops the run, the same contract the composer's stop button has.
    if (event.key === 'Escape' && running) {
      event.preventDefault()
      handlers.onStop()
    }
  })

  function autoGrow(): void {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
  }

  // The unsent draft survives restarts and chat switches; a submitted draft
  // is dropped, mirroring per-session draft stores in DeepSeek Harness.
  const DRAFT_KEY = 'halis.composer-draft'
  try {
    textarea.value = localStorage.getItem(DRAFT_KEY) ?? ''
    if (textarea.value) autoGrow()
  } catch {
    // storage unavailable — draft just does not persist
  }
  let draftTimer = 0
  const saveDraft = (): void => {
    window.clearTimeout(draftTimer)
    draftTimer = window.setTimeout(() => {
      try {
        if (textarea.value.trim()) localStorage.setItem(DRAFT_KEY, textarea.value)
        else localStorage.removeItem(DRAFT_KEY)
      } catch {
        // ignore
      }
    }, 250)
  }
  textarea.addEventListener('input', () => {
    autoGrow()
    saveDraft()
  })

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
    if (message.content.trim().length === 0 && message.tools?.length) {
      bubble.classList.add('empty')
    }
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

    if (message.todos?.length) {
      wrap.appendChild(renderTodoCard(message.todos))
    }
    if (message.tools?.length) {
      wrap.append(bubble, renderToolTrace(message.tools), meta)
    } else {
      wrap.append(bubble, meta)
    }
    return wrap
  }

  const userMeta = el('div', 'meta')
  userMeta.appendChild(el('span', undefined, formatTime(message.createdAt)))
  const userCopy = el('button', 'copy-msg') as HTMLButtonElement
  userCopy.type = 'button'
  userCopy.title = 'Copy message'
  userCopy.appendChild(svg(icons.copy, 12))
  userCopy.addEventListener('click', () => {
    void navigator.clipboard.writeText(message.content).then(() => {
      userCopy.replaceChildren(svg(icons.check, 12))
      window.setTimeout(() => userCopy.replaceChildren(svg(icons.copy, 12)), 1200)
    })
  })
  userMeta.appendChild(userCopy)
  wrap.appendChild(el('div', 'bubble selectable', message.content))
  wrap.appendChild(userMeta)
  return wrap
}

/** The agent's plan as a checklist; latest snapshot wins. */
function renderTodoCard(todos: TodoItem[]): HTMLElement {
  const card = el('div', 'todo-card')
  const done = todos.filter((item) => item.status === 'completed').length
  const header = el('div', 'todo-head')
  header.append(el('span', 'todo-title', 'Plan'), el('span', 'todo-count', `${done}/${todos.length}`))
  card.appendChild(header)
  for (const item of todos) {
    const row = el('div', `todo-row ${item.status}`)
    const state = el('span', 'todo-state')
    if (item.status === 'completed') {
      state.appendChild(svg(icons.check, 11))
    } else if (item.status === 'in_progress') {
      state.appendChild(el('span', 'todo-spinner'))
    } else {
      state.appendChild(svg(icons.circle, 11))
    }
    row.append(state, el('span', 'todo-text', item.content))
    card.appendChild(row)
  }
  return card
}

/** Collapsible replay of the tool calls behind an assistant message. */
function renderToolTrace(tools: ToolTrace[]): HTMLElement {
  const details = el('details', 'tool-trace')
  const summary = el('summary')
  summary.appendChild(
    el('span', undefined, `${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}`)
  )
  details.appendChild(summary)
  for (const trace of tools) {
    details.appendChild(renderToolRow(trace, false))
  }
  return details
}

/** One tool call: spinner while running, expandable output once done. */
function renderToolRow(trace: ToolTrace, running: boolean): HTMLElement {
  if (running) {
    const row = el('div', 'tool-row live')
    row.appendChild(el('span', 'tool-spinner'))
    row.appendChild(el('span', 'tool-name', trace.name))
    row.appendChild(el('span', 'tool-arg', toolArgSummary(trace)))
    return row
  }

  const item = el('details', `tool-row done ${trace.ok ? 'ok' : 'fail'}`)
  const summary = el('summary')
  const status = el('span', 'tool-status')
  if (trace.ok) {
    status.appendChild(svg(icons.check, 11))
    status.appendChild(el('span', undefined, formatDuration(trace.durationMs)))
  } else {
    status.appendChild(svg(icons.close, 11))
    status.appendChild(el('span', undefined, 'failed'))
  }
  summary.append(
    el('span', 'tool-name', trace.name),
    el('span', 'tool-arg', toolArgSummary(trace)),
    status
  )
  item.appendChild(summary)

  const diff = toolDiff(trace)
  if (diff) {
    if (diff.added > 0 || diff.removed > 0) {
      const totals = el('span', 'diff-totals')
      if (diff.added > 0) totals.appendChild(el('span', 'diff-added', `+${diff.added}`))
      if (diff.removed > 0) totals.appendChild(el('span', 'diff-removed', `−${diff.removed}`))
      summary.insertBefore(totals, status)
    }
    item.appendChild(renderDiffBlock(diff))
  } else if (trace.output) {
    const output = el('pre', 'tool-output')
    output.textContent = trace.output
    item.appendChild(output)
  }
  return item
}

/* ---------- edit diffs ---------- */

interface DiffLine {
  kind: 'add' | 'del'
  text: string
}

interface ToolDiff {
  lines: DiffLine[]
  added: number
  removed: number
}

const DIFF_MAX_LINES = 24

/**
 * Build a small add/remove view for tools that change file content: edit_file
 * pairs old_text with new_text, write_file replaces the whole file. Returns
 * null for tools whose output should be shown instead.
 */
function toolDiff(trace: ToolTrace): ToolDiff | null {
  if (!trace.ok) return null
  if (trace.name === 'edit_file') {
    const oldText = typeof trace.input.old_text === 'string' ? trace.input.old_text : ''
    const newText =
      trace.input.new_text === undefined || typeof trace.input.new_text !== 'string'
        ? ''
        : trace.input.new_text
    if (!oldText && !newText) return null
    const lines: DiffLine[] = [
      ...splitDiffLines(oldText).map((text) => ({ kind: 'del' as const, text })),
      ...splitDiffLines(newText).map((text) => ({ kind: 'add' as const, text }))
    ]
    return capDiff(lines)
  }
  if (trace.name === 'write_file') {
    const content = typeof trace.input.content === 'string' ? trace.input.content : null
    if (content === null) return null
    return capDiff(splitDiffLines(content).map((text) => ({ kind: 'add' as const, text })))
  }
  return null
}

/** Split into displayed lines, dropping only the trailing newline remainder. */
function splitDiffLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

/** Head/tail cap so a huge rewrite cannot flood the conversation. */
function capDiff(lines: DiffLine[]): ToolDiff {
  const added = lines.filter((line) => line.kind === 'add').length
  const removed = lines.length - added
  if (lines.length <= DIFF_MAX_LINES) {
    return { lines, added, removed }
  }
  const head = Math.ceil(DIFF_MAX_LINES / 2)
  const tail = DIFF_MAX_LINES - head
  const gap: DiffLine[] = [
    ...lines.slice(0, head),
    { kind: 'del', text: `… ${lines.length - DIFF_MAX_LINES} more lines` },
    ...lines.slice(lines.length - tail)
  ]
  return { lines: gap, added, removed }
}

function renderDiffBlock(diff: ToolDiff): HTMLElement {
  const block = el('div', 'tool-diff')
  for (const line of diff.lines) {
    if (line.text.startsWith('… ') && line.kind === 'del') {
      block.appendChild(el('div', 'diff-gap', line.text))
      continue
    }
    block.appendChild(el('div', `diff-line ${line.kind}`, line.text))
  }
  return block
}

/** The most identifying argument of a call, kept short for the row label. */
function toolArgSummary(trace: ToolTrace): string {
  const input = trace.input
  const pick =
    (typeof input.path === 'string' && input.path) ||
    (typeof input.command === 'string' && input.command) ||
    (typeof input.query === 'string' && `"${input.query}"`) ||
    ''
  if (pick.length > 64) return `${pick.slice(0, 61)}…`
  return pick
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)}s`
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
