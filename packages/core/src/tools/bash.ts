import { spawn } from 'node:child_process'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { headTail } from '../util.js'
import { COMMAND_ENV, promoteToJob, startBackgroundJob } from './background.js'

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 600_000

interface ShellResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** The live child, kept only until the run finishes normally. */
  child: ReturnType<typeof spawn> | null
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, ...COMMAND_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, timeoutMs)

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut, child })
    }

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
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
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
    const { stdout, stderr, code, timedOut, child } = await runShell(command, ctx.cwd, timeoutMs, ctx.signal)
    const parts: string[] = []
    if (stdout.trim()) parts.push(stdout.replace(/\n+$/, ''))
    if (stderr.trim()) parts.push(`stderr:\n${stderr.replace(/\n+$/, '')}`)
    let body = parts.join('\n') || '(no output)'
    body = headTail(body, 12_000, 3_000)

    if (timedOut) {
      // A command still alive after SIGTERM went through: keep it running as
      // a job so the work is not thrown away, and tell the model where to look.
      if (child && !child.killed) {
        const job = promoteToJob(command, child)
        return {
          output:
            `timed out after ${Math.round(timeoutMs / 1000)}s — the command is still running as background job ${job.id}\n` +
            `output file: ${job.outputFile}\njob_output with its id shows progress.`,
          ok: false,
        }
      }
      return { output: `${body}\nerror: timed out after ${Math.round(timeoutMs / 1000)}s`, ok: false }
    }
    return { output: `exit ${code ?? '?'}\n${body}`, ok: code === 0 }
  },
}
