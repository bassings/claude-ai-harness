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

usage() {
  cat >&2 <<'USAGE'
usage: bin/install.sh [--check]

  (no argument)  install this checkout into $CLAUDE_HOME (default ~/.claude),
                 then verify what was written
  --check        verify only: writes nothing, non-zero exit on drift
  --help, -h     print this message

CLAUDE_HOME overrides the destination.
USAGE
}

# M2 (round 4 review): the parse was `[ "${1:-}" = "--check" ] && CHECK_ONLY=1`
# and everything else fell through to the install branch, so `--dry-run`,
# `--verify`, `-n` and every near-miss spelling of --check wrote 29 files into
# the operator's ~/.claude. Each of those spellings means "tell me, do not
# change anything", and this is the only path in this change that writes
# outside the repo -- on a machine where the workflows are re-read from disk on
# the very next run, so the currently checked-out branch goes live immediately.
# The marker guard below does not cover it: that refuses a destination which
# does not LOOK like a Claude install, and a real ~/.claude does.
#
# Writing is now reachable only by asking for nothing, which is the one
# spelling that cannot be a typo of something else.
CHECK_ONLY=0
if [ "$#" -gt 1 ]; then
  echo "install: too many arguments (expected at most one)." >&2
  usage
  exit 2
fi
case "${1:-}" in
  '') ;;
  --check) CHECK_ONLY=1 ;;
  -h|--help) usage; exit 0 ;;
  *)
    echo "install: unrecognised argument '$1'." >&2
    usage
    exit 2
    ;;
esac

if [ ! -f "$LIB" ]; then
  echo "install: cannot find $LIB; run this from a claude-ai-harness checkout." >&2
  exit 2
fi

# M4: --check calls checkStaleness() directly -- the SAME function
# bin/optimise-cycle-weekly.sh uses -- instead of a second, independently
# maintained drift detector. Exits before the install-only logic below ever
# runs.
#
# M6 (round 4 review): the library path crosses into node as an ARGUMENT, like
# $REPO and $DEST on the same line, never as part of the program text. It used
# to be escaped for a JavaScript string literal by a sed that handled the
# single quote and nothing else, and pasted into `import ... from '...'`.
# Measured: a checkout path containing a backslash and an apostrophe died with
# `SyntaxError: Unexpected identifier`, and a backslash alone was worse than a
# crash -- the backslash was consumed as a JS escape, so node resolved a
# DIFFERENT path and reported ERR_MODULE_NOT_FOUND from the one tool whose job
# is telling an operator whether their install is current. pathToFileURL does
# the encoding correctly, which is the point of passing data as data: there is
# no escaping question left to get wrong.
#
# RESIDUAL, measured and bounded rather than claimed closed: node's ESM
# resolver REFUSES any file URL holding an encoded backslash
# (ERR_INVALID_MODULE_SPECIFIER, "must not include encoded / or \\
# characters"), so a checkout path containing a backslash cannot be imported
# however it is passed -- as an argument, as a relative specifier, or as
# source. What changes here is that such a path is no longer MANGLED into a
# different one, and the failure is the installer's own diagnostic naming the
# real path instead of an unhandled node stack trace. Every other shape the
# old sed could not handle (an apostrophe, a double quote, a dollar sign, a
# backtick, a space) now works. Recorded as debt in the spec.
#
# The library path goes LAST, and that position is load-bearing: the module
# decides whether it is being run as a CLI by comparing its own path against
# process.argv[1] (the same check bin/optimise-cycle-weekly.sh relies on to run
# it deliberately as main). Handing it its own path first therefore makes it
# execute its CLI and exit instead of being imported -- which is what happened
# on the first attempt at this fix, and what the installer's existing tests
# caught.
if [ "$CHECK_ONLY" -eq 1 ]; then
  exec node --input-type=module -e "
import { pathToFileURL } from 'node:url'
const [repo, dest, lib] = process.argv.slice(1)
let checkStaleness
try {
  ;({ checkStaleness } = await import(pathToFileURL(lib).href))
} catch (e) {
  console.error('install --check: cannot load ' + lib + ' -- ' + e.message)
  process.exit(2)
}
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
" "$REPO" "$DEST" "$LIB"
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
import { pathToFileURL } from 'node:url'
const [repo, lib] = process.argv.slice(1)
let listInstallFiles
try {
  ;({ listInstallFiles } = await import(pathToFileURL(lib).href))
} catch (e) {
  console.error('install: cannot load ' + lib + ' -- ' + e.message)
  process.exit(2)
}
const r = listInstallFiles(repo)
if (r.blind) {
  console.error('install: could not determine which files this repo tracks (not a git checkout?).')
  process.exit(2)
}
for (const f of r.files) console.log(f)
" "$REPO" "$LIB")

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
