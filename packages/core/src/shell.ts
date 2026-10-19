/**
 * One place that knows how a command line reaches a shell on this machine.
 * The bash tool, background jobs and the terminal's `!` passthrough all
 * spawn through it, so Windows, macOS and Linux get the same story: the
 * user's login shell on unix (cmd.exe on Windows), a `HALIS_SHELL` override
 * for everything else, and a tree-kill that reaches grandchildren on every
 * platform — a bare child.kill() only ever reaches the shell itself and
 * leaves `npm run` workers behind.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { userInfo } from 'node:os'

/** How the command string is handed to the shell. */
export type ShellSpec =
  | {
      /** argv style: spawn(program, [...prefix, command]) — every posix shell. */
      style: 'argv'
      program: string
      args: string[]
      label: string
    }
  | {
      /** cmdline style: spawn(command, { shell }) — Windows quoting rules. */
      style: 'cmdline'
      shell: string
      label: string
    }

/** Escalation grace before a SIGTERM becomes a SIGKILL. */
const KILL_GRACE_MS = 2_000

function basename(program: string): string {
  const tail = program.split(/[\\/]/).pop() ?? program
  return tail.replace(/\.exe$/i, '').toLowerCase()
}

/** What a forced HALIS_SHELL wants: posix shells take -c, powershell takes
 *  -Command, and anything else must behave like cmd for node's shell spawn. */
function forcedSpec(shell: string, platform: NodeJS.Platform): ShellSpec {
  const label = basename(shell)
  if (platform === 'win32' && !/(^|\/)(bash|zsh|sh|dash|ash|ksh)$/.test(label)) {
    if (label === 'pwsh' || label === 'powershell') {
      return { style: 'argv', program: shell, args: ['-NoProfile', '-NonInteractive', '-Command'], label }
    }
    return { style: 'cmdline', shell, label: label || 'shell' }
  }
  return { style: 'argv', program: shell, args: ['-c'], label: label || 'shell' }
}

function loginShell(): string {
  try {
    return userInfo().shell || ''
  } catch {
    return ''
  }
}

/**
 * Resolve the shell for a platform and environment. Pure, so the smoke
 * tests can pin a platform without being on it; the process caches
 * nothing — callers resolve once if they care.
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellSpec {
  const forced = env.HALIS_SHELL?.trim()
  if (forced) return forcedSpec(forced, platform)
  if (platform === 'win32') {
    return { style: 'cmdline', shell: env.ComSpec?.trim() || 'cmd.exe', label: 'cmd' }
  }
  const shell = env.SHELL?.trim() || loginShell() || '/bin/bash'
  return { style: 'argv', program: shell, args: ['-c'], label: basename(shell) }
}

/** The shell's short name — prompts and status lines show it to the model. */
export function shellLabel(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string {
  return resolveShell(platform, env).label
}

/**
 * Spawn a command line through the resolved shell. Unix children run
 * detached in their own process group so a later group-kill reaches the
 * whole tree; on Windows that flag would open a new console instead, and
 * taskkill handles trees there.
 */
export function spawnShellCommand(command: string, options: SpawnOptions = {}): ChildProcess {
  const spec = resolveShell()
  if (spec.style === 'cmdline') {
    return spawn(command, {
      ...options,
      shell: spec.shell,
      windowsHide: true,
    })
  }
  return spawn(spec.program, [...spec.args, command], {
    ...options,
    windowsHide: true,
    detached: process.platform !== 'win32' && options.detached !== false,
  })
}

/**
 * Kill a spawned command's whole process tree. Posix shells lead a group
 * (see spawnShellCommand), so the negative pid takes the children down;
 * taskkill /T walks the tree on Windows. Escalates to a hard kill after a
 * grace period unless `force` — the quit path uses force, because an
 * unref'd escalation timer never fires once the process is leaving.
 */
export function killTree(child: ChildProcess, force = false): void {
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      const kill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      // A missing taskkill must not take the app down on the way out.
      kill.on('error', () => undefined)
      kill.unref()
    }
    return
  }
  const pid = child.pid
  const signalTree = (signal: NodeJS.Signals): void => {
    if (pid !== undefined) {
      try {
        process.kill(-pid, signal)
      } catch {
        // group already gone; the direct kill below is a no-op then
      }
    }
    try {
      child.kill(signal)
    } catch {
      // already exited
    }
  }
  signalTree(force ? 'SIGKILL' : 'SIGTERM')
  if (force) return
  const escalation = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    signalTree('SIGKILL')
  }, KILL_GRACE_MS)
  escalation.unref()
  child.once('close', () => clearTimeout(escalation))
}
