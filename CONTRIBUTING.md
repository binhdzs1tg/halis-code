# Contributing to Halis Code

Thanks for wanting to help. This document is the short path from a fresh
clone to a merged pull request. It covers the ground rules, the commands
you will run every day, and the few conventions this repo refuses to bend
on — they exist because the product promises the same behavior on macOS,
Linux and Windows, and that promise is cheap to break.

## Ground rules

- Keep diffs focused. A pull request that does one thing ships fast; one
  that does four things ships never.
- Cross-platform is the product. If a change works on your machine only,
  it is not done (see [the rules that keep the repo portable](#the-rules-that-keep-the-repo-portable)).
- New agent behavior comes with smoke coverage. The smoke suites are the
  only tests this repo has, and that is a feature: they run in plain Node
  on all three platforms, in under a minute, with no harness ceremony.
- Ask before large refactors. Opening an issue first costs an hour and
  saves a week.

## Getting the code

Node 20 or newer (22 LTS recommended) and npm 11.

```sh
git clone https://github.com/binhdzs1tg/halis-code.git
cd halis-code
npm install
```

If you only touch the terminal side (`packages/core`, `packages/cli`),
skip the ~100 MB electron download:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
```

## Everyday commands

From the repo root:

| command                          | what it does                                   |
| -------------------------------- | ---------------------------------------------- |
| `npm run typecheck`              | strict typecheck of every workspace            |
| `npm run build`                  | cli (bundles core from source), then desktop   |
| `npm run dev:cli`                | watch mode for the terminal ui                 |
| `npm run dev:desktop`            | build + launch the desktop app                 |
| `npm run smoke -w @halis/core`   | terminal-side loop against a scripted provider |
| `npm run smoke -w @halis/desktop`| algorithm smoke tests, plain node              |
| `npm run lint:md`                | markdownlint over every md file                |

The smoke suites are the release gate. `@halis/core` runs the whole agent
loop — repeat guard, compaction cut points, usage parsing, both wire
protocols, spill, the model spec parser, the bundled catalog — against a
local scripted provider, so it needs no key and no network. `@halis/desktop`
exercises the pure algorithms behind the app: diff, guard, risk
heuristics, patch parsing, edit matching, glob, grep, html conversion,
tool input repair, the read-before-edit gate, background jobs, subagents,
the mcp client. If you touched anything under `electron/main/agent/` or
under `packages/core/`, run the matching suite before you push; the ci
matrix will run it again on all three platforms.

## Where things live

```text
apps/desktop      electron app — main process runtime, renderer, packaging
packages/core     agent loop, tools, provider client, model catalog
packages/cli      ink tui, esbuild bundle, npm package (bin: halis)
docs/             architecture, development, releases, security notes
```

`packages/core` stays free of Electron, Ink and React imports; pure logic
in the desktop app stays free of Electron imports so the smoke suites can
run it in plain Node. `AGENTS.md` carries the full conventions for coding
agents and humans alike — read it before your first change.

## The rules that keep the repo portable

Three rules cover almost every cross-platform regression this repo has
ever had:

1. **Never hardcode a shell.** Commands spawn through `resolveShell()` /
   `spawnShellCommand()` in `packages/core/src/shell.ts` — the user's
   login shell on unix, `cmd.exe` on Windows, `HALIS_SHELL` as the
   override. A bare `child.kill()` only reaches the shell itself and
   leaves `npm run` workers behind; `killTree()` exists so grandchildren
   die too, on every platform.
2. **Never assume a file is one ending.** `read` strips carriage returns
   for display, `edit` folds replacements into the line endings the file
   already uses, and glob matching follows the filesystem — case
   insensitive on Windows and macOS, strict on Linux.
3. **Keep smoke cases quote-free or branch by platform.** The suites run
   against `cmd.exe` on the ci windows runners; anything fancier than
   plain words breaks there first.

## Developing without a key

A scripted OpenAI-compatible provider ships with the cli, so the tui can
be exercised end to end — tools, plan cards, usage tokens and all:

```sh
npm run mock -w halis-code          # listens on :8787
HALIS_BASE_URL=http://localhost:8787/v1 HALIS_API_KEY=mock \
  node packages/cli/bin/halis.js
```

## Commits

One line, lowercase, an area prefix, present tense — the same voice the
history already uses:

```text
core: keep crlf files and case-insensitive filesystems working
cli: catalog picker, new slash commands, approvals modes, background shells
readme: cross-platform notes
```

Areas in use: `core`, `cli`, `desktop`, `tui`, `ci`, `docs`, `readme`,
`repo`, `license`. If your change does not fit an area, drop the prefix
rather than inventing a new one for a single commit.

## Pull requests

- Branch from `main`, keep the diff focused, and run the relevant smoke
  suite before opening.
- Fill in the pull request template; it is short on purpose.
- The ci matrix (macOS, Linux, Windows) must pass. If a test only fails
  on Windows, that is a real bug, not a flaky runner.
- New tools, guardrail changes and anything touching `web_fetch` or the
  key store will get extra scrutiny — that scrutiny is the product.

## Releases

Cutting a release is one push of a semver tag; the full pipeline is
documented in [docs/releases.md](docs/releases.md). You do not need to do
anything release-related for a normal contribution.

## Reporting a vulnerability

Do not open a public issue for anything security-sensitive — follow
[SECURITY.md](SECURITY.md) instead.
