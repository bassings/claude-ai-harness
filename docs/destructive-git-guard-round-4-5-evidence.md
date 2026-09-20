# Destructive git guard: measured evidence, review rounds 4 and 5

This file exists because the PR body's figures went stale against the branch
tip and nobody could tell which were still true (K1 review round 5, M7).
Evidence that a reviewer has to trust belongs with the code, where a diff
shows it moving, not in a comment thread.

Everything below was measured on this branch. Re-measure rather than quote
after any change to `hooks/destructive-git-guard.py` or
`hooks/destructive-git-cases.json`.

- Measured at: round 5, with 231 corpus cases (the commit that adds this
  file; re-measure rather than quote if the corpus moves)
- Platform: macOS, Darwin 27.0.0, Apple Silicon
- git 2.54.0 (Apple Git-157), Python 3.14.7, Node 22

## Corpus size

| | Count |
|---|---|
| Cases | 231 |
| `block` cases | 113 |
| `allow` cases | 118 |
| Distinct commands | 123 |
| Commands with a `block` case and no `allow` twin | 18 |

Those 18 are the three families where a same-command clean twin is
impossible, each with its reason recorded in a case note and the nearest
honest twin beside it: a `git stash` push followed by a drop, an
unresolvable `cd` target, and `--git-dir`/`--work-tree` retargeting.

## Per-invocation timing

`hooks/test_destructive_git_cases.py`'s `TestHookProcessContract` runs every
case as a real subprocess of the guard, the deployed hook path, and prints
these. Three consecutive runs on an otherwise idle machine:

| Run | n | Max | Median |
|---|---|---|---|
| 1 | 231 | 196.4ms | 42.1ms |
| 2 | 231 | 50.5ms | 38.8ms |
| 3 | 231 | 154.5ms | 39.1ms |

The per-invocation budget asserted by the test is 1000ms (AC-QA-7). The
maximum varies by roughly a factor of four between runs on the same machine,
so treat any single figure as an upper bound with wide error bars rather
than a benchmark. The figure that matters is the headroom, not the number.

Worst case by construction, which is what `hooks/hooks.json`'s registered
timeout has to clear: `MAX_SUBPROCESS_CALLS_PER_SEGMENT` (3) x
`SUBPROCESS_TIMEOUT_SECONDS` (10) = 60s for a single segment, asserted
against the registered timeout by `hooks/test_hook_timeout_budget.py`. A
PreToolUse hook that times out lets the command PROCEED, so that assertion
is load-bearing.

## Suite sizes

| Suite | Tests |
|---|---|
| `python3 -m unittest discover -s hooks -p 'test_*.py'` | 104 |
| `node --test test/*.test.js` | 1201 |

## Round 4 mutation table

Every mutation was applied, verified to have landed, then restored and the
restore confirmed byte-identical. "Red" names the corpus cases or tests that
failed under the mutation.

| Mutation | Result |
|---|---|
| Drop `-q`/`--quiet` from the clean dry run's reporting-only flags | H1 cases red |
| Strip `-f` from the clean dry run again | H2 case red |
| Skip the `clean.requireForce` config read | M2 block case red |
| Always measure an unforced clean | M2 allow case red (over-block direction) |
| Match a stash push by literal spelling again | 5 H3 cases red |
| Drop `drop` from the non-push subcommand set | existing empty-stash allow twins red |
| `normalize_stash_ref` returns the raw ref | H4 index cases red |
| An unreducible stash ref read as "no match" | reflog-date case red |
| `classify_stash` reads `rest[1]` blindly | flag-before-ref twin red |
| Remove the `refs/` prefix strip | `refs/stash@{0}` case red |
| `--git-dir`/`--work-tree` not marked as retargeting | 4 M1 cases red |
| Ignore the `GIT_DIR=` env-prefix spelling | 2 M1 cases red |
| Refuse every clean unconditionally | 22 allow twins red |
| xargs reports no unknown trailing arguments | probe #13 and the restore cases red |
| Stash drop not widened to clear under unknown args | **survived**; a distinguishing case was added, then red |
| checkout not widened to tree-wide under unknown args | probe #13 red |
| `child_context` returns `state` (the cwd leak) | 4 M4 cases red, both directions |
| `child_context` copies `shared` too | 2 stash-crossing cases red |
| Evaluate every substitution up front | M4-3 pair red |
| Emit no placeholder for `$(...)` | 4 substitution cases red |
| `switch` stops recognising `-f`/`--force` | 2 cases red |
| `checkout` stops recognising `--force` | 1 case red |
| Disable `resolve_as_ref` entirely | **survived** -- see below |
| `sanitized_git_env` returns the real environment | 2 Python tests red, and only those two |

### The survivor worth knowing about

Disabling `resolve_as_ref()` leaves the whole corpus green. Measured reason:
`git status --porcelain -- HEAD README.md` exits 0 with empty output,
because git status tolerates an unmatched pathspec instead of rejecting it,
so narrowing the scope never changes the answer. The only shape where it
would is `git checkout master README.md` with both a branch and a file named
`master`, which git itself refuses (`ambiguous argument`, exit 128).

It costs one subprocess call per checkout segment and a third of the worst
case above. Recorded as a simplification candidate, not changed.

## Round 5 mutation table

| Mutation | Result |
|---|---|
| `validate_setup_op` never called from `apply_setup` | 6 hostile-argument tests red |
| `_check_config` becomes a no-op | 3 config tests red, sentinel created |
| `resolve_inside` stops containing | **survived** against the op tests; a direct test was added, then red |
| Path/name allowlist accepts a leading dash | option-injection test red |
| `split_segments` reports no pipeline component | 2 pipeline `cd` cases red |
| Subshell `(` pushes no context | 3 subshell `cd` cases red |
| `take_subshell_parens` counts no `(` | 3 subshell `cd` cases red |
| Schema-export drift check: each of the three doctorings made a no-op | the export mutation guard red, once per doctoring |

### The survivor worth knowing about

`resolve_inside()` is the second layer behind the path allowlist, and
`apply_setup()` never reaches it with a hostile path because the allowlist
rejects those first. Mutating its containment check away left every
argument-validation test green. It is now exercised directly on its own
contract, which is what would still hold if the allowlist regex were ever
loosened.

## What the guard does not stop

`README.md`'s "What this guard does not stop" table is the single list, and
every row in it was run against this tip. It is not repeated here, so there
is one copy to keep true rather than two.
