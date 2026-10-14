import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { createMainWindow, focusMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { refresh as refreshModels } from './models-dev/catalog'
import { requestQuit, isQuitting } from './quit'
import { initShellSettings } from './settings'
import { createTray, destroyTray } from './tray'
import { installApplicationMenu } from './menu'
import { installCrashHandlers, markRunning } from './crash'
import { applyLoginShellEnvironment } from './login-shell-env'

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

  // Terminal and agent spawns read `process.env` per command, so merging the
  // login shell env late is harmless — everything started afterwards benefits.
  void applyLoginShellEnvironment()

  app.whenReady().then(() => {
    installApplicationMenu()
    registerIpcHandlers()
    createMainWindow()

    if (process.platform !== 'darwin') {
      createTray(path.join(app.getAppPath(), 'resources', 'tray.png'))
    }

    // Warm up the model catalog; errors are handled inside the service.
    void refreshModels()

    const [win] = BrowserWindow.getAllWindows()
    win?.webContents.once('did-finish-load', () => markRunning())

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
    destroyTray()
  })
}
