import type {
  AppInfo,
  ProviderKeyStatuses,
  WorkspaceEntry
} from './types'
import type { ModelCatalog } from './models'

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

  /** Full models.dev catalog (providers + models), normalized. */
  getModels(): Promise<ModelCatalog>
  /** Re-fetch the catalog from upstream immediately. */
  refreshModels(): Promise<ModelCatalog>
  /** Fired on the renderer whenever the catalog changes in the main process. */
  onModelsUpdated(listener: () => void): () => void

  /** Providers that currently have a key, either from the vault or the env. */
  getKeyStatuses(): Promise<ProviderKeyStatuses>
  setProviderKey(providerId: string, value: string): Promise<ProviderKeyStatuses>
  removeProviderKey(providerId: string): Promise<ProviderKeyStatuses>
  /** Fired whenever a vault key is added or removed. */
  onKeysChanged(listener: () => void): () => void
}
