import type { AppInfo, WorkspaceEntry } from './types'

/**
 * Contract of the `window.halis` bridge exposed by the preload script.
 * Kept in shared/ so the renderer can type it without importing electron.
 */
export interface HalisApi {
  getInfo(): Promise<AppInfo>
  minimize(): void
  maximize(): void
  close(): void

  pickWorkspace(): Promise<string | null>
  openWorkspace(absolutePath: string): Promise<string | null>
  readDir(relPath: string): Promise<WorkspaceEntry[]>
  readFile(relPath: string): Promise<string>
}
