import { app, BrowserWindow } from 'electron'
import { createMainWindow, focusMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { refresh as refreshModels } from './models-dev/catalog'
import { requestQuit, isQuitting } from './quit'

const gotLock = app.requestSingleInstanceLock()
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

  app.whenReady().then(() => {
    registerIpcHandlers()
    createMainWindow()

    // Warm up the model catalog; errors are handled inside the service.
    void refreshModels()

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
}
