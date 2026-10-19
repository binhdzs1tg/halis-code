import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'

export const writeTool: Tool = {
  spec: {
    name: 'write',
    description:
      'Create or overwrite a file with the given content. Parent directories are created as needed. ' +
      'Read an existing file first — writing over a file you have not read is refused.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file, absolute or relative to the working directory.' },
        content: { type: 'string', description: 'Full content to write. The file is replaced entirely.' },
      },
      required: ['file_path', 'content'],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const raw = typeof input.file_path === 'string' ? input.file_path : ''
    const content = typeof input.content === 'string' ? input.content : ''
    if (!raw.trim()) return { output: 'error: file_path is required', ok: false }
    const file = path.resolve(ctx.cwd, raw)

    try {
      const existing = await stat(file)
      if (!existing.isFile()) return { output: `error: not a regular file: ${file}`, ok: false }
      if (!ctx.readFiles.has(file)) {
        const head = (await readFile(file, 'utf8')).split('\n').slice(0, 5).join('\n')
        return {
          output:
            `error: ${path.basename(file)} exists and has not been read this session. ` +
            `Read it first (it starts with: ${JSON.stringify(head)}) or pick another path.`,
          ok: false,
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { output: `error: cannot write ${file}: ${String(err)}`, ok: false }
      }
    }

    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
    return { output: `wrote ${Buffer.byteLength(content)} bytes to ${file}`, ok: true }
  },
}
