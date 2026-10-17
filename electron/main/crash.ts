/**
 * Crash reports: the complete diagnostic of one fatal failure, written before
 * the dialog so the dialog can name the file. Reports live in a bounded
 * directory, newest kept, older ones pruned by file-name order, and renderer-side failures (console errors, crashed render
 * process, failed load) captured into the same pipeline.
 */
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { app, BrowserWindow, dialog } from 'electron'

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
    void handleFatal('uncaughtException', error)
      .then(() => {
        app.exit(1)
      })
      .catch(() => {
        // The report pipeline itself failed; exiting late beats never exiting.
        app.exit(1)
      })
  })
  process.on('unhandledRejection', (reason) => {
    // The app stays alive for rejections, so the guard must release too —
    // a later fatal error still deserves its own report.
    void handleFatal('unhandledRejection', reason)
      .catch(() => undefined)
      .then(() => {
        handling = false
      })
  })
}

/* ---------- renderer-side diagnostics ---------- */

/** Error-level console lines kept for the next report, bounded in bytes. */
const CONSOLE_TAIL_MAX_BYTES = 64 * 1024

/**
 * A byte-bounded ring of error-level console output. Oversized lines are kept
 * whole so stack traces are never cut mid-frame; old lines fall off the front.
 */
export class RendererConsoleTail {
  private lines: string[] = []
  private bytes = 0

  push(line: string): void {
    this.lines.push(line)
    this.bytes += Buffer.byteLength(line) + 1
    while (this.bytes > CONSOLE_TAIL_MAX_BYTES && this.lines.length > 1) {
      const dropped = this.lines.shift()
      this.bytes -= Buffer.byteLength(dropped ?? '') + 1
    }
  }

  format(): string {
    return this.lines.join('\n')
  }
}

/**
 * Route the window's renderer failures into the crash pipeline: console
 * errors feed the tail, and a dead render process, a failed main-frame load
 * or a preload error each write a report and offer recovery.
 */
export function attachWindowDiagnostics(win: BrowserWindow): void {
  const tail = new RendererConsoleTail()

  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      tail.push(`[${details.sourceId || 'renderer'}:${details.lineNumber}] ${details.message}`)
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    void reportWindowFatal(
      `renderer process gone (reason: ${details.reason}, exit code ${details.exitCode})`,
      tail
    ).then((file) => {
      void offerReloadOrQuit(
        win,
        'The renderer process is gone',
        `The window's render process exited unexpectedly (${details.reason}).`,
        file
      )
    })
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    // -3 is ABORTED, the normal outcome of cancelled navigations.
    if (!isMainFrame || errorCode === -3) return
    void reportWindowFatal(
      `main frame failed to load (${errorCode}: ${errorDescription})`,
      tail
    ).then((file) => {
      void offerReloadOrQuit(
        win,
        'The window failed to load',
        `The page did not load: ${errorDescription} (${errorCode}).`,
        file
      )
    })
  })

  win.webContents.on('preload-error', (_event, scriptPath, error) => {
    void reportWindowFatal(`preload script failed: ${scriptPath}\n${inspect(error, { depth: 4 })}`, tail)
    dialog.showErrorBox(
      'Halis Code could not start properly',
      `The preload script failed:\n${scriptPath}\n\n${error instanceof Error ? error.message : String(error)}`
    )
  })
}

/** Write one window-sourced report; returns the file it landed in, if any. */
async function reportWindowFatal(summary: string, tail: RendererConsoleTail): Promise<string | undefined> {
  const directory = join(app.getPath('userData'), 'logs')
  const path = join(directory, reportFileName(new Date()))
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const content = [
      renderReport('running', summary).trimEnd(),
      '',
      '--- renderer console (errors) ---',
      tail.format()
    ].join('\n')
    await writeFile(path, content, { mode: 0o600, flag: 'wx' })
    await pruneReports(directory).catch(() => undefined)
    return path
  } catch (error) {
    console.error('shell: window crash report could not be written', path, error)
    return undefined
  }
}

/** Recovery dialog after a renderer failure: try again or give up. */
async function offerReloadOrQuit(
  win: BrowserWindow,
  message: string,
  detail: string,
  reportFile: string | undefined
): Promise<void> {
  if (win.isDestroyed()) return
  const fullDetail = [detail, reportFile ? `\nA crash report was written to:\n${reportFile}` : '']
    .join('')
    .trim()
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Halis Code',
    message,
    detail: fullDetail,
    buttons: ['Reload', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (result.response === 0) {
    if (!win.isDestroyed()) win.reload()
  } else {
    app.quit()
  }
}
