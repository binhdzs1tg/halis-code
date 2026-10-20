# Halis Code

Halis Code is a coding agent that lives where you work: a desktop app on
Electron and a terminal UI that share one idea — a streaming agent that
reads, edits and runs code in your project, with the guardrails (compaction,
approvals, repeat-call guards) already built in.

This repository is a monorepo:

```text
apps/desktop    the Electron desktop app (sidebar, workspace rail, editor,
                terminal, streaming chat, tool cards)
packages/cli    the terminal UI — bin: halis
packages/core   agent loop, file tools, model catalog and provider client,
                shared by the terminal side and reusable elsewhere
```

## The terminal UI

`halis` opens a session that behaves like a terminal-first pair
programmer: a bordered composer with a command palette, a live spinner
while the model thinks, tool cards with durations and output previews,
bash approvals before anything destructive runs, and a status line with
model, context usage and session cost straight from the catalog. The
primary color is blue and the mascot — the Halis penguin — sits in the
corner of the welcome screen, redrawn pixel by pixel from the brand art
with truecolor half-blocks.

The session rides the same guardrails the product promises: the
transcript compacts itself into a summary before the context window
fills, identical repeat calls earn escalating warnings and then a hard
stop, oversized tool output spills to a readable file instead of
truncating silently, and the conversation is checkpointed to
`~/.halis/sessions` after every turn, so `halis -c` picks it back up
after a restart.

![a halis session mid-run](packages/cli/docs/tui.png)

Install from npm (the cli bundles everything it needs):

```sh
npm install -g halis-code
halis
```

Or run it straight from a clone of the repo:

```sh
# from the repo root
npm install -w halis-code
npm run build -w halis-code

node packages/cli/bin/halis.js            # interactive session
node packages/cli/bin/halis.js -p "summarize this repo"
node packages/cli/bin/halis.js -p --json "fix the test"   # jsonl event stream
node packages/cli/bin/halis.js -c          # continue the last session here
node packages/cli/bin/halis.js sessions    # list stored sessions
node packages/cli/bin/halis.js mascot      # the penguin, full size
```

Or link it once with `npm link -w halis-code` and just run `halis`.

### Slash commands

| command     | what it does                                        |
| ----------- | --------------------------------------------------- |
| `/help`     | list every command                                  |
| `/model`    | pick a model from the catalog (search + variants)   |
| `/models`   | the same picker, alias                              |
| `/provider` | switch provider preset (zai, deepseek, groq, …)     |
| `/diff`     | git diff of the working tree                        |
| `/compact`  | compact the transcript now                          |
| `/resume`   | pick an earlier session to load                     |
| `/title`    | rename this session (auto-titled after turn one)    |
| `/export`   | write the transcript to markdown                    |
| `/usage`    | token totals and estimated cost                     |
| `/skills`   | list installed skills                               |
| `/yolo`     | toggle command approvals off (careful)              |
| `/doctor`   | check config, key, catalog and endpoint             |
| `/init`     | write an `AGENTS.md` for the current repo           |
| `/status`   | config, key and session info                        |
| `/mascot`   | say hi to the penguin                               |
| `/clear`    | drop the conversation context                       |
| `/exit`     | quit (or ctrl+c twice)                              |

![the command palette filtering on /pro](packages/cli/docs/commands.png)

### Providers and models

The whole models.dev catalog ships in the box: 200+ providers and 8000+
models, bundled as a snapshot and refreshed in the background with an
ETag-cached revalidation. `/model` opens a searchable picker; the CLI
takes the same spec anywhere a model is asked for:

```sh
halis -m anthropic/claude-sonnet-4-5#high      # provider/model plus reasoning variant
halis -m glm-4.7-flash                          # bare ids search the favorites first
halis --yolo "run the whole migration"          # no approval prompts
```

Both wire protocols are supported: OpenAI-style chat completions for
most providers and Anthropic messages with thinking blocks for the
Anthropic family, chosen from the catalog data instead of a hand-listed
table. Keys come from each provider's documented environment variable
(`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, …) or plain `HALIS_API_KEY`.
The classic presets (`zai`, `deepseek`, `moonshot`, `groq`, `openai`,
`openrouter`, `ollama`) still work through `/provider` and
`HALIS_BASE_URL` + `HALIS_MODEL` for anything self-hosted. Without a
key the CLI runs in a clearly labeled demo mode so the interface is
still explorable.

### The agent's toolkit

`ls`, `read`, `write`, `edit`, `glob`, `grep`, `bash` (with
`run_in_background` and timeout promotion to background jobs),
`job_output` and `job_kill` for those jobs, `web_fetch` (plain-text page
fetcher that refuses private addresses), `web_search` (keyless,
DuckDuckGo-backed), `todo_write` (the plan card you see above), `skill`
(progressive-disclosure skills from `.halis/skills/*/SKILL.md`),
`ask_user` (a question card when a decision is genuinely yours) and
`task` (a subagent that explores with its own context and reports back).

Type `!command` in the composer to run something in your own shell,
without the model in the middle.

### Developing without a key

A scripted OpenAI-compatible provider ships with the cli, so the tui can
be exercised end to end — tools, plan cards, usage tokens and all:

```sh
npm run mock -w halis-code                                     # listens on :8787
HALIS_BASE_URL=http://localhost:8787/v1 HALIS_API_KEY=mock \
  node packages/cli/bin/halis.js
```

## The desktop app

The Electron app pairs a session-list sidebar and a centered conversation
with a workspace rail (files, search, editor, terminal). Highlights:

- **Streaming agent** with tool use (`list_dir`, `read_file`, `write_file`,
  `edit_file`, `search`, `glob`, `grep`, `web_fetch`, `web_search`,
  `patch`, `ask_user`, `run_command`, `todo_write`, `skill`), live tool
  cards, plan todos and a message queue while a run is in flight.
- **Model catalog from models.dev**: 230+ providers and 8,000+ models in a
  bundled snapshot, refreshed in the background with ETag-cached
  revalidation.
- **Context compaction** at 80% of the model's window with a 16% verbatim
  tail, tool-pair-safe cut points and an 8-section checkpoint summary.
- **Repeat-call guard**, command approvals, workspace instructions
  (`AGENTS.md` / `CLAUDE.md`) and progressive-disclosure skills.

Screenshots live in `apps/desktop/docs/screenshots`.

```sh
npm install          # everything, including electron
npm run dev:desktop  # build + launch electron
```

## Cross-platform

The same code runs on macOS, Linux and Windows. The terminal side adapts
to wherever it finds itself:

- **Shell**: commands go through the user's login shell on unix
  (`$SHELL`, falling back to the account shell, then `/bin/bash`) and
  through `cmd.exe` on Windows (`%ComSpec%`). Set `HALIS_SHELL` to force
  one — a posix-style `bash.exe` (git bash) is invoked with `-c`,
  `pwsh.exe` with `-NoProfile -NonInteractive -Command`, anything else
  must speak cmd. The system prompt tells the model which shell it has,
  so on Windows it writes `dir` and `%VAR%` instead of `ls` and `$VAR`.
- **Process trees**: timeouts and cancels kill the whole tree — process
  groups with SIGTERM-to-SIGKILL escalation on unix, `taskkill /T` on
  Windows — and a foreground command that outlives its timeout is
  promoted to a background job on every platform.
- **Files**: `read` shows CRLF files without the carriage returns,
  `edit` folds the replacement into the line endings the file already
  uses, and `grep` matches across both. Glob matching follows the
  filesystem: case-insensitive on Windows and macOS, strict on Linux.

## Layout

```text
apps/desktop/
  electron/main/          main process: windows, ipc, sessions, agent runtime
  electron/main/agent/    run loop, providers, tools, compaction, guard,
                          approvals, instructions, skills, file refs, diffs
  electron/preload/       context bridge
  electron/shared/        ipc channels, api contract, types
  src/                    renderer: sidebar, conversation, workspace rail
  scripts/                build + smoke tests
packages/core/
  src/                    types, agent loop, provider (both wire protocols),
                          catalog, prompt, config, spill, guard, tools
  assets/                 the bundled models.dev snapshot
packages/cli/
  src/                    ink app, composer, model picker, command palette,
                          session store, mascot renderer
  build.mjs               esbuild bundling into bin/halis.js
```

## Development

TypeScript 7 everywhere, strict. From the root:

```sh
npm run typecheck      # all workspaces
npm run build          # core -> cli -> desktop
npm run dev:cli        # watch mode for the terminal ui
npm run dev:desktop    # watch + launch the desktop app
npm run smoke -w @halis/core      # the terminal-side loop against a scripted provider
npm run smoke -w @halis/desktop   # algorithm smoke tests
```

The `ci` workflow runs the typecheck and both smoke suites on macOS,
Linux and Windows for every push and pull request.

## Releases

Cutting a release is one step: publish a GitHub release with a semver tag
(`v0.3.0`). Two workflows pick it up and run in parallel:

- **npm publish** — sets `halis-code` to the tag's version, builds the
  bundle and publishes to npm with provenance. Auth goes through the
  `NPM_TOKEN` secret, or OIDC trusted publishing once the package has a
  trusted publisher configured on npmjs.com.
- **desktop release** — builds the Electron app on macOS, Linux and Windows
  at the same time and attaches the installers to the release: `.dmg`
  (arm64 + x64), `.deb` + `.AppImage`, and the NSIS `.exe` setup.

The desktop workflow also runs on demand from the Actions tab (`Run
workflow`) when you want a packaging dry run without cutting a release.
