#!/bin/sh
# Point this clone's git at .githooks, so the pre-push gate actually runs.
#
# Why this exists: core.hooksPath is LOCAL config. A repository cannot set it
# for you, so a committed hook is inert in every fresh clone, and it fails
# SILENTLY -- git ignores an unset hooksPath without a word, so the push
# succeeds and looks gated. Measured: with .githooks/pre-push present,
# executable and unconditionally `exit 1`, `git push` returned 0 and the hook
# never printed; after `git config core.hooksPath .githooks` the identical
# push was blocked.
#
# Deliberately RELATIVE. An absolute path is resolved against each linked
# worktree, so a worktree would run the main checkout's copy of the hook --
# including a stale copy from a branch that predates it.
set -e

cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks

configured=$(git config --get core.hooksPath)
if [ "$configured" != ".githooks" ]; then
  echo "setup-hooks: expected core.hooksPath=.githooks, got '${configured:-unset}'" >&2
  exit 1
fi
if [ ! -x .githooks/pre-push ]; then
  echo "setup-hooks: .githooks/pre-push is missing or not executable; the gate would be silently skipped" >&2
  exit 1
fi
echo "setup-hooks: core.hooksPath=.githooks, pre-push gate active"
