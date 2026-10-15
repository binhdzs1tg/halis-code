import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import { AnsiWriter } from '../core/ansi'
import type { TerminalExitEvent } from '../../electron/shared/types'

/** Keep the scrollback bounded so long builds don't grow the DOM forever. */
const MAX_OUT_CHARS = 400_000

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
    body.scrollTop = body.scrollHeight
  }

  const appendText = (text: string): void => {
    writer.write(text)
    writer.trim(MAX_OUT_CHARS)
    scrollToEnd()
  }

  const echo = (command: string): void => {
    const line = el('div', 'line')
    const mark = el('span', 'prompt', prompt.textContent ? `${prompt.textContent} $ ` : '$ ')
    line.append(mark, document.createTextNode(command))
    out.appendChild(line)
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
    setStatus('running…')
    try {
      currentRunId = await window.halis.runTerminalCommand(command)
    } catch (err) {
      appendText(`${err instanceof Error ? err.message : String(err)}\n`)
      busy = false
      currentRunId = null
      setStatus('idle')
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
      event.preventDefault()
      const command = input.value.trim()
      if (!command) return
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
    if (event.id !== currentRunId) return
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
      input.focus()
    }
  })

  // Follow the workspace: jump the shell to the newly opened folder.
  store.subscribe((state, prev) => {
    if (state.railTab === 'terminal' && prev.railTab !== 'terminal') {
      input.focus()
    }
    if (state.workspaceRoot && state.workspaceRoot !== prev.workspaceRoot && !busy) {
      void window.halis
        .runTerminalCommand(`cd "${state.workspaceRoot}"`)
        .catch(() => undefined)
    }
  })

  paintPrompt()
  return panel
}
