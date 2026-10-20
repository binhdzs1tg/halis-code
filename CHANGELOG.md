# Changelog

Notable changes to Halis Code, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [semver](https://semver.org/). Release notes for each version are
also generated on the release page, grouped from the commit log.

## [Unreleased]

### Added

- MIT license — the repo is now open source, with a contributing guide,
  a security policy, a code of conduct and issue forms for reports.
- Security workflows: CodeQL analysis, dependency review on pull
  requests, an OpenSSF Scorecard published to the readme badge.
- Tag-driven releases: pushing `vX.Y.Z` now creates the GitHub release
  with notes grouped from the commit log; the npm publish and desktop
  release pipelines hang off it unchanged.
- The ci pipeline is path-gated (core, desktop or infra jobs only run
  when their paths move), runs the typecheck on node 22 and 24, checks
  the bundled cli end-to-end against the mock provider, and lints the
  workflows (actionlint) and every md file (markdownlint).

### Changed

- The readme is rewritten for a public audience, and the full docs set
  (architecture, development, releases, security design) lives under
  `docs/`.

## [0.2.0] — 2026-10-19

### Added

- `halis`, the terminal ui: an ink tui with a composer and command
  palette, tool cards with durations, live spinner, a status line with
  model, context usage and session cost — and the Halis penguin,
  redrawn pixel by pixel in truecolor half-blocks.
- `@halis/core`, the terminal-side runtime: the agent loop, file tools
  and streaming provider client, shared shape with the desktop
  runtime's invariants (no dangling tool calls, declined calls fed
  back, spill instead of silent truncation).
- The whole models.dev catalog ships in the box (200+ providers,
  8,000+ models) with background revalidation, a searchable picker and
  `provider/model#variant` specs anywhere a model is asked for.
- The Anthropic messages protocol alongside OpenAI-style chat
  completions, chosen from catalog data; thinking blocks included.
- Session guardrails in the terminal: transcript compaction with safe
  cut points, a repeat-call guard with escalation, per-turn usage and
  cost from the catalog, and sessions checkpointed to `~/.halis/sessions`
  so `halis -c` resumes where you left off.
- Background shells: `run_in_background`, timeout promotion to jobs,
  `job_output` and `job_kill`; `web_fetch` (private addresses refused),
  `web_search`, `todo_write`, `skill`, `ask_user` and the `task`
  subagent; `!command` to run something in your own shell without the
  model in the middle.
- `-p` print mode, `-p --json` (one event per line for scripts), and a
  scripted mock provider so the tui develops without a key.
- npm packaging (`npm i -g halis-code`), desktop installers (dmg, deb,
  AppImage, exe) and a three-platform ci matrix.

### Changed

- Shell commands run through the platform shell everywhere — the
  user's login shell on unix, `cmd.exe` on Windows, `HALIS_SHELL` as
  the override — with process-tree kills on every platform.
- CRLF files read clean, edits fold into the line endings the file
  already uses, and glob matching follows the filesystem's case
  sensitivity.

## [0.1.0] — 2026-10-14

### Added

- The desktop app: an Electron build with a session sidebar, streaming
  conversation with markdown rendering and live tool cards, and a
  workspace rail — file explorer (create, rename, delete), editor with
  tabs and save, terminal panel and workspace search.
- The first agent runtime in the main process: workspace tools
  (`list_dir`, `read_file`, `write_file`, `edit_file`, `search`,
  `glob`, `grep`, `web_fetch`, `web_search`, `patch`, `ask_user`,
  `run_command`, `todo_write`, `skill`), command approvals with risk
  labeling, streaming from both OpenAI and Anthropic wire formats.
- The provider key vault with safeStorage encryption, the model
  catalog picker with variants, auto-titled sessions and history, the
  settings view, focus mode and dark theme.
- Tray keep-alive with quit confirmation while the agent runs, a
  native application menu, and crash reports written before the fatal
  dialog shows.

[Unreleased]: https://github.com/binhdzs1tg/halis-code/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/binhdzs1tg/halis-code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/binhdzs1tg/halis-code/releases/tag/v0.1.0
