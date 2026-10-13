import path from 'node:path'
import fs from 'node:fs'
import type { WorkspaceEntry } from '../shared/types'

let workspaceRoot: string | null = null

const IGNORED = new Set(['node_modules', '.git', 'dist', 'out'])

export function getWorkspaceRoot(): string | null {
  return workspaceRoot
}

export function setWorkspaceRoot(root: string | null): void {
  workspaceRoot = root
}

/** Resolve a workspace-relative path and make sure it stays inside the root. */
export function resolveInWorkspace(relPath: string): string {
  if (!workspaceRoot) {
    throw new Error('No workspace open')
  }
  const target = path.resolve(workspaceRoot, relPath)
  if (target !== workspaceRoot && !target.startsWith(workspaceRoot + path.sep)) {
    throw new Error('Path escapes the workspace')
  }
  return target
}

export function openWorkspaceByPath(absolutePath: string): string | null {
  try {
    const resolved = path.resolve(absolutePath)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      workspaceRoot = resolved
      return resolved
    }
  } catch {
    // fall through
  }
  return null
}

export function listDir(relPath: string): WorkspaceEntry[] {
  const target = resolveInWorkspace(relPath)
  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => !IGNORED.has(entry.name) && !entry.name.startsWith('.'))
    .map<WorkspaceEntry>((entry) => ({
      name: entry.name,
      path: relPath ? `${relPath}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file'
    }))

  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

const MAX_READ_SIZE = 1024 * 1024

export function readFileContent(relPath: string): string {
  const target = resolveInWorkspace(relPath)
  const stat = fs.statSync(target)
  if (!stat.isFile()) {
    throw new Error('Not a regular file')
  }
  if (stat.size > MAX_READ_SIZE) {
    throw new Error('File is too large to preview (max 1 MB)')
  }
  return fs.readFileSync(target, 'utf8')
}
