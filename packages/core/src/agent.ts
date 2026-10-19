import { streamChat } from './provider.js'
import type { AgentRunOptions, ToolResult } from './types.js'

/**
 * The tool loop: stream an assistant turn, run the requested tools, feed the
 * results back, repeat until the model answers without tools, the user aborts
 * or the turn budget runs out. Events drive the UI; the transcript array is
 * mutated in place so the caller keeps the full conversation.
 */
export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const { onEvent, signal } = opts
  let turn = 0

  try {
    while (true) {
      turn++
      if (turn > opts.maxTurns) {
        onEvent({ type: 'notice', text: `stopped after ${opts.maxTurns} turns — send another message to continue` })
        onEvent({ type: 'done', reason: 'max-turns' })
        return
      }

      const res = await streamChat({
        baseUrl: opts.provider.baseUrl,
        model: opts.provider.model,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools.map((t) => t.spec),
        signal,
        onDelta: (text) => onEvent({ type: 'text-delta', text }),
        ...(opts.provider.apiKey ? { apiKey: opts.provider.apiKey } : {}),
      })

      const assistant: typeof opts.messages[number] = {
        role: 'assistant',
        content: res.text,
        ...(res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}),
      }
      opts.messages.push(assistant)

      if (res.toolCalls.length === 0) {
        onEvent({ type: 'done', reason: 'complete' })
        return
      }

      for (const call of res.toolCalls) {
        const started = Date.now()
        onEvent({ type: 'tool-start', call })

        let allowed = true
        if (opts.approve) allowed = await opts.approve(call)
        let outcome: { output: string; ok: boolean }
        if (!allowed) {
          outcome = { output: 'the user declined this call — continue without it or explain what you need', ok: false }
        } else {
          const tool = opts.tools.find((t) => t.spec.name === call.name)
          outcome = tool
            ? await tool.run(call.input, { cwd: opts.cwd, signal, readFiles: opts.readFiles })
            : { output: `error: unknown tool "${call.name}"`, ok: false }
        }

        const result: ToolResult = {
          callId: call.id,
          name: call.name,
          output: outcome.output,
          ok: outcome.ok,
        }
        onEvent({ type: 'tool-end', call, result, ms: Date.now() - started })
        opts.messages.push({ role: 'tool', toolCallId: call.id, content: result.output })
      }
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      onEvent({ type: 'done', reason: 'aborted' })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    onEvent({ type: 'error', message })
    onEvent({ type: 'done', reason: 'error' })
  }
}
