import { BrowserWindow, app, dialog, nativeImage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { isQuitting, markSessionEnding, clearSessionEnding } from './quit'
import { IpcChannel } from '../shared/ipc-channels'
import { shellSettings } from './settings'
import { saveWindowState, windowBoundsOptions } from './window-state'
import { attachWindowDiagnostics } from './crash'

const DIST = path.join(__dirname, '..')
const RESOURCES = path.join(app.getAppPath(), 'resources')

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...windowBoundsOptions(),
    minWidth: 960,
    minHeight: 620,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0e1014',
    title: 'Halis Code',
    icon: path.join(RESOURCES, 'icon.png'),
    webPreferences: {
      preload: path.join(DIST, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  win.setMenuBarVisibility(false)

  // Renderer console errors, crashed render processes and failed loads all
  // land in the crash-report pipeline instead of vanishing silently.
  attachWindowDiagnostics(win)

  // Windows: 'session-end' is the shutdown notification on the window itself;
  // it does not count as a real close, so it only flags the quit path.
  if (process.platform === 'win32') {
    win.on('session-end', markSessionEnding)
  }
  // macOS power-off can be cancelled; when the user backs out, the next
  // window focus restores the normal quit confirmation.
  win.on('focus', clearSessionEnding)

  // Maximize and fullscreen changes are pushed so the renderer's titlebar
  // button reflects the real state, including changes made from the OS.
  const pushWindowState = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.WindowState, win.isMaximized() || win.isFullScreen())
    }
  }
  win.on('maximize', pushWindowState)
  win.on('unmaximize', pushWindowState)
  win.on('enter-full-screen', pushWindowState)
  win.on('leave-full-screen', pushWindowState)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Closing the window keeps the app alive in the tray (Windows/Linux) so
  // running tasks continue; the confirmation explains that on the first hide.
  win.on('close', (event) => {
    if (isQuitting() || process.platform === 'darwin') {
      saveWindowState(win)
      return
    }
    if (!shellSettings().closeToTray) return
    event.preventDefault()
    void hideToTray(win)
  })

  // Dev server hook for later hot-reload tooling.
  const devUrl = process.env.HALIS_DEV_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(DIST, 'renderer', 'index.html'))
  }

  return win
}

/** Show and focus the primary window, restoring it from tray or taskbar first. */
export function showMainWindow(): void {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) {
    createMainWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

// Keep the old name working for the second-instance handler.
export const focusMainWindow = showMainWindow

async function hideToTray(win: BrowserWindow): Promise<void> {
  if (!backgroundCloseConfirmed()) {
    const confirmed = await askBackgroundClose(win)
    if (!confirmed) return
    markBackgroundCloseConfirmed()
  }
  if (!win.isDestroyed()) {
    win.hide()
  }
}

/* ---------- one-time background-close notice (Windows parity with Harness) ---------- */

const MARKER = 'background-close-confirmed'

function markerPath(): string {
  return path.join(app.getPath('userData'), MARKER)
}

function backgroundCloseConfirmed(): boolean {
  try {
    return fs.existsSync(markerPath())
  } catch {
    return false
  }
}

function markBackgroundCloseConfirmed(): void {
  try {
    fs.writeFileSync(markerPath(), new Date().toISOString(), { mode: 0o600 })
  } catch (error) {
    console.warn('shell: background-close marker could not be written', error)
  }
}

async function askBackgroundClose(win: BrowserWindow): Promise<boolean> {
  const result = await dialog.showMessageBox(win, {
    type: 'info',
    icon: nativeImage.createFromPath(path.join(RESOURCES, 'icon.png')),
    title: 'Halis Code',
    message: 'Close the window?',
    detail:
      'Halis Code keeps running in the system tray. ' +
      'Running tasks continue, and the tray icon brings the window back.',
    buttons: ['Hide to tray', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return result.response === 0
}
