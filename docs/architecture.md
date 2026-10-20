# Architecture

How Halis Code fits together, and why it is shaped the way it is. Read
this before your first non-trivial change; it explains the boundaries the
conventions in [AGENTS.md](../AGENTS.md) enforce.

## The shape of the repo

```text
halis-code/
  apps/desktop        the Electron app
    electron/main     main process: windows, tray, ipc, sessions,
                      and the desktop agent runtime (electron/main/agent)
    electron/preload  the context bridge — the renderer's only door
    electron/shared   ipc channels, api contract, types shared by both
    src               the renderer: sidebar, conversation, workspace rail
  packages/core       the terminal-side runtime: agent loop, file tools,
                      provider client, model catalog (pure node)
  packages/cli        the ink tui — bundled by esbuild into bin/halis.js
  docs/               these documents
```

Two apps, one idea: a streaming agent that reads, edits and runs code,
wrapped in the guardrails that keep long sessions honest — compaction,
approvals, repeat-call guards, spill files. The terminal side and the
desktop side each ship the whole idea; they differ in presentation and,
today, in runtime.

## One runtime, two implementations

The honest, slightly unusual part first: `packages/core` and the desktop
runtime under `apps/desktop/electron/main/agent/` are **not** one shared
module. They started as one and forked when the desktop app grew
machinery the terminal does not need — the mcp client, subagents, skill
loading, patch application, diff rendering, workspace instructions
(`AGENTS.md` / `CLAUDE.md` discovery), provider key vault. The terminal
side stays deliberately small: everything the tui needs, bundled into a
single file that ships on npm.

The contract between them is the loop itself, and both sides keep the
same invariants:

- the transcript never carries a dangling `tool_use` — every call is
  closed with a result, synthetic ones when a run aborts mid-batch;
- a declined call is fed back to the model with an explanation, never
  silently skipped;
- tool output beyond the budget spills to disk behind a preview, never
  truncates quietly.

If you change one side's loop semantics, check the other. Smoke suites
on both sides pin these invariants.

## The loop

`runAgent()` in `packages/core/src/agent.ts` is the whole terminal-side
loop, in 165 lines:

1. Turn budget check — past `maxTurns`, the run parks itself and asks
   the user to continue.
2. Compaction check — when the estimated token count crosses the budget,
   the older history folds into a model-written summary.
3. Stream an assistant turn over the provider's wire, with token usage
   reported per turn.
4. No tool calls in the answer — the run is done.
5. Tool calls — each one goes through the approval hook when one is
   set, runs, and its result rides back into the transcript. Identical
   repeat calls earn escalating reminders and finally stop the run.
6. An abort mid-batch still closes every pending call (see the
   invariants above).

Events, not callbacks, drive the surface: the tui and the desktop both
consume `text-delta`, `tool-start`, `tool-end`, `usage`, `notice`,
`done`. The `-p --json` print mode is just those events, one json line
each — the same stream scripts can consume.

## Providers

`packages/core/src/provider.ts` speaks both wire protocols the catalog
knows about: OpenAI-style chat completions (most providers) and
Anthropic messages, thinking blocks included. Which protocol, which
endpoint, which key variable — all resolved from the catalog entry, not
a hand-listed table, so a provider joins by existing in
[models.dev](https://models.dev) with correct data.

Keys come from the provider's documented environment variable
(`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `ZAI_API_KEY`,
…) or plain `HALIS_API_KEY`, which works everywhere. Presets (`zai`,
`deepseek`, `moonshot`, `groq`, `openai`, `openrouter`, `ollama`) just
pin a base url and a default model; `HALIS_BASE_URL` + `HALIS_MODEL`
reach anything the presets do not.

## The catalog

The whole models.dev snapshot — 200+ providers, 8,000+ models — ships
in the box (`packages/core/assets/models-dev-snapshot.json`, staged
into the npm package as `bin/models-dev/`), so model picking works on a
plane. At runtime it revalidates in the background with an ETag-cached
fetch and swaps in fresh data when the snapshot moves. The spec parser
takes `provider/model#variant` anywhere a model is asked for; bare ids
search a favorites-first list.

## The terminal side

`packages/cli` is React through Ink, bundled by esbuild into a single
`bin/halis.js` plus the catalog snapshot — no runtime `node_modules`,
one file to install globally. Sessions checkpoint to
`~/.halis/sessions/<slug>.json` after every turn (one resume file per
working directory), which is what `halis -c` picks back up. Background
jobs live under `~/.halis/jobs`, spill files under
`~/.halis/tool-output`.

The `!command` passthrough, the mock provider for keyless development
(`npm run mock -w halis-code`), and the `-p --json` event stream are
all deliberately the same runtime with thinner presentation — one
codebase to test, three doors.

## The desktop side

The Electron split is the security story as much as the architecture
story:

- **Main process** owns everything risky: the agent runtime, the file
  system, the terminal, the key vault (safeStorage-encrypted when the
  platform offers it, plainly marked otherwise), the session store.
- **Renderer** renders. It talks to the main process exclusively
  through the preload context bridge, and every `ipcMain` handler
  validates its inputs before touching anything — the renderer is
  treated as hostile input, because a compromised renderer must not
  become a shell.

Details are in [security.md](security.md); the process split, window
management, tray behavior and the workspace rail (files, search,
editor, terminal panels) live under `electron/main/` and `src/`.

## Cross-platform discipline

Three rules keep the same code honest on macOS, Linux and Windows —
shell resolution, line endings, and case sensitivity. They are enforced
by the ci matrix (three operating systems), by the smoke suites (which
pin platforms without being on them), and by convention in
[AGENTS.md](../AGENTS.md):

- every command spawns through `resolveShell()` — the user's login
  shell on unix, `cmd.exe` on Windows, `HALIS_SHELL` as the override;
- timeouts and cancels kill the whole process tree — process groups
  with SIGTERM-to-SIGKILL escalation on unix, `taskkill /T` on Windows;
- `read` hides CRLF, `edit` preserves the file's line endings, glob
  matching follows the filesystem's case sensitivity.

A pull request that breaks any of these on one platform is not a
partial success; the matrix is the product.

## Where to next

- [development.md](development.md) — the everyday commands, the smoke
  suites, adding a tool or a smoke case, the environment variables.
- [releases.md](releases.md) — how a tag becomes a release with
  installers and an npm package.
- [security.md](security.md) — the guardrails as a system, and the
  boundaries that are deliberately not claimed.
