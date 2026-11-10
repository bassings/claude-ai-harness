#!/bin/sh
# Tripwire for a test run writing into the operator's real run ledger.
#
#   ledger-tripwire.sh state            print the ledger's state on one line
#   ledger-tripwire.sh verify "<state>" exit 1, naming the file, unless the state is unchanged
#
# The ledger is <git common dir>/../.claude/harness-ledger.jsonl, resolved the way
# workflows/lib/ledger-append.mjs resolves it, so a linked worktree points at the
# main checkout's ledger. "absent" is a state: a run that creates a ledger that was
# not there has changed it. The state is the file's sha256 and size.
#
# This lives outside test/ on purpose: the suite must not name the live ledger
# (HARN-AUDIT-1 AC-QA-9), so the check that it stays untouched sits in the gates
# that run the suite (.githooks/pre-push and the CI test step).
set -u

_path() {
  _common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  printf '%s\n' "$(dirname "$_common")/.claude/harness-ledger.jsonl"
}

_state() {
  _p=$(_path) || { echo "no-git-repository"; return 0; }
  if [ -f "$_p" ]; then
    if command -v sha256sum >/dev/null 2>&1; then _sum=$(sha256sum < "$_p" | cut -d' ' -f1); else _sum=$(shasum -a 256 < "$_p" | cut -d' ' -f1); fi
    _size=$(wc -c < "$_p" | tr -d ' ')
    echo "present sha256=${_sum} size=${_size} path=${_p}"
  else
    echo "absent path=${_p}"
  fi
}

case "${1:-}" in
  state) _state ;;
  verify)
    _after=$(_state)
    if [ "$_after" != "${2:-}" ]; then
      echo "ledger-tripwire: the run changed the operator's run ledger; a test must never write to it." >&2
      echo "ledger-tripwire: before: ${2:-}" >&2
      echo "ledger-tripwire: after:  ${_after}" >&2
      exit 1
    fi
    ;;
  *) echo "usage: ledger-tripwire.sh state | verify \"<state>\"" >&2; exit 2 ;;
esac
