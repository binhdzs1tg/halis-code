import { BrowserWindow } from 'electron'
import os from 'node:os'
import { IpcChannel } from '../../shared/ipc-channels'
import type {
  AgentTurnRequest,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatErrorCode,
  ChatMessage,
  ChatNoticeEvent,
  ChatRunStarted,
  ChatToolEvent,
  CompactRequest,
  CompactResult,
  TodoItem,
  TodoUpdatedEvent
} from '../../shared/types'
import { providerNeedsKey, type ModelEntry, type ModelSelection, type ModelVariant, type ProviderEntry } from '../../shared/models'
import * as modelsCatalog from '../models-dev/catalog'
import * as keyStore from '../keys/store'
import { ProviderError, streamChat, type ProviderMessage } from './providers'
import { runTool, toolSpecs, validateTodos, todoCountsOutput, type ToolHooks } from './tools'
import { compactMessages, estimateTokens, pruneToolResults } from './compaction'
import { RepeatGuard } from './guard'
import { loadWorkspaceInstructions } from './instructions'
import { skillCatalogBlock } from './skills'
import { buildFileRefBlock } from './file-refs'
import { askApproval, dropApprovalsForRun, askUserQuestion } from './approval'
import { getGitInfo } from './git-info'
import { setJobSink } from './jobs'
import { getWorkspaceRoot } from '../workspace'

const MAX_HISTORY_MESSAGES = 40
/** Rounds of tool calls before the model is asked to wrap up. */
const MAX_TOOL_STEPS = 24

const SYSTEM_PROMPT = [
  'You are Halis, the coding agent built into the Halis Code editor.',
  'Reply in the same language the user writes in.',
  'Be concise and practical; prefer working code over prose.',
  'Use Markdown and tag fenced code blocks with their language.',
  'When tools are available, work with the open folder instead of guessing:',
  'list_dir, read_file and glob to explore, search or grep to locate code,',
  'edit_file or write_file for single changes, patch when several files change',
  'at once, run_command to build, test or inspect. Read a file before editing',
  'it and keep changes small and focused. For multi-step work, keep a plan',
  'with todo_write and update it as you go. Fetch web pages with web_fetch and',
  'search the web with web_search when the task needs outside facts. Ask the',
  'user with ask_user only when the next step truly needs their call. If no',
  'folder is open, ask the user to open one.'
].join('\n')

/**
 * The system prompt grows per turn: base behavior, then the workspace's own
 * instruction files, then the skill catalog — each inside its own
 * <system-reminder> frame so the model can tell them apart from user speech.
 */
function buildSystemPrompt(): string {
  const parts = [SYSTEM_PROMPT]
  for (const block of [loadWorkspaceInstructions(), skillCatalogBlock()]) {
    if (block) parts.push(block)
  }
  return parts.join('\n\n')
}

/* ---------- time context ---------- */

/** Re-sample the clock at most this often, mirroring the harness's time-context. */
const TIME_REFRESH_MS = 10 * 60_000
let lastTimeSample = 0

/** The workspace the environment context was last injected for. */
let lastEnvironmentRoot: string | null | undefined

function sampleTimeContext(): string | null {
  const now = Date.now()
  const elapsed = lastTimeSample === 0 ? null : now - lastTimeSample
  if (elapsed !== null && elapsed < TIME_REFRESH_MS) return null
  lastTimeSample = now
  const clock = new Date(now).toLocaleString('en-GB', { hour12: false })
  const elapsedNote =
    elapsed === null
      ? 'first sample of this session'
      : `elapsed since the previous sample: ${formatSpan(elapsed)}`
  return `<system-reminder>Time sampled while preparing this turn: ${clock} (local). ${elapsedNote}.</system-reminder>`
}

/**
 * Environment context, codex-style: the folder, platform and git state the
 * model is actually working against. Injected once per workspace — a new
 * folder is a new world, the same folder keeps its earlier snapshot.
 */
async function environmentContext(): Promise<string | null> {
  const root = getWorkspaceRoot()
  if (root === lastEnvironmentRoot) return null
  lastEnvironmentRoot = root
  const lines = ['<environment_context>']
  lines.push(`Working directory: ${root ?? 'no folder open'}`)
  lines.push(`Platform: ${process.platform} ${os.release()} (${os.arch()})`)
  if (root) {
    const git = await getGitInfo(root)
    if (git) {
      lines.push(`Git branch: ${git.branch}`)
      lines.push(`Git commit: ${git.commit}`)
    }
  }
  lines.push('</environment_context>')
  return lines.join('\n')
}

function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

interface Turn {
  prompt: string
  history: ChatMessage[]
  model: ModelSelection
}

const runs = new Map<string, AbortController>()
let runCounter = 0

/* ---------- provider retry ---------- */

/** Retries per request, straight from llm-retry's defaults. */
const RETRY_MAX = 5
const RETRY_INITIAL_MS = 500
const RETRY_MAX_MS = 10_000
const RETRY_JITTER_RATIO = 0.1

function retryable(err: ProviderError): boolean {
  if (err.code === 'network') return true
  if (err.code === 'http' && (err.status === undefined || err.status === 429 || err.status >= 500)) {
    return true
  }
  return false
}

function backoffDelay(attempt: number, retryAfterMs?: number): number {
  // A Retry-After hint wins over the local curve, but stays capped so a
  // confused gateway cannot stall the turn for minutes — the harness's
  // llm-retry honors the header the same way.
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    return Math.min(Math.max(retryAfterMs, 0), RETRY_MAX_MS)
  }
  const base = Math.min(RETRY_INITIAL_MS * 2 ** Math.min(attempt - 1, 1_024), RETRY_MAX_MS)
  const jitter = 1 - RETRY_JITTER_RATIO + 2 * RETRY_JITTER_RATIO * Math.random()
  return Math.min(base * jitter, RETRY_MAX_MS)
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError('aborted', 'cancelled'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ProviderError('aborted', 'cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * streamChat with the harness's bounded backoff: transient provider
 * failures (rate limits, server errors, flaky connections) retry with an
 * exponential, jittered delay; anything structural fails through. Once a
 * retry's target has already streamed deltas to the user, retrying would
 * replay the answer from byte zero — `allowRetry` puts a stop to that.
 */
async function streamWithRetry(
  request: Parameters<typeof streamChat>[0],
  allowRetry: () => boolean
): Promise<ReturnType<typeof streamChat>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await streamChat(request)
    } catch (err) {
      if (
        attempt >= RETRY_MAX ||
        !allowRetry() ||
        !(err instanceof ProviderError) ||
        !retryable(err)
      ) {
        throw err
      }
      await wait(backoffDelay(attempt, err.retryAfterMs), request.signal)
    }
  }
}

/**
 * Start an agent turn. Resolves immediately with a run id; the actual text
 * streams back as `chat:delta` events and ends with `chat:done` or `chat:error`.
 */
export async function startRun(raw: unknown, win: BrowserWindow | null): Promise<ChatRunStarted> {
  const turn = readTurn(raw)
  if (!turn) {
    throw new Error('chat:send expects { prompt, history, model }')
  }
  const runId = `run-${Date.now()}-${(runCounter += 1)}`
  const controller = new AbortController()
  runs.set(runId, controller)
  void execute(runId, turn, controller, win)
  return { runId }
}

export function cancelRun(runId: string): void {
  runs.get(runId)?.abort()
  // A cancelled run never gets to run its waiting commands.
  dropApprovalsForRun(runId)
}

/** Runs currently in flight; the quit confirmation reports these as active work. */
export function activeRuns(): number {
  return runs.size
}

async function execute(
  runId: string,
  turn: Turn,
  controller: AbortController,
  win: BrowserWindow | null
): Promise<void> {
  const emit = (channel: IpcChannel, payload: unknown): void => {
    if (!win || win.isDestroyed()) {
      // Nobody is listening anymore; stop burning tokens.
      controller.abort()
      return
    }
    try {
      win.webContents.send(channel, payload)
    } catch {
      // The frame died mid-run (crash, reload); same treatment.
      controller.abort()
    }
  }
  // Background jobs outlive their run; the last run's window keeps
  // receiving their completion notices.
  setJobSink((event) => emit(IpcChannel.JobNotice, event))
  const fail = (code: ChatErrorCode, message: string, status?: number): void => {
    const event: ChatErrorEvent = { runId, code, message, ...(status !== undefined ? { status } : {}) }
    emit(IpcChannel.ChatError, event)
  }

  try {
    const target = await resolveModelTarget(turn.model)
    if ('error' in target) {
      fail(target.error.code, target.error.message)
      return
    }
    const { provider, entry, variant, key } = target

    let messages = buildMessages(turn)
    const turnNotes = [await environmentContext(), sampleTimeContext()].filter(
      (note): note is string => note !== null
    )
    if (turnNotes.length > 0) {
      // Attach to the prompt's user message when there is one — two user
      // messages in a row make Anthropic reject the whole request.
      const note = turnNotes.join('\n\n')
      const last = messages[messages.length - 1]
      if (last && last.role === 'user') {
        last.content = `${last.content}\n\n${note}`
      } else {
        messages.push({ role: 'user', content: note })
      }
    }

    // Free context before the first step when the history runs long.
    const compacted = await compactMessages({
      provider,
      model: entry,
      variant,
      apiKey: key.value,
      system: buildSystemPrompt(),
      messages,
      signal: controller.signal
    }).catch(() => null)
    if (compacted) {
      messages = compacted.messages
      const notice: ChatNoticeEvent = {
        runId,
        kind: 'compacted',
        text: 'Context compacted — the older span of this conversation now lives in a checkpoint.'
      }
      emit(IpcChannel.ChatNotice, notice)
    }

    const system = buildSystemPrompt()
    const guard = new RepeatGuard()
    const specs = toolSpecs()
    const hooks: ToolHooks = {
      requestApproval: (command, callId) => askApproval(runId, callId, command, win),
      requestUserQuestion: (question, options, multiple, callId) =>
        askUserQuestion(runId, callId, question, options, multiple, win)
    }

    for (let step = 0; ; step += 1) {
      // Budget spent: force one plain, tool-less completion so the turn still ends with an answer.
      const wrapUp = step >= MAX_TOOL_STEPS
      if (wrapUp) {
        const wrapUpText =
          'The tool budget for this turn is used up. Give your final answer now, without calling any more tools.'
        const last = messages[messages.length - 1]
        if (last && last.role === 'user') {
          last.content = `${last.content}\n\n${wrapUpText}`.trim()
        } else {
          messages.push({ role: 'user', content: wrapUpText })
        }
      }

      // Deterministic relief before spending a model call: old oversized
      // tool results lose their middle, the newest message stays intact.
      pruneToolResults(messages)

      // Context pressure can arrive mid-run too: every step accumulates tool
      // results, so re-check the budget before each model call instead of
      // ending the turn with a provider 400.
      if (step > 0) {
        const compacted = await compactMessages({
          provider,
          model: entry,
          variant,
          apiKey: key.value,
          system,
          messages,
          signal: controller.signal
        }).catch(() => null)
        if (compacted) {
          messages = compacted.messages
          const notice: ChatNoticeEvent = {
            runId,
            kind: 'compacted',
            text: 'Context compacted mid-run — the older span now lives in a checkpoint.'
          }
          emit(IpcChannel.ChatNotice, notice)
        }
      }

      // Once a delta has reached the user, a mid-stream failure must not
      // retry — a fresh attempt would replay the whole answer on screen.
      let streamed = false
      const result = await streamWithRetry(
        {
          provider,
          model: entry,
          variant,
          apiKey: key.value,
          system,
          messages,
          ...(wrapUp ? {} : { tools: specs }),
          signal: controller.signal,
          onDelta: (text) => {
            streamed = true
            const event: ChatDeltaEvent = { runId, text }
            emit(IpcChannel.ChatDelta, event)
          }
        },
        () => !streamed
      )

      if (result.toolCalls.length === 0 || wrapUp) break

      // Thinking blocks ride along: Anthropic requires them on the replayed
      // assistant turn whenever extended thinking produced a tool call.
      messages.push({
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls,
        ...(result.thinkingBlocks?.length ? { thinkingBlocks: result.thinkingBlocks } : {})
      })
      const results = []
      for (const call of result.toolCalls) {
        const startedAt = Date.now()
        const start: ChatToolEvent = { runId, callId: call.id, name: call.name, phase: 'start', input: call.input }
        emit(IpcChannel.ChatTool, start)

        // Todo writes are run-level state: validate, remember the snapshot,
        // and fan it out to the renderer instead of touching the workspace.
        if (call.name === 'todo_write') {
          const todoOutcome = handleTodoWrite(
            runId,
            call,
            (event) => emit(IpcChannel.ChatTool, event),
            (event) => emit(IpcChannel.ChatTodo, event)
          )
          results.push({ callId: call.id, output: todoOutcome.output, ok: todoOutcome.ok })
          continue
        }

        const outcome = await runTool(call, controller.signal, hooks)
        // The repeat guard counts failed calls too: a model hammering a
        // denied call is exactly the loop worth breaking.
        const reminder = guard.record(call.name, call.input)
        if (reminder) {
          outcome.output = `${outcome.output}\n\n${reminder}`
        }
        const end: ChatToolEvent = {
          runId,
          callId: call.id,
          name: call.name,
          phase: 'end',
          input: call.input,
          output: outcome.output,
          ok: outcome.ok,
          durationMs: Date.now() - startedAt,
          ...(outcome.diff ? { diff: outcome.diff } : {})
        }
        emit(IpcChannel.ChatTool, end)
        const changedPaths = [
          ...(outcome.changedPath ? [outcome.changedPath] : []),
          ...(outcome.changedPaths ?? [])
        ]
        for (const changed of changedPaths) {
          emit(IpcChannel.WorkspaceChanged, { path: changed })
        }
        results.push({ callId: call.id, output: outcome.output, ok: outcome.ok })
        if (controller.signal.aborted) break
      }
      if (controller.signal.aborted) break
      messages.push({ role: 'user', content: '', toolResults: results })
    }

    const done: ChatDoneEvent = { runId, aborted: controller.signal.aborted }
    emit(IpcChannel.ChatDone, done)
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'aborted') {
      const done: ChatDoneEvent = { runId, aborted: true }
      emit(IpcChannel.ChatDone, done)
      return
    }
    if (err instanceof ProviderError) {
      fail(err.code, err.message, err.status)
      return
    }
    fail('network', err instanceof Error ? err.message : String(err))
  } finally {
    runs.delete(runId)
  }
}

/**
 * Resolve a model selection against the catalog and the key vault, shared
 * by the run loop and manual compaction so both fail the same way.
 */
interface ModelTarget {
  provider: ProviderEntry
  entry: ModelEntry
  variant: ModelVariant | null
  key: { value: string }
}

async function resolveModelTarget(
  selection: ModelSelection
): Promise<{ error: { code: ChatErrorCode; message: string } } | ModelTarget> {
  const { providers } = await modelsCatalog.list()
  const provider = providers.find((item) => item.id === selection.providerID)
  const entry = provider?.models.find((item) => item.id === selection.modelID)
  if (!provider || !entry) {
    return {
      error: { code: 'invalid-model', message: 'The selected model is no longer available — pick another one.' }
    }
  }
  const variant = entry.variants.find((item) => item.id === selection.variant) ?? null
  // Local servers take unauthenticated traffic; everyone else needs a key.
  if (!providerNeedsKey(provider)) {
    return { provider, entry, variant, key: { value: '' } }
  }
  const key = await keyStore.resolve(provider)
  if (!key) {
    const envHint = provider.env.length > 0 ? `, or set ${provider.env.join(' / ')} and restart` : ''
    return {
      error: {
        code: 'missing-key',
        message: `No API key for ${provider.name}. Enter one in the dialog that opens${envHint}.`
      }
    }
  }
  return { provider, entry, variant, key }
}

/**
 * Manual compaction from the chat's /compact command: fold the given
 * conversation into a checkpoint right away and hand it back for the
 * renderer to splice in.
 */
export async function compactNow(raw: unknown): Promise<CompactResult> {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('chat:compact expects { history, model }')
  }
  const candidate = raw as Partial<CompactRequest>
  if (!Array.isArray(candidate.history) || !isSelection(candidate.model)) {
    throw new Error('chat:compact expects { history, model }')
  }
  const turn: Turn = {
    prompt: '',
    history: candidate.history.filter(
      (item): item is ChatMessage =>
        typeof item === 'object' &&
        item !== null &&
        (item.role === 'user' || item.role === 'assistant' || item.role === 'system') &&
        typeof item.content === 'string'
    ),
    model: candidate.model
  }

  const target = await resolveModelTarget(turn.model)
  if ('error' in target) {
    throw new Error(target.error.message)
  }
  const messages = buildMessages(turn)
  if (messages.length === 0) {
    throw new Error('Nothing to compact yet — send a message first.')
  }
  const beforeTokens = estimateTokens(messages)
  const compacted = await compactMessages({
    provider: target.provider,
    model: target.entry,
    variant: target.variant,
    apiKey: target.key.value,
    system: buildSystemPrompt(),
    messages,
    signal: new AbortController().signal,
    force: true
  })
  if (!compacted) {
    throw new Error('Could not produce a checkpoint for this conversation.')
  }
  // The framed checkpoint alone — never the merged first tail message,
  // whose text the conversation keeps as-is.
  return {
    checkpoint: compacted.checkpoint,
    beforeTokens,
    afterTokens: estimateTokens(compacted.messages)
  }
}

interface TodoWriteOutcome {
  ok: boolean
  output: string
  todos?: TodoItem[]
}

/**
 * Validate and publish one whole-list todo snapshot. The end tool event and
 * the renderer snapshot are emitted here so the call stays self-contained;
 * a validation failure goes back to the model as a failed tool result.
 */
function handleTodoWrite(
  runId: string,
  call: { id: string; name: string; input: Record<string, unknown> },
  emitTool: (event: ChatToolEvent) => void,
  emitTodo: (event: TodoUpdatedEvent) => void
): TodoWriteOutcome {
  const startedAt = Date.now()
  try {
    const todos = validateTodos(call.input)
    const end: ChatToolEvent = {
      runId,
      callId: call.id,
      name: call.name,
      phase: 'end',
      input: call.input,
      output: todoCountsOutput(todos),
      ok: true,
      durationMs: Date.now() - startedAt
    }
    emitTool(end)
    emitTodo({ runId, todos })
    return { ok: true, output: end.output ?? '', todos }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const end: ChatToolEvent = {
      runId,
      callId: call.id,
      name: call.name,
      phase: 'end',
      input: call.input,
      output: message,
      ok: false,
      durationMs: Date.now() - startedAt
    }
    emitTool(end)
    return { ok: false, output: message }
  }
}

function buildMessages(turn: Turn): ProviderMessage[] {
  const out: ProviderMessage[] = []
  // Anthropic insists on alternating roles; merging consecutive turns of the
  // same role (e.g. two user messages split by a dropped system note) keeps
  // every provider happy.
  const push = (role: 'user' | 'assistant', content: string): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${content}`
      return
    }
    out.push({ role, content })
  }
  for (const message of turn.history) {
    // System notes are UI chatter — except checkpoints, which are the
    // durable product of a compaction and must reach the model.
    if (message.role === 'system') {
      if (message.content.includes('<compacted-summary>')) {
        push('user', message.content.trim())
      }
      continue
    }
    const content = message.content.trim()
    if (!content) continue
    push(message.role === 'assistant' ? 'assistant' : 'user', content)
  }
  const prompt = turn.prompt.trim()
  if (prompt) {
    // @-referenced files ride along with the prompt that mentions them.
    const attachment = buildFileRefBlock(prompt)
    push('user', attachment ? `${prompt}\n\n${attachment}` : prompt)
  }
  const trimmed = out.slice(-MAX_HISTORY_MESSAGES)
  // Providers like Anthropic require the first message to be a user turn;
  // a slice landing on an assistant message breaks the whole request.
  while (trimmed.length > 0 && trimmed[0]?.role === 'assistant') {
    trimmed.shift()
  }
  return trimmed
}

function readTurn(value: unknown): Turn | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<AgentTurnRequest>
  if (typeof candidate.prompt !== 'string' || candidate.prompt.trim().length === 0) return null
  if (!isSelection(candidate.model)) return null
  if (!Array.isArray(candidate.history)) return null
  const history = candidate.history.filter(
    (item): item is ChatMessage =>
      typeof item === 'object' &&
      item !== null &&
      (item.role === 'user' || item.role === 'assistant' || item.role === 'system') &&
      typeof item.content === 'string'
  )
  return { prompt: candidate.prompt, history, model: candidate.model }
}

function isSelection(value: unknown): value is ModelSelection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModelSelection).providerID === 'string' &&
    typeof (value as ModelSelection).modelID === 'string'
  )
}
