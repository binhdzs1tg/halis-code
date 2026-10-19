/**
 * Risk heuristics for shell commands. The approval gate in the terminal ui
 * uses these to label what it is asking about, and auto mode uses them to
 * decide what it may approve by itself.
 */

/** Heuristic flags for commands that deserve a human's say-so. */
const RISKY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Flags may sit anywhere in the rm line (`rm -v -rf x`, `rm x -rf` both count).
  { pattern: /\brm\s+(?:[^;&|]*\s)?-{1,2}[a-z]*[rf][a-z]*\b/i, reason: 'it deletes files recursively or by force' },
  { pattern: /\b(?:sudo|doas)\b/i, reason: 'it runs with elevated privileges' },
  // -fn, +branch and a global -f force the push just like --force does.
  { pattern: /\bgit\b[^;&|]*\bpush\b[^;&|]*(?:--force(?:-with-lease)?\b|\s-f[a-z]*\b|\s\+\S)/i, reason: 'it force-pushes to a remote' },
  { pattern: /\bgit\s+-f\b[^;&|]*\bpush\b/i, reason: 'it force-pushes to a remote' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'it discards local changes permanently' },
  { pattern: /\bgit\s+clean\b/i, reason: 'it deletes untracked files' },
  { pattern: /\bmkfs(?:\.\w+)?\b|\bdd\s+(?:[^;&|]*\s)?(?:if|of)=\s*\/dev\//i, reason: 'it can overwrite disk contents' },
  { pattern: /\bfind\b[^;&|]*\s-delete\b/i, reason: 'it deletes files in bulk' },
  // Anything piped into a shell or interpreter runs text the upstream
  // command chose, not the user.
  { pattern: /[^;&|`]*\|\s*(?:(?:ba|z|da)?sh|python3?|perl|node|ruby|pwsh)\b/i, reason: 'it pipes command output into a shell or interpreter' },
  { pattern: /[^;&|`]*\|\s*xargs\s+(?:ba|z|da)?sh\b/i, reason: 'it pipes command output into a shell' },
  // Download-then-run without the pipe: fetched file handed straight to a
  // shell in the same command list.
  { pattern: /\b(?:curl|wget)\b[^;&|]*(?:&&|;)\s*(?:ba|z|da)?sh\b/i, reason: 'it runs a shell script right after downloading it' },
  // Process substitution feeding a download straight into an interpreter.
  { pattern: /<\(\s*(?:curl|wget)\b/i, reason: 'it runs a downloaded script without saving it' },
  // 0777 makes files world-writable, and so does granting write to all or
  // others by symbol. Plain a+x / a=rx only add execute and stay common,
  // safe build idioms.
  { pattern: /\bchmod\s+(?:-[a-z]+\s+)*(?:0?7777\b|0?777\b|[ug]*[ao][ug]*(?:=|\+)[rwx]*w[rwx]*\b)/i, reason: 'it makes files world-writable' },
  { pattern: /\b(?:npm|yarn|pnpm)\s+(?:publish|unpublish)\b/, reason: 'it publishes to a package registry' },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: 'it stops or restarts the machine' },
  // Redirecting into a real device node can clobber hardware; the null and
  // std-fd sinks are among the most common shell idioms and must not teach
  // users to rubber-stamp the approval dialog.
  { pattern: />\s*\/dev\/(?!null\b|stdout\b|stderr\b)/, reason: 'it writes directly to a device node' },
  // -9, -KILL, -SIGKILL, -s KILL and --signal KILL all force-kill.
  { pattern: /\bp?kill(?:all)?\b[^;&|]*\s-(?:9\b|(?:SIG)?KILL\b|(?:s|e)\s+(?:SIG)?(?:KILL|9)\b|-signal\s+(?:SIG)?(?:KILL|9)\b)/i, reason: 'it force-kills processes' },
  { pattern: /\btruncate\s+(?:-[a-z]+\s+)*(?:-s\s*0\b|--size\s*=?\s*0\b)/i, reason: 'it empties files' },
  { pattern: /\b(?:drop|truncate)\s+(?:table|database)\b/i, reason: 'it destroys database contents' },
  // Interpreter one-liners run arbitrary code the same way a piped script
  // does — only the transport differs. Syntax-check flags (-c for ruby and
  // perl, node --check) stay allowed: they execute nothing.
  { pattern: /\bnode\s+(?:--?e[cv]?\b|-p\b|--eval\b|--print\b)/i, reason: 'it runs an inline script through an interpreter' },
  { pattern: /\bpython3?\s+(?:--?e[cv]?\b|-c\b|--eval\b)/i, reason: 'it runs an inline script through an interpreter' },
  { pattern: /\b(?:perl|ruby)\s+(?:-e\b|--eval\b)/i, reason: 'it runs an inline script through an interpreter' },
  { pattern: /\bphp\s+(?:-r\b|--eval\b)/i, reason: 'it runs an inline script through an interpreter' },
  // Windows destroyers: the shell verbs and flags look nothing like their
  // POSIX cousins, and without these the gate only guarded half the machines.
  { pattern: /\bpowershell(?:\.exe)?\b[^;&|]*remove-item\b[^;&|]*-(?:recurse|force)\b/i, reason: 'it deletes files recursively or by force' },
  { pattern: /\b(?:del|erase|rd|rmdir)\b[^;&|]*\/s\b/i, reason: 'it deletes files in bulk' },
  { pattern: /\bformat\s+[a-z]:/i, reason: 'it can wipe a whole drive' },
  { pattern: /\bdiskpart\b/i, reason: 'it can reconfigure or wipe disks' },
  { pattern: /\bcipher\s+\/w\b/i, reason: 'it overwrites free space beyond recovery' },
  { pattern: /\breg\s+delete\b/i, reason: 'it removes registry entries' },
  { pattern: /\bdocker\s+(?:system|volume|image|container)\s+prune\b/i, reason: 'it bulk-deletes docker state' },
  { pattern: /\bcrontab\s+-r\b/i, reason: 'it removes the whole crontab' },
  { pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i, reason: 'it discards stashed work' }
]

/** Destructive verbs are only checked against commands that also carry a
 *  substitution: matching them unconditionally would flag innocuous text
 *  that merely mentions them. */
const SUBSTITUTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b[^;&|]*-{1,2}[a-z]*[rf][a-z]*\b/i, reason: 'it deletes files recursively or by force' },
  { pattern: /\bmkfs(?:\.\w+)?\b/i, reason: 'it can overwrite disk contents' },
  { pattern: /\bdd\b[^;&|]*=\s*\/dev\//i, reason: 'it can overwrite disk contents' },
  { pattern: /\btruncate\b[^;&|]*-s\s*=?\s*0\b/i, reason: 'it empties files' }
]

/** The sh-literal form of the command: quote removal and backslash escapes
 *  applied, so `r'm' -rf` or `r\m -rf` read as the rm invocation they become
 *  when a shell actually runs the string. */
function shellLiteralForm(command: string): string {
  return command.replace(/\\(.)/g, '$1').replace(/['"]/g, '')
}

/** Why a command is flagged, or null when it looks safe to run unchecked. */
export function assessCommand(command: string): string | null {
  const literal = shellLiteralForm(command)
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(command) || pattern.test(literal)) return reason
  }
  // A substitution body runs at execution time, so a destructive verb parked
  // inside $( ) or backticks must not hide from the heuristics above.
  if (/\$\(|`/.test(command)) {
    for (const { pattern, reason } of SUBSTITUTION_PATTERNS) {
      if (pattern.test(command)) return reason
    }
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
