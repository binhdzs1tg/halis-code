/**
 * Window bounds persistence: the last size, position and maximized flag are
 * saved when the window closes and restored on the next launch. Read-once
 * with validation, so a broken or off-screen document falls back to the
 * defaults instead of trapping the window outside every connected display.
 */
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface WindowState {
  width: number
  height: number
  x: number | null
  y: number | null
  maximized: boolean
}

const DEFAULT_WIDTH = 1320
const DEFAULT_HEIGHT = 860

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function sanitize(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const width = Number(raw.width)
  const height = Number(raw.height)
  if (!Number.isFinite(width) || width < 500 || width > 20_000) return null
  if (!Number.isFinite(height) || height < 400 || height > 20_000) return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  return {
    width: Math.round(width),
    height: Math.round(height),
    x: Number.isFinite(x) ? Math.round(x) : null,
    y: Number.isFinite(y) ? Math.round(y) : null,
    maximized: raw.maximized === true
  }
}

/** Saved state when it is readable and plausible; defaults otherwise. */
export function loadWindowState(): WindowState {
  const fallback: WindowState = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: null,
    y: null,
    maximized: false
  }
  try {
    const parsed = sanitize(JSON.parse(readFileSync(statePath(), 'utf8')))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** Persist the normal (non-maximized) bounds; called on window close. */
export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  let bounds: Rectangle
  try {
    bounds = win.getNormalBounds()
  } catch {
    return
  }
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: win.isMaximized()
  }
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    console.warn('shell: window state could not be saved', error)
  }
}

/**
 * Keep a restored position only when it is still reachable — a monitor that
 * was unplugged since the last run must not push the window off every screen.
 */
function positionIsVisible(state: WindowState): boolean {
  if (state.x === null || state.y === null) return false
  const corner = { x: state.x + 80, y: state.y + 80 }
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      corner.x >= area.x &&
      corner.y >= area.y &&
      corner.x < area.x + area.width &&
      corner.y < area.y + area.height
    )
  })
}

/** Constructor options for `createMainWindow` plus the maximized flag it restores. */
export interface RestoredBounds {
  options: Partial<Electron.BrowserWindowConstructorOptions>
  maximized: boolean
}

/** Options for `createMainWindow` derived from the saved state. */
export function windowBoundsOptions(): RestoredBounds {
  const state = loadWindowState()
  if (state.x === null || state.y === null || !positionIsVisible(state)) {
    return { options: { width: state.width, height: state.height }, maximized: state.maximized }
  }
  return {
    options: { width: state.width, height: state.height, x: state.x, y: state.y },
    maximized: state.maximized
  }
}
