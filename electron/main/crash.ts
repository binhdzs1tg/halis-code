/**
 * Crash reports: the complete diagnostic of one fatal failure, written before
 * the dialog so the dialog can name the file. Adapted from DeepSeek Harness
 * desktop — a bounded report directory, newest kept, older ones pruned by
 * file-name order.
 */
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { app, dialog } from 'electron'

/** Reports kept after pruning, newest first by file name. */
const REPORTS_RETAINED = 10

/** Upper bound of the rendered error section. */
const ERROR_SECTION_MAX_CHARS = 256 * 1024

/** The exact generated file name syntax; pruning touches only files that match it. */
const REPORT_NAME = /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-main\.log$/u

/** Whether the failure surfaced before the window was up. */
type Phase = 'startup' | 'running'

function reportFileName(time: Date): string {
  return `crash-${time.toISOString().replaceAll(/[:.]/gu, '-')}-main.log`
}

function renderReport(phase: Phase, error: unknown): string {
  const header = [
    `time: ${new Date().toISOString()}`,
    `phase: ${phase}`,
    `app: halis-code ${app.getVersion()}`,
    `platform: ${process.platform} ${process.arch}`,
    `electron: ${process.versions.electron ?? '?'}`,
    `node: ${process.versions.node ?? '?'}`,
    `pid: ${String(process.pid)}`
  ]
  return [header.join('\n'), '', '--- error ---', boundedError(error), ''].join('\n')
}

function boundedError(error: unknown): string {
  const rendered = inspect(error, {
    depth: 6,
    maxStringLength: 64 * 1024,
    maxArrayLength: 100,
    breakLength: 120
  })
  return rendered.length <= ERROR_SECTION_MAX_CHARS
    ? rendered
    : `${rendered.slice(0, ERROR_SECTION_MAX_CHARS)}\n… (error section cut at ${ERROR_SECTION_MAX_CHARS} characters)`
}

async function writeReport(directory: string, phase: Phase, error: unknown): Promise<string | undefined> {
  const path = join(directory, reportFileName(new Date()))
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path, renderReport(phase, error), { mode: 0o600, flag: 'wx' })
    return path
  } catch (writeError) {
    console.error('shell: crash report could not be written', path, writeError)
    return undefined
  }
}

async function pruneReports(directory: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    console.error('shell: crash report directory could not be listed', directory, error)
    return
  }
  const reports = names.filter((name) => REPORT_NAME.test(name)).sort()
  const excess = reports.slice(0, Math.max(0, reports.length - REPORTS_RETAINED))
  for (const name of excess) {
    try {
      await unlink(join(directory, name))
    } catch (error) {
      console.error('shell: stale crash report could not be removed', join(directory, name), error)
    }
  }
}

let handling = false

/**
 * Whether the window has signalled readiness; used to phase-tag reports.
 * The main window calls this once its page has loaded.
 */
let running = false

export function markRunning(): void {
  running = true
}

async function handleFatal(kind: 'uncaughtException' | 'unhandledRejection', error: unknown): Promise<void> {
  if (handling) return
  handling = true
  const phase: Phase = running ? 'running' : 'startup'
  const directory = join(app.getPath('userData'), 'logs')
  const file = await writeReport(directory, phase, error).catch(() => undefined)
  await pruneReports(directory).catch(() => undefined)
  const message = error instanceof Error ? error.message : String(error)
  const detail = [
    message,
    '',
    file ? `A crash report was written to:\n${file}` : 'The crash report could not be written.'
  ].join('\n')
  // Synchronous box; the process goes away with it for uncaught exceptions.
  dialog.showErrorBox(`Halis Code ${kind === 'uncaughtException' ? 'crashed' : 'hit an error'}`, detail)
}

/**
 * Install the fatal-error handlers. Uncaught exceptions exit after the report
 * is on disk; rejections keep the app alive but are still reported.
 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (error) => {
    void handleFatal('uncaughtException', error).then(() => {
      app.exit(1)
    })
  })
  process.on('unhandledRejection', (reason) => {
    void handleFatal('unhandledRejection', reason)
  })
}
