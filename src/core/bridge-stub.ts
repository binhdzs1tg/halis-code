import type { HalisApi } from '../../electron/shared/api'

/**
 * Inert stand-in for the preload bridge, installed when the renderer starts
 * without one (the bundle opened in a plain browser, say for CSS work).
 * Without it, the first `window.halis` access throws inside `boot()` and the
 * splash screen never clears — the opposite of "keep going with defaults".
 *
 * Invocations settle the way a cancelled/empty session would (null, empty
 * list, false) so the UI degrades quietly; the ones with no such natural
 * answer reject with a clear message that existing call sites already
 * surface. Subscriptions accept a listener and return an unsubscribe no-op.
 */
export function installBridgeStub(): void {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('The Halis bridge is not available in this environment.'))
  const noop = (): void => undefined
  const listener = (): (() => void) => (): void => undefined

  const api: HalisApi = {
    getInfo: unavailable,
    minimize: noop,
    maximize: noop,
    close: noop,
    onWindowState: listener,

    pickWorkspace: () => Promise.resolve(null),
    openWorkspace: unavailable,
    readDir: () => Promise.resolve([]),
    readFile: unavailable,
    writeFile: unavailable,
    createEntry: unavailable,
    renameEntry: unavailable,
    deleteEntry: unavailable,
    searchWorkspace: () => Promise.resolve({ hits: [], truncated: false }),

    runTerminalCommand: unavailable,
    killTerminalCommand: () => Promise.resolve(false),
    onTerminalData: listener,
    onTerminalExit: listener,

    getModels: unavailable,
    refreshModels: unavailable,
    onModelsUpdated: listener,

    sendChat: unavailable,
    cancelChat: noop,
    compactConversation: unavailable,
    onChatDelta: listener,
    onChatDone: listener,
    onChatError: listener,
    onChatTool: listener,
    onChatTodo: listener,
    onChatNotice: listener,
    onJobNotice: listener,
    onApprovalRequest: listener,
    respondApproval: noop,
    onUserQuestion: listener,
    respondUserQuestion: noop,
    onWorkspaceChanged: listener,

    getAgentSettings: unavailable,
    setAgentSettings: unavailable,
    exportConversation: () => Promise.resolve(null),

    getKeyStatuses: unavailable,
    setProviderKey: unavailable,
    removeProviderKey: unavailable,
    onKeysChanged: listener,

    listSessions: () => Promise.resolve([]),
    loadSession: unavailable,
    saveSession: unavailable,
    generateSessionTitle: unavailable,
    deleteSession: unavailable,
    onMenuCommand: listener
  }

  Object.defineProperty(window, 'halis', { value: api, configurable: true })
}
