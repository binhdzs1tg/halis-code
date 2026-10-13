import { app, BrowserWindow } from 'electron'
import { createMainWindow, focusMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { refresh as refreshModels } from './models-dev/catalog'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
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
