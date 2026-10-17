/**
 * Context menu for the main window: undo/redo/cut/copy/paste/select-all built
 * from the webContents editFlags for editable fields, copy-only for text
 * selections, plus an open-in-browser entry for links. Items are added only
 * when they can do something, so the popup never shows dead entries.
 */
import { clipboard, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const editable = params.isEditable
    const hasSelection = params.selectionText.trim().length > 0
    if (!editable && !hasSelection && !params.linkURL) return

    const flags = params.editFlags
    const items: MenuItemConstructorOptions[] = []

    if (editable) {
      items.push(
        { label: 'Undo', role: 'undo', enabled: flags.canUndo, accelerator: '' },
        { label: 'Redo', role: 'redo', enabled: flags.canRedo, accelerator: '' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: flags.canCut, accelerator: '' },
        {
          label: 'Paste',
          role: 'paste',
          enabled: flags.canPaste,
          accelerator: ''
        },
        { label: 'Paste and match style', role: 'pasteAndMatchStyle', enabled: flags.canPaste, accelerator: '' }
      )
    }

    if (hasSelection) {
      items.push(
        { label: 'Copy', role: 'copy', enabled: flags.canCopy, accelerator: '' },
        { label: 'Search the web for “%s”', visible: false }
      )
    } else if (editable) {
      items.push(
        { label: 'Select all', role: 'selectAll', enabled: flags.canSelectAll, accelerator: '' }
      )
    }

    if (params.linkURL && /^https?:\/\//.test(params.linkURL)) {
      items.push(
        { type: 'separator' },
        {
          label: 'Open link in browser',
          click: (): void => {
            void shell.openExternal(params.linkURL)
          }
        },
        {
          label: 'Copy link address',
          click: (): void => {
            clipboard.writeText(params.linkURL)
          }
        }
      )
    }

    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window: win })
  })
}
