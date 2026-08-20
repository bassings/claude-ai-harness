# destructive-git-guard mutation proofs

Per standard §11: for each guard below, the guarded behaviour was actually
broken in `hooks/destructive-git-guard.py` (edited in the working file, not
"mentally mutated"), the diff was read back to confirm the edit landed on the
intended line (not a comment or an unrelated match), `test/destructive-git-guard.test.js`
was run and the exact failing test(s) recorded, then the file was restored
via `cp` from a pre-mutation snapshot -- never `git checkout --`, which is
the exact command this guard exists to refuse and reverts to the last commit,
which can destroy uncommitted work -- confirmed via `diff` against the
snapshot returning nothing before the next mutation. Full suite
(`node --test test/*.test.js`) run three times after restoring, all green
(723/723).

Driven as a real subprocess (`spawnSync('python3', [HOOK_PATH], ...)`)
against a real temp git repository via `test/helpers/temp-repo.js`
(`makeTempRepo`, `sanitizedGitEnv`), never by asserting on the hook's source
text.

| # | Guard | Location | Mutation | Diff confirmed on | Result |
|---|---|---|---|---|---|
| 1 | Blocking exit code must be exactly 2 (any other exit code is silently ignored by Claude Code's PreToolUse contract) | `main()`, `sys.exit(2)` | `sys.exit(2)` -> `sys.exit(1)` | line 210, single-line diff | 22 tests, 15 pass, 7 fail -- every test asserting `status === 2` (all refusal-path tests) |
| 2 | Untracked files do not count as "something to lose" (`git reset --hard` and `git checkout --` cannot lose an untracked file) | `has_uncommitted_change()`, the `??`-exclusion | `if not line.startswith('??')` -> `if True` | line 163, single-line diff | 22 tests, 20 pass, 2 fail -- exactly the two untracked-file carve-out tests (`reset --hard` with only an untracked file; `checkout -- <untracked file>`) |
| 3 | Escape hatch (`HARNESS_ALLOW_DESTRUCTIVE_GIT=1`, inline or exported) actually bypasses the guard | `evaluate()`, `if escape_hatch_active(command)` | condition wrapped in `False and (...)` | line 180, single-line diff | 22 tests, 20 pass, 2 fail -- exactly the two escape-hatch tests (inline, exported) |
| 4 | `git restore --staged <path>` alone is allowed (it only unstages) | `destructive_scope()`, `if staged and not worktree` | `if staged and not worktree` -> `if False` | line 129, single-line diff | 22 tests, 20 pass, 2 fail -- exactly the two `--staged`-alone tests |
| 4b | Fails in the OTHER direction too: `--staged --worktree` (which DOES touch the worktree) must still be refused | same line, inverse mutation | `if staged and not worktree` -> `if staged` | line 129, single-line diff | 22 tests, 21 pass, 1 fail -- exactly the `--staged --worktree` refusal test, disjoint from 4's failure set |
| 5 | `git checkout -- <path>` detection | `destructive_scope()`, `if '--' in rest:` (checkout branch) | `if '--' in rest:` -> `if False and '--' in rest:` | line 119, single-line diff | 22 tests, 19 pass, 3 fail -- the three tests driving a literal `git checkout -- <path>` (direct, chained after `echo`, and the refusal-message-content test) |
| 6 | Quote-aware tokenisation (shlex) is load-bearing, not decorative: a naive substring check on the raw command string would false-positive on destructive-looking text inside a quoted argument | `evaluate()`, replaced the tokenised scan with a naive `'git checkout --' in command` substring check ahead of it | inserted 2 lines before the `try: segments = split_segments(...)` block | lines 182-183, confirmed by diff (pure insertion, nothing upstream touched) | 22 tests, 21 pass, 1 fail -- exactly `destructive-looking text INSIDE A QUOTED ARGUMENT is not mistaken for a real invocation` (`git commit -m "git checkout -- README.md"` on a dirty+staged README.md, which the naive form incorrectly refuses) |

Not separately mutated (structurally vacuous to test in isolation, and
covered indirectly by the table above): the `-b`/bare-branch checkout
exclusion is not a distinct code branch -- `destructive_scope()` only
recognises `--` or a sole `.` argument, so `git checkout -b` and
`git checkout <branch>` fall through to `None` with no dedicated
conditional to break; test 5's mutation (which does touch the `checkout`
branch) does not affect those two tests, which stayed green through it.
`git reset --hard`'s own presence check (`'--hard' in rest`) was not
separately mutated -- it is the same shape as mutation 5 on the same
function and was judged redundant to prove twice; the two `reset --hard`
tests (dirty -> refused, clean -> allowed) are exercised end to end by every
other mutation's control run.

## Escape hatch: verified end to end, not just at the detection layer

Tests 19-20 in `test/destructive-git-guard.test.js` prove the escape hatch
by running the REAL hook against a REAL dirty repo and asserting exit 0 --
not by asserting the regex matches. Mutation 3 above additionally proves the
check is load-bearing: removing it flips exactly those two tests from pass
to fail and nothing else, confirming no other code path independently
allows the same commands through.

## What was NOT covered

- **Shell shapes `shlex` cannot represent** (subshells `$(...)`, backticks,
  here-docs, process substitution) are documented as fail-open in the
  module's own docstring and are not mutation-tested here, because there is
  no code path to break: `split_segments()` either tokenises them into
  something that does not match `git checkout|restore|reset` (most
  subshell forms) or raises inside `shlex`, both of which already return
  `None`/allow deliberately. This is a scope boundary, not an unverified
  guard.
- **A hostile `cwd`** (a payload naming a directory that is not a git
  repository, or one where `git status` itself fails) was exercised
  indirectly via `has_uncommitted_change()`'s `try/except` and the
  `returncode != 0` check, but has no dedicated test in this round; the
  fail-open behaviour there (treat as clean, allow) matches the documented
  design but was not driven with a fixture that makes `git status` itself
  fail (e.g. a corrupted `.git`). Flagged rather than silently assumed
  correct.
