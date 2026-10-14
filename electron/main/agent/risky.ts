/**
 * Risk heuristics for shell commands, kept free of Electron imports so the
 * smoke tests can exercise them. The approval gate lives in approval.ts.
 */

/** Heuristic flags for commands that deserve a human's say-so. */
const RISKY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(?:-[a-z]*[rf][a-z]*\s+|--recursive\s)/i, reason: 'it deletes files recursively' },
  { pattern: /\bsudo\b/i, reason: 'it runs with elevated privileges' },
  { pattern: /\bgit\s+push\b[^;&|]*(?:--force\b|-f\b)/i, reason: 'it force-pushes to a remote' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'it discards local changes permanently' },
  { pattern: /\bgit\s+clean\b/i, reason: 'it deletes untracked files' },
  { pattern: /\bmkfs(?:\.\w+)?\b|\bdd\s+if=/i, reason: 'it can overwrite disk contents' },
  { pattern: /\b(?:curl|wget)\b[^;&|]*\|\s*(?:ba|z|da)?sh\b/i, reason: 'it executes a downloaded script' },
  { pattern: /\bchmod\s+(?:-[a-z]+\s+)*777\b/i, reason: 'it makes files world-writable' },
  { pattern: /\b(?:npm|yarn|pnpm)\s+(?:publish|unpublish)\b/, reason: 'it publishes to a package registry' },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: 'it stops or restarts the machine' },
  { pattern: />\s*\/dev\//, reason: 'it writes directly to a device node' },
  { pattern: /\bkill(?:all)?\b\s+-9\b/i, reason: 'it force-kills processes' },
  { pattern: /\b(?:drop|truncate)\s+(?:table|database)\b/i, reason: 'it destroys database contents' }
]

/** Why a command is flagged, or null when it looks safe to run unchecked. */
export function assessCommand(command: string): string | null {
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(command)) return reason
  }
  return null
}

/** The denial recipe the model sees, mirroring the harness's escalation-at-denial-point. */
export function denialText(reason: string): string {
  return (
    `The command was not approved by the user (${reason}). ` +
    'Do not retry it, and do not work around it with another command — the refusal stands. ' +
    'If the step really needs this, stop and explain to the user why, then let them run it themselves.'
  )
}
