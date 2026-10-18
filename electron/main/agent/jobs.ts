/**
 * Background command jobs: long commands return to the model immediately,
 * stream their output to a file the model can page through, and push one
 * completion notice when they settle — no polling, no lost dev servers.
 * Foreground commands that hit their timeout are promoted into a job
 * instead of being killed. Pure Node, no Electron imports.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { JobNoticeEvent } from '../../shared/types'

/** Model-friendly env, shared with the foreground runner in tools.ts. */
export const COMMAND_ENV: Record<string, string> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0'
}

/** Concurrent background commands beyond this are refused. */
const MAX_RUNNING_JOBS = 8

/** Settled jobs kept around for job_output reads. */
const MAX_SETTLED_JOBS = 25

/** Output files older than this are swept on startup. */
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
/** Output streams per active job; settled notices read only flushed bytes. */
const streams = new Map<string, fs.WriteStream>()
const killRequested = new Set<string>()
let outputBase: string | null = null
let sink: ((event: JobNoticeEvent) => void) | null = null

/** Where completion notices go; the run loop points this at the window. */
export function setJobSink(notify: ((event: JobNoticeEvent) => void) | null): void {
  sink = notify
}

export function configureJobStore(userDataDir: string): void {
  outputBase = path.join(userDataDir, 'jobs')
  try {
    fs.mkdirSync(outputBase, { recursive: true, mode: 0o700 })
    const cutoff = Date.now() - RETENTION_MS
    for (const entry of fs.readdirSync(outputBase)) {
      const target = path.join(outputBase, entry)
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
}

function jobsDir(): string {
  const base = outputBase ?? path.join(os.tmpdir(), 'halis-jobs')
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  } catch {
    // best effort; the write stream will complain if it matters
  }
  return base
}

function nextId(): string {
  return `sh-${randomBytes(3).toString('hex')}`
}

/**
 * Reserve an id and an output file for a command. The record itself is
 * only created on activation, so a foreground command that finishes
 * normally never exists as a job.
 */
export function allocateJob(): JobHandle {
  const id = nextId()
  return { id, outputFile: path.join(jobsDir(), `${id}.out`) }
}

function register(handle: JobHandle, command: string, child: ChildProcess): ShellJob {
  const job: ShellJob = {
    id: handle.id,
    command,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    outputFile: handle.outputFile
  }
  jobs.set(handle.id, job)
  children.set(handle.id, child)
  child.once('close', (code) => settleJob(handle.id, code))
  return job
}

function settleJob(id: string, code: number | null): void {
  const job = jobs.get(id)
  if (!job || job.status !== 'running') return
  const stream = streams.get(id)
  if (stream && !stream.destroyed && !stream.writableFinished) {
    // The completion notice carries the job's output tail, so the last
    // buffered chunk must reach the file before anything reads it — a
    // quick `echo` can otherwise settle with an empty notice. Wait on
    // 'close', not 'finish': it fires after a clean flush AND after an
    // error destroy, so an unwritable file settles instead of wedging.
    try {
      stream.end()
    } catch {
      // end already requested; the close event still fires
    }
    stream.once('close', () => settleJob(id, code))
    return
  }
  streams.delete(id)
  children.delete(id)
  job.exitCode = code
  job.finishedAt = Date.now()
  job.status = killRequested.has(id) ? 'killed' : code === 0 ? 'completed' : 'failed'
  killRequested.delete(id)
  pruneSettled()
  const event: JobNoticeEvent = {
    jobId: id,
    command: job.command,
    status: job.status,
    exitCode: job.exitCode,
    output: tailChars(job.outputFile, 4_000),
    outputFilePath: job.outputFile
  }
  sink?.(event)
}

function pruneSettled(): void {
  const settled = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  for (const job of settled.slice(MAX_SETTLED_JOBS)) {
    jobs.delete(job.id)
  }
}

/** A foreground command finished on its own; its reserved handle dissolves
 *  and the placeholder output file goes with it — only promoted jobs keep
 *  their file around for job_output reads. */
export function releaseJob(handle: JobHandle): void {
  jobs.delete(handle.id)
  children.delete(handle.id)
  streams.delete(handle.id)
  fs.rm(handle.outputFile, { force: true }, () => {})
}

/**
 * Hand a live child to the registry — either a run_in_background start or
 * a foreground command being promoted after its timeout.
 */
export function activateJob(handle: JobHandle, command: string, child: ChildProcess): ShellJob {
  return register(handle, command, child)
}

/**
 * Register the output stream a caller keeps for a job, so the settle path
 * can wait for the final flush before reading the file's tail.
 */
export function attachJobStream(id: string, stream: fs.WriteStream): void {
  streams.set(id, stream)
}

/** Count of still-running jobs, for the concurrency cap. */
export function runningJobCount(): number {
  let count = 0
  for (const job of jobs.values()) {
    if (job.status === 'running') count += 1
  }
  return count
}

export interface SpawnedJob {
  job: ShellJob
  child: ChildProcess
}

/**
 * Spawn a command as a background job. Refuses when too many are already
 * running — the model should stop one first.
 */
export function startBackgroundJob(command: string, root: string, timeoutMs: number): SpawnedJob {
  if (runningJobCount() >= MAX_RUNNING_JOBS) {
    throw new Error(
      `Too many background commands are already running (max ${MAX_RUNNING_JOBS}). Stop one with job_kill first.`
    )
  }
  const handle = allocateJob()
  const child = spawn(command, {
    shell: true,
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ...COMMAND_ENV },
    detached: process.platform !== 'win32'
  })
  const stream = fs.createWriteStream(handle.outputFile, { flags: 'w' })
  streams.set(handle.id, stream)
  // An unwritable output file must not take the process down; the job
  // keeps running and job_output just reports an empty tail.
  let streamBroken = false
  stream.on('error', () => {
    streamBroken = true
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  const holdBack = (): void => {
    // The disk cannot keep up; hold the child back instead of letting the
    // file stream buffer the whole output in memory.
    child.stdout?.pause()
    child.stderr?.pause()
    stream.once('drain', () => {
      child.stdout?.resume()
      child.stderr?.resume()
    })
  }
  child.stdout?.on('data', (chunk: string) => {
    if (!streamBroken && !stream.write(chunk)) holdBack()
  })
  child.stderr?.on('data', (chunk: string) => {
    if (!streamBroken && !stream.write(chunk)) holdBack()
  })
  child.once('close', () => stream.end())
  child.once('error', () => stream.end())
  const job = activateJob(handle, command, child)
  if (timeoutMs > 0) {
    const timer = setTimeout(() => {
      killJob(job.id)
    }, timeoutMs)
    timer.unref()
    child.once('close', () => clearTimeout(timer))
  }
  return { job, child }
}

/** Kill a job's whole process tree, escalating after a grace period. */
export function killJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job || job.status !== 'running') return false
  killRequested.add(id)
  const child = children.get(id)
  if (!child) return true
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    }
    return true
  }
  if (child.pid === undefined) {
    child.kill()
    return true
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill()
    return true
  }
  const pid = child.pid
  const escalation = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill()
    }
  }, 2_000)
  escalation.unref()
  child.once('close', () => clearTimeout(escalation))
  return true
}

export function jobStatus(id: string): ShellJob | null {
  return jobs.get(id) ?? null
}

/** Kill every running job; called on quit — the spawns are detached, so
 *  without this the shells would outlive the app with no way to stop them. */
export function stopAllJobs(): void {
  for (const id of [...jobs.keys()]) {
    killJob(id)
  }
}

/** The last `maxChars` of a job's output file, decoded safely. */
export function tailChars(file: string, maxChars: number): string {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size === 0) return ''
    const bytes = Math.min(stat.size, maxChars * 4 + 8)
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      fs.readSync(fd, buffer, 0, bytes, stat.size - bytes)
      // The slice starts mid-byte only when the tail began inside a
      // multi-byte character; trimming one replacement char is enough.
      return buffer.toString('utf8').replace(/^\uFFFD/, '').slice(-maxChars)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}
