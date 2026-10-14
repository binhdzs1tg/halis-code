import { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc-channels'
import type {
  AgentTurnRequest,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatErrorCode,
  ChatMessage,
  ChatRunStarted,
  ChatToolEvent
} from '../../shared/types'
import type { ModelSelection } from '../../shared/models'
import * as modelsCatalog from '../models-dev/catalog'
import * as keyStore from '../keys/store'
import { ProviderError, streamChat, type ProviderMessage } from './providers'
import { runTool, toolSpecs } from './tools'

const MAX_HISTORY_MESSAGES = 40
/** Rounds of tool calls before the model is asked to wrap up. */
const MAX_TOOL_STEPS = 24

const SYSTEM_PROMPT = [
  'You are Halis, the coding agent built into the Halis Code editor.',
  'Reply in the same language the user writes in.',
  'Be concise and practical; prefer working code over prose.',
  'Use Markdown and tag fenced code blocks with their language.',
  'When tools are available, work with the open folder instead of guessing:',
  'list_dir and read_file to explore, search to locate code, edit_file or write_file',
  'to change files, run_command to build, test or inspect. Read a file before editing',
  'it and keep changes small and focused. If no folder is open, ask the user to open one.'
].join('\n')

interface Turn {
  prompt: string
  history: ChatMessage[]
  model: ModelSelection
}

const runs = new Map<string, AbortController>()
let runCounter = 0

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
}

async function execute(
  runId: string,
  turn: Turn,
  controller: AbortController,
  win: BrowserWindow | null
): Promise<void> {
  const emit = (channel: IpcChannel, payload: unknown): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload)
    } else {
      // Nobody is listening anymore; stop burning tokens.
      controller.abort()
    }
  }
  const fail = (code: ChatErrorCode, message: string): void => {
    const event: ChatErrorEvent = { runId, code, message }
    emit(IpcChannel.ChatError, event)
  }

  try {
    const { providers } = await modelsCatalog.list()
    const provider = providers.find((item) => item.id === turn.model.providerID)
    const entry = provider?.models.find((item) => item.id === turn.model.modelID)
    if (!provider || !entry) {
      fail('invalid-model', 'The selected model is no longer available — pick another one.')
      return
    }
    const variant = entry.variants.find((item) => item.id === turn.model.variant) ?? null

    const key = await keyStore.resolve(provider)
    if (!key) {
      const envHint = provider.env.length > 0 ? `, or set ${provider.env.join(' / ')} and restart` : ''
      fail('missing-key', `No API key for ${provider.name}. Add one from the chat header${envHint}.`)
      return
    }

    const messages = buildMessages(turn)
    const specs = toolSpecs()

    for (let step = 0; ; step += 1) {
      // Budget spent: force one plain, tool-less completion so the turn still ends with an answer.
      const wrapUp = step >= MAX_TOOL_STEPS
      if (wrapUp) {
        messages.push({
          role: 'user',
          content: 'The tool budget for this turn is used up. Give your final answer now, without calling any more tools.'
        })
      }

      const result = await streamChat({
        provider,
        model: entry,
        variant,
        apiKey: key.value,
        system: SYSTEM_PROMPT,
        messages,
        tools: wrapUp ? undefined : specs,
        signal: controller.signal,
        onDelta: (text) => {
          const event: ChatDeltaEvent = { runId, text }
          emit(IpcChannel.ChatDelta, event)
        }
      })

      if (result.toolCalls.length === 0 || wrapUp) break

      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })
      const results = []
      for (const call of result.toolCalls) {
        const startedAt = Date.now()
        const start: ChatToolEvent = { runId, callId: call.id, name: call.name, phase: 'start', input: call.input }
        emit(IpcChannel.ChatTool, start)
        const outcome = await runTool(call, controller.signal)
        const end: ChatToolEvent = {
          runId,
          callId: call.id,
          name: call.name,
          phase: 'end',
          input: call.input,
          output: outcome.output,
          ok: outcome.ok,
          durationMs: Date.now() - startedAt
        }
        emit(IpcChannel.ChatTool, end)
        if (outcome.changedPath) {
          emit(IpcChannel.WorkspaceChanged, { path: outcome.changedPath })
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
      fail(err.code, err.message)
      return
    }
    fail('network', err instanceof Error ? err.message : String(err))
  } finally {
    runs.delete(runId)
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
    if (message.role === 'system') continue
    const content = message.content.trim()
    if (!content) continue
    push(message.role === 'assistant' ? 'assistant' : 'user', content)
  }
  push('user', turn.prompt.trim())
  return out.slice(-MAX_HISTORY_MESSAGES)
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
