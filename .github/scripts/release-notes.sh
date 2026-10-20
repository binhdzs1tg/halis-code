#!/usr/bin/env bash
# Assemble release notes from the commit log since <since> up to <until>.
# The repo commits with an area prefix ("core: ...", "cli: ..."), so the
# notes group themselves: product work first, then tooling and docs.
# usage: release-notes.sh <since> [<until>]
set -euo pipefail

since="${1:?usage: release-notes.sh <since> [<until>]}"
until="${2:-HEAD}"

mapfile -t subjects < <(git log --no-merges --format='%s' "${since}..${until}")

product=()
meta=()

for subject in "${subjects[@]}"; do
  case "$subject" in
    ci:*|repo:*|docs:*|readme:*|deps:*|license:*) meta+=("$subject") ;;
    *) product+=("$subject") ;;
  esac
done

{
  if [ "${#product[@]}" -gt 0 ]; then
    echo "### The product"
    echo
    for subject in "${product[@]}"; do echo "- $subject"; done
    echo
  fi
  if [ "${#meta[@]}" -gt 0 ]; then
    echo "### Tooling and docs"
    echo
    for subject in "${meta[@]}"; do echo "- $subject"; done
    echo
  fi
  echo "Full changelog: <https://github.com/binhdzs1tg/halis-code/compare/${since}...${until}>"
}
