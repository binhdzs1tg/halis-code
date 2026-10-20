import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
  const base = (name || 'root').slice(0, 80).toLowerCase()
  // The bare slug collides — `/home/u/my app`, `/home/u/my-app` and
  // `/home/u/my_app` all fold to the same name, and two projects would
  // read and overwrite each other's transcript. A short cwd hash keeps
  // distinct paths distinct.
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
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
    // tmp + rename, so a crash mid-write cannot leave a half-written file
    // behind for the next `halis -c` to choke on.
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(body, null, 1)}\n`, 'utf8')
    await rename(tmp, file)
  } catch {
    /* best effort */
  }
}

/** Drop the stored transcript for this directory — /clear uses it so the
 *  forgotten conversation stays forgotten instead of resurrecting on -c. */
export async function clearStoredSession(cwd: string): Promise<void> {
  try {
    await rm(fileFor(cwd), { force: true })
  } catch {
    /* best effort */
  }
}

/** Shape-check a parsed snapshot: a hand-edited or half-understood file
 *  must come back with sane defaults, not crash the renderer. */
function normalizeSnapshot(parsed: unknown): SessionSnapshot | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Partial<SessionSnapshot>
  if (!Array.isArray(p.messages)) return null
  const messages = p.messages.filter(
    (m): m is ChatMessage =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as ChatMessage).role === 'string' &&
      typeof (m as ChatMessage).content === 'string',
  )
  return {
    version: 2,
    cwd: typeof p.cwd === 'string' ? p.cwd : '',
    provider: typeof p.provider === 'string' ? p.provider : '',
    model: typeof p.model === 'string' ? p.model : '',
    saved: typeof p.saved === 'string' ? p.saved : '',
    ...(typeof p.title === 'string' && p.title.length > 0 ? { title: p.title } : {}),
    usage: {
      input: Number.isFinite(p.usage?.input) ? Number(p.usage?.input) : 0,
      output: Number.isFinite(p.usage?.output) ? Number(p.usage?.output) : 0,
    },
    messages,
  }
}

export async function loadLatestSession(cwd: string): Promise<SessionSnapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(fileFor(cwd), 'utf8'))
    return normalizeSnapshot(parsed)
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
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return normalizeSnapshot(parsed)
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
