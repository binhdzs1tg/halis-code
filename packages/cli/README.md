<div align="center">

# halis-code

**A coding agent with guardrails, for your terminal.**

[![npm](https://img.shields.io/npm/v/halis-code)](https://www.npmjs.com/package/halis-code)
[![node](https://img.shields.io/badge/node-%3E%3D20-399c39?logo=nodedotjs&logoColor=white)](#install)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/binhdzs1tg/halis-code/blob/main/LICENSE)

</div>

The terminal side of [Halis Code](https://github.com/binhdzs1tg/halis-code)
— a streaming agent that reads, edits and runs code in your project,
with the guardrails already built in: the transcript compacts itself
before the context window fills, identical repeat calls earn escalating
warnings and then a hard stop, oversized tool output spills to a
readable file instead of truncating silently, and every session is
checkpointed so you can pick it back up after a restart.

![a halis session mid-run](docs/tui.png)

## Install

```sh
npm install -g halis-code
```

Then run `halis` inside any project. Requires Node 20+. The package is
self-contained — the agent loop, file tools, model catalog and provider
client are bundled into the `halis` binary, so there is nothing else to
install.

## Quick start

```sh
halis                            # interactive session
halis -p "summarize this repo"   # one-shot print mode
halis -p --json "fix the test"   # jsonl event stream, one event per line
halis -c                         # continue the last session here
halis sessions                   # list stored sessions
halis -m glm-4.7-flash           # pick a model for this run
```

On the first run `/doctor` checks your config, key and endpoint.
`/provider` switches between presets (zai, deepseek, groq, …) and
`/model` opens a searchable picker over the bundled models.dev catalog —
200+ providers and 8,000+ models, refreshed in the background. A key
from any provider's usual variable (`ANTHROPIC_API_KEY`,
`DEEPSEEK_API_KEY`, `ZAI_API_KEY`, …) or plain `HALIS_API_KEY` gets you
running; without one, the tui stays in a clearly labeled demo mode.

## What you get

- a bordered composer with a command palette, a live spinner while the
  model thinks, and tool cards with durations and output previews
- bash approvals before anything destructive runs, each with its reason
  on the card (`/yolo` turns them off — careful)
- a status line with model, context usage and session cost straight
  from the catalog
- slash commands: `/help`, `/model`, `/diff`, `/compact`, `/resume`,
  `/export`, `/usage`, `/skills`, `/init`, `/doctor` and friends —
  `/help` lists them all
- sessions stored under `~/.halis/sessions`, auto-titled after turn one
- the Halis penguin sitting on the welcome screen

## Config

| variable | what it overrides |
| -------- | ----------------- |
| `HALIS_API_KEY` | key when you don't want the provider-specific variable |
| `HALIS_BASE_URL` | the endpoint — self-hosted, proxies, the mock provider |
| `HALIS_MODEL` | default model, `provider/model#variant` specs welcome |
| `HALIS_SHELL` | force a shell (login shell and `cmd.exe` are auto-detected) |
| `HALIS_PERMISSIONS` | `default` / `auto` (ask only for risky) / `yolo` |

The config file lives at `~/.halis/config.json`; `halis /status` shows
what is in effect. The full environment variable list is in the
[development docs](https://github.com/binhdzs1tg/halis-code/blob/main/docs/development.md).

## Source

The desktop app, the shared core and the terminal ui live in the
[monorepo](https://github.com/binhdzs1tg/halis-code) — architecture,
release pipeline and the security design are documented in its
[docs](https://github.com/binhdzs1tg/halis-code/tree/main/docs).
