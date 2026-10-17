/**
 * Subagent delegation: the model hands one self-contained task to a fresh
 * agent run
 * that shares the workspace but not the conversation, so exploration dumps
 * and intermediate file reads stay out of the parent's context — the
 * parent gets a report back instead. The subagent runs the same loop with
 * the same model and every tool except asking questions, editing the todo
 * list or spawning further subagents; its final message returns verbatim
 * as the tool result. Pure Node besides the provider call itself.
 */
import type { ToolCall, ToolSpec } from '../../shared/types'
import { loadWorkspaceInstructions } from './instructions'
import { pruneToolResults } from './compaction'
import { RepeatGuard } from './guard'
import { streamChat, ProviderError, type ProviderMessage } from './providers'
import type { ModelTarget } from './run'
import type { ToolOutcome } from './tools'

export const TASK_TOOL_NAME = 'task'

export const TASK_TOOL_SPEC: ToolSpec = {
  name: TASK_TOOL_NAME,
  description:
    'Hand one self-contained task to a fresh subagent that shares the workspace ' +
    'but not this conversation. Worth it when exploration would flood your context ' +
    'with file dumps: the subagent reads everything itself and you get a report back. ' +
    'It has your tools (minus asking questions), your model, and cannot spawn further ' +
    'subagents. Brief it like a colleague who just walked in — goal, relevant paths, ' +
    'and exactly what to report back. Do not delegate trivial work you can finish in a ' +
    'call or two, and do not delegate understanding: when the next step hinges on a ' +
    'specific file or line, find it yourself first.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short task summary (3-6 words) shown while it runs' },
      prompt: { type: 'string', description: 'Full brief for the subagent: goal, context, paths to look at, what to report back' }
    },
    required: ['prompt']
  }
}

/**
 * Tools the subagent does not get. `task` would allow unbounded recursion
 * (both sources default to depth 1); `ask_user` because there is no user on
 * the subagent's side of the line; `todo_write` because the list is run-level
 * UI state and a background writer would fight the parent's plan.
 */
const SUBAGENT_BLOCKLIST = new Set([TASK_TOOL_NAME, 'ask_user', 'todo_write'])

/** The subagent's own tool budget — tighter than the parent's 24 steps. */
const SUBAGENT_MAX_STEPS = 16

const MAX_PROMPT_CHARS = 16_000
const MAX_RESULT_CHARS = 20_000

/** Everything the nested loop needs, injected by the run loop. */
export interface SubagentContext {
  target: ModelTarget
  /** The parent's tool specs, including MCP tools. */
  specs: ToolSpec[]
  signal: AbortSignal
  /** Runs one sub-step tool call (the parent's runTool with its hooks). */
  runStep: (call: ToolCall) => Promise<ToolOutcome>
}

const ROLE_PROMPT = [
  'You are a subagent spawned by the main coding agent to finish one delegated task.',
  'You have not seen the main conversation — everything you need is in the task prompt.',
  'Work with the workspace tools directly: explore, read, edit and run commands as the task requires.',
  'You cannot ask the user questions; make a reasonable decision and note it in your report instead.',
  'Your final message is the whole handoff to the main agent, and the only part of this run it ' +
    'ever sees. Say what you did, what you found, the concrete paths and commands involved, and ' +
    'what it should do next — no preamble, no narrative.',
  'If you cannot finish, report exactly what blocked you and what you already tried.'
].join('\n')

/** The subagent inherits the workspace's own instruction files — same repo, same rules. */
export function subagentSystemPrompt(): string {
  const instructions = loadWorkspaceInstructions()
  return instructions ? `${ROLE_PROMPT}\n\n${instructions}` : ROLE_PROMPT
}

export function filterSubagentSpecs(specs: ToolSpec[]): ToolSpec[] {
  return specs.filter((spec) => !SUBAGENT_BLOCKLIST.has(spec.name))
}

export function validateTaskInput(input: Record<string, unknown>): { description: string; prompt: string } {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) {
    throw new Error('Parameter "prompt" is required — describe the task the subagent should do.')
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Parameter "prompt" is too long (${prompt.length} chars); keep it under ${MAX_PROMPT_CHARS}.`)
  }
  const description =
    typeof input.description === 'string' && input.description.trim().length > 0
      ? input.description.trim().slice(0, 120)
      : deriveDescription(prompt)
  return { description, prompt }
}

function deriveDescription(prompt: string): string {
  const firstLine = prompt.split('\n').find((line) => line.trim().length > 0) ?? prompt
  return firstLine.trim().slice(0, 60)
}

/** Frames the handoff so the parent can tell it apart from its own turn's text. */
export function taskEnvelope(text: string): string {
  return `<task-result>\n${text}\n</task-result>`
}

function boundResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  const head = text.slice(0, MAX_RESULT_CHARS - 1_000)
  const tail = text.slice(-1_000)
  return `${head}\n\n[… ${text.length - MAX_RESULT_CHARS} characters omitted …]\n\n${tail}`
}

const STOPPED_OUTPUT =
  'The task was stopped before it finished. Start it again with the same brief, or do the remaining work directly.'

/**
 * Run one delegated task to completion and return the subagent's last
 * message as the tool result. Sub-step failures are not fatal — they go
 * back to the subagent as failed tool results, exactly like the parent
 * loop. Only a provider-level failure or the abort bubbles out.
 */
export async function runTaskTool(input: Record<string, unknown>, ctx: SubagentContext): Promise<ToolOutcome> {
  const changedPaths = new Set<string>()
  try {
    const { prompt } = validateTaskInput(input)
    const specs = filterSubagentSpecs(ctx.specs)
    const system = subagentSystemPrompt()
    const messages: ProviderMessage[] = [{ role: 'user', content: prompt }]
    const guard = new RepeatGuard()
    let lastText = ''

    for (let step = 0; ; step += 1) {
      // Budget spent: force one plain completion so a handoff still arrives
      // instead of the run dying once the step budget is exhausted.
      const wrapUp = step >= SUBAGENT_MAX_STEPS
      if (wrapUp) {
        const wrapUpText =
          'The tool budget for this task is used up. Give your final report now, without calling any more tools.'
        const last = messages[messages.length - 1]
        if (last && last.role === 'user') {
          last.content = `${last.content}\n\n${wrapUpText}`
        } else {
          messages.push({ role: 'user', content: wrapUpText })
        }
      }

      pruneToolResults(messages)
      const result = await streamChat({
        provider: ctx.target.provider,
        model: ctx.target.entry,
        variant: ctx.target.variant,
        apiKey: ctx.target.key.value,
        system,
        messages,
        ...(wrapUp ? {} : { tools: specs }),
        signal: ctx.signal,
        // The parent's chat keeps its own stream; the subagent stays silent
        // until its report lands as this tool's output.
        onDelta: () => {}
      })
      if (result.text.trim()) lastText = result.text.trim()
      if (result.toolCalls.length === 0 || wrapUp) break

      // Thinking blocks ride along for providers that require them on replay.
      messages.push({
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls,
        ...(result.thinkingBlocks?.length ? { thinkingBlocks: result.thinkingBlocks } : {})
      })
      const results = []
      for (const call of result.toolCalls) {
        const outcome = await ctx.runStep(call)
        const reminder = guard.record(call.name, call.input)
        if (outcome.changedPath) changedPaths.add(outcome.changedPath)
        for (const changed of outcome.changedPaths ?? []) changedPaths.add(changed)
        results.push({
          callId: call.id,
          output: reminder ? `${outcome.output}\n\n${reminder}` : outcome.output,
          ok: outcome.ok
        })
        if (ctx.signal.aborted) break
      }
      if (ctx.signal.aborted) break
      messages.push({ role: 'user', content: '', toolResults: results })
    }

    if (ctx.signal.aborted) {
      return { ok: false, output: STOPPED_OUTPUT, ...spreadChanged(changedPaths) }
    }
    if (!lastText) {
      return {
        ok: false,
        output:
          'The subagent finished without a final report. Run the task again with a clearer brief, or investigate directly.',
        ...spreadChanged(changedPaths)
      }
    }
    return { ok: true, output: taskEnvelope(boundResult(lastText)), ...spreadChanged(changedPaths) }
  } catch (err) {
    // Only a genuine run-level abort reads as "stopped"; a provider error
    // that merely mentions cancelled/aborted in its message must keep its
    // real cause so the parent can retry with the context it needs.
    if (err instanceof ProviderError && err.code === 'aborted') {
      // An abort that lands inside streamChat still leaves files the
      // subagent wrote before stopping — report them so the explorer and
      // any open editor refresh, exactly like the flag-based path above.
      return { ok: false, output: STOPPED_OUTPUT, ...spreadChanged(changedPaths) }
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      output: `The subagent failed: ${message} — retry the task or do the work directly.`
    }
  }
}

function spreadChanged(changed: Set<string>): { changedPaths?: string[] } {
  return changed.size > 0 ? { changedPaths: [...changed] } : {}
}
