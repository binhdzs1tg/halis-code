import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatMessage } from '@halis/core'

/**
 * One resume file per working directory: `~/.halis/sessions/<slug>.json`.
 * `halis -c` reads it back so a terminal restart does not cost the whole
 * conversation, and the picker lists them with the titles the model (or
 * the user, via /title) gave them. Only the model-visible transcript is
 * stored — the ui redraws its own history from scratch.
 */
export interface SessionSnapshot {
  version: 1 | 2
  cwd: string
  provider: string
  model: string
  saved: string
  /** Session title, set by the model's auto-namer or /title. */
  title?: string
  usage: { input: number; output: number }
  messages: ChatMessage[]
}

export interface SessionEntry {
  file: string
  cwd: string
  title: string
  model: string
  saved: string
}

function sessionsDir(): string {
  return process.env.HALIS_SESSIONS ?? path.join(process.env.HALIS_HOME ?? os.homedir(), '.halis', 'sessions')
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
    const body: SessionSnapshot = { ...snapshot, version: 2, saved: new Date().toISOString() }
    await writeFile(file, `${JSON.stringify(body, null, 1)}\n`, 'utf8')
  } catch {
    /* best effort */
  }
}

export async function loadLatestSession(cwd: string): Promise<SessionSnapshot | null> {
  try {
    const raw = await readFile(fileFor(cwd), 'utf8')
    const parsed = JSON.parse(raw) as SessionSnapshot
    if (!Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}

function parseSnapshot(file: string, raw: string): SessionEntry | null {
  try {
    const parsed = JSON.parse(raw) as SessionSnapshot
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null
    const firstUser = parsed.messages.find((m) => m.role === 'user')?.content ?? ''
    return {
      file,
      cwd: parsed.cwd ?? '',
      title: parsed.title || (firstUser.split('\n')[0] ?? '').slice(0, 60) || 'untitled',
      model: parsed.model ?? '',
      saved: parsed.saved ?? '',
    }
  } catch {
    return null
  }
}

/** Every session on disk, newest first — the resume picker's rows. */
export async function listSessions(): Promise<SessionEntry[]> {
  let names: string[] = []
  try {
    names = await readdir(sessionsDir())
  } catch {
    return []
  }
  const entries: SessionEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(sessionsDir(), name)
    try {
      const entry = parseSnapshot(file, await readFile(file, 'utf8'))
      if (entry) entries.push(entry)
    } catch {
      // unreadable — skip
    }
  }
  return entries.sort((a, b) => b.saved.localeCompare(a.saved))
}

export async function loadSessionFile(file: string): Promise<SessionSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as SessionSnapshot
    if (!Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}

/** Turn a transcript into the markdown export /export writes out. */
export function transcriptToMarkdown(snapshot: { cwd: string; model: string; saved: string; messages: ChatMessage[] }): string {
  const lines = [
    `# halis session — ${snapshot.cwd}`,
    '',
    `- model: ${snapshot.model}`,
    `- saved: ${snapshot.saved}`,
    '',
  ]
  for (const message of snapshot.messages) {
    if (message.role === 'user') {
      lines.push(`## ❯ user`, '', message.content, '')
    } else if (message.role === 'assistant') {
      if (message.content) lines.push(`**halis**`, '', message.content, '')
      for (const call of message.toolCalls ?? []) {
        lines.push(`- tool: \`${call.name}\` \`${JSON.stringify(call.input).slice(0, 120)}\``)
      }
      if (message.toolCalls?.length) lines.push('')
    }
  }
  return lines.join('\n')
}
