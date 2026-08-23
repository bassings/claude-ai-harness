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
| 1 | Blocking exit code must be exactly 2 (any other exit code is silently ignored by Claude Code's PreToolUse contract) | `main()`, `sys.exit(2)` | `sys.exit(2)` -> `sys.exit(1)` | single-line diff (see Location column) | 22 tests, 15 pass, 7 fail -- every test asserting `status === 2` (all refusal-path tests) |
| 2 | Untracked files do not count as "something to lose" (`git reset --hard` and `git checkout --` cannot lose an untracked file) | `has_uncommitted_change()`, the `??`-exclusion | `if not line.startswith('??')` -> `if True` | single-line diff (see Location column) | 22 tests, 20 pass, 2 fail -- exactly the two untracked-file carve-out tests (`reset --hard` with only an untracked file; `checkout -- <untracked file>`) |
| 3 | Escape hatch (`HARNESS_ALLOW_DESTRUCTIVE_GIT=1`, inline or exported) actually bypasses the guard | `evaluate()`, `if escape_hatch_active(command)` | condition wrapped in `False and (...)` | single-line diff (see Location column) | 22 tests, 20 pass, 2 fail -- exactly the two escape-hatch tests (inline, exported) |
| 4 | `git restore --staged <path>` alone is allowed (it only unstages) | `destructive_scope()`, `if staged and not worktree` | `if staged and not worktree` -> `if False` | single-line diff (see Location column) | 22 tests, 20 pass, 2 fail -- exactly the two `--staged`-alone tests |
| 4b | Fails in the OTHER direction too: `--staged --worktree` (which DOES touch the worktree) must still be refused | same line, inverse mutation | `if staged and not worktree` -> `if staged` | single-line diff (see Location column) | 22 tests, 21 pass, 1 fail -- exactly the `--staged --worktree` refusal test, disjoint from 4's failure set |
| 5 | `git checkout -- <path>` detection | `destructive_scope()`, `if '--' in rest:` (checkout branch) | `if '--' in rest:` -> `if False and '--' in rest:` | single-line diff (see Location column) | 22 tests, 19 pass, 3 fail -- the three tests driving a literal `git checkout -- <path>` (direct, chained after `echo`, and the refusal-message-content test) |
| 6 | Quote-aware tokenisation (shlex) is load-bearing, not decorative: a naive substring check on the raw command string would false-positive on destructive-looking text inside a quoted argument | `evaluate()`, replaced the tokenised scan with a naive `'git checkout --' in command` substring check ahead of it | inserted 2 lines before the `try: segments = split_segments(...)` block | confirmed by diff (pure two-line insertion, nothing upstream touched) | 22 tests, 21 pass, 1 fail -- exactly `destructive-looking text INSIDE A QUOTED ARGUMENT is not mistaken for a real invocation` (`git commit -m "git checkout -- README.md"` on a dirty+staged README.md, which the naive form incorrectly refuses) |

`git reset --hard`'s own presence check (`'--hard' in rest`) was not
separately mutated -- it is the same shape as mutation 5 on the same
function and was judged redundant to prove twice; the two `reset --hard`
tests (dirty -> refused, clean -> allowed) are exercised end to end by every
other mutation's control run.

Rows 1-6 originally recorded specific line numbers, which went stale the very
next round (round 2 inserted a new `resolve_as_ref()` function and roughly 40
lines into `destructive_scope()`'s `checkout` branch, and round 3 rewrote most
of the file again). A doc that names a line number is wrong again on the next
unrelated edit and has no way to notice, which is worse than not naming one --
so this doc now anchors every mutation to the function/constant it targets
(the Location column) instead of a line number, which cannot go stale the same
way. The mutations themselves, and the diff-confirmation discipline, are
unchanged.

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
| A | An argument that resolves as a ref is treated as a ref, not a pathspec (git's own precedence) | `destructive_scope()`, `if resolve_as_ref(cwd, first):` | `if resolve_as_ref(cwd, first):` -> `if False and resolve_as_ref(cwd, first):` | single-line diff (see Location column) | 42 tests, 41 pass, 1 fail -- exactly the ambiguous-name test (`README.md` as both branch and dirty file, expected allowed, now wrongly refused) |
| B | `git checkout -f`/`--force` scopes the whole tree | `destructive_scope()`, `if '-f' in rest or '--force' in rest:` | condition -> `if False:` | single-line diff (see Location column) | 42 tests, 39 pass, 3 fail -- the three `checkout -f`/`--force` dirty-tree refusal tests (named branch, `--force` long form, bare `-f`), disjoint from A |
| C | `git switch -f`/`--force`/`--discard-changes` scopes the whole tree | `destructive_scope()`, switch branch's `if` | condition -> `if False:` | single-line diff (see Location column) | 42 tests, 39 pass, 3 fail -- the three `switch` force-variant dirty-tree refusal tests, disjoint from A and B |
| D | A bare pathspec (no leading ref, no `--`) is scoped as a path, not silently allowed | `destructive_scope()`, `return ('paths', non_flags)` | `-> return None` | single-line diff (see Location column) | 42 tests, 40 pass, 2 fail -- exactly the bare-file (`git checkout README.md`) and bare-directory (`git checkout src/`) refusal tests, disjoint from A/B/C |
| E | The two-argument `<ref> <path>` form is scoped by its trailing paths, not silently allowed | `destructive_scope()`, `return ('paths', remainder) if remainder else None` | `-> return None` | single-line diff (see Location column) | 42 tests, 41 pass, 1 fail -- exactly `git checkout HEAD <dirty file>`, disjoint from A/B/C/D |
| F | `-b`/`-B`/`--orphan` still exempts branch creation from scoping, even when the new branch name collides with an existing dirty tracked file | `destructive_scope()`, `if '-b' in rest or '-B' in rest or '--orphan' in rest:` | condition -> `if False:` | single-line diff (see Location column) | 42 tests, 41 pass, 1 fail -- exactly the colliding-name floor test (`git checkout -b README.md` on a dirty `README.md`); the ORIGINAL non-colliding `-b` floor test (`git checkout -b another-new-branch`) stayed green through this mutation, confirming that test alone could never have caught a broken carve-out (it was added deliberately for this reason) |
| G | `resolve_as_ref()` must return `False`, not just "truthy", when `rev-parse` fails -- proves the DANGEROUS direction: an over-eager "always a ref" classification would silently let bare-pathspec reverts back through | `resolve_as_ref()`, `return result.returncode == 0` | `-> return True` | single-line diff (see Location column) | 42 tests, 40 pass, 2 fail -- the SAME two tests as D (bare-file and bare-directory pathspec refusal). Same failure set as D by design: D and G are two independent lines that must both be correct for those two tests to pass -- breaking either one alone reopens the hole, which is the point of proving both |

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

The two escape-hatch tests named "the escape hatch, set INLINE in the
command" and "the escape hatch, set as the hook PROCESS environment" in
`test/destructive-git-guard.test.js` prove the escape hatch by running the
REAL hook against a REAL dirty repo and asserting exit 0 -- not by asserting
a regex matches. (Deliberately named rather than indexed by position: a test
index drifts every time a test is added or removed above it, which is
exactly the staleness this doc's own line-number cleanup above was written
to stop repeating.) Mutation 3 above additionally proves the check is
load-bearing: removing it flips exactly those two tests from pass to fail
and nothing else, confirming no other code path independently allows the
same commands through. Round 3's escape-hatch redesign (below) replaces this
mechanism entirely and re-proves it against the tightened version.

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

## Round 3: a normalisation layer, closing eight bypasses a review reproduced against real destruction

**The hole.** Round 2 closed the bare-pathspec and forced-checkout gaps but
still pattern-matched the raw, untokenised shell string with no
normalisation stage in between. A multi-lens review, followed by an
orchestrator re-verification against a real dirty repo (`README.md`
`PRECIOUS` -> `seed`), reproduced eight distinct spellings of the four
already-guarded commands walking straight past the matcher with exit 0
where exit 2 was required, plus a false positive in the opposite direction.
Every one of the eight was one symptom of the same missing stage: `git -C`,
`--no-pager`, and an absolute `/usr/bin/git` all hid the subcommand behind a
token the matcher never looked past; `-fq`/`-fb` hid `force` inside a
bundled short-flag cluster; `> /dev/null` smuggled a redirect target into
the pathspec list; a quoted or commented mention of
`HARNESS_ALLOW_DESTRUCTIVE_GIT=1` disarmed the escape hatch from outside the
segment it was meant to scope; a bare newline was not a segment separator at
all, so the SECOND line of any multi-line Bash call -- the ordinary shape of
agent tool use -- was invisible to the guard entirely;
`--pathspec-from-file` produced no non-flag token to scope against. The `cd
<dir> && ...` false positive/negative pair shared the same root cause from
the other side: scope was always judged against the payload `cwd`, never
against a `cd` earlier in the same command.

**The fix** (`hooks/destructive-git-guard.py`, effectively rewritten): a
normalisation layer runs between the raw command string and
`destructive_scope()`, in order, per segment: `split_segments()` now treats
a bare newline as a control operator identical to `;`/`&&` (shlex's default
`whitespace` swallows `\n` before `punctuation_chars` ever sees it, so this
required clearing `lexer.whitespace` down to `' \t'`, not just adding `\n`
to `punctuation_chars` -- the first attempt at this fix looked correct and
silently did nothing, see the note below); `strip_redirects()` drops a
redirection operator and the token after it; `parse_git_invocation()`
recognises `git` by `os.path.basename()` rather than exact string match and
consumes git's own global options (`-C`, `--git-dir`, `--work-tree`, `-c`,
`--no-pager`, `-p`/`--paginate`, `--exec-path`, all forms) between the
binary and the subcommand, threading `-C`'s directory through as the
effective cwd; `expand_bundled_short_flags()` splits a `-[A-Za-z]+` token
into single-character flags, applied only to the portion of `rest` before a
literal `--` so a pathspec that happens to look like a flag cluster is never
shredded; `escape_hatch_active_for_segment()` replaces the old raw-string
`re.search` entirely, checking only the leading `VAR=value` run of the
SAME segment's own tokens; a new `cd`-tracking pass in `evaluate()` updates
an `effective_cwd` carried across segments, refusing (fail CLOSED) any later
guarded shape when the `cd` target could not be resolved statically rather
than judging it against a directory that might be wrong; and
`has_uncommitted_change()`'s pathspec-rejected branch now retries scoped to
the whole tree instead of concluding "clean", so a pathspec git itself
refuses can never become a licence for the destructive command.

**What was measured before writing the fix** (against a real dirty repo,
`hooks/destructive-git-guard.py`'s prior form as the control):

- All eight bypasses and the false positive reproduced exactly as the review
  reported, with the orchestrator's own probe additionally confirming real
  content destruction through the `git -C .` spelling specifically.
- The newline fix's first draft (`punctuation_chars` extended to include
  `'\n'`, `whitespace` left at its default) tokenised
  `'echo hi\ngit checkout -- README.md'` into a SINGLE segment with no `\n`
  token anywhere in it -- shlex's whitespace-skip runs before
  `punctuation_chars` is consulted, so a character present in both is
  treated as whitespace and never becomes a token. Only setting
  `lexer.whitespace = ' \t'` (removing `\r\n`) surfaced it as its own token.
  Recorded here because this is exactly the "guard that looks correct and
  isn't" failure standard §11 describes: the first version passed a manual
  read and would have shipped a hook that still did not catch a newline.

**The fix, closing all eight bypasses plus the false positive (probed
directly against a real dirty repo, then re-proven as the 20 RED-before-GREEN
tests below):**

| Bypass (round-2 review's table) | Before | After |
|---|---|---|
| `echo hi\n` + `git checkout -- README.md` | exit 0 | exit 2 |
| `git -C . checkout -- README.md` | exit 0 | exit 2 |
| `git --no-pager checkout -- README.md` | exit 0 | exit 2 |
| `/usr/bin/git checkout -- README.md` | exit 0 | exit 2 |
| `git checkout -fq other` | exit 0 | exit 2 |
| `git checkout -fb newbr` | exit 0 | exit 2 |
| `echo "HARNESS_ALLOW_DESTRUCTIVE_GIT=1" && git checkout -- README.md` | exit 0 | exit 2 |
| `git checkout -- README.md > /dev/null` | exit 0 | exit 2 |
| `git checkout --pathspec-from-file=paths.txt` | exit 0 | exit 2 |
| `cd <dirty repo> && git checkout -- README.md` (scoped against payload cwd) | exit 0 | exit 2 |
| `cd /tmp && git checkout -- README.md` (payload cwd dirty, but untouched) | exit 2 (false positive) | exit 0 |

`if true; then git checkout -- README.md; fi` was reproduced as a ninth
bypass beyond the review's table (a shell-keyword prefix, same root cause)
and is closed the same way, by `strip_shell_keywords()`.

**Proof, driven as `test/destructive-git-guard.test.js`'s real subprocess
against a real temp repo (never by asserting on the hook's source text):**
42 new normalisation-layer tests were added (10 targeting each bypass
directly, plus counterweight floor tests for `git checkout -b`, `git log
--oneline`, `git add`, `git stash`, `grep -r checkout .`, `git checkout -B`
and the exact `git commit -m "git checkout README.md"` text, none of which
may regress). Run against the PRE-round-3 hook (a `cp` snapshot, restored
after), 20 of the new tests failed with the exact defect each was written
against (`actual: 2` where `expected: 0`, or the reverse for the cd
false-positive test) -- confirmed RED for the right reason, not a typo or a
broken fixture. The remaining 22 new tests (floor/coverage additions for
shapes the pre-round-3 hook already handled correctly, plus the two M3
tests below) were already green before the fix, which is the expected
shape for tests that add coverage rather than close a hole. All 82 tests in
the file pass against the fixed hook; the full suite (784 tests) passes
three times in a row.

Targeted single-mutation proofs, each applied to a fresh `cp` of the fixed
file, diff-confirmed to land on the intended construct, run, then restored
before the next mutation (final restore diff-confirmed empty):

| # | Guard | Location | Mutation | Diff confirmed on | Result |
|---|---|---|---|---|---|
| H1 | A bare newline is a command separator | `CONTROL_OPERATORS` | `'\n'` removed from the tuple | single-line diff | 82 tests, 80 pass, 2 fail -- exactly the two newline-as-separator tests |
| H2a | `-C <path>` is consumed as a git global option and moves the effective cwd | `parse_git_invocation()`, `if tok == '-C':` | condition -> `if False and tok == '-C':` | single-line diff | 82 tests, 81 pass, 1 fail -- exactly the `-C <other dirty repo>` test |
| H2b | `git` is recognised by binary BASENAME, not exact string match | `is_git_binary()` | `os.path.basename(token) == 'git'` -> `token == 'git'` | single-line diff | 82 tests, 81 pass, 1 fail -- exactly the absolute-path-to-git test |
| H2c | `--no-pager`/`-p`/`--paginate` are consumed as git global options | `parse_git_invocation()`, `if tok in GIT_GLOBAL_OPTS_NO_VALUE:` | condition -> `if False and ...` | single-line diff | 82 tests, 81 pass, 1 fail -- exactly the `--no-pager` test |
| H4 | Escape hatch scoped to the segment's own leading env-prefix, not a raw substring search | `escape_hatch_active_for_segment()` | forced to always `return True` | two-line insertion, confirmed by diff | 82 tests, 42 pass, 40 fail -- every test that depends on the guard actually refusing anything (an over-eager escape hatch disarms the whole file, which is the point: this proves the check is load-bearing across the ENTIRE guard, not just the four escape-hatch-specific tests) |
| H5 | Bundled short-flag expansion (`-fq` -> `-f`, `-q`) | `expand_bundled_short_flags()` | the `re.fullmatch` condition -> `if False and ...` | single-line diff | 82 tests, 79 pass, 3 fail -- exactly the three bundled-flag tests (`-fq` checkout, `-fb` checkout, `-fq` switch) |
| M1a | `cd <path>` updates the effective cwd for later segments | `classify_cd()`, the `cd`-recognition guard | forced to always treat tokens as "not a cd" | single-line diff | 82 tests, 80 pass, 2 fail -- exactly the two `cd` M1 tests (bypass direction AND false-positive direction fail TOGETHER, since both depend on the same tracking existing at all -- proves the fix closes both directions with one mechanism, not two) |
| M2 | A pathspec git rejects retries tree-wide rather than concluding "clean" | `has_uncommitted_change()`, the `kind == 'paths'` retry branch | retry removed, falls through to unconditional `return False` | single-line diff | 82 tests, 81 pass, 1 fail -- exactly the out-of-repo-pathspec-with-real-dirt test (the companion "still allowed when actually clean" test stays green, confirming the retry itself does not over-block) |
| L1 | `--pathspec-from-file` scoped tree-wide (no non-flag token to scope against otherwise) | `has_pathspec_from_file()` | forced to always `return False` | two-line insertion, confirmed by diff | 82 tests, 80 pass, 2 fail -- exactly the two `--pathspec-from-file` tests (checkout and restore branches) |

## Round 3: H6 and M3 -- proving the guards ON the guard, not just in it

Two round-3 findings were about coverage that was entirely absent rather
than logic that was wrong, so their proof is that a NEW test starts failing
where nothing did before, not that a failure set narrows.

**H6 (registration wiring).** `test/destructive-git-guard.test.js`'s 82
tests all invoke `hooks/destructive-git-guard.py` directly by path, which
is structurally incapable of noticing whether `hooks/hooks.json` actually
registers it. Measured: with the file as originally reported, deleting the
entire `PreToolUse` block from `hooks/hooks.json` left the pre-round-3 suite
at 743/743 green, unchanged. `test/static-checks.test.js` now has one
set-based test asserting the set of `hooks/*.py` files equals the set of
scripts `hooks.json` registers (so an unwired new hook script fails this by
name, not just the one this round added), plus that the destructive-guard
entry specifically is under `PreToolUse` with matcher `"Bash"`. Proof: the
same mutation (delete the `PreToolUse` block, `json.dump` back with the diff
confirmed to touch only that key) now fails exactly the new registration
test and nothing else (36 pass, 1 fail in `static-checks.test.js`) -- restored
via `cp`, diff-confirmed clean, full suite re-run green.

**M3 (the duplicated `GIT_ENV_ALLOWLIST` had zero coverage).** Two new
tests: one drives the real hook with `GIT_DIR`/`GIT_WORK_TREE` leaked into
its process environment (constructed directly, bypassing the JS test
harness's own `sanitizedGitEnv()` helper, which would otherwise strip them
before the hook ever saw them) pointed at a second, CLEAN repo, while the
payload `cwd` names a dirty one -- asserting the hook still reads `cwd`, not
the leaked `GIT_DIR`. The other spawns `python3 -c` to import the hook
module directly and compares its `GIT_ENV_ALLOWLIST` constant, as a real
Python set, against `test/helpers/git-env.js`'s `GIT_ENV_ALLOWLIST`, so the
deliberate duplication between the two files cannot drift silently. Two
independent mutations: (1) `sanitized_git_env()`'s stripping loop replaced
with a no-op (`return dict(os.environ)` with the `for`/`if`/`del` body
removed, diff confirmed to touch only that loop) -- 81 pass, 1 fail, exactly
the GIT_DIR-leak test, while the allowlist-parity test stays green (the
constant itself was untouched, which is the correct discrimination: this
mutation broke the STRIPPING, not the LIST). (2) The allowlist constant
itself had `'GIT_COMMITTER_DATE'` deleted (diff confirmed to touch only that
line) -- 81 pass, 1 fail, exactly the allowlist-parity test, while the
GIT_DIR-leak test stays green (a narrower allowlist still strips `GIT_DIR`
correctly; it just no longer MATCHES the JS side, which is what the parity
test exists to catch). Both restored via `cp`, diff-confirmed clean.

## Round 3: what was deliberately NOT changed

- **`git clean`, `git stash drop`, `git worktree remove --force`, `git
  branch -D`** remain out of scope, per the brief this round was built
  against. Documented explicitly in README.md's "Deliberately out of scope"
  list (previously undocumented, which the round-2 review flagged as M4)
  rather than guarded, since adding a new guarded command was out of this
  round's brief.
- **A hostile `cwd` where `git status` itself fails** (a corrupted `.git`,
  not merely a rejected pathspec) is still not driven with a dedicated
  fixture -- flagged in round 1 and round 2, still true in round 3. The M2
  fix changes what happens when a PATHSPEC is rejected (retry tree-wide);
  it does not change what happens when the TREE-WIDE retry itself fails,
  which remains the documented fail-open (`return False`) for the reason
  named in `has_uncommitted_change()`'s own docstring: at that point nothing
  can confirm risk at all.
- **Heredocs, backticks, and `$(...)` command substitution** remain
  documented fail-open shapes, unchanged from round 1. A `cd` target
  containing `$(...)` is caught by the same `dynamic` classification as a
  bare `$VAR` (both fail `'$' in target`), so the round-3 `cd` fix at least
  refuses rather than mis-scoping in that specific case, but the underlying
  shlex limitation on subshells generally is unchanged.
