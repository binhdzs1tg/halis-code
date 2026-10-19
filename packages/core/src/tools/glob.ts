import path from 'node:path'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { fsIgnoresCase, globToRegExp, walk } from '../util.js'

const MAX_RESULTS = 200

export const globTool: Tool = {
  spec: {
    name: 'glob',
    description:
      'Find files by glob pattern, e.g. "src/**/*.ts" or "package.json". ' +
      'Results are paths relative to the search directory, newest last is not guaranteed — treat as unsorted.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern. * and ** are supported; ** crosses directories.' },
        path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
      },
      required: ['pattern'],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern.trim()) return { output: 'error: pattern is required', ok: false }
    const base = path.resolve(ctx.cwd, typeof input.path === 'string' && input.path.trim() ? input.path : '.')
    const re = globToRegExp(pattern, { ignoreCase: fsIgnoresCase() })
    const matches: string[] = []
    for await (const file of walk(base, ctx.signal)) {
      const rel = path.relative(base, file).split(path.sep).join('/')
      if (re.test(rel)) {
        matches.push(rel)
        if (matches.length >= MAX_RESULTS) break
      }
    }
    if (matches.length === 0) return { output: `no files match ${pattern}`, ok: true }
    matches.sort()
    const suffix = matches.length >= MAX_RESULTS ? `\n(stopped at ${MAX_RESULTS} files)` : ''
    return { output: matches.join('\n') + suffix, ok: true }
  },
}
