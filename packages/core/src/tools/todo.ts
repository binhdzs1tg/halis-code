import type { TodoItem, Tool, ToolContext, ToolOutcome } from '../types.js'

const STATUSES = new Set(['pending', 'in_progress', 'done'])

function render(items: TodoItem[]): string {
  const box = { pending: '[ ]', in_progress: '[~]', done: '[x]' } as const
  return items.map((item) => `${box[item.status]} ${item.text}`).join('\n')
}

/**
 * The plan tool: hands the model's checklist to the host so it can be seen
 * while the work happens. The output is a plain checklist render — the model
 * reads back what the user sees.
 */
export const todoTool: Tool = {
  spec: {
    name: 'todo_write',
    description:
      'Write the visible plan for multi-step work: one row per step with a status. ' +
      'Call it again as work progresses — replace the whole list every time, ' +
      'marking finished rows done and the row you are working on in_progress. ' +
      'Skip it for single-step questions.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full plan, in order. Replace the previous list entirely.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'One step, phrased as an outcome.' },
              status: {
                type: 'string',
                description: 'pending (not started), in_progress (current step) or done.',
                enum: ['pending', 'in_progress', 'done'],
              },
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const raw = Array.isArray(input.todos) ? input.todos : []
    if (raw.length === 0) {
      return { output: 'error: todos must be a non-empty array of {text, status}', ok: false }
    }
    const items: TodoItem[] = []
    for (const row of raw) {
      const text = typeof (row as Record<string, unknown>)?.text === 'string' ? (row as { text: string }).text.trim() : ''
      const status = typeof (row as Record<string, unknown>)?.status === 'string' ? (row as { status: string }).status : ''
      if (!text) return { output: 'error: every todo needs a non-empty text', ok: false }
      if (!STATUSES.has(status)) {
        return { output: `error: "${text}" has status "${status}" — use pending, in_progress or done`, ok: false }
      }
      items.push({ text: text.slice(0, 200), status: status as TodoItem['status'] })
    }
    ctx.setTodos?.(items)
    const done = items.filter((i) => i.status === 'done').length
    return { output: `plan updated — ${items.length} rows, ${done} done\n${render(items)}`, ok: true }
  },
}
