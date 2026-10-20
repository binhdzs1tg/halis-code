/**
 * Background command jobs: long commands return to the model immediately,
 * stream their output to a file the model can page through, and one
 * completion notice fires when they settle. Foreground commands that hit
 * their timeout are promoted into a job instead of being killed — a build
 * that needed two more minutes should finish, not die.
 */
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { killTree, spawnShellCommand } from '../shell.js'

/** Model-friendly env, shared with the foreground runner. */
export const COMMAND_ENV: Record<string, string> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
}

/** Concurrent background commands beyond this are refused. */
const MAX_RUNNING_JOBS = 8

/** Settled jobs kept around for job_output reads. */
const MAX_SETTLED_JOBS = 25

/** Output files older than this are swept when the store wakes up. */
const RETENTION_MS = 7 * 24 * 60 * 60_000

export interface ShellJob {
  id: string
  command: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode: number | null
  startedAt: number
  finishedAt: number | null
  /** Full output file; the model pages through it with job_output. */
  outputFile: string
}

export interface JobHandle {
  id: string
  outputFile: string
}

const jobs = new Map<string, ShellJob>()
const children = new Map<string, ChildProcess>()
const streams = new Map<string, fs.WriteStream>()
let settleSink: ((job: ShellJob) => void) | null = null

/** Where completion notices go; the host points this at its ui. */
export function setJobSink(notify: ((job: ShellJob) => void) | null): void {
  settleSink = notify
}

function jobsDir(): string {
  const base =
    process.env.HALIS_JOBS_DIR ??
    path.join(process.env.HALIS_HOME ?? path.join(os.homedir(), '.halis'), 'jobs')
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    const cutoff = Date.now() - RETENTION_MS
    for (const entry of fs.readdirSync(base)) {
      const target = path.join(base, entry)
      try {
        const stat = fs.statSync(target)
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(target)
      } catch {
        // unreadable entries are none of our business
      }
    }
  } catch {
    // no directory yet — created on demand
  }
  return base
}

function nextId(): string {
  return `sh-${randomBytes(3).toString('hex')}`
}

/** Running count gate; foreground promotions bypass nothing. */
function runningCount(): number {
  let count = 0
  for (const job of jobs.values()) if (job.status === 'running') count += 1
  return count
}

/**
 * Spawn a command as a tracked background job. Output streams to a file;
 * the model reads it back with job_output. Refuses when the runner is
 * already saturated — eight concurrent dev servers is a mistake, not a
 * feature.
 */
export function startBackgroundJob(command: string, cwd: string): { id: string; outputFile: string } | { error: string } {
  if (runningCount() >= MAX_RUNNING_JOBS) {
    return { error: `too many background jobs are already running (${MAX_RUNNING_JOBS}) — job_kill one first` }
  }
  const id = nextId()
  const outputFile = path.join(jobsDir(), `${id}.out`)
  let child: ChildProcess
  try {
    child = spawnShellCommand(command, {
      cwd,
      env: { ...process.env, ...COMMAND_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const job: ShellJob = {
    id,
    command,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    outputFile,
  }
  jobs.set(id, job)
  children.set(id, child)
  attachOutput(id, child, outputFile)
  child.once('close', (code, signal) => settleJob(id, code, signal))
  return { id, outputFile }
}

/** Attach output collection to a child that may have started in the foreground.
 *  `seed` pre-fills the file — a promoted job keeps the output its foreground
 *  life had already produced. */
function attachOutput(id: string, child: ChildProcess, outputFile: string, seed = ''): void {
  try {
    const stream = fs.createWriteStream(outputFile, { flags: 'w', mode: 0o600 })
    streams.set(id, stream)
    if (seed) stream.write(seed)
    child.stdout?.on('data', (chunk: Buffer) => stream.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stream.write(chunk))
  } catch {
    // no output file — job_output reports the gap honestly
  }
}

/** Promote a timed-out foreground child into a job instead of killing it.
 *  `preOutput` is the output the foreground run already collected. */
export function promoteToJob(command: string, child: ChildProcess, preOutput = ''): JobHandle {
  const id = nextId()
  const outputFile = path.join(jobsDir(), `${id}.out`)
  const job: ShellJob = {
    id,
    command,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    outputFile,
  }
  jobs.set(id, job)
  children.set(id, child)
  attachOutput(id, child, outputFile, preOutput)
  child.once('close', (code, signal) => settleJob(id, code, signal))
  return { id, outputFile }
}

function settleJob(id: string, code: number | null, signal?: string | null): void {
  const job = jobs.get(id)
  if (!job || job.status !== 'running') return
  const stream = streams.get(id)
  streams.delete(id)
  children.delete(id)
  job.status = code === 0 ? 'completed' : signal ? 'killed' : 'failed'
  job.exitCode = code
  job.finishedAt = Date.now()

  const finishSettle = (): void => {
    // Trim the settled shelf: the oldest finished jobs fall off first.
    const settled = [...jobs.values()].filter((j) => j.status !== 'running')
    if (settled.length > MAX_SETTLED_JOBS) {
      settled
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
        .slice(0, settled.length - MAX_SETTLED_JOBS)
        .forEach((j) => jobs.delete(j.id))
    }
    settleSink?.(job)
  }

  if (stream && !stream.destroyed && !stream.writableFinished) {
    // The completion notice carries the output tail, so the last bytes must
    // be on disk before the notice fires — end the stream and wait for it.
    stream.end(() => finishSettle())
  } else {
    finishSettle()
  }
}

export function getJob(id: string): ShellJob | null {
  return jobs.get(id) ?? null
}

export function listJobs(): ShellJob[] {
  return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** Kill one job's process tree. 'killed' when a running job got the signal,
 *  'settled' when the job had already finished, 'unknown' for a bad id. */
export function killJob(id: string): 'killed' | 'settled' | 'unknown' {
  const job = jobs.get(id)
  if (!job) return 'unknown'
  const child = children.get(id)
  if (child) {
    killTree(child)
    return 'killed'
  }
  if (job.status === 'running') {
    job.status = 'killed'
    job.finishedAt = Date.now()
    settleSink?.(job)
    return 'killed'
  }
  return 'settled'
}

/** Output characters job_output keeps inline around a page cut. */
const JOB_OUTPUT_PAGE = 12_000

/**
 * Page through a job's output: the tail by default, or a window at
 * `offsetChars` from the start. Reports the file size either way so the
 * model knows when it has seen everything.
 */
export function jobOutput(id: string, offsetChars?: number): string {
  const job = jobs.get(id)
  if (!job) {
    const known = [...jobs.keys()].map((k) => k).join(', ')
    return `error: unknown job "${id}"${known ? ` — known: ${known}` : ''}`
  }
  let size = 0
  try {
    size = fs.statSync(job.outputFile).size
  } catch {
    size = 0
  }
  const status = job.status === 'running' ? 'still running' : `${job.status} (exit ${job.exitCode ?? '?'})`
  const header = `job ${job.id} — ${status}\ncommand: ${job.command}\noutput file: ${job.outputFile} (${size} bytes)`

  let content = ''
  try {
    content = fs.readFileSync(job.outputFile, 'utf8')
  } catch {
    return `${header}\n\n(no output yet)`
  }

  const offset = Math.max(0, Math.trunc(offsetChars ?? Math.max(0, content.length - JOB_OUTPUT_PAGE)))
  const window = content.slice(offset, offset + JOB_OUTPUT_PAGE)
  const parts = [header, '']
  if (offset > 0) parts.push(`[…skipped to character ${offset}…]`)
  parts.push(window || '(empty)')
  if (offset + window.length < content.length) {
    parts.push('', `…more output follows — call job_output again with offset_chars ${offset + window.length}`)
  }
  return parts.join('\n')
}

/** Test seam: forget every job and its children. */
export function resetJobsForTests(): void {
  for (const child of children.values()) killTree(child, true)
  children.clear()
  for (const stream of streams.values()) stream.destroy()
  streams.clear()
  jobs.clear()
}
