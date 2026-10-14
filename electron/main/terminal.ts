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
    runCd(id, trimmed, win)
    return id
  }

  const proc = spawn(trimmed, {
    shell: true,
    cwd,
    windowsHide: true,
    env: process.env
  })
  child = proc

  const append = (chunk: Buffer): void => {
    const event: TerminalDataEvent = { id, chunk: chunk.toString('utf8') }
    emit(win, IpcChannel.TerminalData, event)
  }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)

  proc.on('error', (err) => {
    append(Buffer.from(`${err.message}\n`))
    finish(win, id, 1)
  })
  proc.on('close', (code) => {
    finish(win, id, code)
  })

  return id
}

/** Kill the running command; returns false when nothing is running. */
export function kill(): boolean {
  if (!child) return false
  child.kill()
  return true
}

function finish(win: BrowserWindow | null, id: string, code: number | null): void {
  if (child) {
    child = null
    const event: TerminalExitEvent = { id, code, cwd }
    emit(win, IpcChannel.TerminalExit, event)
  }
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
