/**
 * Native application menu. On macOS it fixes the usual frameless-app gaps
 * (Edit roles, About panel); on Windows/Linux it adds the File and Help
 * entries. DevTools toggles ship as hidden menu items so the accelerators
 * keep working in packaged builds.
 */
import { app, BrowserWindow, Menu, dialog, type MenuItemConstructorOptions } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'

export type MenuCommand = 'open-workspace' | 'toggle-sidebar' | 'toggle-terminal' | 'toggle-chat'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(IpcChannel.MenuCommand, command)
  }
}

function toggleDevTools(): void {
  const win = BrowserWindow.getFocusedWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.toggleDevTools()
  }
}

function showAbout(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: 'About Halis Code',
    message: 'Halis Code',
    detail: `A desktop coding agent.\n\nVersion ${app.getVersion()}\nElectron ${process.versions.electron ?? '?'}\nNode ${process.versions.node ?? '?'}`,
    buttons: ['OK']
  })
}

const isMac = process.platform === 'darwin'

export function installApplicationMenu(): void {
  const devToolsItems: MenuItemConstructorOptions[] = [
    {
      label: 'Toggle Developer Tools',
      accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => toggleDevTools()
    },
    {
      label: 'Toggle Developer Tools (F12)',
      accelerator: 'F12',
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => toggleDevTools()
    }
  ]

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    { label: 'Toggle Sidebar', click: () => send('toggle-sidebar') },
    { label: 'Toggle Terminal', click: () => send('toggle-terminal') },
    { label: 'Toggle Agent', click: () => send('toggle-chat') },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    ...devToolsItems
  ]

  const template: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        },
        {
          label: 'File',
          submenu: [{ label: 'Open Workspace…', click: () => send('open-workspace') }]
        },
        { role: 'editMenu' },
        { label: 'View', submenu: viewSubmenu },
        { role: 'windowMenu' }
      ]
    : [
        {
          label: 'File',
          submenu: [
            { label: 'Open Workspace…', click: () => send('open-workspace') },
            { type: 'separator' },
            { role: 'quit' }
          ]
        },
        { role: 'editMenu' },
        { label: 'View', submenu: viewSubmenu },
        {
          label: 'Help',
          submenu: [{ label: 'About Halis Code', click: () => showAbout() }]
        }
      ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  if (isMac) {
    app.setAboutPanelOptions({
      applicationName: 'Halis Code',
      applicationVersion: app.getVersion(),
      credits: 'A desktop coding agent.'
    })
  }
}
