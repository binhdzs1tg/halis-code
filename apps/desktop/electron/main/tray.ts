/**
 * System tray for Windows and Linux: the always-present way back to a hidden
 * window and the explicit quit entry. The icon stays present for the whole
 * run, not only while the window is hidden.
 */
import { Menu, Tray, nativeImage } from 'electron'
import { requestQuit } from './quit'
import { showMainWindow } from './window'

let tray: Tray | null = null

/** Create the tray icon once; later calls are no-ops. */
export function createTray(iconPath: string): void {
  if (tray) return
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)
  tray.setToolTip('Halis Code')
  tray.on('click', () => {
    showMainWindow()
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Halis Code', click: () => showMainWindow() },
      { type: 'separator' },
      // Runs through the same quit confirmation as every other quit entry.
      { label: 'Quit Halis Code', click: () => requestQuit() }
    ])
  )
}

/** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
export function destroyTray(): void {
  const current = tray
  tray = null
  current?.destroy()
}
