import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { fsIgnoresCase, globToRegExp, truncateLine, walk } from '../util.js'

const MAX_MATCHES = 200
const CONTEXT_WIDTH = 240

export const grepTool: Tool = {
  spec: {
    name: 'grep',
    description:
      'Search file contents with a regular expression. Returns file:line: text matches. ' +
      'Searches text files under the working directory, skipping node_modules and .git.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (JavaScript syntax).' },
        path: { type: 'string', description: 'Directory or single file to search. Defaults to the working directory.' },
        include: { type: 'string', description: 'Only consider files matching this glob, e.g. "*.ts".' },
        case_insensitive: { type: 'boolean', description: 'Ignore case. Defaults to false.' },
      },
      required: ['pattern'],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern.trim()) return { output: 'error: pattern is required', ok: false }
    let re: RegExp
    try {
      re = new RegExp(pattern, input.case_insensitive === true ? 'i' : '')
    } catch (err) {
      return { output: `error: invalid pattern: ${String(err)}`, ok: false }
    }
    const includeRe =
      typeof input.include === 'string' && input.include.trim()
        ? globToRegExp(input.include, { ignoreCase: fsIgnoresCase() })
        : null
    const base = path.resolve(ctx.cwd, typeof input.path === 'string' && input.path.trim() ? input.path : '.')

    const out: string[] = []
    let truncated = false
    for await (const file of walk(base, ctx.signal)) {
      if (includeRe && !includeRe.test(path.basename(file))) continue
      let text: string
      try {
        const bytes = await readFile(file)
        if (bytes.subarray(0, 4096).includes(0)) continue
        text = bytes.toString('utf8')
      } catch {
        continue
      }
      // CRLF files: the carriage return would ride along on every line and
      // break $ anchors.
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line === undefined) continue
        if (re.test(line)) {
          const rel = path.relative(base, file).split(path.sep).join('/')
          out.push(`${rel}:${i + 1}: ${truncateLine(line.trim(), CONTEXT_WIDTH)}`)
          if (out.length >= MAX_MATCHES) {
            truncated = true
            break
          }
        }
      }
      if (truncated) break
    }
    if (out.length === 0) return { output: `no matches for ${pattern}`, ok: true }
    const suffix = truncated ? `\n(stopped at ${MAX_MATCHES} matches)` : ''
    return { output: out.join('\n') + suffix, ok: true }
  },
}
