/**
 * Subagent delegation: the model hands one self-contained task to a fresh
 * agent run that shares the workspace but not the conversation, so
 * exploration dumps and intermediate file reads stay out of the parent's
 * context — the parent gets a report back instead. The subagent runs the
 * same loop with the same model and every tool except asking questions,
 * editing the todo list or spawning further subagents; its final message
 * returns verbatim as the tool result.
 */
import type { AgentRunOptions, Tool, ToolContext, ToolOutcome } from '../types.js'
import { runAgent } from '../agent.js'
import { buildSystemPrompt } from '../prompt.js'

export const TASK_TOOL_NAME = 'task'

/** The subagent's own turn budget — tighter than the parent's run. */
const SUBAGENT_MAX_TURNS = 24

/** The most a subagent's report may carry inline before it is bound. */
const MAX_RESULT_CHARS = 12_000

/**
 * Tools the subagent does not get. `task` would allow unbounded recursion;
 * `ask_user` has no user on the subagent's side of the line; `todo_write`
 * is run-level UI state and a background writer would fight the parent's plan.
 */
const SUBAGENT_BLOCKLIST = new Set([TASK_TOOL_NAME, 'ask_user', 'todo_write'])

const ROLE_PROMPT = [
  'You are a subagent spawned by the main coding agent to finish one delegated task.',
  'You have not seen the main conversation — everything you need is in the task prompt.',
  'Work with the workspace tools directly: explore, read, edit and run commands as the task requires.',
  'You cannot ask the user questions; make a reasonable decision and note it in your report instead.',
  'Your final message is the whole handoff to the main agent, and the only part of this run it ' +
    'ever sees. Say what you did, what you found, the concrete paths and commands involved, and ' +
    'what it should do next — no preamble, no narrative.',
  'If you cannot finish, report exactly what blocked you and what you already tried.',
].join('\n')

/** Everything the subagent inherits from the run that spawned it. */
export interface TaskShared {
  provider: AgentRunOptions['provider']
  tools: Tool[]
  readFiles: Set<string>
  cwd: string
  approve?: AgentRunOptions['approve']
  /** Extra guardrail for the subagent's own bash calls, if the host wants one. */
  onSubagentNotice?: (text: string) => void
}

/**
 * Build the task tool bound to one parent run. The closure keeps the
 * parent's provider, toolset and readFiles so the subagent works in the
 * same workspace with the same capabilities.
 */
export function createTaskTool(shared: TaskShared): Tool {
  return {
    spec: {
      name: TASK_TOOL_NAME,
      description:
        'Hand one self-contained task to a fresh subagent that shares the workspace but not this ' +
        'conversation. Worth it when exploration would flood your context with file dumps: the ' +
        'subagent reads everything itself and you get a report back. It has your tools (minus ' +
        'asking questions), your model, and cannot spawn further subagents. Brief it like a ' +
        'colleague who just walked in — goal, relevant paths, and exactly what to report back. ' +
        'Do not delegate trivial work you can finish in a call or two, and do not delegate ' +
        'understanding: when the next step hinges on a specific file or line, find it yourself first.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short task summary (3-6 words) shown while it runs' },
          prompt: {
            type: 'string',
            description: 'Full brief for the subagent: goal, context, paths to look at, what to report back',
          },
        },
        required: ['prompt'],
      },
    },
    async run(input, ctx: ToolContext): Promise<ToolOutcome> {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (!prompt) {
        return { ok: false, output: 'Parameter "prompt" is required — describe the task the subagent should do.' }
      }
      if (prompt.length > 32_000) {
        return {
          ok: false,
          output: `Parameter "prompt" is too long (${prompt.length} chars); keep it under 32000.`,
        }
      }

      const workspace = await buildSystemPrompt({ cwd: shared.cwd })
      const system = workspace ? `${ROLE_PROMPT}\n\n${workspace}` : ROLE_PROMPT
      const tools = shared.tools.filter((tool) => !SUBAGENT_BLOCKLIST.has(tool.spec.name))
      const messages: AgentRunOptions['messages'] = [{ role: 'user', content: prompt }]

      try {
        await runAgent({
          system,
          messages,
          tools,
          maxTurns: SUBAGENT_MAX_TURNS,
          signal: ctx.signal,
          cwd: shared.cwd,
          provider: shared.provider,
          readFiles: shared.readFiles,
          // The subagent stays silent while it works; only its report surfaces.
          onEvent: (event) => {
            if (event.type === 'notice' && shared.onSubagentNotice) shared.onSubagentNotice(event.text)
          },
          ...(shared.approve ? { approve: shared.approve } : {}),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          output: `The subagent failed: ${message} — retry the task or do the work directly.`,
        }
      }

      if (ctx.signal.aborted) {
        return {
          ok: false,
          output: 'The task was stopped before it finished. Start it again with the same brief, or do the remaining work directly.',
        }
      }

      const report = messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? ''
      if (!report.trim()) {
        return {
          ok: false,
          output:
            'The subagent finished without a final report. Run the task again with a clearer brief, or investigate directly.',
        }
      }
      return { ok: true, output: taskEnvelope(boundResult(report.trim())) }
    },
  }
}

/** Frames the handoff so the parent can tell it apart from its own turn's text. */
function taskEnvelope(text: string): string {
  return `<task-result>\n${text}\n</task-result>`
}

function boundResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  const head = text.slice(0, MAX_RESULT_CHARS - 1_000)
  const tail = text.slice(-1_000)
  return `${head}\n\n[… ${text.length - MAX_RESULT_CHARS} characters omitted …]\n\n${tail}`
}
