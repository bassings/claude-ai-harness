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

`git reset --hard`'s own presence check (`'--hard' in rest`) was not
separately mutated -- it is the same shape as mutation 5 on the same
function and was judged redundant to prove twice; the two `reset --hard`
tests (dirty -> refused, clean -> allowed) are exercised end to end by every
other mutation's control run.

Note on line numbers in rows 1-6 above: they were measured against the file
as it stood before round 2 (below), which inserts a new `resolve_as_ref()`
function and roughly 40 additional lines into `destructive_scope()`'s
`checkout` branch. The code and the mutations performed are unchanged and
still present, just at higher line numbers now; rows 1-6 were not
re-verified against the shifted file this round, so their line references
are historical, not current-file pointers.

## Round 2: a bare pathspec and forced checkout/switch bypassed the guard entirely

**The hole.** `destructive_scope()`'s original `checkout` handling returned
`None` (not guarded) for a `checkout` with no `--` and no bare `.`, on the
stated ground that the sole argument "might be `-b <branch>` or a bare
`<branch>`". That reasoning is exactly the paragraph this section replaces:
it treated "not distinctly coded" as "safe to leave unguarded", when in fact
`git checkout <file>` -- no `--`, shorter to type than the guarded
`git checkout -- <file>` and so the more likely form for an agent to
actually type -- reverts the file identically to the guarded form whenever
`<file>` does not happen to also be a valid ref. Measured directly against a
real repo (a real edit destroyed, not inferred): `git checkout README.md`,
`git checkout src/` (bare directory pathspec) and `git checkout -f
<branch>`/`git checkout --force <branch>` all discarded uncommitted work
while exit 0/allowed.

**What was measured before writing the fix** (all against a real temp repo,
recorded here because the fix's correctness depends on them):

- `git rev-parse --verify --quiet <arg>^{commit}` returns exit 0 for a valid
  branch, tag or `HEAD`, and exit 1 for anything that is not a valid ref
  (including an ordinary tracked-file path) -- this is the test
  `resolve_as_ref()` uses, run with the same `cwd` and `sanitized_git_env()`
  as `has_uncommitted_change()`'s own `git status` call.
- **Ambiguous case (an argument that is BOTH a valid ref and an existing
  path):** created a branch named `README.md` alongside the tracked file
  `README.md`, dirtied the file, ran `git checkout README.md`. Git printed
  `Switched to branch 'README.md'` and left the working-tree modification
  in place (`M README.md` in `git status` afterwards) -- git's own
  precedence resolves the ambiguity as a REF, not a pathspec, and does not
  discard the uncommitted change. When the two diverge in content instead
  (branch's committed `README.md` differs from the dirty working copy),
  git refuses outright: `error: Your local changes to the following files
  would be overwritten by checkout... Aborting`. Both outcomes are
  non-destructive, so `resolve_as_ref` returning `True` for a single
  ambiguous argument and `destructive_scope()` returning `None` (not
  guarded) for it is correct -- git's own safety net covers the case this
  hook does not need to.
- **Two-argument form**: `git checkout HEAD README.md` (no `--`) reverted
  the dirty file exactly like the guarded `--` form. `git rev-parse
  --verify --quiet HEAD^{commit}` resolves; the trailing pathspec is
  treated as a path regardless of whether it separately resolves as a ref.
  `git checkout a.txt b.txt` (two bare pathspecs, no leading ref) also
  reverted both files -- multiple non-ref arguments are all pathspecs.
- **Forced checkout/switch**: `git checkout -f <branch>`, `git checkout
  --force <branch>`, a bare `git checkout -f`, `git checkout -f -b
  <newbranch>`, `git switch -f <branch>`, `git switch --force <branch>` and
  `git switch --discard-changes <branch>` all silently discarded a dirty
  tracked file tree-wide -- every variant named in the brief was confirmed
  destructive, none contradicted the claim. `git checkout -f -- <path>` was
  also measured and found to behave identically to the unforced `--`
  pathspec form (no wider blast radius), so `-f` is checked for scope
  purposes only when `--` is absent; when `--` is present the existing
  path-scoped handling already covers it precisely, and widening it to
  `('tree', None)` would only make the guard block unrelated dirty files
  outside the named path -- a false positive, not a fix.

**The fix** (`hooks/destructive-git-guard.py`): a new `resolve_as_ref(cwd,
arg)` helper runs the `rev-parse` check above. `destructive_scope()`'s
`checkout` branch, after the existing `--` and bare-`.` checks, now: (a)
scopes `('tree', None)` if `-f`/`--force` is present, checked before the
`-b`/`-B`/`--orphan` carve-out because force overrides it (measured); (b)
still returns `None` for `-b`/`-B`/`--orphan` (branch creation); (c)
otherwise resolves the first non-flag argument as a ref-or-not and scopes
accordingly -- `('paths', remainder)` if it is a ref and there are trailing
arguments, `None` if it is a ref with nothing trailing (a plain branch
switch, left to git's own safety net), `('paths', non_flags)` if it is not.
A new `switch` branch scopes `('tree', None)` for
`-f`/`--force`/`--discard-changes` and `None` otherwise (a plain switch
git itself refuses if it would overwrite).

| # | Guard | Location | Mutation | Diff confirmed on | Result |
|---|---|---|---|---|---|
| A | An argument that resolves as a ref is treated as a ref, not a pathspec (git's own precedence) | `destructive_scope()`, `if resolve_as_ref(cwd, first):` | `if resolve_as_ref(cwd, first):` -> `if False and resolve_as_ref(cwd, first):` | line 164, single-line diff | 42 tests, 41 pass, 1 fail -- exactly the ambiguous-name test (`README.md` as both branch and dirty file, expected allowed, now wrongly refused) |
| B | `git checkout -f`/`--force` scopes the whole tree | `destructive_scope()`, `if '-f' in rest or '--force' in rest:` | condition -> `if False:` | line 156, single-line diff | 42 tests, 39 pass, 3 fail -- the three `checkout -f`/`--force` dirty-tree refusal tests (named branch, `--force` long form, bare `-f`), disjoint from A |
| C | `git switch -f`/`--force`/`--discard-changes` scopes the whole tree | `destructive_scope()`, switch branch's `if` | condition -> `if False:` | line 175, single-line diff | 42 tests, 39 pass, 3 fail -- the three `switch` force-variant dirty-tree refusal tests, disjoint from A and B |
| D | A bare pathspec (no leading ref, no `--`) is scoped as a path, not silently allowed | `destructive_scope()`, `return ('paths', non_flags)` | `-> return None` | line 172, single-line diff | 42 tests, 40 pass, 2 fail -- exactly the bare-file (`git checkout README.md`) and bare-directory (`git checkout src/`) refusal tests, disjoint from A/B/C |
| E | The two-argument `<ref> <path>` form is scoped by its trailing paths, not silently allowed | `destructive_scope()`, `return ('paths', remainder) if remainder else None` | `-> return None` | line 168, single-line diff | 42 tests, 41 pass, 1 fail -- exactly `git checkout HEAD <dirty file>`, disjoint from A/B/C/D |
| F | `-b`/`-B`/`--orphan` still exempts branch creation from scoping, even when the new branch name collides with an existing dirty tracked file | `destructive_scope()`, `if '-b' in rest or '-B' in rest or '--orphan' in rest:` | condition -> `if False:` | line 158, single-line diff | 42 tests, 41 pass, 1 fail -- exactly the colliding-name floor test (`git checkout -b README.md` on a dirty `README.md`); the ORIGINAL non-colliding `-b` floor test (`git checkout -b another-new-branch`) stayed green through this mutation, confirming that test alone could never have caught a broken carve-out (it was added deliberately for this reason) |
| G | `resolve_as_ref()` must return `False`, not just "truthy", when `rev-parse` fails -- proves the DANGEROUS direction: an over-eager "always a ref" classification would silently let bare-pathspec reverts back through | `resolve_as_ref()`, `return result.returncode == 0` | `-> return True` | line 133, single-line diff | 42 tests, 40 pass, 2 fail -- the SAME two tests as D (bare-file and bare-directory pathspec refusal). Same failure set as D by design: D and G are two independent lines that must both be correct for those two tests to pass -- breaking either one alone reopens the hole, which is the point of proving both |

Restored via `cp` from the pre-round-2 snapshot after each mutation, never
`git checkout --`; `diff` against the snapshot confirmed clean before the
next mutation. Full suite (`node --test test/*.test.js`) run three times
after the final restore, all green (743/743).

## Not separately mutated (round 2)

- **`-b`/`-B`/`--orphan` combined with `-f`** was measured (`git checkout -f
  -b <newbranch>` on a dirty tree discards the change) but is not a
  distinct branch to mutate: it is exercised by mutation B (force is
  checked, and found, before the `-b` carve-out is ever reached).
- **A subprocess failure inside `resolve_as_ref()`** (`git` unavailable, a
  timeout) falls back to `False` (fail-open toward treating the argument as
  a pathspec, at which point `has_uncommitted_change()`'s real `git status`
  call still governs whether anything is actually blocked) -- not driven
  with a fixture that makes the `rev-parse` subprocess itself fail, for the
  same reason `has_uncommitted_change()`'s equivalent except-branch was
  flagged rather than tested in round 1.

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
