import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { skillCatalogBlock } from './tools/skill.js'

const INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'HALIS.md']
const BUDGET = 64 * 1024
const GIT_TIMEOUT_MS = 5_000

const run = promisify(execFile)

export interface PromptContext {
  cwd: string
  platform?: NodeJS.Platform
  now?: Date
}

/**
 * Project root for the instructions chain: the first ancestor holding a
 * .git directory. Above it the walk stops — another repo's instructions
 * are not ours to read.
 */
function projectRoot(cwd: string): string {
  let current = path.resolve(cwd)
  while (true) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const platform = ctx.platform ?? process.platform
  const now = ctx.now ?? new Date()
  const lines = [
    "You are Halis Code, a coding agent that works in the user's terminal.",
    '',
    '# How you work',
    `- You share the user's shell environment: ${ctx.cwd} is the working directory.`,
    '- Solve the task end to end. Explore before you change anything: read the relevant files,',
    '  then edit with the smallest correct change.',
    '- Always read a file before editing or overwriting it; the edit and write tools enforce this.',
    '- Prefer the dedicated tools over shell tricks: read/write/edit/glob/grep/ls exist so you',
    '  get clean, structured output. Use bash for builds, tests, git and anything else.',
    '- Long-running work (servers, watchers, slow builds) goes through run_in_background on bash;',
    '  a foreground command that outlives its timeout is promoted to a background job, not killed.',
    '- Run the test suite or a build when your change deserves it, and report what you ran.',
    '- Keep tool output in mind: it is fed back to you verbatim, so keep commands targeted.',
    '- When you finish, answer briefly: what changed, where, and what to try next. No filler.',
    '',
    '# Environment',
    `- working directory: ${ctx.cwd}`,
    `- platform: ${platform} (${os.arch()})`,
    `- date: ${now.toISOString().slice(0, 10)}`,
  ]

  const git = await loadGitInfo(ctx.cwd)
  if (git) lines.push(`- git: ${git}`)

  const instructions = await loadInstructions(ctx.cwd)
  if (instructions) {
    lines.push(
      '',
      'Workspace instructions follow. They were written for agents working in this repository and outrank your defaults.',
      `<system-reminder>${instructions}</system-reminder>`,
    )
  }

  const skills = skillCatalogBlock(ctx.cwd)
  if (skills) lines.push('', skills)
  return lines.join('\n')
}

/** Branch and short commit, cached briefly so turns do not shell out twice. */
let gitCache: { root: string; at: number; text: string | null } | null = null

async function loadGitInfo(cwd: string): Promise<string | null> {
  if (gitCache && gitCache.root === cwd && Date.now() - gitCache.at < 60_000) return gitCache.text
  let text: string | null = null
  try {
    const [branch, commit] = await Promise.all([
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: GIT_TIMEOUT_MS }),
      run('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: GIT_TIMEOUT_MS }),
    ])
    const branchName = branch.stdout.trim()
    const commitHash = commit.stdout.trim()
    if (branchName && commitHash && branchName !== 'HEAD') text = `${branchName}@${commitHash}`
  } catch {
    // outside a repo, or git missing — no block
  }
  gitCache = { root: cwd, at: Date.now(), text }
  return text
}

/**
 * The instruction chain: the user's global file first, then AGENTS.md
 * files from the project root down to the cwd, concatenated in order —
 * deeper files refine shallower ones. `AGENTS.override.md` replaces
 * `AGENTS.md` where both exist.
 */
async function loadInstructions(cwd: string): Promise<string | null> {
  const files: string[] = []
  const globalDir = process.env.HALIS_HOME ?? path.join(os.homedir(), '.halis')
  const globalFile = path.join(globalDir, 'AGENTS.md')
  if (await isFile(globalFile)) files.push(globalFile)

  const root = projectRoot(cwd)
  const chain: string[] = []
  let current = path.resolve(cwd)
  while (true) {
    chain.push(current)
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const dir of chain.reverse()) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name)
      if (await isFile(file)) {
        files.push(file)
        break
      }
    }
  }

  const parts: string[] = []
  let used = 0
  for (const file of files) {
    if (used >= BUDGET) break
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const room = BUDGET - used
    if (text.length > room) {
      text = `${text.slice(0, room)}\n(... truncated at the ${Math.round(BUDGET / 1024)} KiB budget)`
    }
    used += text.length
    parts.push(`# from ${file.replace(os.homedir(), '~')}\n\n${text}`)
  }
  if (parts.length === 0) return null
  return parts.join('\n\n')
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
