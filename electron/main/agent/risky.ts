/**
 * Risk heuristics for shell commands, kept free of Electron imports so the
 * smoke tests can exercise them. The approval gate lives in approval.ts.
 */

/** Heuristic flags for commands that deserve a human's say-so. */
const RISKY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Flags may sit anywhere in the rm line (`rm -v -rf x`, `rm x -rf` both count).
  { pattern: /\brm\s+(?:[^;&|]*\s)?-{1,2}[a-z]*[rf][a-z]*\b/i, reason: 'it deletes files recursively or by force' },
  { pattern: /\bsudo\b/i, reason: 'it runs with elevated privileges' },
  // -fn, +branch and a global -f force the push just like --force does.
  { pattern: /\bgit\b[^;&|]*\bpush\b[^;&|]*(?:--force(?:-with-lease)?\b|\s-f[a-z]*\b|\s\+\S)/i, reason: 'it force-pushes to a remote' },
  { pattern: /\bgit\s+-f\b[^;&|]*\bpush\b/i, reason: 'it force-pushes to a remote' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'it discards local changes permanently' },
  { pattern: /\bgit\s+clean\b/i, reason: 'it deletes untracked files' },
  { pattern: /\bmkfs(?:\.\w+)?\b|\bdd\s+(?:[^;&|]*\s)?(?:if|of)=\s*\/dev\//i, reason: 'it can overwrite disk contents' },
  { pattern: /\bfind\b[^;&|]*\s-delete\b/i, reason: 'it deletes files in bulk' },
  // Anything piped into a shell runs text the upstream command chose, not the user.
  { pattern: /[^;&|`]*\|\s*(?:ba|z|da)?sh\b/i, reason: 'it pipes command output into a shell' },
  { pattern: /[^;&|`]*\|\s*xargs\s+(?:ba|z|da)?sh\b/i, reason: 'it pipes command output into a shell' },
  // 0777 and a=rwx make files world-writable just like 777 does.
  { pattern: /\bchmod\s+(?:-[a-z]+\s+)*(?:0?777\b|a[=+][rwx]+\b)/i, reason: 'it makes files world-writable' },
  { pattern: /\b(?:npm|yarn|pnpm)\s+(?:publish|unpublish)\b/, reason: 'it publishes to a package registry' },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: 'it stops or restarts the machine' },
  { pattern: />\s*\/dev\//, reason: 'it writes directly to a device node' },
  // -9, -SIGKILL and -s KILL all force-kill.
  { pattern: /\bp?kill(?:all)?\b[^;&|]*\s-(?:9\b|SIGKILL\b|(?:s|e)\s+(?:SIG)?(?:KILL|9)\b)/i, reason: 'it force-kills processes' },
  { pattern: /\btruncate\s+(?:-[a-z]+\s+)*(?:-s\s*0\b|--size\s*=?\s*0\b)/i, reason: 'it empties files' },
  { pattern: /\b(?:drop|truncate)\s+(?:table|database)\b/i, reason: 'it destroys database contents' }
]

/** Why a command is flagged, or null when it looks safe to run unchecked. */
export function assessCommand(command: string): string | null {
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(command)) return reason
  }
  return null
}

/** The denial recipe the model sees. */
export function denialText(reason: string): string {
  return (
    `The command was not approved by the user (${reason}). ` +
    'Do not retry it, and do not work around it with another command — the refusal stands. ' +
    'If the step really needs this, stop and explain to the user why, then let them run it themselves.'
  )
}
