import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { truncateLine } from '../util.js'

const MAX_LINES = 800
const MAX_LINE_WIDTH = 2000

export const readTool: Tool = {
  spec: {
    name: 'read',
    description:
      'Read a text file with line numbers. Optional offset (1-based line) and limit. ' +
      'Read before editing — the edit and write tools refuse to touch files you have not read.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file, absolute or relative to the working directory.' },
        offset: { type: 'number', description: 'First line to show (1-based). Defaults to the start.' },
        limit: { type: 'number', description: 'How many lines to show. Defaults to 800.' },
      },
      required: ['file_path'],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const raw = typeof input.file_path === 'string' ? input.file_path : ''
    if (!raw.trim()) return { output: 'error: file_path is required', ok: false }
    const file = path.resolve(ctx.cwd, raw)
    let info
    try {
      info = await stat(file)
    } catch {
      return { output: `error: file not found: ${file}`, ok: false }
    }
    if (!info.isFile()) return { output: `error: not a regular file: ${file}`, ok: false }

    const bytes = await readFile(file)
    if (bytes.subarray(0, 8192).includes(0)) {
      ctx.readFiles.add(file)
      return { output: `binary file, ${info.size} bytes — not shown`, ok: true }
    }

    // CRLF files read clean: the carriage returns would pollute every line
    // the model quotes back through the edit tool.
    const lines = bytes.toString('utf8').split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const total = lines.length
    const offsetRaw = typeof input.offset === 'number' ? input.offset : 1
    const start = Math.max(1, Math.floor(offsetRaw))
    const limitRaw = typeof input.limit === 'number' ? input.limit : MAX_LINES
    const limit = Math.min(Math.max(1, Math.floor(limitRaw)), MAX_LINES)
    const slice = lines.slice(start - 1, start - 1 + limit)
    const width = String(start - 1 + slice.length).length
    const body = slice
      .map((line, i) => `${String(start + i).padStart(width, ' ')}\t${truncateLine(line, MAX_LINE_WIDTH)}`)
      .join('\n')
    ctx.readFiles.add(file)

    const notes: string[] = []
    if (start > 1) notes.push(`(from line ${start})`)
    if (start - 1 + slice.length < total) notes.push(`(${total - (start - 1 + slice.length)} more lines, raise the offset)`)
    const suffix = notes.length > 0 ? `\n${notes.join(' ')}` : ''
    return { output: body || '(empty file)' + suffix, ok: true }
  },
}
