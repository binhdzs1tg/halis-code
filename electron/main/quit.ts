/**
 * Native quit confirmation: quitting proceeds silently only when nothing is
 * running that a quit would interrupt. One decision at a time; repeated
 * quit requests join the open dialog instead of stacking a second one.
 */
import { app, dialog } from 'electron'
import * as terminal from './terminal'
import { activeRuns } from './agent/run'

/** What the user would interrupt by quitting now; empty when nothing runs. */
function describeActiveWork(): string[] {
  const notes: string[] = []
  const runs = activeRuns()
  if (runs > 0) {
    notes.push(
      runs === 1
        ? 'The agent is still working on a reply. Quitting now interrupts it.'
        : `${runs} agent runs are still working. Quitting now interrupts them.`
    )
  }
  if (terminal.isRunning()) {
    notes.push('A terminal command is still running. Quitting now interrupts it.')
  }
  return notes
}

let pending: Promise<boolean> | null = null

/** Set while the OS is shutting down; quit prompts are skipped entirely. */
let sessionEnding = false

/**
 * Mark an in-progress OS shutdown (powerMonitor 'shutdown', or the Windows
 * 'session-end' window event). Shutting down is not the moment to hold the
 * process hostage for a confirmation, so the next quit goes straight through.
 * A cancelled macOS power-off clears the flag on the next
 * window focus.
 */
export function markSessionEnding(): void {
  sessionEnding = true
}

export function clearSessionEnding(): void {
  sessionEnding = false
}

/**
 * Decide whether the quit may proceed. The inspection runs once per decision;
 * work that starts or ends while the dialog is open does not change its copy,
 * and approval never re-inspects.
 */
export function confirmQuit(): Promise<boolean> {
  if (pending) {
    return pending
  }
  pending = decide().finally(() => {
    pending = null
  })
  return pending
}

async function decide(): Promise<boolean> {
  const busy = describeActiveWork()
  if (busy.length === 0) {
    return true
  }
  // Button order follows each platform: macOS lays buttons out right-to-left
  // from index 0, so "Quit" sits right of "Cancel"; the Windows task dialog
  // keeps array order, "Quit" left of "Cancel".
  const windows = process.platform === 'win32'
  const result = await dialog.showMessageBox({
    type: windows ? 'none' : 'warning',
    title: 'Halis Code',
    message: 'Quit Halis Code?',
    detail: busy.join('\n'),
    buttons: ['Quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return result.response === 0
}

/** Set once a quit is confirmed so later close/quit paths pass through. */
let quitting = false

export function isQuitting(): boolean {
  return quitting
}

export function markQuitting(): void {
  quitting = true
}

/** Interceptable quit entry: asks once, then lets the quit through. */
export function requestQuit(): void {
  if (sessionEnding) {
    // The OS owns this shutdown; prompting would only risk data loss when
    // the deadline kills the process anyway.
    markQuitting()
    app.quit()
    return
  }
  void confirmQuit().then((ok) => {
    if (!ok) {
      return
    }
    markQuitting()
    app.quit()
  }).catch(() => {
    // The confirmation could not be shown; staying open is the safe answer.
  })
}
