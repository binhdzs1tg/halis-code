/**
 * Repeat-call guard: when the model fires the exact same tool call with
 * identical arguments over and over, a reminder rides along with the tool
 * result. The guard is advisory — it never vetoes — and counts declined
 * calls too, since a model hammering a declined call is exactly the loop
 * worth breaking.
 */

/** Escalating nudge points; each level is only reminded once per chain. */
const THRESHOLDS = [3, 5, 8] as const

/** Arguments shown in the detailed reminder, head-truncated. */
const PREVIEW_CHARS = 500

/** Deep key-sort then stringify, so argument order never hides a repeat. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function head(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text
  return `${text.slice(0, PREVIEW_CHARS)}… (+${text.length - PREVIEW_CHARS} more chars)`
}

export class RepeatGuard {
  private key: string | null = null
  private count = 0
  private reminded = new Set<number>()

  /** A new user turn always starts a fresh chain. */
  reset(): void {
    this.key = null
    this.count = 0
    this.reminded.clear()
  }

  /**
   * Record one execution of a tool call. Returns the reminder text to
   * append to the tool result, or null while the call still looks healthy.
   */
  record(tool: string, input: unknown): string | null {
    const key = JSON.stringify([tool, canonicalize(input)])
    if (key === this.key) {
      this.count += 1
    } else {
      this.key = key
      this.count = 1
      this.reminded.clear()
    }

    const level = THRESHOLDS.indexOf(this.count as (typeof THRESHOLDS)[number])
    if (level === -1 || this.reminded.has(this.count)) return null
    this.reminded.add(this.count)

    if (level === 0) {
      return (
        'You are repeating the exact same tool call with identical arguments. Carefully ' +
        'analyze the previous result before calling again: if it failed, change the input ' +
        'or the approach; if it succeeded, move on to the next step instead.'
      )
    }

    return [
      `You have now repeated the exact same tool call ${this.count} times in a row, which is almost never useful.`,
      'Break the loop — pick a materially different strategy:',
      '- tool: ' + tool,
      `- consecutive_calls: ${this.count}`,
      `- arguments: ${head(canonicalize(input))}`,
      '',
      'If the same call keeps producing the same failure, the problem is the plan, not the call. ' +
        'Re-read the error, question your assumptions about the file or environment, and try a ' +
        'different tool, a different scope, or report the blocker to the user.',
    ].join('\n')
  }
}
