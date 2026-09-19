#!/bin/sh
# Install (or verify) this checkout's harness into the operator's ~/.claude.
#
# WHY THIS EXISTS. The harness RUNS from the installed mirror, not from this
# checkout: a Stop hook, a workflow script and a skill are all loaded from
# ~/.claude. So a change can merge, pass every test, and change nothing on a
# real run. That is the standards' "correct in source, absent from the build"
# shape, applied to an install rather than a compiler, and nothing in the repo
# can see it: the tests import the repo's copy.
#
# Measured 2026-09-14: after two PRs merged, the installed ledger-append.mjs
# still differed from this repo's, and the weekly job had reported that drift
# for three consecutive weeks into a log nobody reads.
#
# WHAT IT INSTALLS is decided by workflows/lib/install-consistency.mjs, which
# already owns the authoritative list and is what the weekly drift check reads.
# This script asks that module rather than carrying its own copy of the list.
# Two copies of one rule is the defect this repo hit twice in a single day (the
# AC-id pattern, and the AC-definition counter that duplicated it), so the
# installer and the detector are wired to the same source by construction: if
# they could disagree, following both would still leave you stale.
#
#   bin/install.sh            install, then verify
#   bin/install.sh --check    verify only, write nothing, non-zero on drift
#
# CLAUDE_HOME overrides the destination (the same override the drift check and
# the weekly runner already honour).
set -eu

REPO="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
LIB="$REPO/workflows/lib/install-consistency.mjs"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ ! -f "$LIB" ]; then
  echo "install: cannot find $LIB; run this from a claude-ai-harness checkout." >&2
  exit 2
fi

# The one list, read from the module that owns it, intersected with what the
# repo actually TRACKS.
#
# The intersection is not belt and braces. Caught on the first real run: the
# 'hooks/' pattern walks the whole directory, so the installer copied
# hooks/__pycache__/test_plan_guard_stop.cpython-314.pyc into the operator's
# harness -- compiled bytecode of a test file, gitignored, and guaranteed to go
# stale against the .py beside it. The same directory tripped the
# optimiser-reference scan earlier the same day for the same reason: a walk
# that does not distinguish source from build output. A release contains what
# the repository publishes, so "tracked" is the right test, and it needs no
# second list of exclusions to maintain.
FILES=$(node --input-type=module -e "
import { execSync } from 'node:child_process'
import { listConsumerSubsetFiles } from '$(printf '%s' "$LIB" | sed "s/'/\\\\'/g")'
const repo = process.argv[1]
const tracked = new Set(execSync('git ls-files -z', { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split('\\0').filter(Boolean))
for (const f of listConsumerSubsetFiles(repo)) if (tracked.has(f)) console.log(f)
" "$REPO")

if [ -z "$FILES" ]; then
  echo "install: the consumer subset came back empty; refusing to 'install' nothing." >&2
  exit 2
fi

# A destination that contains files but none of the harness's own is probably
# not ~/.claude. Scattering a harness across someone's home directory is not
# recoverable by reading a log, so it is refused rather than warned about.
#
# L1 (round 2 review): this guard used to default to OFF (${...:-0}), so it
# only ever ran when an operator or a test explicitly set the variable to 1 --
# which no real invocation does, so the guard never actually fired in
# production. Measured: a CLAUDE_HOME pointing at a directory holding only
# an unrelated file installed 29 files, including executable hooks, and
# exited 0. The comment above said "opt in with ...=0", which was already
# describing the opt-OUT direction this now actually implements: the guard
# is ON by default, and =0 is how a genuinely fresh install opts out of it.
if [ "$CHECK_ONLY" -eq 0 ] && [ "${HARNESS_INSTALL_REQUIRE_MARKER:-1}" = "1" ]; then
  if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
    if [ ! -e "$DEST/AGENT-HARNESS.md" ] && [ ! -d "$DEST/workflows" ] && [ ! -d "$DEST/skills" ]; then
      echo "install: $DEST is not empty and does not look like a Claude install" >&2
      echo "         (no AGENT-HARNESS.md, workflows/ or skills/). Refusing." >&2
      exit 2
    fi
  fi
fi

drift=0
installed=0
for rel in $FILES; do
  src="$REPO/$rel"
  dst="$DEST/$rel"
  [ -f "$src" ] || continue
  if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ ! -f "$dst" ]; then
      echo "missing: $rel"
      drift=$((drift + 1))
    elif ! cmp -s "$src" "$dst"; then
      echo "drift:   $rel"
      drift=$((drift + 1))
    fi
  else
    mkdir -p "$(dirname -- "$dst")"
    # Only copy what actually differs, so an install is quiet and its output
    # says what genuinely moved.
    if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
      cp "$src" "$dst"
      echo "updated: $rel"
      installed=$((installed + 1))
    fi
  fi
done

if [ "$CHECK_ONLY" -eq 1 ]; then
  if [ "$drift" -gt 0 ]; then
    echo "install --check: $drift file(s) drifted or missing in $DEST. Run bin/install.sh" >&2
    exit 1
  fi
  echo "install --check: $DEST matches this checkout."
  exit 0
fi

echo "install: $installed file(s) updated in $DEST."
# Verify what we just did, rather than assuming the copies landed.
exec "$0" --check
