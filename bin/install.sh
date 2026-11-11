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
#
# A first install is a destination holding nothing, or holding the markers of a
# Claude home: settings.json or projects/ (what Claude Code itself creates
# before any harness is installed), or the harness's own files. Anything else
# is refused, and the refusal prints the one command that proceeds.
#
# One thing outranks every marker: a typical user-home entry (a shell rc file,
# Documents, Desktop, Library, Downloads) means this is somebody's home
# directory, not a Claude home, however many markers it also holds. A plain
# ~/projects is common, so a marker alone proves nothing.
shquote() {
  _s=$1
  _out=
  _sq="'"
  while :; do
    case $_s in
      *"$_sq"*)
        _pre=${_s%%"$_sq"*}
        _out="$_out$_pre$_sq\\$_sq$_sq"
        _s=${_s#*"$_sq"}
        ;;
      *) _out="$_out$_s"; break ;;
    esac
  done
  printf "'%s'" "$_out"
}

refuse_destination() {
  echo "install: $DEST does not look like a Claude install: $1. Refusing." >&2
  echo "         If this really is where the harness should go, run:" >&2
  echo "HARNESS_INSTALL_REQUIRE_MARKER=0 CLAUDE_HOME=$(shquote "$DEST") $(shquote "$REPO/bin/install.sh")" >&2
  exit 2
}

if [ "$CHECK_ONLY" -eq 0 ] && [ "${HARNESS_INSTALL_REQUIRE_MARKER:-1}" = "1" ]; then
  if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
    for _entry in .zshrc .bashrc .bash_profile .profile Documents Desktop Library Downloads; do
      if [ -e "$DEST/$_entry" ] || [ -L "$DEST/$_entry" ]; then
        refuse_destination "it holds $_entry, which belongs to a user's home directory"
      fi
    done
    if [ ! -e "$DEST/AGENT-HARNESS.md" ] && [ ! -d "$DEST/workflows" ] && [ ! -d "$DEST/skills" ] \
      && [ ! -e "$DEST/settings.json" ] && [ ! -d "$DEST/projects" ]; then
      refuse_destination "it holds none of settings.json, projects/, AGENT-HARNESS.md, workflows/ or skills/"
    fi
  fi
fi

# Installing a checkout that is not the reviewed default branch, or that holds
# uncommitted changes, puts that code live on the next session. Warn, naming
# which, and carry on: it is a legitimate thing to do, just not silently.
_default=$(git -C "$REPO" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null || true)
_default=${_default#origin/}
[ -n "$_default" ] || _default=main
_branch=$(git -C "$REPO" symbolic-ref --short -q HEAD 2>/dev/null || true)
[ -n "$_branch" ] || _branch="(detached HEAD)"
if [ "$_branch" != "$_default" ]; then
  echo "install: warning: installing from branch '$_branch', not the default branch '$_default'." >&2
fi
_dirty=$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null || true)
if [ -n "$_dirty" ]; then
  echo "install: warning: installing from a checkout with uncommitted changes to tracked files:" >&2
  printf '%s\n' "$_dirty" >&2
fi

# Overwritten files are first copied under one dedicated directory, never
# beside the original, so a backup cannot be loaded as an agent, skill,
# workflow or hook. Only the newest KEEP_BACKUPS timestamp directories are kept.
KEEP_BACKUPS=10
BK_ROOT="$DEST/.harness-backups"
BK_DIR=""
installed=0
tmp=""

# The one way an install fails part-way: say what was done, that the result is
# a mix, and the two ways out.
fail_install() {
  echo "install: $1" >&2
  echo "install: INCOMPLETE: $installed file(s) updated before this failure, so $DEST holds a mix of old and new files." >&2
  echo "         To finish: fix the cause above and re-run this installer." >&2
  if [ -n "$BK_DIR" ]; then
    echo "         To undo: copy the files back from $BK_DIR (same relative paths)." >&2
  else
    echo "         No file was backed up in this run, so there is nothing to restore." >&2
  fi
  exit 1
}

# Timestamp-named directories are the only entries retention counts or deletes.
is_backup_name() {
  case "$1" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z*) return 0 ;;
  esac
  return 1
}

make_backup_dir() {
  mkdir -p "$BK_ROOT" || fail_install "cannot create $BK_ROOT; nothing was overwritten by this step."
  _ts=$(date -u +%Y%m%dT%H%M%SZ)
  _cand=$_ts
  _n=0
  # mkdir without -p fails if the name exists, so a second install in the same
  # second takes the next suffix instead of reusing (and overwriting into) the
  # first one's directory.
  while ! mkdir "$BK_ROOT/$_cand" 2>/dev/null; do
    if [ ! -e "$BK_ROOT/$_cand" ]; then
      fail_install "cannot create a backup directory under $BK_ROOT; nothing was overwritten by this step."
    fi
    _n=$((_n + 1))
    _cand="$_ts-$_n"
  done
  BK_DIR="$BK_ROOT/$_cand"
  echo "install: previous versions of overwritten files are backed up in $BK_DIR"
}

# An interrupted earlier install (a kill, which no trap can catch) leaves
# <file>.harness-tmp.<pid> beside its destination. Remove those, only in the
# directories this install publishes into and only with exactly that suffix,
# and name each one.
_seen="|"
for rel in $FILES; do
  _d="$DEST/$(dirname -- "$rel")"
  case "$_seen" in *"|$_d|"*) continue ;; esac
  _seen="$_seen$_d|"
  [ -d "$_d" ] || continue
  for _stale in "$_d"/*.harness-tmp.[0-9]*; do
    [ -f "$_stale" ] || continue
    rm -f "$_stale"
    echo "install: removed leftover temp file from an interrupted install: $_stale" >&2
  done
done

# A signal between the temp write and the rename must not leave the temp file.
trap 'if [ -n "$tmp" ]; then rm -f "$tmp"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for rel in $FILES; do
  src="$REPO/$rel"
  dst="$DEST/$rel"
  if [ ! -f "$src" ]; then
    echo "install: skipped $rel (listed as published, but not found in $REPO)" >&2
    continue
  fi
  mkdir -p "$(dirname -- "$dst")"
  # Only copy what actually differs, so an install is quiet and its output
  # says what genuinely moved.
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    continue
  fi
  if [ -f "$dst" ]; then
    [ -n "$BK_DIR" ] || make_backup_dir
    mkdir -p "$(dirname -- "$BK_DIR/$rel")" \
      && cp -p "$dst" "$BK_DIR/$rel" \
      && cmp -s "$dst" "$BK_DIR/$rel" \
      || fail_install "could not back up $rel; it was left unchanged."
  fi
  # Written beside the destination (same filesystem, so the rename is atomic)
  # under a name no loader matches, then renamed over it: a kill at any point
  # leaves the old file whole.
  tmp="$dst.harness-tmp.$$"
  cp "$src" "$tmp" && cmp -s "$src" "$tmp" \
    || fail_install "could not write $rel; it was left unchanged."
  mv -f "$tmp" "$dst" \
    || fail_install "could not replace $rel; it was left unchanged."
  tmp=""
  echo "updated: $rel"
  installed=$((installed + 1))
done

if [ -n "$BK_DIR" ]; then
  _count=0
  for _name in $(ls -1 "$BK_ROOT"); do
    if is_backup_name "$_name"; then _count=$((_count + 1)); fi
  done
  _excess=$((_count - KEEP_BACKUPS))
  for _name in $(ls -1 "$BK_ROOT"); do
    [ "$_excess" -gt 0 ] || break
    is_backup_name "$_name" || continue
    [ "$BK_ROOT/$_name" != "$BK_DIR" ] || continue
    rm -rf "$BK_ROOT/$_name"
    _excess=$((_excess - 1))
  done
fi

echo "install: $installed file(s) updated in $DEST."
# Verify what we just did, rather than assuming the copies landed.
exec "$0" --check
