import { spawn } from 'node:child_process'
import type { Tool, ToolContext, ToolOutcome } from '../types.js'
import { headTail } from '../util.js'

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 600_000

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, TERM: 'dumb' },
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
      resolve({ stdout, stderr, code, timedOut })
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
      'Interactive commands and long-running servers are not supported; ' +
      'background a server with a trailing & if you must, then poll it with curl.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds, 30000 by default, 600000 at most.',
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
    const rawTimeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : DEFAULT_TIMEOUT
    const timeoutMs = Math.min(Math.max(rawTimeout, 1000), MAX_TIMEOUT)
    const { stdout, stderr, code, timedOut } = await runShell(command, ctx.cwd, timeoutMs, ctx.signal)
    const parts: string[] = []
    if (stdout.trim()) parts.push(stdout.replace(/\n+$/, ''))
    if (stderr.trim()) parts.push(`stderr:\n${stderr.replace(/\n+$/, '')}`)
    let body = parts.join('\n') || '(no output)'
    body = headTail(body, 12_000, 3_000)
    if (timedOut) {
      body += `\nerror: timed out after ${Math.round(timeoutMs / 1000)}s`
      return { output: body, ok: false }
    }
    return { output: `exit ${code ?? '?'}\n${body}`, ok: code === 0 }
  },
}
