# Releases

How a commit on `main` becomes a GitHub release with installers on all
three platforms and a package on npm. The whole pipeline is push-driven:
the only manual step is the tag.

## The pipeline

```text
push tag vX.Y.Z
      │
      ▼
release create ......... notes grouped from the commit log,
      │                 the GitHub release is published
      ▼
release: published
      ├──────────────────────────────┐
      ▼                              ▼
npm publish                     desktop release
version from the tag            build + package on
build bin/halis.js              macOS · Linux · Windows
npm publish --provenance        dmg · deb · AppImage · exe
                                attached to the release
```

Everything in the chain runs on the tag's commit; nothing is published
from a dirty tree. The `ci` workflow has already run on `main` before
you tag, so the code that ships is code that passed the three-platform
matrix.

## Cutting a release

```sh
npm run typecheck
npm run smoke -w @halis/core
npm run smoke -w @halis/desktop
git tag v0.3.0 && git push origin v0.3.0
```

That is the whole ceremony. Within minutes the release page carries
generated notes and the installers, and `npm i -g halis-code` picks up
the new version.

The notes come from [`.github/scripts/release-notes.sh`](../.github/scripts/release-notes.sh),
which groups the commit log since the previous tag by the area prefixes
the history already uses — product work (`core`, `cli`, `desktop`,
`tui`) first, then tooling and docs (`ci`, `repo`, `docs`, `readme`).
Commit messages are the release notes; keep them honest.

## Versioning

Versions live in three places and the pipeline sets them all from the
tag:

- `packages/cli/package.json` and `packages/cli/src/version.ts` —
  rewritten by the npm publish job.
- `apps/desktop/package.json` — rewritten by the desktop release job.

A non-semver tag (or a manual release with a non-semver name) keeps the
versions already in the tree and prints a warning instead of shipping
something odd. Workspaces that don't ship (core, the monorepo root)
keep their own versions; they move with the tree, not the pipeline.

## npm authentication, two ways

The publish job authenticates either way, in this order:

1. **`NPM_TOKEN` secret** (set up already) — classic token publish,
   with provenance attestations.
2. **OIDC trusted publishing** — delete the secret and register a
   trusted publisher for this repository and workflow on npmjs.com
   (package settings), and the same job publishes through OIDC, no
   long-lived credentials anywhere.

Both paths publish with provenance; the artifact carries a signed
statement linking it to this repository and workflow run.

## Desktop packaging

electron-builder runs on all three platforms in parallel, one job each:

- macOS — `.dmg` for both arm64 and x64 (unsigned; `CSC_IDENTITY_AUTO_DISCOVERY`
  is off, so the first run of the unsigned app needs the usual macOS
  right-click → open)
- Linux — `.deb` and `.AppImage`
- Windows — NSIS `.exe` setup

Manual runs from the Actions tab (`desktop release` → *Run workflow*)
do a packaging dry run and upload the installers as workflow artifacts
instead of a release — useful when touching `electron-builder.yml` or
the build scripts.

The `npm publish` workflow also takes manual runs, dry by default: it
prints exactly what would ship (`npm pack --dry-run`) without touching
the registry. Flip the input when you mean it.

## What the badges promise

The readme badge for releases points at the latest GitHub release;
`npm` badges come from the registry, not from this repo. They move the
moment the pipeline finishes — if a badge lags, check the Actions tab
before assuming the release failed.
