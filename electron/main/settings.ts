/**
 * Local shell settings, loaded once per process. Read-once with validation:
 * a broken document falls back to the defaults instead of blocking startup,
 * and absent fields keep whatever the user already has on disk.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSettings, CommandApprovalMode } from '../shared/types'

export interface ShellSettings extends AgentSettings {
  /** Closing the window hides it to the tray instead of quitting (Windows/Linux). */
  closeToTray: boolean
}

function defaults(): ShellSettings {
  return { closeToTray: process.platform !== 'darwin', commandApproval: 'ask' }
}

function approvalMode(value: unknown, fallback: CommandApprovalMode): CommandApprovalMode {
  return value === 'ask' || value === 'fullAccess' ? value : fallback
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let current: ShellSettings | null = null
let settingsPath: string | null = null

/** Read `userData/settings.json`, creating the default document when missing. */
export function initShellSettings(userData: string): ShellSettings {
  const path = join(userData, 'settings.json')
  settingsPath = path
  const fallback = defaults()
  try {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(userData, { recursive: true, mode: 0o700 })
      try {
        writeFileSync(path, `${JSON.stringify(fallback, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      } catch (writeError) {
        // An existing document belongs to the user; only a truly missing one is created.
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
      }
      raw = readFileSync(path, 'utf8')
    }
    const value: unknown = JSON.parse(raw)
    if (!record(value)) {
      throw new Error('expected a JSON object')
    }
    if (value.closeToTray !== undefined && typeof value.closeToTray !== 'boolean') {
      throw new Error('closeToTray must be true or false')
    }
    current = {
      closeToTray: value.closeToTray ?? fallback.closeToTray,
      commandApproval: approvalMode(value.commandApproval, fallback.commandApproval)
    }
    return current
  } catch (error) {
    console.warn(`shell settings: ${path}: using defaults because settings could not be loaded`, error)
    current = fallback
    return current
  }
}

/** Settings of the running process; defaults before `initShellSettings` ran. */
export function shellSettings(): ShellSettings {
  return current ?? defaults()
}

/** Patch and persist settings; the process reads the new values right away. */
export function updateShellSettings(patch: Partial<AgentSettings>): ShellSettings {
  const base = current ?? defaults()
  const next: ShellSettings = {
    ...base,
    commandApproval: patch.commandApproval
      ? approvalMode(patch.commandApproval, base.commandApproval)
      : base.commandApproval
  }
  current = next
  if (settingsPath) {
    try {
      writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      console.warn('shell settings: the change applies to this session but could not be saved', error)
    }
  }
  return next
}
