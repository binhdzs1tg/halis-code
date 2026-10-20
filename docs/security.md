# Security design notes

The policy — how to report, what is in scope — lives in
[SECURITY.md](../SECURITY.md). This page explains the *design*: where
the trust boundaries are, and which guardrail catches what.

## The premise

A coding agent executes what a model decides. The model's output is
therefore **untrusted input with execution rights** — the premise every
guardrail in this repo starts from. The design goal is not to make the
model wise (nobody can), but to keep the human in charge of everything
that crosses the boundary between "the model said" and "the machine
did".

## The boundaries

### Command approval

Every shell command the model wants goes through the approval gate
before it runs. Three modes, set with `/yolo`, `HALIS_PERMISSIONS`, or
the `--yolo` flag:

- `default` — ask for every bash call.
- `auto` — ask only for commands the risk heuristics flag.
- `yolo` — ask never. The name is a warning.

The risk heuristics (`packages/core/src/risky.ts` and the desktop
counterpart) label *why* something asks: recursive or forced deletion,
elevated privileges, force-pushes, disk writes to device nodes,
download-then-run patterns, pipes into shells, world-writable
permissions, registry publishes, machine shutdowns, forced kills,
bulk deletes. The approval card shows the reason — a human asked to
decide should also be told what they are deciding *about*.

### The fetch guard

`web_fetch` refuses private addresses before any socket opens:
loopback and link-local, RFC 1918 space, unique local addresses,
`localhost` and friends, plus `internal`/`local` suffixes. The model
can read the public web; it cannot reach the machine's own network
neighborhood through the tool. Timeouts and byte caps keep a single
fetch from eating the session.

### The renderer is hostile input

The desktop app treats the renderer process as untrusted: it reaches
the main process only through the preload context bridge, and every
`ipcMain` handler validates its arguments before touching the file
system, the terminal or the agent. A compromised renderer can ask for
a lot of things; it cannot reach around the validation.

### Key storage

Desktop: provider keys go into a per-app file under the OS user data
directory, encrypted with Electron `safeStorage` when the platform
offers it, and marked clearly when it could not be. Terminal: keys
live in the environment or `~/.halis/config.json`, the way every cli
tool keeps them — file permissions are the boundary there.

### Process trees

Timeouts and cancels kill the whole process tree — process groups with
SIGTERM-to-SIGKILL escalation on unix, `taskkill /T` on Windows. The
failure mode this prevents is a dead agent with living grandchildren:
the model's `npm run` outlives its timeout and keeps writing to the
workspace. A foreground command that outlives its timeout is instead
promoted to a background job, visible and killable, on every platform.

## The integrity guardrails

Three mechanisms keep long sessions *honest* rather than safe — they
protect the quality of the agent's own context:

- **Compaction** — when the transcript crosses the token budget, older
  history folds into a model-written summary. The cut point never
  splits a tool call from its result, and a verbatim tail keeps the
  current task intact. A dangling `tool_use` would make the next
  request invalid; the cut-point search makes that unrepresentable.
- **The repeat guard** — an identical tool call, canonicalized by deep
  key-sort so argument order cannot hide a repeat, earns escalating
  reminders at calls 3, 5 and 8, and a hard stop at 12. Declined calls
  count too; a model hammering a declined call is exactly the loop
  worth breaking.
- **Spill** — oversized tool output goes to a file under
  `~/.halis/tool-output` with a bounded head/tail preview in the
  transcript and a pointer the model can page through. Nothing is lost
  to silent truncation, and nothing bloats the context either.

## What is deliberately not claimed

- The desktop installers are **unsigned**. macOS shows Gatekeeper
  friction on first launch; Windows may warn. Signing certificates are
  a maintainer purchase away, not a code change.
- There is **no sandbox claim** around bash. The approval gate is the
  boundary; once approved, a command runs with your user's rights.
  `yolo` mode moves that boundary to "everything", which is why its
  name is what it is.
- The model can still *suggest* a bad idea persuasively. Guardrails
  act on execution, not on prose.

## Verification

The ci matrix runs the smoke suites on macOS, Linux and Windows for
every push; the guard heuristics, the fetch guard's address list, the
compaction cut points and the repeat guard all have smoke cases
pinning them. CodeQL scans the tree weekly and on pull requests; the
scorecard workflow grades the supply-chain posture in the open. If you
find a hole in any of it, [SECURITY.md](../SECURITY.md) is the way in.
