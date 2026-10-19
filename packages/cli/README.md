# halis-code

The terminal side of [Halis Code](https://github.com/binhdzs1tg/halis-code) — a
coding agent that lives in your terminal. A streaming agent that reads, edits
and runs code in your project, with the guardrails already built in: the
transcript compacts itself before the context window fills, identical repeat
calls earn escalating warnings and then a hard stop, oversized tool output
spills to a readable file instead of truncating silently, and every session is
checkpointed so you can pick it back up after a restart.

## Install

```sh
npm install -g halis-code
```

Then run `halis` inside any project. Requires Node 20+.

## Quick start

```sh
halis                            # interactive session
halis -p "summarize this repo"   # one-shot print mode
halis -p --json "fix the test"   # jsonl event stream
halis -c                         # continue the last session here
halis sessions                   # list stored sessions
halis -m glm-4.7-flash           # pick a model for this run
```

On the first run `/doctor` checks your config, key and endpoint. `/provider`
switches between presets (zai, deepseek, groq, …) and `/model` opens a
searchable picker over the bundled models.dev catalog — 200+ providers and
8000+ models, refreshed in the background.

## What you get

- a bordered composer with a command palette, a live spinner while the model
  thinks, and tool cards with durations and output previews
- bash approvals before anything destructive runs (`/yolo` turns them off —
  careful)
- a status line with model, context usage and session cost straight from the
  catalog
- slash commands: `/help`, `/model`, `/diff`, `/compact`, `/resume`, `/export`,
  `/usage`, `/skills`, `/init`, `/doctor` and friends — `/help` lists them all
- sessions stored under `~/.halis/sessions`, auto-titled after turn one
- the Halis penguin sitting in the corner of the welcome screen

`halis-code` is self-contained — the agent loop, file tools, model catalog and
provider client (`@halis/core`) are bundled into the `halis` binary, so there
is nothing else to install.

## Source

The desktop app, the shared core and the terminal UI live in the
[monorepo](https://github.com/binhdzs1tg/halis-code).
