# AGENTS.md

Instructions for coding agents (and humans) working on Halis Code.

## Commands

- `npm run typecheck` — strict typecheck of both processes (TypeScript 7).
- `npm run build` — bundle main, preload and renderer with esbuild.
- `npm run dev` — build and launch the app.
- `npm run smoke` — algorithm smoke tests (diff, guard, file refs, risk
  heuristics, glob matching, grep, html conversion, patch parsing, edit
  matching). Run it after touching anything under
  `electron/main/agent/`.

## Conventions

- TypeScript everywhere, strict, `noUnusedLocals`/`noUnusedParameters` on.
  Do not loosen the compiler options.
- The main process never trusts the renderer: every `ipcMain` handler
  validates its inputs and only the main frame of an app window may call.
  Keep that discipline for new channels.
- Electron imports stay out of `electron/shared/` so the renderer can type
  against it. Pure logic (diff, guard, risk patterns) stays free of
  Electron imports so the smoke tests can run it in plain Node.
- Tool results are fed back into the model — keep them within the output
  budget and write messages that tell the model what to do next, not just
  what failed.
- Comments explain why, not what. Names of runtime-injected context blocks
  follow the `<system-reminder>` convention.

## Agent-facing behavior

- `AGENTS.md` and `CLAUDE.md` at the workspace root are injected into the
  agent's system prompt; this file is one. Keep edits here short and
  factual — everything here costs context in every run inside this repo.
- Skills live in `.halis/skills/<kebab-name>/SKILL.md` with `name`,
  `description` and optional `whenToUse` frontmatter. A skill's body is
  loaded only when the model calls the `skill` tool, so the frontmatter
  should carry enough description to route correctly.
- Destructive shell commands ask the user for a one-shot approval. Do not
  add command allowlists; extend `electron/main/agent/risky.ts` if a class
  of commands deserves scrutiny.
