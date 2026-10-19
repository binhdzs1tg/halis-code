# AGENTS.md

Instructions for coding agents (and humans) working on Halis Code.

## Layout

Monorepo, npm workspaces:

- `apps/desktop` — Electron desktop app. Agent runtime lives in
  `electron/main/agent/`, renderer in `src/`.
- `packages/core` — agent loop, file tools, model catalog, provider client
  (`@halis/core`). Pure Node, no Electron imports.
- `packages/cli` — terminal UI (`halis-code` on npm, bin `halis`), built with Ink
  and bundled by esbuild into `bin/halis.js`. Consumes `@halis/core`
  directly from source through tsconfig paths and an esbuild alias.

## Commands

From the repo root:

- `npm run typecheck` — strict typecheck of every workspace (TypeScript 7).
- `npm run build` — core, then cli, then desktop, in that order.
- `npm run dev:cli` — watch mode for the terminal ui.
- `npm run dev:desktop` — build and launch the desktop app.
- `npm run smoke -w @halis/desktop` — algorithm smoke tests (diff, guard,
  file refs, risk heuristics, glob matching, grep, html conversion, patch
  parsing, edit matching, tool input repair, spill, the read-before-edit
  gate, git info, background jobs, subagents, the mcp client). Run it after
  touching anything under `apps/desktop/electron/main/agent/`.
- `npm run smoke -w @halis/core` — the terminal-side loop against a
  scripted local provider (repeat guard, compaction cut points, usage
  parsing, the tool wiring, the anthropic wire format, spill, the model
  spec parser and the bundled catalog). Run it after touching
  `packages/core` or anything in `packages/cli` that feeds the loop.

## Conventions

- TypeScript everywhere, strict, `noUnusedLocals`/`noUnusedParameters` and
  `exactOptionalPropertyTypes` on. Do not loosen the compiler options —
  spread optional fields conditionally instead of assigning undefined.
- The desktop main process never trusts the renderer: every `ipcMain`
  handler validates its inputs and only the main frame of an app window may
  call. Keep that discipline for new channels.
- Electron imports stay out of `electron/shared/` so the renderer can type
  against it. Pure logic (diff, guard, risk patterns) stays free of
  Electron imports so the smoke tests can run it in plain Node.
- `packages/core` stays free of Electron, Ink and React imports — the
  terminal ui owns presentation, the core owns the loop.
- The models.dev snapshot lives at `packages/core/assets/`. The cli build
  stages it into `bin/models-dev/` and the loader finds it next to the
  bundle; source-level runs read it through `HALIS_MODELS_SNAPSHOT` or the
  assets fallback. Keep the bundled snapshot roughly current when models
  drift.
- Tool results are fed back into the model — keep them within the output
  budget and write messages that tell the model what to do next, not just
  what failed. Oversized results go through the spill store, never silent
  truncation.
- Comments explain why, not what. Names of runtime-injected context blocks
  follow the `<system-reminder>` convention.
- The penguin is drawn from `packages/cli/src/mascot-art.ts`; keep the
  palette keys stable when regenerating the grids.
