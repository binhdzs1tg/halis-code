import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/types'

/**
 * Command-runner terminal: every submitted line is spawned through the user's
 * shell with a persistent cwd. Not a full PTY — interactive TUIs are out of
 * scope — but build/test/git workflows work, including `cd` between runs.
 */
let cwd = os.homedir()
let child: ChildProcess | null = null
let seq = 0

/** Output bursts coalesce into one IPC message per tick instead of per chunk. */
const FLUSH_MS = 16
const COALESCE_AT = 64 * 1024
const BUFFER_CAP = 256 * 1024

export function currentCwd(): string {
  return cwd
}

function emit(win: BrowserWindow | null, channel: IpcChannel, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

/** Run one command line; resolves immediately, output streams as terminal:data. */
export function run(command: string, win: BrowserWindow | null): string {
  if (child) {
    throw new Error('A command is already running — stop it first')
  }

  const id = `term-${Date.now()}-${(seq += 1)}`
  const trimmed = command.trim()

  if (trimmed === 'cd' || trimmed.startsWith('cd ')) {
    // Deferred: emitting synchronously inside the ipcMain.handle call lets
    // terminal:exit race the invoke reply, and the renderer — which assigns
    // the run id from that reply — would drop the exit and sit on a stuck
    // "running…" status forever.
    setImmediate(() => runCd(id, trimmed, win))
    return id
  }

  const proc = spawn(trimmed, {
    shell: true,
    cwd,
    windowsHide: true,
    env: process.env,
    // Its own process group so kill() reaches the whole tree, not just the
    // shell that spawned it (a `npm run build && say done` has grandchildren).
    detached: process.platform !== 'win32'
  })
  child = proc

  // Decode at the stream level: a multi-byte character split across data
  // events would otherwise come through as two replacement characters.
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')

  // A chatty build would otherwise turn every stdout chunk into a
  // synchronous webContents.send and starve both processes; buffer and
  // drain instead, keeping the buffer itself capped for runaway output.
  let buffer = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (buffer.length === 0) return
    const event: TerminalDataEvent = { id, chunk: buffer }
    buffer = ''
    emit(win, IpcChannel.TerminalData, event)
  }
  const append = (chunk: string): void => {
    buffer += chunk
    if (buffer.length > BUFFER_CAP) {
      buffer = `… output dropped (buffer over ${BUFFER_CAP} bytes) …\n${buffer.slice(-BUFFER_CAP)}`
    }
    if (buffer.length >= COALESCE_AT) {
      flush()
      return
    }
    if (flushTimer === null) {
      flushTimer = setTimeout(flush, FLUSH_MS)
    }
  }
  const onError = (err: Error): void => {
    append(`${err.message}\n`)
    flush()
    finish(win, proc, id, 1)
  }
  const onClose = (code: number | null): void => {
    // Drain first so the exit event can never overtake buffered output.
    flush()
    finish(win, proc, id, code)
  }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)
  proc.on('error', onError)
  proc.on('close', onClose)

  return id
}

/** Signal the whole process tree of a spawned shell. */
function killTree(proc: ChildProcess): void {
  if (process.platform === 'win32') {
    if (proc.pid === undefined) return
    // A bare kill only reaches cmd.exe; taskkill walks the child tree so
    // grandchildren (npm run build -> node) go down with it.
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, 'SIGTERM')
      return
    } catch {
      // group already gone; the direct kill below is a no-op then
    }
  }
  proc.kill()
}

/** Kill the running command; returns false when nothing is running. */
export function kill(): boolean {
  if (!child) return false
  killTree(child)
  return true
}

/** Kill anything still running; called on quit so nothing outlives the app. */
export function shutdown(): void {
  if (child) killTree(child)
}

/** True while a command is in flight; the quit confirmation reports it as active work. */
export function isRunning(): boolean {
  return child !== null
}

function finish(win: BrowserWindow | null, proc: ChildProcess, id: string, code: number | null): void {
  // Events are keyed to the process, not the slot: a late event from an
  // older command must not clear a newer one's slot or report its exit.
  if (child !== proc) return
  child = null
  proc.stdout?.removeAllListeners('data')
  proc.stderr?.removeAllListeners('data')
  proc.removeAllListeners('error')
  proc.removeAllListeners('close')
  const event: TerminalExitEvent = { id, code, cwd }
  emit(win, IpcChannel.TerminalExit, event)
}

function runCd(id: string, command: string, win: BrowserWindow | null): void {
  const raw = command === 'cd' ? '' : command.slice(2).trim()
  const target = raw.length === 0 ? os.homedir() : expandHome(raw.replace(/^"(.*)"$/, '$1'))
  try {
    const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`cd: not a directory: ${target}`)
    }
    cwd = resolved
  } catch (err) {
    const event: TerminalDataEvent = {
      id,
      chunk: `${err instanceof Error ? err.message : String(err)}\n`
    }
    emit(win, IpcChannel.TerminalData, event)
    const exit: TerminalExitEvent = { id, code: 1, cwd }
    emit(win, IpcChannel.TerminalExit, exit)
    return
  }
  const exit: TerminalExitEvent = { id, code: 0, cwd }
  emit(win, IpcChannel.TerminalExit, exit)
}

function expandHome(target: string): string {
  if (target === '~' || target.startsWith('~/')) {
    return path.join(os.homedir(), target.slice(1))
  }
  return target
}
