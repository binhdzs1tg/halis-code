import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatMessage } from '@halis/core'

/**
 * One resume file per working directory: `~/.halis/sessions/<slug>.json`.
 * `halis -c` reads it back so a terminal restart does not cost the whole
 * conversation. Only the model-visible transcript is stored — the ui redraws
 * its own history from scratch.
 */
export interface SessionSnapshot {
  version: 1
  cwd: string
  provider: string
  model: string
  saved: string
  usage: { input: number; output: number }
  messages: ChatMessage[]
}

function sessionsDir(): string {
  return process.env.HALIS_SESSIONS ?? path.join(os.homedir(), '.halis', 'sessions')
}

function slug(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (name || 'root').slice(0, 96).toLowerCase()
}

function fileFor(cwd: string): string {
  return path.join(sessionsDir(), `${slug(cwd)}.json`)
}

/** Persist the transcript; storage trouble never kills the session. */
export async function saveSession(snapshot: Omit<SessionSnapshot, 'version' | 'saved'>): Promise<void> {
  try {
    const file = fileFor(snapshot.cwd)
    await mkdir(path.dirname(file), { recursive: true })
    const body: SessionSnapshot = { ...snapshot, version: 1, saved: new Date().toISOString() }
    await writeFile(file, `${JSON.stringify(body, null, 1)}\n`, 'utf8')
  } catch {
    /* best effort */
  }
}

export async function loadLatestSession(cwd: string): Promise<SessionSnapshot | null> {
  try {
    const raw = await readFile(fileFor(cwd), 'utf8')
    const parsed = JSON.parse(raw) as SessionSnapshot
    if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}
