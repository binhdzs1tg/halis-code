import { app, BrowserWindow, powerMonitor } from 'electron'
import path from 'node:path'
import { createMainWindow, focusMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { refresh as refreshModels } from './models-dev/catalog'
import { requestQuit, isQuitting, markSessionEnding } from './quit'
import { initShellSettings } from './settings'
import { createTray, destroyTray } from './tray'
import { installApplicationMenu } from './menu'
import { installCrashHandlers, markRunning } from './crash'
import { applyLoginShellEnvironment } from './login-shell-env'
import { shutdown as shutdownTerminals } from './terminal'
import { configureSpillStore } from './agent/spill'
import { configureJobStore, stopAllJobs } from './agent/jobs'
import { stopAllMcpServers, syncMcpServers } from './agent/mcp'

const gotLock = app.requestSingleInstanceLock()
installCrashHandlers()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
  })

  // Every quit entry funnels through here, so a running agent or terminal
  // command is always confirmed before the process goes away.
  app.on('before-quit', (event) => {
    if (isQuitting()) return
    event.preventDefault()
    requestQuit()
  })

  initShellSettings(app.getPath('userData'))
  // Oversized tool output spills here instead of being lost to truncation.
  configureSpillStore(app.getPath('userData'))
  // Background command jobs keep their output files here.
  configureJobStore(app.getPath('userData'))
  // MCP servers from ~/.halis/mcp.json come up now so their tools are
  // listed before the first chat turn pays for the handshake.
  void syncMcpServers()

  // Terminal and agent spawns read `process.env` per command, so merging the
  // login shell env late is harmless — everything started afterwards benefits.
  void applyLoginShellEnvironment()

  app.whenReady().then(() => {
    // OS shutdowns quit without the confirmation prompt.
    powerMonitor.on('shutdown', markSessionEnding)

    installApplicationMenu()
    registerIpcHandlers()
    createMainWindow()

    if (process.platform !== 'darwin') {
      createTray(path.join(app.getAppPath(), 'resources', 'tray.png'))
    }

    // Warm up the model catalog; a cold snapshot keeps the app usable when
    // the network (or the upstream payload) misbehaves.
    void refreshModels().catch((err) => {
      console.warn('[models-dev] warm-up failed:', err instanceof Error ? err.message : err)
    })

    const [win] = BrowserWindow.getAllWindows()
    // Not `once`: a reload after a failed first load must move the crash
    // phase out of `startup` too.
    win?.webContents.on('did-finish-load', () => markRunning())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    // Orphaned shells outlive the window otherwise; the quit dialog promised
    // quitting would interrupt them — the job spawns are detached, so they
    // need an explicit kill just like the terminals do.
    shutdownTerminals()
    stopAllJobs()
    stopAllMcpServers()
    destroyTray()
  })
}
