# Halis Code

Halis Code is a coding agent that lives where you work: a desktop app on
Electron and a terminal UI that share one idea — a streaming agent that
reads, edits and runs code in your project, with the guardrails (compaction,
approvals, repeat-call guards) already built in.

This repository is a monorepo:

```
apps/desktop    the Electron desktop app (sidebar, workspace rail, editor,
                terminal, streaming chat, tool cards)
packages/cli    the terminal UI — bin: halis
packages/core   agent loop, file tools and provider client, shared by the
                terminal side and reusable elsewhere
```

## The terminal UI

`halis` opens a session that behaves like a terminal-first pair
programmer: a bordered composer with a command palette, a live spinner
while the model thinks, tool cards with durations and output previews,
bash approvals before anything destructive runs, and a status line with
model and token usage. The primary color is blue and the mascot — the
Halis penguin — sits in the corner of the welcome screen, redrawn pixel
by pixel from the brand art with truecolor half-blocks.

```sh
# from the repo root
npm install -w @halis/core -w @halis/cli
npm run build -w @halis/cli

node packages/cli/bin/halis.js            # interactive session
node packages/cli/bin/halis.js -p "summarize this repo"
node packages/cli/bin/halis.js mascot     # the penguin, full size
```

Or link it once with `npm link -w @halis/cli` and just run `halis`.

### Slash commands

| command     | what it does                              |
| ----------- | ----------------------------------------- |
| `/help`     | list every command                        |
| `/model`    | show or switch the model                  |
| `/provider` | switch provider preset                    |
| `/mascot`   | say hi to the penguin                     |
| `/init`     | write an `AGENTS.md` for the current repo |
| `/status`   | config, key and session info              |
| `/clear`    | drop the conversation context             |
| `/exit`     | quit                                      |

### Providers

The CLI speaks the OpenAI chat-completions wire format with streaming and
tool calls. Providers ship as presets: `zai` (default, GLM 4.7 Flash),
`deepseek`, `moonshot`, `groq`, `openai`, `openrouter`, `ollama`. Point it
at anything compatible with `HALIS_BASE_URL` + `HALIS_API_KEY` + `HALIS_MODEL`,
or persist choices in `~/.halis/config.json`. Without a key the CLI runs in
a clearly labeled demo mode so the interface is still explorable.

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

## Layout

```
apps/desktop/
  electron/main/          main process: windows, ipc, sessions, agent runtime
  electron/main/agent/    run loop, providers, tools, compaction, guard,
                          approvals, instructions, skills, file refs, diffs
  electron/preload/       context bridge
  electron/shared/        ipc channels, api contract, types
  src/                    renderer: sidebar, conversation, workspace rail
  scripts/                build + smoke tests
packages/core/
  src/                    types, agent loop, provider, prompt, config, tools
packages/cli/
  src/                    ink app, composer, command palette, mascot renderer
  build.mjs               esbuild bundling into bin/halis.js
```

## Development

TypeScript 7 everywhere, strict. From the root:

```sh
npm run typecheck      # all workspaces
npm run build          # core -> cli -> desktop
npm run dev:cli        # watch mode for the terminal ui
npm run dev:desktop    # watch + launch the desktop app
npm run smoke -w @halis/desktop   # algorithm smoke tests
```
