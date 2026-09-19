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
# WHAT IT INSTALLS, and what counts as DRIFT, are both decided by
# workflows/lib/install-consistency.mjs, which already owns the authoritative
# list and is what the weekly drift check reads. This script calls that
# module's own exported entry points (listInstallFiles for what to copy,
# checkStaleness for what counts as drift) rather than carrying a second copy
# of either. Two copies of one rule is the defect this repo hit twice in a
# single day (the AC-id pattern, and the AC-definition counter that
# duplicated it) -- and, M4 (round 2 review), a third time inside this very
# script: --check used to reimplement drift detection with its own shell
# loop, and it disagreed with checkStaleness about a missing OPTIONAL file
# (a manual install that skips the weekly job is a legitimate configuration
# to checkStaleness; the old loop counted it as drift regardless).
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
LIB_JS="$(printf '%s' "$LIB" | sed "s/'/\\\\'/g")"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ ! -f "$LIB" ]; then
  echo "install: cannot find $LIB; run this from a claude-ai-harness checkout." >&2
  exit 2
fi

# M4: --check calls checkStaleness() directly -- the SAME function
# bin/optimise-cycle-weekly.sh uses -- instead of a second, independently
# maintained drift detector. Exits before the install-only logic below ever
# runs.
if [ "$CHECK_ONLY" -eq 1 ]; then
  exec node --input-type=module -e "
import { checkStaleness } from '$LIB_JS'
const [repo, dest] = process.argv.slice(1)
const r = checkStaleness(repo, dest)
for (const rel of r.missing) console.log('missing: ' + rel)
for (const rel of r.drifted) console.log('drift:   ' + rel)
if (r.blind || r.unmatched_patterns.length > 0) {
  console.error('install --check: could not verify ' + dest + ' -- ' +
    (r.blind ? 'no published files were found to compare (not a git checkout?)' : 'pattern(s) matched nothing: ' + r.unmatched_patterns.join(', ')))
  process.exit(2)
}
if (r.status === 'drift') {
  console.error('install --check: ' + r.drift.length + ' file(s) drifted or missing in ' + dest + '. Run bin/install.sh')
  process.exit(1)
}
console.log('install --check: ' + dest + ' matches this checkout.')
" "$REPO" "$DEST"
fi

# M4: the same listInstallFiles() the module exports for exactly this,
# instead of a `node --input-type=module -e` block re-deriving "consumer
# subset intersected with what git tracks" inline. The intersection is not
# belt and braces: caught on the first real run, the 'hooks/' pattern walks
# the whole directory, so the installer copied
# hooks/__pycache__/test_plan_guard_stop.cpython-314.pyc into the operator's
# harness -- compiled bytecode of a test file, gitignored, guaranteed to go
# stale against the .py beside it. A release contains what the repository
# publishes, so "tracked" is the right test.
FILES=$(node --input-type=module -e "
import { listInstallFiles } from '$LIB_JS'
const r = listInstallFiles(process.argv[1])
if (r.blind) {
  console.error('install: could not determine which files this repo tracks (not a git checkout?).')
  process.exit(2)
}
for (const f of r.files) console.log(f)
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

installed=0
for rel in $FILES; do
  src="$REPO/$rel"
  dst="$DEST/$rel"
  [ -f "$src" ] || continue
  mkdir -p "$(dirname -- "$dst")"
  # Only copy what actually differs, so an install is quiet and its output
  # says what genuinely moved.
  if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
    cp "$src" "$dst"
    echo "updated: $rel"
    installed=$((installed + 1))
  fi
done

echo "install: $installed file(s) updated in $DEST."
# Verify what we just did, rather than assuming the copies landed.
exec "$0" --check
