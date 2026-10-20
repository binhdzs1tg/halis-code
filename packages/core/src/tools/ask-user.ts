/**
 * Structured question card: the model asks the user one concrete question
 * with suggested answers instead of guessing. The host renders it; print
 * mode has no user on the line, so the call declines politely and the
 * model makes the reasonable default choice itself.
 */
import type { Tool, ToolOutcome } from '../types.js'

export const askUserTool: Tool = {
  spec: {
    name: 'ask_user',
    description:
      'Ask the user one concrete question and wait for the answer. Use it when a decision is ' +
      'genuinely the user\'s to make — a destructive choice, a missing requirement, an ambiguous ' +
      'scope — not when re-reading the task or the files would settle it. Offer 2-4 concrete ' +
      'answer options when you can; free text stays possible either way.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, self-contained and answerable in one line' },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Suggested answers, 2-4 of them; optional',
        },
      },
      required: ['question'],
    },
  },
  async run(input, ctx): Promise<ToolOutcome> {
    const question = typeof input.question === 'string' ? input.question.trim() : ''
    if (!question) return { ok: false, output: 'Parameter "question" is required.' }
    const rawChoices = Array.isArray(input.choices) ? input.choices : []
    // Trimmed, deduped and capped: duplicate options would render as double
    // rows and the number shortcuts would answer an arbitrary twin.
    const seen = new Set<string>()
    const choices: string[] = []
    for (const raw of rawChoices) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      if (trimmed.length === 0 || seen.has(trimmed)) continue
      seen.add(trimmed)
      choices.push(trimmed)
      if (choices.length === 4) break
    }

    if (!ctx.askUser) {
      return {
        ok: false,
        output:
          'No user is available to answer in this mode. Decide yourself using the most reasonable ' +
          'default, state the assumption, and keep going.',
      }
    }
    const answer = await ctx.askUser({ question, ...(choices.length > 0 ? { choices } : {}) })
    if (answer.cancelled || answer.text.length === 0) {
      return {
        ok: false,
        output:
          'The user skipped the question. Proceed with the most reasonable default, state the assumption, and keep going.',
      }
    }
    return { ok: true, output: `The user answered: ${answer.text}` }
  },
}
