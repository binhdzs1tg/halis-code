import type { AppInfo } from '../../electron/shared/types'
import type { ModelSelection } from '../../electron/shared/models'

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'error'
export type RailTab = 'files' | 'search' | 'editor' | 'terminal'

/** A workspace file the agent or the user just changed. */
export interface TouchedFile {
  path: string
  seq: number
  /** Mirrors WorkspaceChangedEvent.change when the main process reports it. */
  change?: 'write' | 'create' | 'rename' | 'delete'
  /** Previous path, only set for renames. */
  from?: string
}

export interface AppState {
  appInfo: AppInfo | null
  workspaceRoot: string | null
  /** Left column: session list, expanded or collapsed. */
  sidebarVisible: boolean
  /** Right column: the workspace rail (files/search/editor/terminal). */
  railVisible: boolean
  railTab: RailTab
  /** Bumped whenever sessions change so the sidebar list can repaint. */
  sessionsVersion: number
  /** Tabs in the editor, in order. */
  openFiles: string[]
  /** Active tab. */
  openFile: string | null
  /** Line to reveal when the active file opens (search result jumps). */
  openFileLine: number | null
  agentStatus: AgentStatus
  selectedModel: ModelSelection | null
  lastTouchedFile: TouchedFile | null
}

type Listener = (state: AppState, prev: AppState) => void

function initialState(): AppState {
  return {
    appInfo: null,
    workspaceRoot: null,
    sidebarVisible: true,
    railVisible: true,
    railTab: 'files',
    sessionsVersion: 0,
    openFiles: [],
    openFile: null,
    openFileLine: null,
    agentStatus: 'idle',
    selectedModel: null,
    lastTouchedFile: null
  }
}

class Store {
  private state: AppState = initialState()
  private listeners = new Set<Listener>()
  /** Guards the notification pass against re-entrant update() calls. */
  private notifying = false
  private queued: Partial<AppState>[] = []

  get(): AppState {
    return this.state
  }

  update(patch: Partial<AppState>): void {
    if (this.notifying) {
      // A listener is reacting mid-pass; a nested update here would hand
      // listeners later in the set a mismatched (state, prev) pair. Defer
      // it until the current pass has drained.
      this.queued.push(patch)
      return
    }
    this.notifying = true
    try {
      this.apply(patch)
      while (this.queued.length > 0) {
        const next = this.queued.shift()
        if (next === undefined) break
        this.apply(next)
      }
    } finally {
      this.notifying = false
      this.queued = []
    }
  }

  private apply(patch: Partial<AppState>): void {
    const prev = this.state
    this.state = { ...prev, ...patch }
    // Snapshot: listeners may subscribe/unsubscribe during the pass.
    for (const listener of [...this.listeners]) {
      listener(this.state, prev)
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const store = new Store()
