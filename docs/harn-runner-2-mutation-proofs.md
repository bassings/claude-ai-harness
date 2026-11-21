# HARN-RUNNER-2 T1 mutation proofs (fix round 1)

Each row: the edit was applied to the file named, confirmed to have landed on a
code line (not a comment), `node --test test/harn-runner-2-t1.test.js` was run
and the named test failed, and the file was restored byte-identical (compared
with the original text in the same script). The collector is
`workflows/lib/optimise-collect.mjs`, the reader `workflows/lib/optimise-read.mjs`.
Test names are shortened to their leading words.

Two rows were first survivors and led to a stronger test: C3 (the all-non-digit
case passed because a thrown TypeError also reads as mode `other`; the test now
pins the reason) and C8 (the 429 fixture also said "Too Many Requests", so the
words alone matched; the fixture is now `HTTP 429` alone).

| id | criterion | the edit | named test that failed |
|---|---|---|---|
| M1 | AC-QA-7, AC-QA-16, AC-OPS-4 | `process.kill(-child.pid, 'SIGKILL')` to `child.kill('SIGKILL')` | "a gh run list that hangs, with a background grandchild"; "a gh run view that hangs"; "a git log that hangs, with a background grandchild"; "a git rev-parse that hangs"; "SIGTERM while gh is running" |
| C1 | AC-QA-6 (M2) | `runCount: entries.length - fetchFailedCount` to `entries.length` | "one run whose gh run view is rate limited"; "one run whose gh run view fails for another reason" |
| C2 | AC-QA-6 (M2) | `failed.length === entries.length` to `false` | "every gh run view rate limited"; "every gh run view failing for another reason"; "every gh run view unauthenticated" |
| C3 | AC-QA-6 (M2) | `entries.length === 0` to `false` | "gh returning runs whose ids are all non-digit" |
| C22 | AC-QA-6 (M2) | `entry.attempt1_fetch_error = first.error` to `undefined` | "a failed attempt-1 call only keeps the run counted" |
| C23 | AC-QA-6 (M2) | `entry.fetch_error = latest.error` to `undefined` | the five per-run failure tests (one run rate limited, one run other, all rate limited, all other, all unauthenticated) |
| C4 | AC-SEC-8, AC-QA-8 (L1) | remove `'-c', 'safe.bareRepository=explicit'` from the git argv | "a planted bare repository that has commits is refused" (and the AC-SEC-8 argv test) |
| C5 | AC-SEC-8, AC-QA-8 (L1) | `safe.bareRepository=explicit` to `safe.bareRepository=all` | "a planted bare repository that has commits is refused" (and the AC-SEC-8 argv test) |
| C6 | AC-SEC-11 (L2) | `dir ? !st.isDirectory() : ...` to `dir ? false : ...` | "a .claude directory that is itself a symlink" |
| C7 | AC-QA-6 (L3) | add `HTTP 403` to `RATE_LIMIT_RE` | "an HTTP 403 that is a permission refusal" |
| C8 | AC-QA-6 (L3) | drop `HTTP 429` from `RATE_LIMIT_RE` | "gh reporting HTTP 429 alone" |
| C9 | AC-OPS-4 (L4) | log line prefix `COLLECT` to `COLLECTED` | "K ledger lines, R gh runs and F fix commits" (line pinned); "a gh run list that hangs" (`ci=failed:timeout` pinned) |
| C10 | AC-ARCH-5 (L5) | the git figure's identity passed as `null` | "K ledger lines..." (repo `demo`); "the reader's escaped-defects command and the collector return the same figures" |
| C20 | AC-ARCH-5 (L5) | `gitLane` given `null` instead of the ledger lane's identity | the same two tests |
| C11 | AC-ARCH-5, AC-QA-8 (L5) | `if (figures.rejected) throw` to `if (false) throw` | "a root that is a subdirectory of a repository" |
| C21 | AC-ARCH-5 (L5) | reader: `realpathSync(toplevel) === realpathSync(root)` to `true` | "a root that is a subdirectory of a repository"; "the reader exports escapedDefectsFigures" |
| C12 | AC-ARCH-5 (L6) | re-add `const MIN_RUNS_NEVER_FAILED = 5` to the collector | "the collector carries no second copy of the minimum-runs constant" |
| C13 | AC-ARCH-5 (L7) | reader: worktree resolver `... : root` to `return root` | "a configured linked worktree is collected from the main checkout ledger"; "the main-checkout root ... the ledger writer resolves with git --git-common-dir" |
| C14 | AC-PROD-3 (L8) | `/not a git repository/` to `/not a git repositoryZ/` | "a configured path that is not a git repository" |
| C15 | AC-SEC-12 (L8) | unknown-shape git reason to include `res.stderr` | "a git failure of an unknown shape reports the exit status only" |
| C18 | AC-QA-8 | `log.length === 0` to `false` | "a git log that succeeds with no output" |
| C16 | AC-OPS-4 | `timeoutMs: ctx.timeouts[name]` to a fixed `120000` | the gh list, gh view, git log, git rev-parse and reader timeout tests |
| C17 | AC-OPS-4 | timeout reason without the command name | the same five timeout tests |
| C19 | AC-OPS-4 | reader called under the `git log` timeout key | "a reader that overruns its own timeout" |
