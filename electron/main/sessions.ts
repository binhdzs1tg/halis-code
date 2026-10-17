/**
 * Chat session persistence: every conversation is a JSON document under
 * `userData/sessions`, listed by recency and pruned to a bounded set.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ChatMessage, ChatSession, ChatSessionMeta, TodoItem } from '../shared/types'

const SESSION_ID = /^s-\d+-\d+$/
const MAX_SESSIONS = 50
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_MESSAGES = 2_000

let seq = 0

function sessionsDir(): string {
  return join(app.getPath('userData'), 'sessions')
}

/** Only generated ids pass; anything else is a traversal attempt. */
function safeId(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readSessionFile(path: string): ChatSession | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const value: unknown = JSON.parse(raw)
    if (!record(value)) return null
    const messages = sanitizeMessages(value.messages)
    if (messages.length === 0) return null
    return {
      id: safeId(value.id),
      title: optString(value.title)?.slice(0, 120) ?? 'Chat',
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      workspaceRoot: optString(value.workspaceRoot),
      model: isSelection(value.model)
        ? {
            providerID: value.model.providerID,
            modelID: value.model.modelID,
            ...(typeof value.model.variant === 'string' ? { variant: value.model.variant } : {})
          }
        : null,
      messages
    }
  } catch {
    return null
  }
}

function isSelection(value: unknown): value is { providerID: string; modelID: string; variant?: string } {
  return (
    record(value) &&
    typeof value.providerID === 'string' &&
    typeof value.modelID === 'string' &&
    (value.variant === undefined || typeof value.variant === 'string')
  )
}

/** Drop anything that is not a usable message instead of rejecting the file. */
function sanitizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return []
  const out: ChatMessage[] = []
  for (const item of value.slice(-MAX_MESSAGES)) {
    if (!record(item)) continue
    if (
      typeof item.id !== 'string' ||
      (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') ||
      typeof item.content !== 'string' ||
      typeof item.createdAt !== 'number'
    ) {
      continue
    }
    const message: ChatMessage = {
      id: item.id.slice(0, 64),
      role: item.role,
      content: item.content,
      createdAt: item.createdAt
    }
    if (Array.isArray(item.tools)) {
      message.tools = item.tools.filter(record).map((tool) => ({
        name: typeof tool.name === 'string' ? tool.name : 'tool',
        input: record(tool.input) ? tool.input : {},
        output: typeof tool.output === 'string' ? tool.output : '',
        ok: tool.ok !== false,
        durationMs: typeof tool.durationMs === 'number' ? tool.durationMs : 0,
        // Hunk diffs are optional; sanitizeShapes keeps replay faithful.
        ...(Array.isArray(tool.diff)
          ? {
              diff: tool.diff
                  .filter((diff: unknown) => record(diff) && typeof (diff as { path?: unknown }).path === 'string')
                  .map((diff: unknown) => {
                    const entry = diff as {
                      path?: string
                      op?: unknown
                      lines?: unknown
                      added?: unknown
                      removed?: unknown
                    }
                    return {
                      path: typeof entry.path === 'string' ? entry.path : '',
                      op: entry.op === 'create' ? ('create' as const) : ('update' as const),
                      lines: Array.isArray(entry.lines)
                        ? entry.lines
                            .filter((line: unknown) => record(line))
                            .map((line: unknown) => {
                              const info = line as { kind?: unknown; text?: unknown }
                              return {
                                kind:
                                  info.kind === 'add' || info.kind === 'del' || info.kind === 'ctx'
                                    ? info.kind
                                    : 'ctx',
                                text: typeof info.text === 'string' ? info.text : ''
                              }
                            })
                        : [],
                      added: typeof entry.added === 'number' ? entry.added : 0,
                      removed: typeof entry.removed === 'number' ? entry.removed : 0
                    }
                  })
            }
          : {})
      }))
    }
    if (Array.isArray(item.todos)) {
      const todos: TodoItem[] = []
      for (const raw of item.todos) {
        if (!record(raw) || typeof raw.content !== 'string' || raw.content.length === 0) continue
        const status: TodoItem['status'] =
          raw.status === 'completed' ? 'completed' : raw.status === 'in_progress' ? 'in_progress' : 'pending'
        todos.push({ content: raw.content, status })
      }
      message.todos = todos
    }
    out.push(message)
  }
  return out
}

/** Save one session; assigns the id on first save and prunes old files. */
export function saveSession(raw: unknown): ChatSessionMeta {
  const value = record(raw) ? raw : {}
  const data = value as Record<string, unknown>
  const existing = safeId(data.id)
  const messages = sanitizeMessages(data.messages)
  if (messages.length === 0) {
    throw new Error('sessions:save expects at least one message')
  }

  const id = existing ?? `s-${Date.now()}-${(seq += 1)}`
  const session: ChatSession = {
    id,
    title: optString(data.title)?.trim().slice(0, 120) || 'Chat',
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
    updatedAt: Date.now(),
    workspaceRoot: optString(data.workspaceRoot),
    model: isSelection(data.model)
      ? {
          providerID: data.model.providerID,
          modelID: data.model.modelID,
          ...(typeof data.model.variant === 'string' ? { variant: data.model.variant } : {})
        }
      : null,
    messages
  }

  const directory = sessionsDir()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${id}.json`)
  const payload = JSON.stringify(session, null, 2)
  if (Buffer.byteLength(payload) > MAX_FILE_BYTES) {
    throw new Error('This chat has grown too large to save.')
  }
  // Write through a temp file and rename over the target: a crash or full
  // disk mid-write must never leave a half-written session behind, and a
  // truncated file would not just vanish from the list — the next prune
  // would delete it for good.
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, payload, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // nothing more to clean up
    }
    throw err
  }
  pruneSessions(directory)
  return {
    id,
    title: session.title,
    updatedAt: session.updatedAt,
    messageCount: messages.length
  }
}

/** Keep the newest MAX_SESSIONS files, judged by the timestamps inside them. */
function pruneSessions(directory: string): void {
  const entries: Array<{ file: string; updatedAt: number }> = []
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) continue
    if (file.endsWith('.json.tmp')) {
      // Saves are synchronous, so a leftover temp file means a crashed
      // write — no reader wants it, sweep it.
      try {
        rmSync(join(directory, file), { force: true })
      } catch {
        // best effort
      }
      continue
    }
    const session = readSessionFile(join(directory, file))
    if (session) {
      entries.push({ file, updatedAt: session.updatedAt })
    } else {
      // A file we cannot read has no value; drop it so the folder stays clean.
      try {
        rmSync(join(directory, file))
      } catch {
        // best effort
      }
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  for (const entry of entries.slice(MAX_SESSIONS)) {
    try {
      rmSync(join(directory, entry.file))
    } catch {
      // best effort
    }
  }
}

/** Session summaries, newest first. */
export function listSessions(): ChatSessionMeta[] {
  const directory = sessionsDir()
  let files: string[]
  try {
    files = readdirSync(directory)
  } catch {
    return []
  }
  const metas: ChatSessionMeta[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const session = readSessionFile(join(directory, file))
    if (session?.id) {
      metas.push({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt || session.createdAt,
        messageCount: session.messages.length
      })
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Load one session by id; unknown or broken ids throw so the UI can report. */
export function loadSession(id: unknown): ChatSession {
  const safe = safeId(id)
  if (!safe) {
    throw new Error('sessions:load expects a valid session id')
  }
  const session = readSessionFile(join(sessionsDir(), `${safe}.json`))
  if (!session || session.id !== safe) {
    throw new Error('That chat no longer exists.')
  }
  return session
}

/** Delete one session; a missing file is already the desired state. */
export function deleteSession(id: unknown): void {
  const safe = safeId(id)
  if (!safe) {
    throw new Error('sessions:delete expects a valid session id')
  }
  try {
    rmSync(join(sessionsDir(), `${safe}.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}
