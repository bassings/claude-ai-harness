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

## Fix round 2

Same method as above (applied, confirmed landed on a code line, test run, restored
byte-identical). Rows D1 to D6 and D8 to D9 use `optimise-read.mjs` (D) or the
collector (all others); tests are in `test/harn-runner-2-t1.test.js`. A subset of
the file was run for D1 (a /dev/zero symlink test would otherwise read the device
under the mutant).

| id | criterion | the edit | named test that failed |
|---|---|---|---|
| D1 | AC-SEC-11 (M1) | triggers file read with a raw `fs.readFileSync` instead of the guarded helper | "a triggers file that is a symlink to a regular file outside"; "a triggers path that is a directory"; "an oversize regular triggers file"; "in the reader, a read of the filesystem happens only inside the guarded helpers" |
| D2 | AC-SEC-11 (M1) | triggers size cap raised to 1 GiB | "an oversize regular triggers file is not read" |
| D2b | AC-SEC-11 (M1) | ledger size cap raised to 8 GiB | "a ledger over the size cap is could_not_read" |
| D3 | AC-SEC-11 (M1) | directory-on-the-way check disabled | "a .claude directory that is itself a symlink"; "the reader ledger command does not follow a .claude directory that is a symlink" |
| D6 | AC-SEC-11 (M1) | reader `ledger` command ignores a non-ok, non-absent read status | "the reader ledger command refuses a ledger that is a symlink to /dev/zero"; "the reader ledger command does not follow a .claude directory" |
| D8r | AC-SEC-11 (M1) | an `fs.existsSync` added to a reader function | "in the reader, a read of the filesystem happens only inside the guarded helpers" |
| D8c | AC-SEC-11 (M1) | an `fs.existsSync` added to a collector function | "in the collector, the only direct filesystem read is of the operator-configured root" |
| D5 | AC-ARCH-5 (L3) | an undeterminable layout returns the configured root instead of unresolved | "a linked worktree of a BARE repository ... is could_not_read"; "the reader ledger command applies the same rule" |
| D9 | AC-ARCH-5 (L3) | collector ignores `unresolved` | "a linked worktree of a BARE repository ... is could_not_read" |
| E1 | AC-OPS-4 (M2) | budget check before `gh run view` disabled | "a ci lane that runs out of budget keeps the runs already fetched"; "a budget that runs out before any run is fetched" |
| E2 | AC-OPS-4 (M2) | all-unfetched-by-budget case reported as a view failure | "a budget that runs out before any run is fetched" |
| E3 | AC-OPS-4 (M2) | the partial-budget `reason` removed | "a ci lane that runs out of budget keeps the runs already fetched" |
| E5 | AC-OPS-4 (M2) | one `gh run view` timeout dropped from the worst-case sum | "the worst case for one repository is a stated constant" |
| E6 | AC-OPS-4 (M2) | budget constant 20 to 21 minutes | "the worst case for one repository is a stated constant" |
| F2 | AC-QA-7 (M3) | pipe ends not destroyed on timeout | "a timeout returns within the timeout plus a short grace even when a descendant in its own session holds the output open" |
| F3 | AC-QA-7 (M3) | pipe destruction and the grace settle both removed | the same test |
| F1 | AC-QA-7 (M3) | the grace settle alone removed | **survived**: destroying the pipes alone lets `close` fire, so the grace timer is a second line of defence that no test can make load-bearing (it would need a process that survives SIGKILL and keeps a destroyed pipe from closing). Kept because the brief asks for it and the worst-case arithmetic includes it. |
| G1 | AC-QA-7 (L1) | numeric `timeoutMs` honoured again | "a numeric timeoutMs is not a seam" |
| H1 | AC-SEC-9 (L2) | `fs.chmodSync` removed | "lane files are written 0600 even when a looser file of that name already exists" |
| H2 | AC-QA-6 (L2) | non-array `gh run list` branch removed | "a gh run list whose output is not a JSON array" |
| H3 | AC-QA-19 (L2) | stdout cap disabled | "a git log over the 64 MiB stdout cap" |
| H4 | AC-QA-16 (L2) | SIGTERM exit status 143 to 142 | "SIGTERM while gh is running exits 143" |
| L4 | AC-OPS-4 (L4) | the syscall dropped from the unexpected-error vocabulary | "an output directory that cannot be created"; "a read-only output directory" |
| E4 | AC-OPS-7 (L5) | `ci_runs` segment removed from the COLLECT line | "K ledger lines, R gh runs and F fix commits" (line pinned); "a ci lane that runs out of budget"; "a ci lane where some views failed" |

Not proven by a deterministic test, by design: the descriptor re-check and
`O_NOFOLLOW` in `readRepoFile` close a race between the check and the open, which
needs a concurrent writer to exercise.

## Fix round 3

Same method. Run against the `AC-ARCH-5` tests and the two static read-funnel
tests of `test/harn-runner-2-t1.test.js`. The scan is `test/helpers/read-funnel.js`;
rows S1 to S7 mutate the reader with one shape each, and the scan's own unit
tests (one per shape, plus the quiet cases) pin each shape without a mutation.
Rows S1, S4, S5, S6 and S7 also fail other tests because the injected call runs
and throws; the first test named is the one the row proves.

| id | criterion | the edit | named test that failed |
|---|---|---|---|
| R1 | AC-ARCH-5 (round 3 item 1) | the reader's `ledger` command resolves the root before reading | "the reader ledger command reads the ledger under the root it is handed, for a normal checkout, a linked worktree, a worktree of a bare repository and two roots" |
| R2 | AC-ARCH-5 (round 3 item 1) | the reader's repo-identity read resolves the root first | "the reader escaped-defects command takes the repo identity from the ledger under the root it is handed" |
| R3 | AC-ARCH-5 (round 3 item 2) | a gitdir with no commondir file returns the checkout itself | "a checkout made with --separate-git-dir is could_not_read"; "resolveLedgerRoot places only a plain directory ..." |
| R4 | AC-ARCH-5 (round 3 item 2) | the "directly under <common>/worktrees" test dropped | "resolveLedgerRoot places only ..." |
| R5 | AC-ARCH-5 (round 3 item 2) | an unrecognised `.git` file returns the checkout itself | "resolveLedgerRoot places only ..." |
| R6 | AC-ARCH-5 (round 3 item 2) | the "common directory is named .git" test dropped | "a linked worktree of a BARE repository ... is could_not_read" |
| S1 | AC-SEC-11 (round 3 item 3) | `fs["readFileSync"]('x')` added to a reader function | "in the reader, a read of the filesystem happens only inside the guarded helpers" |
| S2 | AC-SEC-11 (round 3 item 3) | `const { readFileSync: rf } = fs` added at the top level | the same test |
| S3 | AC-SEC-11 (round 3 item 3) | a top-level arrow function that calls `fs.readFileSync`, placed right after the guarded helpers | the same test |
| S4 | AC-SEC-11 (round 3 item 3) | `fs.promises.open('x')` added to a reader function | the same test |
| S5 | AC-SEC-11 (round 3 item 3) | `fs.readSync(...)` added | the same test |
| S6 | AC-SEC-11 (round 3 item 3) | `fs.copyFileSync(...)` added | the same test |
| S7 | AC-SEC-11 (round 3 item 3) | `fs.readlinkSync(...)` added | the same test |
