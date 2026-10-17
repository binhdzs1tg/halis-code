import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolCall, ToolSpec, TodoItem, FileDiff, UserQuestionOption } from '../../shared/types'
import {
  getWorkspaceRoot,
  listDir,
  readFileContent,
  resolveInWorkspace,
  searchWorkspace
} from '../workspace'
import { fileDiff } from './diff'
import { denialText } from './approval'
import { SKILL_TOOL_NAME, SKILL_TOOL_SPEC, runSkillTool } from './skills'
import { GLOB_TOOL_SPEC, globTool } from './glob'
import { GREP_TOOL_SPEC, grepTool } from './grep'
import { WEB_FETCH_TOOL_SPEC, webFetchTool } from './web-fetch'
import { WEB_SEARCH_TOOL_SPEC, webSearchTool } from './web-search'
import { PATCH_TOOL_SPEC, runPatchTool } from './patch'
import { TASK_TOOL_SPEC } from './subagent'
import { applyEditText } from './edit-text'
import { repairToolInput } from './tool-input-repair'
import { readSpill, saveSpill, truncateLongLines } from './spill'
import { assertEditable, observeRead, recordWrite } from './observation'
import {
  activateJob,
  allocateJob,
  COMMAND_ENV,
  jobStatus,
  killJob,
  releaseJob,
  startBackgroundJob,
  tailChars
} from './jobs'

/** What a single tool invocation produced. `changedPath` marks mutations the UI should refresh. */
export interface ToolOutcome {
  ok: boolean
  output: string
  changedPath?: string
  /** Every mutated path, for tools that touch several files at once. */
  changedPaths?: string[]
  /** Hunk diffs for tools that changed file content. */
  diff?: FileDiff[]
}

/** Hook the run loop installs so flagged commands can ask the user. */
export interface ToolHooks {
  /** Resolve to 'allowed-once' or 'rejected' for a flagged command line. */
  requestApproval(command: string, callId: string): Promise<'allowed-once' | 'rejected'>
  /** Resolve to the user's answers, or null when the question goes unanswered. */
  requestUserQuestion(question: string, options: UserQuestionOption[], multiple: boolean, callId: string): Promise<string[] | null>
}

/** Tool results are fed back into the model, so keep them within a sane budget. */
const MAX_OUTPUT = 24_000
/** Characters preserved from the tail when the budget overflows. */
const CLAMP_TAIL = 2_048
const MAX_READ_LINES = 1_200
const MAX_COMMAND_OUTPUT = 1_000_000
const DEFAULT_COMMAND_TIMEOUT = 60_000
const MAX_COMMAND_TIMEOUT = 300_000
/** Background jobs may run this long when the model asks for a timeout at all. */
const MAX_BACKGROUND_TIMEOUT = 24 * 60 * 60_000

export function toolSpecs(): ToolSpec[] {
  return [
    {
      name: 'list_dir',
      description:
        'List the entries of a directory in the workspace. Returns folders first, ' +
        'skipping node_modules, dotfiles and build output.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root.' }
        }
      }
    },
    {
      name: 'read_file',
      description:
        'Read a text file from the workspace. Use offset/limit for long files; ' +
        'the tail tells you how many lines remain. Oversized tool output is ' +
        'saved under the tool-output store; read those files back by their ' +
        'absolute path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root' },
          offset: { type: 'integer', description: '1-based line to start reading from' },
          limit: { type: 'integer', description: `Maximum number of lines to return (default ${MAX_READ_LINES})` }
        },
        required: ['path']
      }
    },
    {
      name: 'write_file',
      description: 'Create a file (with any missing parent folders) or overwrite it with new content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root' },
          content: { type: 'string', description: 'Full new content of the file' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'edit_file',
      description:
        'Replace text in a file: old_text must match exactly (including ' +
        'whitespace) and appear exactly once — include surrounding lines if it ' +
        'is ambiguous. An empty new_text deletes the passage. Pass ' +
        'replace_all=true to swap every occurrence of a repeated snippet. ' +
        'When the exact text is not found, a forgiving match that ignores ' +
        'trailing whitespace and typographic quotes is tried once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root' },
          old_text: { type: 'string', description: 'Exact text to replace' },
          new_text: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match (default false)' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    },
    {
      name: 'search',
      description:
        'Search for a text fragment across the workspace (or a subfolder) and get matching ' +
        'lines as path:line: text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for' },
          path: { type: 'string', description: 'Folder to search in, relative to the root. Defaults to the whole workspace.' },
          case_sensitive: { type: 'boolean', description: 'Match case exactly (default false)' }
        },
        required: ['query']
      }
    },
    GLOB_TOOL_SPEC,
    GREP_TOOL_SPEC,
    WEB_FETCH_TOOL_SPEC,
    WEB_SEARCH_TOOL_SPEC,
    PATCH_TOOL_SPEC,
    {
      name: 'ask_user',
      description:
        'Ask the user one question with 2-8 concrete options (and an optional ' +
        'free-text answer). Use it only when the next step truly needs their ' +
        'call — ambiguity about intent, a destructive trade-off, or missing ' +
        'information no tool can find. For everything else, decide and report. ' +
        'A skipped question means proceed with your best judgment and say so.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, phrased so options make sense' },
          options: {
            type: 'array',
            description: 'Two to eight answer options, most likely first',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short answer text' },
                description: { type: 'string', description: 'One-line hint for when to pick this' }
              },
              required: ['label']
            }
          },
          multiple: { type: 'boolean', description: 'Allow choosing several options (default false)' }
        },
        required: ['question', 'options']
      }
    },
    {
      name: 'run_command',
      description:
        'Run a shell command in the workspace root (build, test, git, …). ' +
        'stdout and stderr are combined; long output keeps its head and tail ' +
        'inline and spills the rest to a file you can read back. Commands that ' +
        'look destructive are shown to the user for approval first; a denied ' +
        'command is a final refusal — do not retry it another way. Pass ' +
        'run_in_background for dev servers, watchers and long builds: it ' +
        'returns at once, you get a completion notice later, and job_output ' +
        'and job_kill work on the running command meanwhile.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to execute' },
          timeout_ms: {
            type: 'integer',
            description: `Timeout in milliseconds (default ${DEFAULT_COMMAND_TIMEOUT}, max ${MAX_COMMAND_TIMEOUT}); a timed-out command keeps running as a background job`
          },
          run_in_background: {
            type: 'boolean',
            description: 'Start the command in the background and return immediately (default false)'
          }
        },
        required: ['command']
      }
    },
    {
      name: 'job_output',
      description:
        'Read the current output and status of a background command. Works ' +
        'while it runs and after it settles; the tail of the output is ' +
        'included, and the full stream stays readable in the job file.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job id returned by run_command' }
        },
        required: ['job_id']
      }
    },
    {
      name: 'job_kill',
      description: 'Stop a background command by job id, together with its process tree.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job id returned by run_command' }
        },
        required: ['job_id']
      }
    },
    SKILL_TOOL_SPEC,
    {
      name: 'todo_write',
      description:
        'Record and update a task list to plan multi-step work and show progress; skip it ' +
        'for trivial single-step tasks. Add one todo per concrete step before you start. ' +
        'While work remains, keep exactly one todo in_progress. Mark each todo completed ' +
        'as soon as it is done. Every call replaces the whole list.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete new todo list.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Short imperative task line' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      }
    },
    TASK_TOOL_SPEC
  ]
}

/** Upper bound on list size; a longer plan means the task should be split first. */
const MAX_TODOS = 50

const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const

/**
 * Counts echo from tool-todo: the summary line gives the model a cheap
 * self-check that the list it sent is the list that landed.
 */
export function todoCountsOutput(todos: TodoItem[]): string {
  const pending = todos.filter((item) => item.status === 'pending').length
  const inProgress = todos.filter((item) => item.status === 'in_progress').length
  const completed = todos.filter((item) => item.status === 'completed').length
  return `Updated todo list: ${pending} pending, ${inProgress} in progress, ${completed} completed.`
}

/**
 * Validate the model-supplied list and build the canonical snapshot:
 * trimmed non-empty unique content, known statuses, and at most one
 * in_progress item (single-active discipline). Throws with a message that
 * goes back to the model so it can correct course.
 */
export function validateTodos(input: Record<string, unknown>): TodoItem[] {
  const raw = input.todos
  if (!Array.isArray(raw)) {
    throw new Error('Parameter "todos" must be an array.')
  }
  if (raw.length > MAX_TODOS) {
    throw new Error(`Too many todos (${raw.length}); keep the list at ${MAX_TODOS} or fewer.`)
  }
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Each todo must be an object with content and status.')
    }
    const candidate = item as { content?: unknown; status?: unknown }
    if (typeof candidate.content !== 'string' || candidate.content.trim().length === 0) {
      throw new Error('Invalid todo: "content" must be a non-empty string.')
    }
    if (typeof candidate.status !== 'string' || !TODO_STATUSES.includes(candidate.status as TodoItem['status'])) {
      throw new Error(
        `Invalid todo status for ${JSON.stringify(candidate.content.trim())}: use pending, in_progress or completed.`
      )
    }
    const content = candidate.content.trim()
    if (seen.has(content)) {
      throw new Error(`Invalid todos: duplicate content ${JSON.stringify(content)}.`)
    }
    seen.add(content)
    if (candidate.status === 'in_progress') active += 1
    todos.push({ content, status: candidate.status as TodoItem['status'] })
  }
  if (active > 1) {
    throw new Error(`Invalid todos: at most one task may be in_progress (got ${active}).`)
  }
  return todos
}

/** Parameter schemas by tool name, filled from toolSpecs on first use. */
const specParameters = new Map<string, Record<string, unknown>>()

function parametersFor(name: string): Record<string, unknown> | null {
  if (specParameters.size === 0) {
    for (const spec of toolSpecs()) specParameters.set(spec.name, spec.parameters)
  }
  return specParameters.get(name) ?? null
}

export async function runTool(
  call: ToolCall,
  signal: AbortSignal,
  hooks?: ToolHooks
): Promise<ToolOutcome> {
  try {
    // Weak models emit numeric strings, stringified JSON and null
    // placeholders; coerce against the schema before the switch sees them.
    const input = repairToolInput(call.input, parametersFor(call.name))
    // Every clamped result may spill its full text to disk first.
    const cl = (pending: Promise<ToolOutcome> | ToolOutcome): Promise<ToolOutcome> =>
      Promise.resolve(pending).then((outcome) => clamp(outcome, call))
    switch (call.name) {
      case 'list_dir':
        return cl(await listDirTool(input))
      case 'read_file':
        return cl(await readFileTool(input))
      case 'write_file':
        return cl(await writeFileTool(input))
      case 'edit_file':
        return cl(await editFileTool(input))
      case 'search':
        return cl(await searchTool(input))
      case 'glob':
        return cl(globTool(input))
      case 'grep':
        return cl(await grepTool(input))
      case 'web_fetch':
        return cl(await webFetchTool(input, signal))
      case 'web_search':
        return cl(await webSearchTool(input, signal))
      case 'patch':
        return await runPatchTool(input)
      case 'ask_user':
        return await askUserTool(input, call.id, hooks)
      case 'run_command':
        return await runCommandTool({ ...call, input }, signal, hooks)
      case 'job_output':
        return cl(jobOutputTool(input))
      case 'job_kill':
        return cl(jobKillTool(input))
      case SKILL_TOOL_NAME:
        return cl(runSkillTool(input))
      default:
        return { ok: false, output: `Unknown tool "${call.name}".` }
    }
  } catch (err) {
    // Tool failures go back to the model so it can correct course; they are not fatal.
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
}

/* ---------- individual tools ---------- */

/** Bounds on the ask_user surface, tightened from the harness's ask-user tool. */
const MAX_OPTIONS = 8
const MIN_OPTIONS = 2
const MAX_QUESTION_CHARS = 500

/**
 * Validate the question, hand it to the run loop's hook, and shape the
 * answer back into model-usable text. No hook (tests, headless) reads as
 * "nobody to ask" — the same fail-closed stance as the approval gate.
 */
async function askUserTool(
  input: Record<string, unknown>,
  callId: string,
  hooks?: ToolHooks
): Promise<ToolOutcome> {
  const question = requireString(input.question, 'question').slice(0, MAX_QUESTION_CHARS)
  const rawOptions = input.options
  if (!Array.isArray(rawOptions) || rawOptions.length < MIN_OPTIONS) {
    throw new Error(`Parameter "options" must be an array of at least ${MIN_OPTIONS} options.`)
  }
  if (rawOptions.length > MAX_OPTIONS) {
    throw new Error(`Too many options (${rawOptions.length}); keep it at ${MAX_OPTIONS} or fewer.`)
  }
  const options: UserQuestionOption[] = []
  const seen = new Set<string>()
  for (const item of rawOptions) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Each option must be an object with a label.')
    }
    const candidate = item as { label?: unknown; description?: unknown }
    if (typeof candidate.label !== 'string' || candidate.label.trim().length === 0) {
      throw new Error('Invalid option: "label" must be a non-empty string.')
    }
    const label = candidate.label.trim().slice(0, 100)
    if (seen.has(label)) {
      throw new Error(`Invalid options: duplicate label ${JSON.stringify(label)}.`)
    }
    seen.add(label)
    options.push({
      label,
      ...(typeof candidate.description === 'string' && candidate.description.trim().length > 0
        ? { description: candidate.description.trim().slice(0, 200) }
        : {})
    })
  }
  const multiple = input.multiple === true

  if (!hooks) {
    return { ok: false, output: 'There is no user to ask in this session. Proceed with your best judgment and note that you did.' }
  }
  const answers = await hooks.requestUserQuestion(question, options, multiple, callId)
  if (answers === null || answers.length === 0) {
    return {
      ok: false,
      output: 'The user skipped the question. Proceed with your best judgment and say which choice you made.'
    }
  }
  const list = answers.map((answer) => `"${answer}"`).join(', ')
  return { ok: true, output: `The user answered: ${list}.` }
}

async function listDirTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const target = optString(input.path) ?? ''
  requireWorkspace()
  const entries = listDir(target)
  if (entries.length === 0) {
    return { ok: true, output: target ? `${target} is empty.` : 'The workspace is empty.' }
  }
  const lines = entries.map((entry) => (entry.kind === 'directory' ? `${entry.path}/` : entry.path))
  return { ok: true, output: lines.join('\n') }
}

async function readFileTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const relPath = requireString(input.path, 'path')
  const offset = Math.max(1, optInt(input.offset) ?? 1)
  const limit = Math.min(4_000, Math.max(1, optInt(input.limit) ?? MAX_READ_LINES))

  // Absolute paths are the escape hatch for spilled tool output: the
  // pointer names a file inside the app's tool-output store, and only that.
  const content = path.isAbsolute(relPath)
    ? readSpill(relPath) ?? rejectAbsolute()
    : readWorkspaceFile(relPath, true)
  const lines = content.split('\n')
  if (offset > lines.length) {
    return {
      ok: false,
      output: `Offset ${offset} is past the end of the file (${lines.length} line${lines.length === 1 ? '' : 's'}).`
    }
  }
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  let output = slice.join('\n')
  const remaining = lines.length - (offset - 1 + slice.length)
  if (remaining > 0) {
    output += `\n… (${remaining} more line${remaining === 1 ? '' : 's'} — continue with offset ${offset + slice.length})`
  }
  return { ok: true, output }
}

function readWorkspaceFile(relPath: string, observed: boolean): string {
  const target = requireWorkspace().resolve(relPath)
  const content = readFileContent(relPath)
  if (observed) observeRead(target)
  return content
}

function rejectAbsolute(): string {
  throw new Error(
    'Absolute paths are only readable inside the tool-output store. ' +
      'Use a path relative to the workspace root instead.'
  )
}

async function writeFileTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const relPath = requireString(input.path, 'path')
  const content = requireString(input.content, 'content')
  const target = requireWorkspace().resolve(relPath)
  assertEditable(target, relPath)

  const before = readBefore(target)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  recordWrite(target)
  const lineCount = content.split('\n').length
  return {
    ok: true,
    output: `Wrote ${lineCount} line${lineCount === 1 ? '' : 's'} to ${relPath}.`,
    changedPath: relPath,
    ...asDiffPatch(fileDiff(relPath, before, content))
  }
}

/** Previous content of an existing file, or null when there is none to diff. */
function readBefore(target: string): string | null {
  try {
    if (!fs.statSync(target).isFile()) return null
    return fs.readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

function asDiffPatch(diff: FileDiff | null): { diff: FileDiff[] } | Record<string, never> {
  return diff ? { diff: [diff] } : {}
}

async function editFileTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const relPath = requireString(input.path, 'path')
  const oldText = requireString(input.old_text, 'old_text')
  // An empty string is a deletion; only a missing value is a bad call.
  const newText = typeof input.new_text === 'string' ? input.new_text : requireString(input.new_text, 'new_text')
  const replaceAll = input.replace_all === true
  const target = requireWorkspace().resolve(relPath)
  assertEditable(target, relPath)

  const content = fs.readFileSync(target, 'utf8')
  const result = applyEditText(content, oldText, newText, replaceAll)
  fs.writeFileSync(target, result.content, 'utf8')
  recordWrite(target)
  let output = `Edited ${relPath}`
  if (result.count > 1) {
    output += ` (${result.count} replacements)`
  }
  if (result.note) {
    output += `. ${result.note}`
  }
  return {
    ok: true,
    output,
    changedPath: relPath,
    ...asDiffPatch(fileDiff(relPath, content, result.content))
  }
}

async function searchTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(input.query, 'query')
  const scope = optString(input.path) ?? ''
  const caseSensitive = input.case_sensitive === true
  requireWorkspace().resolve(scope)

  const { hits, truncated } = searchWorkspace(query, { scope, caseSensitive })
  if (hits.length === 0) {
    return { ok: true, output: `No matches for "${query}".` }
  }
  const lines = hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`)
  let output = `${lines.length} match${lines.length === 1 ? '' : 'es'} for "${query}":\n${lines.join('\n')}`
  if (truncated) {
    output += '\n… (result list capped — narrow the query or the scope)'
  }
  return { ok: true, output }
}

async function runCommandTool(
  call: ToolCall,
  signal: AbortSignal,
  hooks?: ToolHooks
): Promise<ToolOutcome> {
  const command = requireString(call.input.command, 'command')
  const runInBackground = call.input.run_in_background === true
  const root = requireWorkspace().root
  const requested = optInt(call.input.timeout_ms)
  // Background jobs run untimed by default — a dev server is the point.
  const timeout = runInBackground
    ? requested === null
      ? 0
      : Math.min(MAX_BACKGROUND_TIMEOUT, Math.max(1_000, requested))
    : Math.min(MAX_COMMAND_TIMEOUT, Math.max(1_000, requested ?? DEFAULT_COMMAND_TIMEOUT))

  if (hooks) {
    const decision = await hooks.requestApproval(command, call.id)
    if (decision === 'rejected') {
      return { ok: false, output: denialText('the user said no') }
    }
  }

  if (runInBackground) {
    const { job } = startBackgroundJob(command, root, timeout)
    return {
      ok: true,
      output: [
        `$ ${command}`,
        `Command moved to the background (job id: ${job.id}).`,
        'You will be notified automatically when it finishes — do not poll for completion ' +
          'and do not sleep waiting for it. Do useful work now, or end your response; the ' +
          'completion notice will resume you.',
        `Read interim output any time with job_output using {"job_id": "${job.id}"}; ` +
          'stop it with job_kill.'
      ].join('\n')
    }
  }

  return await new Promise<ToolOutcome>((resolve) => {
    // Every command gets an output file: a foreground run dissolves its
    // handle on completion, a promoted one keeps it for job_output.
    const handle = allocateJob()
    const child = spawn(command, {
      shell: true,
      cwd: root,
      windowsHide: true,
      env: { ...process.env, ...COMMAND_ENV },
      // Its own process group so the kill below reaches the whole tree, not
      // just the shell (a `npm test` with workers has grandchildren).
      detached: process.platform !== 'win32'
    })

    let combined = ''
    let truncated = false
    let settled = false
    const stream = fs.createWriteStream(handle.outputFile, { flags: 'w' })
    child.once('close', () => stream.end())

    // Decode at the stream level: a multi-byte character split across data
    // events would otherwise reach the model as replacement characters.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    // Keep a generous tail for the inline answer; the file keeps everything,
    // and the clamp/spill layer adds a pointer when even this is too much.
    const append = (chunk: string): void => {
      combined += chunk
      stream.write(chunk)
      if (combined.length > MAX_COMMAND_OUTPUT) {
        combined = combined.slice(combined.length - MAX_COMMAND_OUTPUT)
        truncated = true
      }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timer = setTimeout(() => {
      // Promote instead of killing, the way the harness's bash tool does:
      // the command keeps running as a job and reports back when done.
      activateJob(handle, command, child)
      finish(
        true,
        `timed out after ${timeout} ms; moved to background job ${handle.id}\n` +
          'The command keeps running in the background. You will be notified when it ' +
          'finishes; read newer output with job_output, stop it with job_kill.',
        { keepAlive: true }
      )
    }, timeout)

    child.on('error', (err) => {
      finish(false, err.message)
    })
    child.on('close', (code) => {
      if (settled) return // the timeout path owns the child now
      releaseJob(handle)
      if (signal.aborted) {
        finish(false, 'cancelled')
      } else {
        finish(code === 0, code === 0 ? undefined : `exit code ${code ?? 'unknown'}`)
      }
    })
    // Hoisted pair so finish can release the listener: a long run makes one
    // command at a time, and piled-up abort listeners trip the leak warning.
    function onAbort(): void {
      finish(false, 'cancelled')
    }
    /** Kill the shell, its tree and, after a grace period, anything that
     *  ignored the first signal — strays keep ports and files busy. */
    function killTree(): void {
      if (process.platform === 'win32') {
        if (child.pid !== undefined) {
          // taskkill walks the child tree; a bare kill would not.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        }
        return
      }
      if (child.pid === undefined) {
        child.kill()
        return
      }
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill()
        return
      }
      const pid = child.pid
      const escalation = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          child.kill()
        }
      }, 2_000)
      escalation.unref()
      child.once('close', () => clearTimeout(escalation))
    }
    function finish(ok: boolean, note?: string, opts?: { keepAlive?: boolean }): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (opts?.keepAlive !== true) {
        killTree()
        stream.end()
      }
      let output = `$ ${command}\n`
      if (truncated) output += '… (earlier output dropped)\n'
      output += combined.trim()
      if (note) output += `\n(${note})`
      resolve({ ok, output })
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function jobOutputTool(input: Record<string, unknown>): ToolOutcome {
  const id = requireString(input.job_id, 'job_id')
  const job = jobStatus(id)
  if (!job) {
    return { ok: false, output: `No job "${id}" is running or has finished recently in this session.` }
  }
  const status =
    job.status === 'running' ? 'running' : `${job.status}, exit code ${job.exitCode ?? 'unknown'}`
  const body = tailChars(job.outputFile, 20_000).trim()
  return {
    ok: true,
    output: `$ ${job.command}\n[status: ${status}]\n${body.length > 0 ? body : '(no output yet)'}`
  }
}

function jobKillTool(input: Record<string, unknown>): ToolOutcome {
  const id = requireString(input.job_id, 'job_id')
  const stopped = killJob(id)
  return stopped
    ? { ok: true, output: `Stopped background job ${id} and its process tree.` }
    : { ok: false, output: `No running job "${id}" to stop.` }
}

/* ---------- input helpers ---------- */

function requireWorkspace(): { root: string; resolve(relPath: string): string } {
  const root = getWorkspaceRoot()
  if (!root) {
    throw new Error('No workspace is open. Ask the user to open a folder first.')
  }
  return { root, resolve: (relPath: string) => resolveInWorkspace(relPath) }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Parameter "${name}" must be a non-empty string.`)
  }
  return value
}

function optString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function clamp(outcome: ToolOutcome, call?: { name: string; id: string }): ToolOutcome {
  if (outcome.output.length <= MAX_OUTPUT) return outcome
  // Fold monster lines first; a capped single line often fits outright.
  const folded = truncateLongLines(outcome.output)
  if (folded.length <= MAX_OUTPUT) {
    return { ...outcome, output: folded }
  }
  const source = folded.length < outcome.output.length ? folded : outcome.output
  // Keep both ends — the tail carries outcomes and completion notes the
  // model needs, the way the harness's retainer keeps head and tail.
  const head = cutSafe(source, 0, MAX_OUTPUT - CLAMP_TAIL)
  const tail = cutSafe(source, source.length - CLAMP_TAIL, source.length)
  const omitted = source.length - head.length - tail.length
  // The full text goes to disk so the model can page through it later;
  // a storage failure degrades to the plain omission marker.
  let marker = `${omitted} middle characters omitted`
  if (call) {
    const spilled = saveSpill(call.name, call.id, outcome.output)
    if (spilled) {
      marker = `${omitted} middle characters omitted; full output saved to: ${spilled} — read it back with read_file using that absolute path`
    }
  }
  return {
    ...outcome,
    output: `${head}\n… (${marker}) …\n${tail}`
  }
}

/** Cut without splitting a surrogate pair in half. */
function cutSafe(text: string, start: number, end: number): string {
  let from = start
  let to = end
  if (to < text.length) {
    const code = text.charCodeAt(to - 1)
    if (code >= 0xd800 && code <= 0xdbff) to -= 1
  }
  if (from > 0) {
    const code = text.charCodeAt(from)
    if (code >= 0xdc00 && code <= 0xdfff) from += 1
  }
  return text.slice(from, to)
}
