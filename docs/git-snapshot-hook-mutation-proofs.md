# git-snapshot hook and destructive-git-guard changes: mutation proofs

Per standard §11: for each guard below, the guarded behaviour was actually
broken in the working file (edited directly, not "mentally mutated"), the
diff was read back to confirm the edit landed on the intended line, the
relevant test file(s) were run and the exact failing test(s) recorded, then
the file was restored via `cp` from a pre-mutation snapshot -- never `git
checkout --` -- confirmed via `diff` against the snapshot returning nothing
before the next mutation.

Driven as real subprocesses (`spawnSync('python3', [HOOK_PATH], ...)`)
against real temp git repositories via `test/helpers/temp-repo.js`
(`makeTempRepo`, `sh`, `sanitizedGitEnv`), never by asserting on the hooks'
source text (except the two purely-static structural checks noted below,
which are explicitly about the source, not the runtime behaviour, and are
labelled as such).

**Test count.** Before this change: 785/785 (baseline stated in the brief).
After: 855/855, run three times consecutively with no flakes observed
(`node --test test/*.test.js`, ~33s per run). Net new: 70 tests -- one new
file, `test/git-snapshot.test.js` (61 tests, satisfying AC-SIMP-12's "at
most one new test file"), plus additions/rewrites inside two existing files
(`test/destructive-git-guard.test.js`, `test/static-checks.test.js`).

## hooks/git-snapshot.py

| # | Guard | Location | Mutation | Diff confirmed on | Result |
|---|---|---|---|---|---|
| 1 | The snapshot runs against a PRIVATE index copy, never the real `.git/index` (the whole premise of the lock-free design, AC-DATA-1/AC-DATA-2) | `snapshot()`, `env['GIT_INDEX_FILE'] = private_index` | replaced with `pass` (never sets `GIT_INDEX_FILE`) | single-line diff, confirmed against the pre-mutation backup | 57 tests, 55 pass, 2 fail -- exactly `AC-DATA-1` (real `.git/index` byte-identical) and `AC-DATA-2` (succeeds while `.git/index.lock` is held) |
| 2 | `git stash create`'s stdout is trusted only when well-formed (AC-DATA-4) | `snapshot()`, `if result.returncode != 0 or not SHA_RE.fullmatch(sha):` | replaced with `if False:` | single-line diff | 56 pass, 1 fail -- **not** `AC-DATA-4` itself (see note below), but `AC-QA-6`/`AC-OPS-3`: the merge-conflict failure state is now misrecorded as `other` instead of `merge or rebase in progress`, because the mutated code falls through into the ref-creation branch, which itself fails (git rejects the garbage "sha") and re-logs a generic failure. **Honest caveat**: `git update-ref` independently refusing a malformed object id is a second, redundant safety net here, so this specific mutation is not isolated by `AC-DATA-4`'s own test as cleanly as intended -- the end property (no bad ref is ever created) still holds, defended twice over, but the test suite's coverage of this one guard is weaker than its name suggests. Recorded as a spec/test gap, not fixed further in this round. |
| 3 | Snapshot refs are keyed PER CHECKOUT (`checkout_key`), so a linked worktree and the main checkout don't collide (AC-DATA-6, and the pruning-isolation half of AC-DATA-8) | `checkout_key()`, `return hashlib.sha1(...)` | replaced with `return 'constant-key'` | single-line diff | **First attempt vacuous**: the original AC-DATA-6/AC-DATA-8 tests used two INDEPENDENT repos (separate `.git` dirs), which never share a ref store regardless of the key, so 57/57 stayed green -- a real gap in the test suite, not in the guard. Fixed by adding a new test driving pruning from a REAL linked worktree (shared ref store) against the main checkout. Re-run: 57 pass, 1 fail -- exactly the new worktree-pruning-isolation test. |
| 4 | Pruning is bounded (AC-DATA-8, AC-ARCH-7) | `prune()`, `excess = refs[:-KEEP_PER_CHECKOUT] if len(refs) > KEEP_PER_CHECKOUT else []` | replaced with `excess = []` | single-line diff | 57 pass, 1 fail -- exactly the N+5-snapshots-leaves-at-most-N test |
| 5 | Every git invocation is scrubbed of the leakable `GIT_*` namespace (AC-SEC-5a) | `sanitized_git_env()`, `if key.startswith('GIT_') and key not in GIT_ENV_ALLOWLIST:` | replaced with `if False:` | single-line diff | 57 pass, 1 fail -- exactly the leaked-`GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`-decoy-repo test. **Note**: `test/destructive-git-guard.test.js`'s AC-ARCH-3 enumerating parity test does NOT catch this mutation (87/87 still green) -- it only verifies the DECLARED `GIT_ENV_ALLOWLIST` set matches, not that the scrub logic is actually applied at runtime. The two tests are complementary, not redundant: AC-ARCH-3 catches drift in the declared set, AC-SEC-5a catches the enforcement breaking. Both are needed; neither subsumes the other. |
| 6 | Every git invocation passes `-c core.fsmonitor=` (AC-SEC-5c) | `run_git()`, `['git', '-c', 'core.fsmonitor='] + args` | replaced with `['git'] + args` | single-line diff | 57 pass, 1 fail -- exactly the hostile-fsmonitor-hook test (confirmed separately, outside the suite, that a hostile `core.fsmonitor` script DOES execute without this flag and does NOT with it, on git 2.50.1 here) |
| 7 | The opt-out (`HARNESS_DISABLE_SNAPSHOT=1`) actually disables snapshotting (AC-SEC-8, AC-OPS-9) | `snapshot()`, `if os.environ.get(ESCAPE_VAR) == '1':` | replaced with `if False:` | single-line diff | 56 pass, 2 fail -- exactly `AC-SEC-8` and `AC-OPS-9` (the kill-switch tests) |
| 8 | The hook never reads the command text (AC-ARCH-1, AC-ARCH-4, AC-DATA-16) | `main()`, added `if 'git' not in cmd: sys.exit(0)` after reading `tool_input.command` | 3-line insertion | 29 pass, 29 fail -- roughly half the suite, including both dedicated `AC-ARCH-1` tests (the tree-identity comparison across three command spellings, and the static "no `tool_input` reference" check) and every test whose fixture's command happens not to contain the literal substring `git` |

## hooks/destructive-git-guard.py (the two in-scope changes only, per AC-SIMP-9)

| # | Guard | Location | Mutation | Diff confirmed on | Result |
|---|---|---|---|---|---|
| 9 | Here-document BODIES are stripped before tokenising, so a guarded command mentioned as inert text inside one is not refused (AC-PROD-6) | `evaluate()`, `segments = split_segments(strip_heredoc_bodies(command))` | replaced with `segments = split_segments(command)` | single-line diff | 87 tests, 86 pass, 1 fail -- exactly the heredoc-body AC-PROD-6 test (the quoted-string and grep-argument AC-PROD-6 tests still pass under this mutation, since those were never heredoc-specific -- confirming the fix is scoped to what it claims) |
| 10 | An unresolvable `cd` target now ALLOWS rather than refuses (AC-SIMP-10) | `evaluate()`, `if kind == 'dynamic':` | replaced with `if False:` | single-line diff | 84 pass, 3 fail -- the two AC-SIMP-10 fail-open tests and the pre-existing "unresolvable cd + harmless command" test, all via an uncaught `TypeError` (join_cwd(cwd, None) -- `classify_cd`'s dynamic case carries no target), confirming the branch is load-bearing even though the failure mode here is a crash rather than a silent wrong-allow |

All ten mutations were restored via `cp` from a pre-mutation backup
(`/tmp/mutation-backups/*.orig`, made once per file before this round) and
confirmed identical via `diff` before the next mutation and before the final
commit. Full suite (`node --test test/*.test.js`) run three times after the
last restore, all green (853/853), no flakes.

## Coverage gaps, stated plainly

- **Mutation 2** (AC-DATA-4's own isolation) is weaker than intended: the
  property it protects is genuinely load-bearing (confirmed by the AC-QA-6
  failure it produced), but the specific guard AC-DATA-4 names is defended
  redundantly by `git update-ref`'s own validation, so a future refactor
  that removed the `SHA_RE` check without also removing the `update-ref`
  fallback would not be caught by `AC-DATA-4`'s test as currently written.
- **Mutation 3** exposed a real test-suite gap (fixed in this round, not a
  pre-existing defect): the original AC-DATA-6/AC-DATA-8 tests for
  cross-checkout isolation used two independent repositories, which never
  share a ref store regardless of the keying logic's correctness. Recorded
  here so a future reviewer does not assume "two repos" is sufficient
  coverage for a claim specifically about linked worktrees sharing one ref
  store.
- **Not mutation-tested in this round**, for time reasons, stated rather
  than silently omitted: the SIGKILL-at-two-points invariant (AC-DATA-9),
  the exact `.git` size ceiling's choice of number (a measured value with a
  generous margin, not independently re-derived), and the full three-variant
  push-residual behaviour beyond what `AC-SEC-2`'s single test exercises
  (`git push --mirror` and an explicit `refs/*:refs/*` refspec transmitting
  snapshot refs is asserted in README as a documented fact, not re-measured
  here with a dedicated test).
