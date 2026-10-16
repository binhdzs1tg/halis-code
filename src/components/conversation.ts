import { el, svg, clear } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import { mountShimmer } from '../app/shimmer'
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ChatMessage,
  TodoItem,
  ToolTrace,
  UserQuestionRequestEvent
} from '../../electron/shared/types'
import type { ModelSelection } from '../../electron/shared/models'
import { agentService, AgentError } from '../core/agent/agent-service'
import * as catalog from '../core/models/catalog'
import { keyStatusOf, refreshKeyStatuses } from '../core/keys'
import { renderMarkdown } from '../core/markdown'
import { StreamingMarkdown } from '../core/markdown-stream'
import { stripAnsi } from '../core/ansi'
import { openModelDialog } from './model-picker'
import { openKeyDialog } from './key-dialog'
import { providerNeedsKey } from '../../electron/shared/models'

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

/**
 * The centre column: a DeepSeek Harness-style conversation — crumbs header,
 * the message flow with a deep-diving shimmer row while the agent runs, and
 * the 28px-radius composer card with its dock (queue + approvals).
 */
export function mountConversation(): HTMLElement {
  const rootEl = el('section', 'conversation')

  /* ---------- header ---------- */
  const header = el('header', 'convo-header')
  const title = el('div', 'convo-title')
  const crumb = el('span', 'crumb', 'New Session')
  title.appendChild(crumb)

  const actions = el('div', 'convo-actions')

  const openFolderBtn = el('button', 'icon-btn') as HTMLButtonElement
  openFolderBtn.type = 'button'
  openFolderBtn.title = 'Open folder'
  openFolderBtn.appendChild(svg(icons.folder, 16))
  openFolderBtn.addEventListener('click', () => {
    void window.halis.pickWorkspace().then((root) => {
      if (root) store.update({ workspaceRoot: root })
    }).catch(() => undefined)
  })

  const railToggle = el('button', 'icon-btn') as HTMLButtonElement
  railToggle.type = 'button'
  railToggle.title = 'Toggle workspace panel'
  railToggle.appendChild(svg(icons.panelRight, 16))
  railToggle.addEventListener('click', () => {
    store.update({ railVisible: !store.get().railVisible })
  })

  actions.append(openFolderBtn, railToggle)
  header.append(title, actions)
  rootEl.appendChild(header)

  const syncCrumb = (messages: ChatMessage[]): void => {
    crumb.textContent = messages.length > 0 ? sessionTitle(messages) : 'New Session'
  }

  /* ---------- scroll body ---------- */
  const scroll = el('div', 'chat-scroll')
  const column = el('div', 'chat-column')
  scroll.appendChild(column)
  rootEl.appendChild(scroll)

  const toBottomSlot = el('div', 'to-bottom-slot')
  const jump = el('button', 'to-bottom') as HTMLButtonElement
  jump.type = 'button'
  jump.title = 'Jump to latest'
  jump.appendChild(svg(icons.chevronDown, 15))
  jump.hidden = true
  jump.addEventListener('click', () => {
    scrollToBottom(scroll, true)
  })
  toBottomSlot.appendChild(jump)
  scroll.appendChild(toBottomSlot)

  scroll.addEventListener('scroll', () => {
    const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
    jump.hidden = distance < 240
  })

  const messages: ChatMessage[] = []
  let running = false
  let stoppedManually = false

  // Publish the column width so the chat content axis resolves, exactly as
  // the harness conversation root does.
  const widthObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0
    document.body.style.setProperty('--dsh-conversation-column-width', `${Math.round(width)}px`)
  })
  widthObserver.observe(rootEl)

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
      store.update({ sessionsVersion: store.get().sessionsVersion + 1 })
      window.dispatchEvent(new CustomEvent<string>('halis:session-opened', { detail: meta.id }))
    } catch {
      // Persistence is best effort; the chat keeps working without it.
    }
  }

  /* ---------- hero (empty state) ---------- */
  const hero = el('div', 'chat-hero')
  const heroStack = el('div', 'hero-stack')
  const headline = el('div', 'headline')
  const fishHitbox = el('span', 'fish-hitbox')
  const fish = el('span', 'fish')
  fish.appendChild(el('span', 'fish-img'))
  fishHitbox.appendChild(fish)
  const heroName = el('span', 'hero-title-img')
  headline.append(fishHitbox, heroName)
  heroStack.appendChild(headline)

  const workspaceRow = el('div', 'workspace-row')
  const workspaceChip = el('button', 'workspace-chip') as HTMLButtonElement
  workspaceChip.type = 'button'
  const wsFolder = el('span', 'folder')
  wsFolder.appendChild(svg(icons.folder, 15))
  const wsLabel = el('span', 'workspace-label', 'Open a folder')
  const wsChevron = el('span', 'chevron')
  wsChevron.appendChild(svg(icons.chevronDown, 13))
  workspaceChip.append(wsFolder, wsLabel, wsChevron)
  workspaceChip.addEventListener('click', () => {
    void window.halis.pickWorkspace().then((root) => {
      if (root) store.update({ workspaceRoot: root })
    }).catch(() => undefined)
  })
  workspaceRow.appendChild(workspaceChip)
  heroStack.appendChild(workspaceRow)

  const heroCardHost = el('div', 'hero-card-host')
  heroStack.appendChild(heroCardHost)
  hero.appendChild(heroStack)

  const syncWorkspaceChip = (): void => {
    const root = store.get().workspaceRoot
    wsLabel.textContent = root ? fileName(root) : 'Open a folder'
  }
  syncWorkspaceChip()
  store.subscribe((state, prev) => {
    if (state.workspaceRoot !== prev.workspaceRoot) syncWorkspaceChip()
  })

  /* ---------- composer ---------- */
  const composer = buildComposer({
    onSubmit: (text) => void send(text),
    onStop: () => {
      // A manual stop also holds the queue back; the user decides what runs next.
      stoppedManually = true
      agentService.cancel()
    },
    onEscape: () => {
      // While an approval is pending, Escape belongs to the approval card.
      if (pendingApproval) {
        agentService.respondApproval(pendingApproval.requestId, 'rejected')
        clearApprovalCard()
        return true
      }
      // Then a pending question, for the same reason.
      if (pendingQuestion) {
        agentService.respondQuestion(pendingQuestion.requestId, null)
        clearQuestionCard()
        return true
      }
      return false
    },
    // Lazy so the binding can live below with the other command flows.
    getCommands: () => getCommands()
  })

  const seat = el('div', 'composer-seat')
  seat.appendChild(composer.root)
  rootEl.appendChild(seat)

  const enterHero = (): void => {
    rootEl.dataset.hero = ''
    scroll.appendChild(hero)
    heroCardHost.appendChild(composer.root)
  }
  const exitHero = (): void => {
    delete rootEl.dataset.hero
    hero.remove()
    seat.appendChild(composer.root)
  }
  enterHero()

  window.addEventListener('halis:new-session', () => void newChat())

  /* ---------- approvals (composer takeover) ---------- */

  let pendingApproval: ApprovalRequestEvent | null = null
  const approvalHost = el('div', 'dock approval-host')
  approvalHost.hidden = true
  // The dock lives under the composer card; without this the approval UI
  // never reaches the DOM and risky commands sit unanswered in silence.
  seat.appendChild(approvalHost)

  const clearApprovalCard = (): void => {
    pendingApproval = null
    approvalHost.hidden = true
    clear(approvalHost)
    composer.setLocked(false)
  }

  const paintApprovalCard = (): void => {
    clear(approvalHost)
    approvalHost.hidden = !pendingApproval
    if (!pendingApproval) return
    const request = pendingApproval
    const dockCard = el('div', 'dock-card')
    const card = el('div', 'approval-card')
    const head = el('div', 'approval-head')
    head.append(el('span', 'approval-dot'), el('span', 'approval-title', 'Waiting for your approval'))
    card.appendChild(head)
    card.appendChild(
      el('div', 'approval-reason', `This command needs your ok — ${request.reason}.`)
    )
    if (request.command) {
      card.appendChild(el('code', 'approval-command', request.command))
    }
    const row = el('div', 'approval-actions')
    const deny = el('button', 'btn ghost approval-deny') as HTMLButtonElement
    deny.type = 'button'
    deny.textContent = 'Deny'
    const allow = el('button', 'btn approval-allow') as HTMLButtonElement
    allow.type = 'button'
    allow.textContent = 'Allow once'
    const decide = (decision: ApprovalDecision): void => {
      if (pendingApproval?.requestId !== request.requestId) return
      agentService.respondApproval(request.requestId, decision)
      clearApprovalCard()
    }
    deny.addEventListener('click', () => decide('rejected'))
    allow.addEventListener('click', () => decide('allowed-once'))
    row.append(deny, allow)
    card.appendChild(row)
    dockCard.appendChild(card)
    approvalHost.appendChild(dockCard)
    allow.focus()
    // The composer is taken over until the user decides — without the lock,
    // one Enter press both approves and queues the composer text.
    composer.setLocked(true)
    // Enter approves, Escape rejects — the same keys as DeepSeek Harness's
    // approval panel; the composer is taken over until the user decides.
    const onKey = (event: KeyboardEvent): void => {
      if (pendingApproval?.requestId !== request.requestId) {
        document.removeEventListener('keydown', onKey)
        return
      }
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        decide('allowed-once')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        decide('rejected')
      }
    }
    document.addEventListener('keydown', onKey)
  }

  /* ---------- agent questions (ask_user tool) ---------- */

  let pendingQuestion: UserQuestionRequestEvent | null = null
  const questionHost = el('div', 'dock question-host')
  questionHost.hidden = true
  seat.appendChild(questionHost)

  const clearQuestionCard = (): void => {
    pendingQuestion = null
    questionHost.hidden = true
    clear(questionHost)
    composer.setLocked(false)
  }

  const paintQuestionCard = (): void => {
    clear(questionHost)
    questionHost.hidden = !pendingQuestion
    if (!pendingQuestion) return
    const request = pendingQuestion
    const dockCard = el('div', 'dock-card')
    const card = el('div', 'question-card')
    const head = el('div', 'question-head')
    head.append(el('span', 'question-dot'), el('span', 'question-title', 'The agent is asking'))
    card.appendChild(head)
    card.appendChild(el('div', 'question-text', request.question))

    const selected = new Set<string>()
    const optionsBox = el('div', 'question-options')
    for (const option of request.options) {
      const button = el('button', 'btn ghost question-option') as HTMLButtonElement
      button.type = 'button'
      button.appendChild(el('span', 'question-option-label', option.label))
      if (option.description) {
        button.appendChild(el('span', 'question-option-hint', option.description))
      }
      button.addEventListener('click', () => {
        const picked = selected.has(option.label)
        if (!request.multiple) {
          selected.clear()
          for (const child of [...optionsBox.children]) {
            child.classList.remove('picked')
          }
        }
        if (picked) {
          selected.delete(option.label)
          button.classList.remove('picked')
        } else {
          selected.add(option.label)
          button.classList.add('picked')
        }
      })
      optionsBox.appendChild(button)
    }
    card.appendChild(optionsBox)

    const custom = el('input', 'question-custom-input') as HTMLInputElement
    custom.type = 'text'
    custom.placeholder = 'Or type your own answer'
    card.appendChild(custom)

    const row = el('div', 'question-actions')
    const skip = el('button', 'btn ghost question-skip') as HTMLButtonElement
    skip.type = 'button'
    skip.textContent = 'Skip'
    const submit = el('button', 'btn question-submit') as HTMLButtonElement
    submit.type = 'button'
    submit.textContent = 'Answer'

    const settle = (answers: string[] | null): void => {
      if (pendingQuestion?.requestId !== request.requestId) return
      agentService.respondQuestion(request.requestId, answers)
      clearQuestionCard()
    }
    const submitAnswers = (): void => {
      const answers = [...selected]
      const own = custom.value.trim()
      if (own.length > 0 && !answers.includes(own)) {
        answers.push(own)
      }
      // Submitting nothing chosen is a skip, not a blank answer.
      settle(answers.length > 0 ? answers : null)
    }
    skip.addEventListener('click', () => settle(null))
    submit.addEventListener('click', submitAnswers)
    custom.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        submitAnswers()
      }
    })
    row.append(skip, submit)
    card.appendChild(row)

    dockCard.appendChild(card)
    questionHost.appendChild(dockCard)
    // The composer stays locked until the question is settled — one Enter
    // must not both answer and send.
    composer.setLocked(true)
    const onKey = (event: KeyboardEvent): void => {
      if (pendingQuestion?.requestId !== request.requestId) {
        document.removeEventListener('keydown', onKey)
        return
      }
      if (event.key === 'Enter' && !event.isComposing && document.activeElement !== custom) {
        event.preventDefault()
        submitAnswers()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        settle(null)
      }
    }
    document.addEventListener('keydown', onKey)
  }

  /* ---------- queued sends (while a run is in flight) ---------- */

  const queue: string[] = []
  const queueBox = el('div', 'dock queue-box')
  queueBox.hidden = true
  seat.appendChild(queueBox)

  const paintQueue = (): void => {
    clear(queueBox)
    queueBox.hidden = queue.length === 0
    if (queue.length === 0) return
    const dockCard = el('div', 'dock-card')
    const rows = el('div', 'queue-rows')
    for (let i = 0; i < queue.length; i += 1) {
      const row = el('div', 'queue-row')
      row.appendChild(el('span', 'queue-label', 'Queued'))
      row.appendChild(el('span', 'queue-text', queue[i]))
      const del = el('button', 'queue-del') as HTMLButtonElement
      del.type = 'button'
      del.title = 'Remove'
      del.appendChild(svg(icons.close, 11))
      del.addEventListener('click', () => {
        queue.splice(i, 1)
        paintQueue()
      })
      row.appendChild(del)
      rows.appendChild(row)
    }
    dockCard.appendChild(rows)
    queueBox.appendChild(dockCard)
  }

  /* ---------- running shimmer row ---------- */

  let runningRow: HTMLElement | null = null
  let runningTimer = 0
  let runningStart = 0
  let runningShimmer: { setText(text: string): void } | null = null

  const showRunningRow = (): void => {
    if (runningRow) return
    runningRow = el('div', 'running flow-item')
    const divider = el('span', 'running-divider')
    divider.dataset.visible = ''
    const content = el('span', 'running-content')
    const mark = el('span', 'running-mark')
    const shimmer = mountShimmer('Deep diving for 0s')
    runningShimmer = shimmer
    content.append(mark, shimmer.root)
    runningRow.append(divider, content)
    column.appendChild(runningRow)
    runningStart = Date.now()
    runningTimer = window.setInterval(() => {
      runningShimmer?.setText(`Deep diving for ${Math.floor((Date.now() - runningStart) / 1000)}s`)
    }, 1000)
    scrollToBottom(scroll)
  }

  const hideRunningRow = (): void => {
    window.clearInterval(runningTimer)
    runningShimmer = null
    runningRow?.remove()
    runningRow = null
  }

  /* ---------- session lifecycle ---------- */

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
    clear(column)
    enterHero()
    syncCrumb(messages)
    store.update({ sessionsVersion: store.get().sessionsVersion + 1 })
    window.dispatchEvent(new CustomEvent<string>('halis:session-opened', { detail: '' }))
  }

  const openSession = async (id: string): Promise<void> => {
    if (running) {
      appendSystemNote('Stop the agent before switching chats.')
      return
    }
    if (!id) return
    try {
      const session = await window.halis.loadSession(id)
      if (sessionId !== id) {
        await persist()
      }
      sessionId = session.id
      messages.splice(0, messages.length, ...session.messages)
      clear(column)
      exitHero()
      for (const message of messages) {
        column.appendChild(renderMessage(message))
      }
      syncCrumb(messages)
      scrollToBottom(scroll, true)
      if (session.model && catalog.isValid(session.model)) {
        store.update({ selectedModel: session.model })
      }
      store.update({ sessionsVersion: store.get().sessionsVersion + 1 })
      window.dispatchEvent(new CustomEvent<string>('halis:session-opened', { detail: id }))
    } catch (err) {
      appendSystemNote(err instanceof Error ? err.message : String(err))
    }
  }

  // The sidebar opens sessions through this hook.
  window.dispatchEvent(
    new CustomEvent<(id: string) => Promise<void>>('halis:register-session-opener', {
      detail: openSession
    })
  )

  /* ---------- slash commands ---------- */

  interface SlashCommand {
    name: string
    description: string
    /** Commands that touch the conversation wait for the agent to settle. */
    requireIdle?: boolean
    run(): void | Promise<void>
  }

  const compactFlow = async (): Promise<void> => {
    if (running) {
      appendSystemNote('Stop the agent before compacting.')
      return
    }
    const selection = store.get().selectedModel
    if (!selection || !catalog.isValid(selection)) {
      appendSystemNote('No model selected yet — pick one to start.', {
        label: 'Select model',
        onClick: () => openModelDialog()
      })
      return
    }
    appendSystemNote('Compacting this conversation…')
    try {
      const result = await agentService.compact({ history: [...messages], model: selection })
      messages.splice(0, messages.length)
      const checkpoint = makeMessage('system', result.checkpoint)
      messages.push(checkpoint)
      clear(column)
      column.appendChild(renderMessage(checkpoint))
      appendSystemNote(
        `Compacted: about ${result.beforeTokens.toLocaleString()} tokens down to about ${result.afterTokens.toLocaleString()}.`
      )
      await persist()
    } catch (err) {
      appendSystemNote(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const exportFlow = async (): Promise<void> => {
    if (messages.length === 0) {
      appendSystemNote('Nothing to export yet.')
      return
    }
    const body = messages
      .map((message) => {
        const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Halis' : 'Note'
        const time = new Date(message.createdAt).toLocaleString()
        return `## ${label} · ${time}\n\n${message.content}`
      })
      .join('\n\n---\n\n')
    const markdown = `# ${sessionTitle(messages)}\n\n${body}\n`
    const base = (sessionTitle(messages) || 'chat').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
    try {
      const path = await window.halis.exportConversation(`${base || 'chat'}.md`, markdown)
      if (path) appendSystemNote(`Exported to ${path}`)
    } catch (err) {
      appendSystemNote(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const getCommands = (): SlashCommand[] => [
    { name: 'new', description: 'Start a new chat', requireIdle: true, run: () => void newChat() },
    { name: 'model', description: 'Switch model', run: () => void openModelDialog() },
    { name: 'compact', description: 'Fold this conversation into a checkpoint', requireIdle: true, run: () => void compactFlow() },
    { name: 'export', description: 'Save this conversation as Markdown', run: () => void exportFlow() },
    {
      name: 'help',
      description: 'List the commands',
      run: () =>
        appendSystemNote(
          `Commands: ${['/new', '/model', '/compact', '/export', '/help']
            .map((name) => name)
            .join(', ')} — @path in a message attaches that file.`
        )
    }
  ]

  const runCommand = async (text: string): Promise<void> => {
    const name = text.slice(1).split(/\s/)[0]?.toLowerCase() ?? ''
    const command = getCommands().find((item) => item.name === name)
    if (!command) {
      appendSystemNote(
        `Unknown command "${name}". Try ${getCommands().map((item) => `/${item.name}`).join(', ')}.`
      )
      return
    }
    if (command.requireIdle && running) {
      appendSystemNote('Stop the agent before running that command.')
      return
    }
    await command.run()
  }

  /* ---------- the send flow ---------- */

  const send = async (text: string): Promise<void> => {
    // Slash commands route to their own handlers instead of the model.
    if (text.startsWith('/')) {
      await runCommand(text)
      return
    }
    if (running) {
      // Like a queue dock: typing while the agent runs parks the message
      // instead of dropping it, and it is sent when the run settles.
      queue.push(text)
      paintQueue()
      return
    }
    // Raised synchronously, before any await: a double-tap of Enter during
    // the key-status roundtrip must not start two runs.
    running = true
    stoppedManually = false

    // Everything that can bail without a run happens before the user's
    // message lands, so a blocked turn never leaves an orphan bubble.
    // The gate itself must never wedge the composer: any failure here
    // releases the run lock instead of queueing forever.
    let selection: ModelSelection
    try {
      const picked = store.get().selectedModel
      if (!picked || !catalog.isValid(picked)) {
        if (rootEl.hasAttribute('data-hero')) {
          exitHero()
        }
        running = false
        appendSystemNote('No model selected yet — pick one to start.', {
          label: 'Select model',
          onClick: () => openModelDialog()
        })
        return
      }
      selection = picked

      // A provider gatekeeping its models gets its key dialog right here,
      // asking for credentials the first time a model needs them.
      const found = catalog.findModel(selection)
      if (found && providerNeedsKey(found.provider)) {
        await refreshKeyStatuses()
        if (!keyStatusOf(found.provider.id)) {
          running = false
          openKeyDialog(
            () => void send(text),
            () => composer.setText(text)
          )
          return
        }
      }

      if (rootEl.hasAttribute('data-hero')) {
        exitHero()
      }
    } catch (err) {
      running = false
      appendSystemNote(`Could not start the run: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const userMsg = makeMessage('user', text)
    messages.push(userMsg)
    column.appendChild(renderMessage(userMsg))
    syncCrumb(messages)
    scrollToBottom(scroll, true)

    running = true
    composer.setRunning(true)
    store.update({ agentStatus: 'thinking' })
    showRunningRow()

    const history = [...messages]
    const assistant = makeMessage('assistant', '')
    const node = renderMessage(assistant)
    const bubble = node.querySelector<HTMLElement>('.bubble')
    bubble?.classList.add('streaming')
    messages.push(assistant)
    column.appendChild(node)

    // Live feed of tool calls made while this answer streams in.
    const traces: ToolTrace[] = []
    const toolLog = el('div', 'tool-log')
    const liveRows = new Map<string, HTMLElement>()
    const traceOf = new Map<string, ToolTrace>()
    // The tool log rides above the streaming bubble, inside the assistant
    // body — .bubble is a child of .assistant-body, not of the message node,
    // so the insertion has to anchor on the bubble itself.
    if (bubble) {
      bubble.before(toolLog)
    } else {
      node.appendChild(toolLog)
    }

    // Live plan card, replaced wholesale on every todo_write snapshot.
    let liveTodos: TodoItem[] = []
    let todoCard: HTMLElement | null = null
    const paintTodos = (): void => {
      if (liveTodos.length === 0) return
      const next = renderTodoCard(liveTodos)
      if (todoCard) todoCard.replaceWith(next)
      else toolLog.before(next)
      todoCard = next
    }

    let buffered = ''
    let frame = 0
    // Only the unstable tail re-renders per frame; settled blocks freeze.
    let stream: StreamingMarkdown | null = null
    if (bubble) {
      bubble.classList.add('streaming-md')
      stream = new StreamingMarkdown(bubble)
    }
    const paint = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        stream?.update(buffered)
        scrollToBottom(scroll)
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
              // Hunk data rides on the end event; without it the diff card
              // falls back to the coarser legacy rendering after a replay.
              if (event.diff) trace.diff = event.diff
              const row = liveRows.get(event.callId)
              if (row) row.replaceWith(renderToolRow(trace, false))
            }
            scrollToBottom(scroll)
          },
          onTodo: (event) => {
            liveTodos = event.todos
            paintTodos()
          },
          onNotice: (event) => {
            appendSystemNote(event.text)
          },
          onApproval: (event) => {
            pendingApproval = event
            paintApprovalCard()
          },
          onQuestion: (event) => {
            pendingQuestion = event
            paintQuestionCard()
          }
        }
      )
      assistant.content = full
      if (traces.length > 0) assistant.tools = [...traces]
      if (liveTodos.length > 0) assistant.todos = [...liveTodos]
      node.replaceWith(renderMessage(assistant))
      void persist()
      drainQueue(sessionId)
    } catch (err) {
      // Drop the placeholder by identity — a compaction notice may have
      // landed after it, and popping the last message would strand an empty
      // assistant bubble in the session forever.
      node.remove()
      const placeholder = messages.indexOf(assistant)
      if (placeholder !== -1) {
        messages.splice(placeholder, 1)
      }
      const agentErr = err instanceof AgentError ? err : null
      if (agentErr && (agentErr.partial.trim() || traces.length > 0)) {
        const partial = makeMessage('assistant', agentErr.partial)
        if (traces.length > 0) partial.tools = [...traces]
        if (liveTodos.length > 0) partial.todos = [...liveTodos]
        messages.push(partial)
        column.appendChild(renderMessage(partial))
        void persist()
      }
      if (agentErr?.code === 'missing-key') {
        appendSystemNote(agentErr.message, { label: 'Add API key', onClick: () => openKeyDialog() })
        openKeyDialog()
      } else if (agentErr?.code === 'invalid-model') {
        appendSystemNote(agentErr.message, { label: 'Select model', onClick: () => openModelDialog() })
      } else if (agentErr?.code === 'http' && (agentErr.status === 401 || agentErr.status === 403)) {
        // A stored key stopped working — surface the same dialog to replace it.
        appendSystemNote(agentErr.message, { label: 'Update API key', onClick: () => openKeyDialog() })
        openKeyDialog()
      } else {
        appendSystemNote(agentErr ? agentErr.message : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`)
        store.update({ agentStatus: 'error' })
      }
      // A failed run still pulls the next queued message — the queue is
      // work the user asked to send, not a retry of the failed one.
      if (agentErr?.code !== 'aborted') drainQueue(sessionId)
    } finally {
      if (frame) cancelAnimationFrame(frame)
      running = false
      composer.setRunning(false)
      hideRunningRow()
      clearApprovalCard()
      // Every settled run — success, error or cancel — clears any ask_user
      // card a tool left behind; the run that owned it is gone.
      clearQuestionCard()
      if (store.get().agentStatus !== 'error') {
        store.update({ agentStatus: 'idle' })
      }
      scrollToBottom(scroll)
    }
  }

  /** Pull the next queued message after a settled run. The session-id
   *  guard keeps a scheduled send from landing in a chat the user just
   *  switched away from during the handoff window. */
  const drainQueue = (atSettle: string | null): void => {
    if (stoppedManually) return
    if (queue.length === 0) return
    const next = queue.shift()
    paintQueue()
    if (next) {
      window.setTimeout(() => {
        if (sessionId !== atSettle) return
        void send(next)
      }, 30)
    }
  }

  const appendSystemNote = (text: string, action?: { label: string; onClick: () => void }): void => {
    const message = makeMessage('system', text)
    messages.push(message)
    const node = renderMessage(message)
    if (action) {
      const btn = el('button', 'btn small note-action') as HTMLButtonElement
      btn.type = 'button'
      btn.textContent = action.label
      btn.addEventListener('click', action.onClick)
      node.querySelector('.bubble')?.appendChild(btn)
    }
    column.appendChild(node)
    scrollToBottom(scroll, true)
  }

  // Copy buttons rendered inside markdown code blocks.
  scroll.addEventListener('click', (event) => {
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

  return rootEl
}

/** First user message, collapsed onto one line, as the session title. */
function sessionTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user')
  const raw = (first?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return 'Chat'
  return raw.length > 48 ? `${raw.slice(0, 45)}…` : raw
}

/* ---------- composer ---------- */

interface ComposerHandlers {
  onSubmit(text: string): void
  onStop(): void
  /** Return true when Escape was already consumed (an approval is pending). */
  onEscape?(): boolean
  /** Slash commands for the composer menu, fetched lazily. */
  getCommands?(): Array<{ name: string; description: string }>
}

function buildComposer(
  handlers: ComposerHandlers
): {
  root: HTMLElement
  setRunning(running: boolean): void
  setLocked(locked: boolean): void
  /** Put text back into the input, e.g. when a send was deferred. */
  setText(text: string): void
} {
  const composer = el('div', 'composer')

  const card = el('div', 'composer-card')
  const scrollWrap = el('div', 'composer-scroll')
  const textarea = el('textarea', 'composer-input') as HTMLTextAreaElement
  textarea.rows = 1
  textarea.placeholder = 'Ask Halis to code something…'
  textarea.spellcheck = false
  scrollWrap.appendChild(textarea)

  const row = el('div', 'composer-row')

  const tools = el('div', 'composer-tools')
  const addBtn = el('button', 'add-button') as HTMLButtonElement
  addBtn.type = 'button'
  addBtn.title = 'Commands'
  addBtn.appendChild(svg(icons.plus, 14))
  tools.appendChild(addBtn)

  const trailing = el('div', 'composer-trailing')
  const modelPill = el('button', 'model-pill') as HTMLButtonElement
  modelPill.type = 'button'
  modelPill.title = 'Select model'
  const modelLabel = el('span', 'model-label', 'Loading models…')
  const modelChev = el('span', 'chev')
  modelChev.appendChild(svg(icons.chevronDown, 13))
  modelPill.append(modelLabel, modelChev)
  modelPill.addEventListener('click', () => {
    openModelDialog()
  })

  const sendBtn = el('button', 'send-button') as HTMLButtonElement
  sendBtn.type = 'button'

  trailing.append(modelPill, sendBtn)
  row.append(tools, trailing)
  card.append(scrollWrap, row)

  composer.append(card)

  let running = false
  let locked = false
  const paintButton = (): void => {
    sendBtn.title = running ? 'Stop' : 'Send'
    sendBtn.className = running ? 'send-button stop' : 'send-button'
    sendBtn.replaceChildren(svg(running ? icons.stop : icons.arrowUp, 15))
  }

  const submit = (): void => {
    if (running || locked) return
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

  addBtn.addEventListener('click', () => {
    if (!textarea.value.startsWith('/')) {
      textarea.value = `/${textarea.value}`
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      autoGrow()
      slashIndex = 0
      refreshSlash()
    }
    textarea.focus()
  })

  /* ---------- slash command menu ---------- */

  const slashPop = el('div', 'slash-pop')
  slashPop.hidden = true
  composer.appendChild(slashPop)
  let slashItems: Array<{ name: string; description: string }> = []
  let slashIndex = 0

  const closeSlash = (): void => {
    slashPop.hidden = true
    slashItems = []
  }

  const paintSlash = (): void => {
    clear(slashPop)
    slashItems.forEach((item, index) => {
      const rowNode = el('div', `slash-row${index === slashIndex ? ' active' : ''}`)
      rowNode.append(
        el('span', 'slash-name', `/${item.name}`),
        el('span', 'slash-desc', item.description)
      )
      rowNode.addEventListener('click', () => {
        acceptSlash(index)
      })
      slashPop.appendChild(rowNode)
    })
  }

  const acceptSlash = (index: number): void => {
    const item = slashItems[index]
    if (!item) return
    textarea.value = `/${item.name} `
    autoGrow()
    closeSlash()
    textarea.focus()
  }

  const refreshSlash = (): void => {
    const value = textarea.value
    if (!value.startsWith('/') || value.includes('\n')) {
      closeSlash()
      return
    }
    const query = value.slice(1).toLowerCase()
    const all = handlers.getCommands?.() ?? []
    slashItems = all.filter((item) => item.name.startsWith(query))
    if (slashItems.length === 0) {
      closeSlash()
      return
    }
    slashIndex = Math.min(slashIndex, slashItems.length - 1)
    paintSlash()
    slashPop.hidden = false
  }

  textarea.addEventListener('keydown', (event) => {
    if (!slashPop.hidden) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        slashIndex = (slashIndex + 1) % slashItems.length
        paintSlash()
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length
        paintSlash()
        return
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        acceptSlash(slashIndex)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSlash()
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }
    // Escape first offers itself to pending approvals, then stops the run —
    // the same contract the composer's stop button has.
    if (event.key === 'Escape') {
      if (handlers.onEscape?.()) {
        event.preventDefault()
        return
      }
      if (running) {
        event.preventDefault()
        handlers.onStop()
      }
    }
  })

  function autoGrow(): void {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 336)}px`
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
    slashIndex = 0
    refreshSlash()
  })

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
  }).catch(() => undefined)

  window.halis.onModelsUpdated(() => {
    catalog.invalidate()
    void catalog.ensureCatalog().then(() => {
      const selection = store.get().selectedModel
      if (!catalog.isValid(selection)) {
        const fallback = catalog.defaultSelection()
        if (fallback) store.update({ selectedModel: fallback })
      }
      refreshModelButton()
    }).catch(() => undefined)
  })

  paintButton()
  return {
    root: composer,
    setRunning(value: boolean): void {
      running = value
      paintButton()
    },
    setLocked(value: boolean): void {
      locked = value
      textarea.disabled = locked
      addBtn.disabled = locked
    },
    setText(text: string): void {
      textarea.value = text
      textarea.focus()
      autoGrow()
    }
  }
}

/* ---------- message rendering ---------- */

function renderMessage(message: ChatMessage): HTMLElement {
  const wrap = el('div', `msg flow-item ${message.role}`)

  // A compaction checkpoint is stored as a system message; show it as a
  // collapsible card instead of a wall of summary text.
  if (message.role === 'system' && message.content.includes('<compacted-summary>')) {
    const details = el('details', 'checkpoint-card')
    const summary = el('summary')
    summary.appendChild(svg(icons.history, 13))
    summary.appendChild(el('span', undefined, 'Conversation checkpoint'))
    details.appendChild(summary)
    const body = el('pre', 'checkpoint-body', message.content)
    details.appendChild(body)
    wrap.appendChild(details)
    return wrap
  }

  if (message.role === 'assistant') {
    const bubble = el('div', 'bubble md selectable')
    bubble.innerHTML = renderMarkdown(message.content)
    if (message.content.trim().length === 0 && message.tools?.length) {
      bubble.classList.add('empty')
    }
    const meta = el('div', 'meta')
    meta.appendChild(el('span', 'time-start', formatTime(message.createdAt)))

    const copy = el('button', 'copy-msg') as HTMLButtonElement
    copy.type = 'button'
    copy.title = 'Copy message'
    copy.appendChild(svg(icons.copy, 13))
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(message.content).then(() => {
        copy.replaceChildren(svg(icons.check, 13))
        window.setTimeout(() => copy.replaceChildren(svg(icons.copy, 13)), 1200)
      })
    })
    meta.appendChild(copy)

    const body = el('div', 'assistant-body')
    if (message.todos?.length) {
      body.appendChild(renderTodoCard(message.todos))
    }
    if (message.tools?.length) {
      body.append(bubble, renderToolTrace(message.tools))
    } else {
      body.appendChild(bubble)
    }
    wrap.append(body, meta)
    return wrap
  }

  if (message.role === 'system') {
    wrap.appendChild(el('div', 'bubble selectable', message.content))
    return wrap
  }

  // user
  const stack = el('div', 'user-stack')
  stack.appendChild(el('div', 'bubble selectable', message.content))
  const meta = el('div', 'meta')
  meta.appendChild(el('span', 'time-start', formatTime(message.createdAt)))
  const userCopy = el('button', 'copy-msg') as HTMLButtonElement
  userCopy.type = 'button'
  userCopy.title = 'Copy message'
  userCopy.appendChild(svg(icons.copy, 13))
  userCopy.addEventListener('click', () => {
    void navigator.clipboard.writeText(message.content).then(() => {
      userCopy.replaceChildren(svg(icons.check, 13))
      window.setTimeout(() => userCopy.replaceChildren(svg(icons.copy, 13)), 1200)
    })
  })
  meta.appendChild(userCopy)
  wrap.appendChild(stack)
  wrap.appendChild(meta)
  return wrap
}

/** The agent's plan as a checklist; latest snapshot wins. */
function renderTodoCard(todos: TodoItem[]): HTMLElement {
  const card = el('div', 'todo-card')
  const done = todos.filter((item) => item.status === 'completed').length
  const head = el('div', 'todo-head')
  const lead = el('span', 'todo-lead')
  lead.appendChild(svg(icons.todo, 13))
  head.append(
    lead,
    el('span', 'todo-title', 'Plan'),
    el('span', 'todo-count', `${done}/${todos.length} done`)
  )
  card.appendChild(head)
  const rows = el('div', 'todo-rows')
  for (const item of todos) {
    const row = el('div', `todo-row ${item.status}`)
    const glyph = el('span', 'todo-glyph')
    if (item.status === 'completed') {
      glyph.appendChild(svg(icons.check, 12))
    } else if (item.status === 'in_progress') {
      glyph.appendChild(el('span', 'todo-spinner'))
    } else {
      glyph.appendChild(svg(icons.circle, 12))
    }
    row.append(glyph, el('span', 'todo-text', item.content))
    rows.appendChild(row)
  }
  card.appendChild(rows)
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
  const log = el('div', 'tool-log')
  for (const trace of tools) {
    log.appendChild(renderToolRow(trace, false))
  }
  details.appendChild(log)
  return details
}

/** One tool call: shimmer while running, expandable output once done. */
function renderToolRow(trace: ToolTrace, live: boolean): HTMLElement {
  if (live) {
    const row = el('div', 'tool-row live')
    const glyph = el('span', 'tool-glyph')
    glyph.appendChild(el('span', 'tool-spinner'))
    const shimmer = mountShimmer(trace.name)
    row.append(glyph, shimmer.root)
    if (toolArgSummary(trace)) {
      row.appendChild(el('span', 'tool-sep'))
      const arg = el('span', 'tool-arg')
      arg.appendChild(mountShimmer(toolArgSummary(trace)).root)
      row.appendChild(arg)
    }
    return row
  }

  const item = el('details', `tool-row done`)
  item.dataset.tool = trace.name
  if (!trace.ok) item.classList.add('fail')

  const summary = el('summary')
  const glyph = el('span', 'tool-glyph')
  const chev = svg(icons.chevronDown, 13)
  chev.classList.add('chev')
  glyph.appendChild(chev)
  summary.appendChild(glyph)
  summary.appendChild(el('span', 'tool-name', trace.name))

  const argText = toolArgSummary(trace)
  if (argText) {
    summary.appendChild(el('span', 'tool-sep'))
    summary.appendChild(el('span', 'tool-arg', argText))
  }

  const status = el('span', `tool-status ${trace.ok ? 'ok' : 'fail'}`)
  if (trace.ok) {
    status.appendChild(svg(icons.check, 12))
    status.appendChild(el('span', undefined, formatDuration(trace.durationMs)))
  } else {
    status.appendChild(svg(icons.close, 12))
    status.appendChild(el('span', undefined, 'failed'))
  }
  summary.appendChild(status)
  item.appendChild(summary)

  const bodyWrap = el('div', 'tool-body-wrap')
  const bodyScroll = el('div', 'tool-body-scroll')

  const diff = toolDiff(trace)
  if (diff) {
    bodyScroll.appendChild(renderDiffBlock(diff, trace))
  } else if (trace.output) {
    const output = el('pre', 'tool-output')
    output.textContent = stripAnsi(trace.output)
    bodyScroll.appendChild(output)
  }
  if (bodyScroll.childNodes.length > 0) {
    bodyWrap.appendChild(bodyScroll)
    item.appendChild(bodyWrap)
  }
  return item
}

/* ---------- edit diffs ---------- */

interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

interface ToolDiff {
  lines: DiffLine[]
  added: number
  removed: number
}

const DIFF_MAX_LINES = 24

/** The harness collapses diff cards beyond nine lines. */
const CHAT_DIFF_MAX_LINES = 9

/**
 * Build a small add/remove view for tools that change file content. Real
 * hunk diffs from the main process win when present; edit_file's paired
 * old_text/new_text and write_file's full content are the legacy fallback
 * for conversations saved before diffs were persisted.
 */
function toolDiff(trace: ToolTrace): ToolDiff | null {
  if (!trace.ok) return null
  if (trace.diff && trace.diff.length > 0) {
    const lines: DiffLine[] = []
    for (const file of trace.diff) {
      file.lines.forEach((line, index) => {
        if (index > 0 || lines.length > 0) {
          if (index === 0) lines.push({ kind: 'del', text: '…' })
        }
        lines.push({ kind: line.kind, text: line.text })
      })
    }
    if (lines.length === 0) return null
    return capDiff(lines, CHAT_DIFF_MAX_LINES)
  }
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
    return capDiff(lines, DIFF_MAX_LINES)
  }
  if (trace.name === 'write_file') {
    const content = typeof trace.input.content === 'string' ? trace.input.content : null
    if (content === null) return null
    return capDiff(
      splitDiffLines(content).map((text) => ({ kind: 'add' as const, text })),
      DIFF_MAX_LINES
    )
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
function capDiff(lines: DiffLine[], maxLines: number): ToolDiff {
  // Context lines and gap markers are not removals; counting everything
  // that is not an add would overstate the removed total on hunk diffs.
  const added = lines.filter((line) => line.kind === 'add').length
  const removed = lines.filter((line) => line.kind === 'del' && !isGapLine(line)).length
  if (lines.length <= maxLines) {
    return { lines, added, removed }
  }
  const head = Math.ceil(maxLines / 2)
  const tail = maxLines - head
  const gap: DiffLine[] = [
    ...lines.slice(0, head),
    { kind: 'del', text: `… ${lines.length - maxLines} more lines` },
    ...lines.slice(lines.length - tail)
  ]
  return { lines: gap, added, removed }
}

/** Gap rows ride as del-marked separators; they are not real removals. */
function isGapLine(line: DiffLine): boolean {
  return line.text === '…' || line.text.startsWith('… ')
}

function renderDiffBlock(diff: ToolDiff, trace: ToolTrace): HTMLElement {
  const wrap = el('div', 'tool-diff')
  const head = el('div', 'diff-head')
  head.appendChild(el('span', 'diff-file', diffPath(trace)))
  const totals = el('span', 'diff-totals')
  if (diff.added > 0) totals.appendChild(el('span', 'diff-added', `+${diff.added}`))
  if (diff.removed > 0) totals.appendChild(el('span', 'diff-removed', `−${diff.removed}`))
  head.appendChild(totals)
  wrap.appendChild(head)
  for (const line of diff.lines) {
    if (line.kind === 'del' && isGapLine(line)) {
      wrap.appendChild(el('div', 'diff-gap', line.text))
      continue
    }
    wrap.appendChild(el('div', `diff-line ${line.kind}`, line.text))
  }
  return wrap
}

function diffPath(trace: ToolTrace): string {
  const path = typeof trace.input.path === 'string' ? trace.input.path : trace.diff?.[0]?.path ?? ''
  return path.split(/[\\/]/).pop() || path
}

/** The most identifying argument of a call, kept short for the row label. */
function toolArgSummary(trace: ToolTrace): string {
  const input = trace.input
  if (typeof input.patch_text === 'string' && input.patch_text.length > 0) {
    const ops = (input.patch_text.match(/^\*\*\* (?:Add|Update|Delete) File:/gm) ?? []).length
    return ops > 0 ? `${ops} file ${ops === 1 ? 'op' : 'ops'}` : 'patch'
  }
  const pick =
    (typeof input.path === 'string' && input.path) ||
    (typeof input.url === 'string' && input.url) ||
    (typeof input.command === 'string' && input.command) ||
    (typeof input.query === 'string' && `"${input.query}"`) ||
    (typeof input.pattern === 'string' && `"${input.pattern}"`) ||
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

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}
