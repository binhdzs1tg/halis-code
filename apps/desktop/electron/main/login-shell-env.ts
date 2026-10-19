/**
 * Dock/Finder/launcher launches inherit only the window server's
 * environment, so tools configured in the user's shell rc files (nvm, homebrew
 * paths, custom PATH entries) are missing and spawning `git` or `node` fails.
 *
 * Probe the account's login shell once and merge what it reports into
 * `process.env`: run
 * `<shell> -ilc` with a NUL-delimited `env -0` framed by markers, ignore all
 * rc-file noise around it, and give each candidate a deadline.
 */
import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'

const PROBE_TIMEOUT_MS = 10_000
/** Real `env -0` output is kilobytes; beyond this it is rc noise. */
const PROBE_OUTPUT_CAP = 8 * 1024 * 1024
const MARKER = '__HALIS_ENV__'

/** Probe-session keys that say nothing about the user's environment. */
const SKIP = new Set(['PWD', 'SHLVL', '_'])

function candidateShells(): string[] {
  const candidates: string[] = []
  try {
    const shell = userInfo().shell
    if (shell) candidates.push(shell)
  } catch {
    // userInfo can fail in odd sandboxed setups; the defaults still apply.
  }
  candidates.push('/bin/zsh', '/bin/bash', '/bin/sh')
  return [...new Set(candidates)]
}

function probe(shell: string): Promise<Map<string, string> | null> {
  return new Promise((resolve) => {
    const script = `printf %s '${MARKER}START'; command env -0; printf %s '${MARKER}END'`
    // Detached in its own process group so the timeout can kill the whole
    // tree; stdin is closed so rc-file prompts see EOF instead of hanging.
    const child = spawn(shell, ['-ilc', script], {
      env: { ...process.env, DISABLE_AUTO_UPDATE: '1', ZSH_TMUX_AUTOSTARTED: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
      windowsHide: true
    })

    let out = ''
    let settled = false
    const done = (value: Map<string, string> | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
      resolve(value)
    }
    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      // An rc file that prints megabytes is noise, not an environment; cap
      // the accumulator so a heavy probe cannot balloon memory.
      if (out.length > PROBE_OUTPUT_CAP) done(null)
    })
    child.on('error', () => done(null))
    child.on('close', (code) => {
      const start = out.indexOf(`${MARKER}START`)
      const end = out.indexOf(`${MARKER}END`)
      if (code !== 0 || start === -1 || end === -1 || end < start) {
        done(null)
        return
      }
      const body = out.slice(start + `${MARKER}START`.length, end)
      const vars = new Map<string, string>()
      for (const entry of body.split('\0')) {
        const eq = entry.indexOf('=')
        if (eq <= 0) continue
        vars.set(entry.slice(0, eq), entry.slice(eq + 1))
      }
      done(vars.size > 0 ? vars : null)
    })
  })
}

/**
 * Merge one environment into another. Keys the probe session invented are
 * skipped; PATH is combined so the shell's additions come first while
 * entries that only existed in the launch environment survive.
 */
export function mergeEnvironments(
  target: Record<string, string | undefined>,
  probed: ReadonlyMap<string, string>,
  options: { skip?: ReadonlySet<string>; protectedPrefixes?: readonly string[] } = {}
): void {
  const skip = options.skip ?? SKIP
  const prefixes = options.protectedPrefixes ?? []
  for (const [key, value] of probed) {
    if (skip.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) continue
    if (key === 'PATH') {
      const current = target.PATH ?? ''
      const separator = pathSeparator()
      const have = new Set(current.split(separator).filter(Boolean))
      const additions = value.split(separator).filter((entry) => entry && !have.has(entry))
      // Only the shell's new entries go in front; prepending the whole probe
      // would duplicate every path the launch environment already had.
      target.PATH = additions.length > 0 ? `${additions.join(separator)}${separator}${current}` : current
      continue
    }
    if (target[key] === undefined) {
      target[key] = value
    }
  }
}

function pathSeparator(): string {
  return process.platform === 'win32' ? ';' : ':'
}

let applied: Promise<void> | null = null

/**
 * One merged login-shell environment per process. Safe to call before
 * `app.whenReady`; the merge lands whenever the probe finishes and every
 * later spawn picks the enriched environment up.
 */
export function applyLoginShellEnvironment(): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve()
  applied ??= (async () => {
    for (const shell of candidateShells()) {
      const vars = await probe(shell)
      if (vars) {
        mergeEnvironments(process.env, vars, {
          protectedPrefixes: ['HALIS_', 'ELECTRON_', 'npm_', 'NODE_']
        })
        return
      }
    }
  })().catch(() => undefined)
  return applied
}
