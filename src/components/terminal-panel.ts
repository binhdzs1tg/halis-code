import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import { AnsiWriter } from '../core/ansi'
import type { TerminalExitEvent } from '../../electron/shared/types'

/** Keep the scrollback bounded so long builds don't grow the DOM forever. */
const MAX_OUT_CHARS = 400_000
const MAX_OUT_LINES = 2_000

/**
 * Working command terminal. Each submitted line spawns through the user's
 * shell in the main process with a persistent cwd; output streams back as
 * `terminal:data` events. Interactive TUIs are out of scope, but cd, build,
 * test and git workflows all behave.
 */
export function mountTerminalPanel(): HTMLElement {
  const panel = el('section', 'terminal-panel')

  // ---- toolbar ----
  const header = el('div', 'term-toolbar')

  const statusHint = el('span', 'tab-hint', 'idle')
  header.appendChild(statusHint)

  const clearBtn = el('button', 'icon-btn') as HTMLButtonElement
  clearBtn.type = 'button'
  clearBtn.title = 'Clear terminal (Ctrl+L)'
  clearBtn.appendChild(svg(icons.trash, 14))
  header.appendChild(clearBtn)

  const dismiss = el('button', 'icon-btn') as HTMLButtonElement
  dismiss.type = 'button'
  dismiss.title = 'Close panel'
  dismiss.appendChild(svg(icons.close, 14))
  header.appendChild(dismiss)

  // ---- body ----
  const body = el('div', 'term-body')
  const out = el('div', 'term-out')
  // Styled output: ANSI colors from build tools render instead of leaking
  // raw escape bytes; the writer also trims the scrollback when capped.
  const writer = new AnsiWriter(out)
  const inputRow = el('div', 'term-input-row')

  const prompt = el('span', 'prompt')
  const input = el('input', 'term-input') as HTMLInputElement
  input.spellcheck = false
  input.autocapitalize = 'off'
  input.autocomplete = 'off'
  input.placeholder = 'Run a command…'

  inputRow.append(prompt, input)
  body.append(out, inputRow)
  panel.append(header, body)

  // ---- state ----
  let cwd: string | null = null
  let busy = false
  let currentRunId: string | null = null
  /** True between submit and the invoke reply that assigns the run id. */
  let pendingStart = false
  const history: string[] = []
  let historyIndex = -1

  const shortCwd = (value: string): string => {
    const segments = value.replace(/[\\/]+$/, '').split(/[\\/]/)
    return segments[segments.length - 1] || value
  }

  const paintPrompt = (): void => {
    if (cwd) {
      prompt.textContent = shortCwd(cwd)
      prompt.title = cwd
    } else {
      prompt.textContent = '~'
      prompt.title = ''
    }
  }

  const scrollToEnd = (): void => {
    // Snap to the bottom only when the user is already there; otherwise a
    // streaming command yanks the viewport down while they read an error
    // further up.
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight
    if (distance < 48) {
      body.scrollTop = body.scrollHeight
    }
  }

  const appendText = (text: string): void => {
    writer.write(text)
    writer.trim(MAX_OUT_CHARS)
    scrollToEnd()
  }

  const echo = (command: string): void => {
    const line = el('div', 'line')
    line.dataset.echo = 'true'
    const mark = el('span', 'prompt', prompt.textContent ? `${prompt.textContent} $ ` : '$ ')
    line.append(mark, document.createTextNode(command))
    out.appendChild(line)
    // Echo bytes never enter `written`, so when the line cap forces a removal
    // only adjust the writer's counter for writer-owned nodes.
    while (out.childElementCount > MAX_OUT_LINES) {
      const first = out.firstChild
      if (!first) break
      const isEcho = first instanceof HTMLElement && first.dataset.echo === 'true'
      if (!isEcho) {
        const removed = (first.textContent ?? '').length
        writer.written = Math.max(0, writer.written - removed)
      }
      first.remove()
    }
    scrollToEnd()
  }

  const setStatus = (text: string): void => {
    statusHint.textContent = text
  }

  const clearOut = (): void => {
    writer.reset()
  }

  const run = async (command: string): Promise<void> => {
    if (busy) return
    echo(command)
    if (command.trim() === 'clear') {
      clearOut()
      return
    }
    busy = true
    pendingStart = true
    setStatus('running…')
    try {
      currentRunId = await window.halis.runTerminalCommand(command)
    } catch (err) {
      appendText(`${err instanceof Error ? err.message : String(err)}\n`)
      busy = false
      currentRunId = null
      setStatus('idle')
    } finally {
      pendingStart = false
    }
  }

  const stop = (): void => {
    if (!busy) return
    appendText('^C\n')
    void window.halis.killTerminalCommand()
  }

  // ---- events ----
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // An IME composition commit arrives as Enter — never submit through it.
      if (event.isComposing) return
      event.preventDefault()
      const command = input.value.trim()
      if (!command) return
      if (busy) return // the text stays; the running command owns the terminal
      input.value = ''
      history.push(command)
      historyIndex = history.length
      void run(command)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (history.length === 0) return
      historyIndex = Math.max(0, historyIndex - 1)
      input.value = history[historyIndex] ?? ''
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (history.length === 0) return
      historyIndex = Math.min(history.length, historyIndex + 1)
      input.value = history[historyIndex] ?? ''
      return
    }
    if (event.key === 'c' && event.ctrlKey) {
      event.preventDefault()
      stop()
      return
    }
    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault()
      clearOut()
    }
  })

  clearBtn.addEventListener('click', () => {
    clearOut()
    input.focus()
  })
  dismiss.addEventListener('click', () => {
    store.update({ railTab: 'files' })
  })

  body.addEventListener('click', (event) => {
    // don't steal the caret when the user is selecting output
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) return
    if (event.target === input) return
    input.focus()
  })

  window.halis.onTerminalData((event) => {
    if (event.id !== currentRunId) return
    appendText(event.chunk)
  })

  window.halis.onTerminalExit((event: TerminalExitEvent) => {
    // While the invoke reply is still in flight, an exit event can only
    // belong to the command we just spawned — accepting it here is what
    // keeps a synchronous `cd` from wedging the panel on a stuck status.
    if (event.id !== currentRunId && !(pendingStart && currentRunId === null)) return
    busy = false
    currentRunId = null
    if (typeof event.code === 'number' && event.code !== 0) {
      setStatus(`exit ${event.code}`)
      window.setTimeout(() => {
        if (!busy) setStatus('idle')
      }, 2500)
    } else {
      setStatus('idle')
    }
    if (event.cwd) {
      cwd = event.cwd
      paintPrompt()
    }
    if (store.get().railTab === 'terminal') {
      // Focus only when the user was already here — a finished build must
      // not yank the caret out of the chat composer mid-run.
      const active = document.activeElement
      const inside = active instanceof Node && panel.contains(active)
      if (inside || active === document.body || active === null) {
        input.focus()
      }
    }
  })

  // Follow the workspace: jump the shell to the newly opened folder.
  store.subscribe((state, prev) => {
    if (state.railTab === 'terminal' && prev.railTab !== 'terminal') {
      input.focus()
    }
    if (state.workspaceRoot && state.workspaceRoot !== prev.workspaceRoot && !busy) {
      // No quoting: main-side `cd` is parsed in JS, not by a shell, so the
      // raw path (spaces included) is exactly what the parser wants.
      void window.halis
        .runTerminalCommand(`cd ${state.workspaceRoot}`)
        .catch(() => undefined)
    }
  })

  paintPrompt()
  return panel
}
