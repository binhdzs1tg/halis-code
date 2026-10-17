/**
 * Minimal MCP client, ported from codex's connection set and opencode's
 * transport handling: servers declared in ~/.halis/mcp.json run as child
 * processes speaking newline-delimited JSON-RPC 2.0, and their tools join
 * the agent's list as mcp__<server>__<tool>. Only the user-level file is
 * read — a workspace copy would let the agent grant itself commands.
 * Connections persist for the app's lifetime and are diffed against the
 * config on every agent run. Pure Node, no Electron imports.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { ToolSpec } from '../../shared/types'
import { getWorkspaceRoot } from '../workspace'

/** The legacy handshake both sources default to. */
const PROTOCOL_VERSION = '2025-06-18'
/** Tool names carry this prefix, codex-style. */
export const MCP_TOOL_PREFIX = 'mcp__'

const STARTUP_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 30_000
const DEFAULT_TOOL_TIMEOUT_MS = 120_000
const MAX_TOOL_TIMEOUT_MS = 300_000
/** Frames beyond this are protocol violations, not slow tools. */
const MAX_LINE_CHARS = 8 * 1024 * 1024
const MAX_LIST_PAGES = 100
const MAX_TOOLS_PER_SERVER = 256
const STDERR_TAIL_CHARS = 2_000
/** A server that failed to start is left alone for this long before retrying. */
const FAILED_RETRY_MS = 2 * 60_000

/* ---------- config ---------- */

export interface McpServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
  toolTimeoutMs: number
}

export interface McpConfigParse {
  servers: Record<string, McpServerConfig>
  /** Human-readable complaints; they surface as tool-output errors, never crashes. */
  errors: string[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === 'string')
}

function clampToolTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TOOL_TIMEOUT_MS
  return Math.min(Math.max(Math.round(value), 1_000), MAX_TOOL_TIMEOUT_MS)
}

/**
 * Parse the `mcpServers` object. Unknown keys are ignored so a server's
 * newer config still loads; a bad entry is reported and skipped rather
 * than taking the whole catalog down with it.
 */
export function parseMcpConfig(raw: unknown): McpConfigParse {
  const out: McpConfigParse = { servers: {}, errors: [] }
  if (raw === null || raw === undefined) return out
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    out.errors.push('mcp.json must contain a JSON object')
    return out
  }
  const root = raw as Record<string, unknown>
  const declared = root.mcpServers
  if (declared === undefined) {
    out.errors.push('mcp.json needs an "mcpServers" object')
    return out
  }
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    out.errors.push('"mcpServers" must be an object')
    return out
  }
  for (const [name, value] of Object.entries(declared)) {
    if (!name.trim()) continue
    if (typeof value !== 'object' || value === null) {
      out.errors.push(`${name}: must be an object`)
      continue
    }
    const entry = value as Record<string, unknown>
    if (entry.disabled === true) continue
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (!command) {
      out.errors.push(`${name}: "command" must be a non-empty string`)
      continue
    }
    if (entry.args !== undefined && !isStringArray(entry.args)) {
      out.errors.push(`${name}: "args" must be an array of strings`)
      continue
    }
    if (entry.env !== undefined && !isStringMap(entry.env)) {
      out.errors.push(`${name}: "env" must map names to string values`)
      continue
    }
    out.servers[name] = {
      command,
      args: entry.args ?? [],
      env: entry.env ?? {},
      toolTimeoutMs: clampToolTimeout(entry.toolTimeoutMs)
    }
  }
  return out
}

/** Providers only accept [a-zA-Z0-9_-]; codex folds everything else to _. */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || '_'
}

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeMcpName(server)}__${sanitizeMcpName(tool)}`
}

/* ---------- result flattening ---------- */

/**
 * Flatten a tools/call result into model-usable text: text blocks are
 * joined, binary blocks are counted rather than carried, unknown blocks
 * keep their raw JSON (codex does the same). `structuredContent`, when
 * present, rides along as a fenced JSON block.
 */
export function flattenMcpContent(result: unknown): { text: string; isError: boolean } {
  if (typeof result !== 'object' || result === null) return { text: '', isError: false }
  const record = result as { content?: unknown; isError?: unknown; structuredContent?: unknown }
  const blocks = Array.isArray(record.content) ? record.content : []
  const texts: string[] = []
  let binary = 0
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as {
      type?: unknown
      text?: unknown
      uri?: unknown
      resource?: { text?: unknown } | null
    }
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text)
    } else if (b.type === 'resource_link' && typeof b.uri === 'string') {
      texts.push(`resource: ${b.uri}`)
    } else if (b.type === 'resource' && typeof b.resource === 'object' && b.resource !== null) {
      if (typeof b.resource.text === 'string') texts.push(b.resource.text)
      else binary += 1
    } else if (b.type === 'image' || b.type === 'audio') {
      binary += 1
    } else {
      texts.push(JSON.stringify(block))
    }
  }
  if (binary > 0) texts.push(`[${binary} binary block${binary === 1 ? '' : 's'} omitted]`)
  if (record.structuredContent !== undefined && record.structuredContent !== null) {
    texts.push(['```json', JSON.stringify(record.structuredContent, null, 2), '```'].join('\n'))
  }
  return { text: texts.join('\n').trim(), isError: record.isError === true }
}

/* ---------- connection ---------- */

interface McpToolEntry {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

function parseToolEntry(item: unknown): McpToolEntry | null {
  if (typeof item !== 'object' || item === null) return null
  const entry = item as { name?: unknown; description?: unknown; inputSchema?: unknown }
  if (typeof entry.name !== 'string' || !entry.name.trim()) return null
  const schema =
    typeof entry.inputSchema === 'object' && entry.inputSchema !== null && !Array.isArray(entry.inputSchema)
      ? (entry.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} }
  return {
    name: entry.name,
    description: typeof entry.description === 'string' ? entry.description : '',
    inputSchema: schema
  }
}

export class McpConnection {
  readonly serverName: string
  /** Kept public so the registry can diff configs without a second map. */
  readonly config: McpServerConfig
  private child: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private tools: McpToolEntry[] = []
  private stderrTail = ''
  private closed = false

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName
    this.config = config
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Spawn the process, run the handshake and list the tools. */
  async start(): Promise<void> {
    const cwd = getWorkspaceRoot() ?? undefined
    this.child = spawn(this.config.command, this.config.args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    const { stdin, stdout, stderr } = this.child
    if (!stdin || !stdout || !stderr) {
      throw new Error(`${this.serverName}: could not open pipes to the server`)
    }
    stdout.setEncoding('utf8')
    const lines = readline.createInterface({ input: stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.onLine(line))
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    this.child.once('close', () => this.die())
    this.child.once('error', (err) => this.die(err))

    const init = await this.request<{ capabilities?: unknown }>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'halis-code', version: '0.1.0' }
    }, STARTUP_TIMEOUT_MS)
    this.notify('notifications/initialized')
    // opencode skips tools/list when the capability is absent — some servers
    // answer it with an error anyway.
    const capabilities = init?.capabilities
    if (typeof capabilities !== 'object' || capabilities === null || !('tools' in capabilities)) {
      this.tools = []
      return
    }
    await this.refreshTools()
  }

  listTools(): McpToolEntry[] {
    return this.tools
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await this.request<{ content?: unknown; isError?: unknown; structuredContent?: unknown }>(
      'tools/call',
      { name, arguments: args },
      this.config.toolTimeoutMs
    )
    return flattenMcpContent(result)
  }

  /** Stop the server's whole process tree, escalating after a grace period. */
  stop(): void {
    if (this.closed) return
    this.closed = true
    const child = this.child
    this.child = null
    this.failPending(new Error(`${this.serverName}: server stopped`))
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      if (child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
      return
    }
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill()
      }
    } else {
      child.kill()
    }
    const pid = child.pid
    const escalation = setTimeout(() => {
      try {
        if (pid !== undefined) process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill()
      }
    }, 2_000)
    escalation.unref()
    child.once('close', () => clearTimeout(escalation))
  }

  private die(err?: Error): void {
    if (this.closed) return
    this.closed = true
    this.child = null
    const detail = err
      ? err.message
      : this.stderrTail.trim()
        ? `server exited unexpectedly — ${this.stderrTail.trim()}`
        : 'server exited unexpectedly'
    this.failPending(new Error(`${this.serverName}: ${detail}`))
  }

  private failPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  private onLine(line: string): void {
    if (line.length > MAX_LINE_CHARS) {
      this.die(new Error(`${this.serverName}: oversized JSON-RPC frame`))
      return
    }
    const trimmed = line.trim()
    if (!trimmed) return
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch {
      return // servers are free to print noise on stdout; ignore it
    }
    if (typeof message !== 'object' || message === null) return
    const record = message as { id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown }
    if (typeof record.id === 'number') {
      const pending = this.pending.get(record.id)
      if (pending) {
        this.pending.delete(record.id)
        clearTimeout(pending.timer)
        if (record.error !== undefined) {
          pending.reject(
            new Error(`${this.serverName}: ${String(record.error.message ?? 'request failed')}`)
          )
        } else {
          pending.resolve(record.result)
        }
      }
      return
    }
    if (record.method === 'notifications/tools/list_changed') {
      void this.refreshTools().catch(() => {})
    }
  }

  /** Paginated tools/list with the repeated-cursor guard codex carries. */
  private async refreshTools(): Promise<void> {
    const tools: McpToolEntry[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await this.request<{ tools?: unknown; nextCursor?: unknown }>(
        'tools/list',
        cursor === undefined ? {} : { cursor },
        LIST_TIMEOUT_MS
      )
      const list = Array.isArray(result?.tools) ? result.tools : []
      for (const item of list) {
        const entry = parseToolEntry(item)
        if (entry) tools.push(entry)
        if (tools.length >= MAX_TOOLS_PER_SERVER) break
      }
      if (tools.length >= MAX_TOOLS_PER_SERVER) break
      const next = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined
      if (!next || seenCursors.has(next)) break
      seenCursors.add(next)
      cursor = next
    }
    this.tools = tools
  }

  private request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin
      if (this.closed || !stdin || stdin.destroyed) {
        reject(new Error(`${this.serverName}: server is not running`))
        return
      }
      const id = this.nextId
      this.nextId += 1
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.serverName}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
        timer
      })
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      stdin.write(`${frame}\n`, (err) => {
        if (!err) return
        const pending = this.pending.get(id)
        if (pending) {
          this.pending.delete(id)
          clearTimeout(timer)
          pending.reject(new Error(`${this.serverName}: could not write to the server (${err.message})`))
        }
      })
    })
  }

  private notify(method: string): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }
}

/* ---------- registry ---------- */

const connections = new Map<string, McpConnection>()
const failedAt = new Map<string, number>()
/** Full tool name -> where it lives; rebuilt whenever connections change. */
const toolIndex = new Map<string, { connection: McpConnection; tool: McpToolEntry }>()
let configFile: string | null = path.join(os.homedir(), '.halis', 'mcp.json')
let lastErrors: string[] = []
let syncing: Promise<void> | null = null

/** Test seam: point the loader at a temp file, or disable it entirely. */
export function setMcpConfigFileForTests(file: string | null): void {
  configFile = file
}

export function mcpConfigErrors(): string[] {
  return [...lastErrors]
}

export function mcpConnectionCount(): number {
  let count = 0
  for (const [, connection] of connections) {
    if (!connection.isClosed) count += 1
  }
  return count
}

/**
 * Bring the live connections in line with the config: unchanged servers
 * keep running, removed or edited ones are stopped, new ones start. A
 * server that failed to start recently is not retried on every turn —
 * npx cold starts are slow enough to notice.
 */
export async function syncMcpServers(): Promise<void> {
  if (syncing) return syncing
  const run = async (): Promise<void> => {
    let raw: unknown = null
    if (configFile && fs.existsSync(configFile)) {
      try {
        raw = JSON.parse(fs.readFileSync(configFile, 'utf8')) as unknown
      } catch (err) {
        lastErrors = [`mcp.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]
        return
      }
    }
    const parsed = parseMcpConfig(raw)
    lastErrors = parsed.errors
    const desired = new Map(Object.entries(parsed.servers))
    for (const [name, connection] of connections) {
      const want = desired.get(name)
      if (!want || JSON.stringify(connection.config) !== JSON.stringify(want) || connection.isClosed) {
        connection.stop()
        connections.delete(name)
      }
    }
    for (const [name, config] of desired) {
      if (connections.has(name)) continue
      const failed = failedAt.get(name)
      if (failed !== undefined && Date.now() - failed < FAILED_RETRY_MS) continue
      const connection = new McpConnection(name, config)
      connections.set(name, connection)
      try {
        await connection.start()
        failedAt.delete(name)
      } catch (err) {
        connection.stop()
        connections.delete(name)
        failedAt.set(name, Date.now())
        lastErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    rebuildToolIndex()
  }
  syncing = run()
    .catch(() => {})
    .finally(() => {
      syncing = null
    })
  return syncing
}

/** The configs are carried by the connections themselves; the diff reads them directly. */

function rebuildToolIndex(): void {
  toolIndex.clear()
  for (const [name, connection] of connections) {
    if (connection.isClosed) continue
    for (const tool of connection.listTools()) {
      const toolName = mcpToolName(name, tool.name)
      if (toolIndex.has(toolName)) {
        lastErrors.push(`tool name collision on ${toolName}; the later server loses`)
        continue
      }
      toolIndex.set(toolName, { connection, tool })
    }
  }
}

/** Tool specs for the model, prefixed with the server so it knows the source. */
export function mcpToolSpecs(): ToolSpec[] {
  const specs: ToolSpec[] = []
  for (const [toolName, entry] of toolIndex) {
    if (entry.connection.isClosed) continue
    specs.push({
      name: toolName,
      description: `[${entry.connection.serverName}] ${entry.tool.description || 'external tool'}`.trim(),
      parameters: entry.tool.inputSchema
    })
  }
  return specs
}

/** The input schema of one MCP tool, for the argument-repair pass. */
export function mcpSchemaFor(toolName: string): Record<string, unknown> | null {
  const entry = toolIndex.get(toolName)
  if (!entry || entry.connection.isClosed) return null
  return entry.tool.inputSchema
}

export function stopAllMcpServers(): void {
  for (const [, connection] of connections) {
    connection.stop()
  }
  connections.clear()
  toolIndex.clear()
}

/** Call one MCP tool by its full mcp__server__tool name. */
export async function callMcpTool(
  name: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; output: string }> {
  const entry = toolIndex.get(name)
  if (!entry || entry.connection.isClosed) {
    return { ok: false, output: `MCP tool "${name}" is not available — its server may have stopped.` }
  }
  try {
    const { text, isError } = await entry.connection.call(entry.tool.name, input)
    if (isError) return { ok: false, output: text || 'The tool reported an error.' }
    return { ok: true, output: text || '(no output)' }
  } catch (err) {
    return { ok: false, output: `MCP call failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
