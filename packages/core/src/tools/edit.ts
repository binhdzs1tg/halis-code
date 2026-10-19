import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { countOccurrences } from '../util.js'

export const editTool: Tool = {
  spec: {
    name: 'edit',
    description:
      'Replace an exact string inside a file. old_string must match exactly, including whitespace, ' +
      'and must be unique unless replace_all is set. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file, absolute or relative to the working directory.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const raw = typeof input.file_path === 'string' ? input.file_path : ''
    const oldString = typeof input.old_string === 'string' ? input.old_string : ''
    const newString = typeof input.new_string === 'string' ? input.new_string : ''
    const replaceAll = input.replace_all === true
    if (!raw.trim() || oldString === '') {
      return { output: 'error: file_path and old_string are required', ok: false }
    }
    if (!ctx.readFiles.has(path.resolve(ctx.cwd, raw))) {
      return { output: `error: read ${raw} before editing it`, ok: false }
    }
    const file = path.resolve(ctx.cwd, raw)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return { output: `error: file not found: ${file}`, ok: false }
    }

    const hits = countOccurrences(text, oldString)
    if (hits === 0) {
      return { output: 'error: old_string not found in the file — copy it exactly from a fresh read', ok: false }
    }
    if (hits > 1 && !replaceAll) {
      return {
        output:
          `error: old_string appears ${hits} times — add surrounding lines to make it unique ` +
          'or set replace_all to true',
        ok: false,
      }
    }

    const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString)
    await writeFile(file, updated, 'utf8')

    const added = newString === '' ? 0 : newString.split('\n').length
    const removed = oldString === '' ? 0 : oldString.split('\n').length
    const scope = replaceAll ? `${hits} place(s)` : '1 place'
    return { output: `edited ${file}: ${scope}, +${added} -${removed} lines`, ok: true }
  },
}
