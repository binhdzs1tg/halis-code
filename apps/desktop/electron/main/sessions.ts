/**
 * Chat session persistence: every conversation is a JSON document under
 * `userData/sessions`, listed by recency and pruned to a bounded set.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

type SessionRead = { kind: 'ok'; session: ChatSession } | { kind: 'malformed' } | { kind: 'unreadable' }

/**
 * Tri-state on purpose: a file that will not parse is garbage worth
 * sweeping, but a file that merely fails to read right now (EIO, EBUSY on
 * Windows, a syncing folder mid-transfer) is a conversation the user
 * expects to keep — pruning must never turn a transient read failure into
 * a permanent deletion.
 */
function readSessionFile(path: string): SessionRead {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'unreadable' }
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value)) return { kind: 'malformed' }
    const messages = sanitizeMessages(value.messages)
    if (messages.length === 0) return { kind: 'malformed' }
    return {
      kind: 'ok',
      session: {
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
    }
  } catch {
    return { kind: 'malformed' }
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

/** Keep the newest MAX_SESSIONS files, judged by mtime. Every save rewrites
 *  its file, so mtime tracks recency without parsing up to 50 × 8 MB
 *  documents on the main thread after every message — the full re-parse
 *  used to stall the ui for seconds on long histories. Malformed files no
 *  longer get swept here; they age out with the mtime order and listSessions
 *  skips them. */
function pruneSessions(directory: string): void {
  let files: string[]
  try {
    files = readdirSync(directory)
  } catch {
    return
  }
  const candidates: Array<{ file: string; mtime: number }> = []
  for (const file of files) {
    const full = join(directory, file)
    if (file.endsWith('.json.tmp')) {
      // Saves are synchronous, so a leftover temp file means a crashed
      // write — no reader wants it, sweep it.
      try {
        rmSync(full, { force: true })
      } catch {
        // best effort
      }
      continue
    }
    if (!file.endsWith('.json')) continue
    try {
      candidates.push({ file, mtime: statSync(full).mtimeMs })
    } catch {
      // vanished mid-listing — nothing to prune
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const entry of candidates.slice(MAX_SESSIONS)) {
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
    const read = readSessionFile(join(directory, file))
    if (read.kind === 'ok' && read.session.id) {
      metas.push({
        id: read.session.id,
        title: read.session.title,
        updatedAt: read.session.updatedAt || read.session.createdAt,
        messageCount: read.session.messages.length
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
  const read = readSessionFile(join(sessionsDir(), `${safe}.json`))
  if (read.kind !== 'ok' || read.session.id !== safe) {
    throw new Error('That chat no longer exists.')
  }
  return read.session
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
