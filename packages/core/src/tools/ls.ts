import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { formatSize } from '../util.js'

const MAX_ENTRIES = 500

export const lsTool: Tool = {
  spec: {
    name: 'ls',
    description: 'List one directory level. Directories get a trailing slash and sort first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list. Defaults to the working directory.' },
      },
      required: [],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const dir = path.resolve(ctx.cwd, typeof input.path === 'string' && input.path.trim() ? input.path : '.')
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      return { output: `error: cannot list ${dir}: ${String(err)}`, ok: false }
    }
    const dirs: string[] = []
    const files: Array<{ name: string; size: number }> = []
    for (const entry of entries) {
      if (dirs.length + files.length >= MAX_ENTRIES) break
      if (entry.isDirectory()) {
        dirs.push(`${entry.name}/`)
      } else if (entry.isFile()) {
        try {
          const info = await stat(path.join(dir, entry.name))
          files.push({ name: entry.name, size: info.size })
        } catch {
          files.push({ name: entry.name, size: 0 })
        }
      } else if (entry.isSymbolicLink()) {
        // Links used to vanish from the listing entirely — resolve them so
        // the model sees the symlinked dir or file like the user does.
        try {
          const info = await stat(path.join(dir, entry.name))
          if (info.isDirectory()) dirs.push(`${entry.name}/`)
          else files.push({ name: entry.name, size: info.size })
        } catch {
          files.push({ name: entry.name, size: 0 }) // dangling link
        }
      }
    }
    dirs.sort((a, b) => a.localeCompare(b))
    files.sort((a, b) => a.name.localeCompare(b.name))
    const lines = [
      ...dirs,
      ...files.map((f) => `${f.name} (${formatSize(f.size)})`),
    ]
    if (lines.length === 0) return { output: '(empty directory)', ok: true }
    const suffix = lines.length >= MAX_ENTRIES ? `\n(capped at ${MAX_ENTRIES} entries)` : ''
    return { output: lines.join('\n') + suffix, ok: true }
  },
}
