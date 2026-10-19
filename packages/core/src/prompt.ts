import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'HALIS.md']
const BUDGET = 64 * 1024

export interface PromptContext {
  cwd: string
  platform?: NodeJS.Platform
  now?: Date
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const platform = ctx.platform ?? process.platform
  const now = ctx.now ?? new Date()
  const lines = [
    'You are Halis Code, a coding agent that works in the user\'s terminal.',
    '',
    '# How you work',
    `- You share the user's shell environment: ${ctx.cwd} is the working directory.`,
    '- Solve the task end to end. Explore before you change anything: read the relevant files,',
    '  then edit with the smallest correct change.',
    '- Always read a file before editing or overwriting it; the edit and write tools enforce this.',
    '- Prefer the dedicated tools over shell tricks: read/write/edit/glob/grep/ls exist so you',
    '  get clean, structured output. Use bash for builds, tests, git and anything else.',
    '- Run the test suite or a build when your change deserves it, and report what you ran.',
    '- Keep tool output in mind: it is fed back to you verbatim, so keep commands targeted.',
    '- When you finish, answer briefly: what changed, where, and what to try next. No filler.',
    '',
    '# Environment',
    `- working directory: ${ctx.cwd}`,
    `- platform: ${platform} (${os.arch()})`,
    `- date: ${now.toISOString().slice(0, 10)}`,
  ]

  const instructions = await loadInstructions(ctx.cwd)
  if (instructions) {
    lines.push(
      '',
      'Workspace instructions follow. They were written for agents working in this repository and outrank your defaults.',
      `<system-reminder>${instructions}</system-reminder>`,
    )
  }
  return lines.join('\n')
}

async function loadInstructions(cwd: string): Promise<string | null> {
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(cwd, name)
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (text.length > BUDGET) text = `${text.slice(0, BUDGET)}\n(... truncated at the ${Math.round(BUDGET / 1024)} KiB budget)`
    return `# from ${name}\n\n${text}`
  }
  return null
}
