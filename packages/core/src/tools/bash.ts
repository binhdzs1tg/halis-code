import type { ChildProcess } from 'node:child_process'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { headTail } from '../util.js'
import { killTree, spawnShellCommand } from '../shell.js'
import { COMMAND_ENV, promoteToJob, startBackgroundJob, type JobHandle } from './background.js'

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 600_000

interface ShellResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** The promoted handle when the command outlived its timeout, else null. */
  promoted: JobHandle | null
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawnShellCommand(command, {
      cwd,
      env: { ...process.env, ...COMMAND_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let promoted: JobHandle | null = null
    let settled = false

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, code, timedOut, promoted })
    }

    const timer = setTimeout(() => {
      // Promote instead of killing: the work is not thrown away, the job
      // reports back when it settles, and the output collected so far still
      // goes inline so the model can react to it.
      timedOut = true
      promoted = promoteToJob(command, child)
      finish(null)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 200_000) stdout = stdout.slice(0, 200_000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 100_000) stderr = stderr.slice(0, 100_000)
    })
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
    child.on('exit', (code) => finish(code))

    const onAbort = () => {
      timedOut = false
      killTree(child)
      finish(null)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('close', () => signal.removeEventListener('abort', onAbort))
  })
}

export const bashTool: Tool = {
  spec: {
    name: 'bash',
    description:
      'Run a shell command in the working directory and see its output. ' +
      'The platform shell runs it — the user login shell on macOS and Linux, ' +
      'cmd.exe on Windows — so use syntax that shell understands. ' +
      'Use for builds, tests, git, package managers and quick inspections. ' +
      'Long-running work (dev servers, watchers, big builds) wants run_in_background: ' +
      'the call returns immediately with a job id, output goes to a file, and job_output ' +
      'reads it. A foreground command that outlives its timeout is promoted to a ' +
      'background job instead of being killed.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds, 30000 by default, 600000 at most.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Start the command as a background job and return its id at once.',
        },
      },
      required: ['command'],
    },
  },
  async run(input, ctx: ToolContext): Promise<ToolOutcome> {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) {
      return { output: 'error: command is required', ok: false }
    }

    if (input.run_in_background === true) {
      const started = startBackgroundJob(command, ctx.cwd)
      if ('error' in started) return { output: `error: ${started.error}`, ok: false }
      return {
        output:
          `started background job ${started.id}\noutput file: ${started.outputFile}\n` +
          'job_output with its id shows progress; the completion notice arrives on its own.',
        ok: true,
      }
    }

    const rawTimeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : DEFAULT_TIMEOUT
    const timeoutMs = Math.min(Math.max(rawTimeout, 1000), MAX_TIMEOUT)
    const { stdout, stderr, code, timedOut, promoted } = await runShell(command, ctx.cwd, timeoutMs, ctx.signal)
    const parts: string[] = []
    if (stdout.trim()) parts.push(stdout.replace(/\n+$/, ''))
    if (stderr.trim()) parts.push(`stderr:\n${stderr.replace(/\n+$/, '')}`)
    let body = parts.join('\n') || '(no output)'
    body = headTail(body, 12_000, 3_000)

    if (promoted) {
      return {
        output:
          `timed out after ${Math.round(timeoutMs / 1000)}s — the command is still running as background job ${promoted.id}\n` +
          `output file: ${promoted.outputFile}\njob_output with its id shows progress.`,
        ok: false,
      }
    }
    if (timedOut) {
      return { output: `${body}\nerror: timed out after ${Math.round(timeoutMs / 1000)}s`, ok: false }
    }
    return { output: `exit ${code ?? '?'}\n${body}`, ok: code === 0 }
  },
}
