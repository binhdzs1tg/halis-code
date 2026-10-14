import type { AppInfo } from '../../electron/shared/types'
import type { ModelSelection } from '../../electron/shared/models'

export type SidebarView = 'explorer' | 'search' | 'settings'
export type AgentStatus = 'idle' | 'thinking' | 'working' | 'error'

/** A workspace file the agent just created or modified. */
export interface TouchedFile {
  path: string
  seq: number
}

export interface AppState {
  appInfo: AppInfo | null
  workspaceRoot: string | null
  sidebarView: SidebarView
  sidebarVisible: boolean
  chatOpen: boolean
  terminalOpen: boolean
  openFile: string | null
  agentStatus: AgentStatus
  selectedModel: ModelSelection | null
  lastTouchedFile: TouchedFile | null
}

type Listener = (state: AppState, prev: AppState) => void

function initialState(): AppState {
  return {
    appInfo: null,
    workspaceRoot: null,
    sidebarView: 'explorer',
    sidebarVisible: true,
    chatOpen: true,
    terminalOpen: false,
    openFile: null,
    agentStatus: 'idle',
    selectedModel: null,
    lastTouchedFile: null
  }
}

class Store {
  private state: AppState = initialState()
  private listeners = new Set<Listener>()

  get(): AppState {
    return this.state
  }

  update(patch: Partial<AppState>): void {
    const prev = this.state
    this.state = { ...prev, ...patch }
    for (const listener of this.listeners) {
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
