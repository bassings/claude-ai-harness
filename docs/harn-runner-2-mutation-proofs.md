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

## After the post-merge clean-up

The clean-up (nested template literals and ternary, optional chaining, ignored
exceptions, a comment at the sequential await) changed no behaviour: the three
test files `test/harn-runner-2-t1.test.js`, `test/optimise-read.test.js` and
the rules-table generator's test file passed unedited (359 tests) before any mutation.
Same method as above (applied, confirmed to have landed on a code line, test run,
restored byte-identical, checked by comparing against the original text). Run
against `test/harn-runner-2-t1.test.js`. C19, C9 and D3 and D2 are recorded rows
re-run; L1, E1, K1 and A1 are new edits on the functions the clean-up touched.

| id | function touched | the edit | named test that failed |
|---|---|---|---|
| C19 | `readerJson` (collector) | reader called under the `git log` timeout key | "AC-OPS-4: a reader that overruns its own timeout ..." |
| C9 | `logLine` (collector) | log line prefix `COLLECT` to `COLLECTED` | "AC-QA-1: K ledger lines, R gh runs and F fix commits ..."; "AC-QA-7: a gh run list that hangs ..." |
| L1 | `laneToken` (collector) | `failed:` to `failedX:` | "AC-QA-7: a gh run list that hangs, with a background grandchild ..." |
| E1 | `collectEntries` (collector) | `if (entry) entries.push(entry)` to `if (false) ...` | "AC-QA-1: K ledger lines ..."; the AC-QA-6 per-run failure tests |
| D3 | `repoFileStatus` (reader) | directory-on-the-way check disabled | "AC-SEC-11: a .claude directory that is itself a symlink ..."; "AC-SEC-11: the reader ledger command does not follow a .claude directory ..." |
| D2 | `REPO_FILE_CAPS` (reader) | triggers size cap raised to 1 GiB | "AC-SEC-11: an oversize regular triggers file is not read" |
| K1 | `repoFileStatus` (reader), the kind if/else | `kind = 'directory'` to `kind = 'other'` | "AC-QA-1: K ledger lines ..."; "AC-SEC-10: a copy of the reader or the collector inside the analysed repository ..." and others |
| A1 | `repoFileStatus` (reader), `e?.code` | `e?.code === 'ENOENT'` to `false` | the same tests as K1 |

Three sites are not pinned by any test; these were survivors on first run and are
recorded as gaps, not as proofs. The tests were not edited (the brief forbade it).

| id | function touched | the edit that survived | why it is out of reach |
|---|---|---|---|
| A2 | `readRepoFile`, the open's `ENOENT` branch | `if (e?.code === 'ENOENT')` to `if (false)` | the file must vanish between the status check and the open |
| EL | `readRepoFile`, the open's `ELOOP` branch | `'ELOOP'` to `'ELOOPZ'` | the final segment must become a symlink between the check and the open |
| UC | `readRepoFile`, the final `catch` | `'unreadable'` to `'not_regular'` | needs a read error on an open descriptor |
| SC | the sidecar loader's malformed-JSON `catch` | its reason to `proposal-target sidecar not found` (also tried with the `return` dropped) | no test in `t1`, `optimise-read`, `harn-opt-4-t6` or `weekly-runner` feeds a malformed sidecar and reads the reason |
| E-ran | `laneToken`, the `ran:<mode>` branch | `ran:` to `ran-` | no test reaches a ran lane with a mode in the log line |
| O1 | `readerJson`, the over-size-limit detail | `'output over the size limit'` to `...Z` | the detail text is not asserted |

## HARN-RUNNER-2 T3 mutation proofs (fix round 1, M6, AC-QA-3)

Re-run on the final code after the verification moved into
`workflows/lib/optimise-verify.mjs`, so every row is true of the code that ships.
Each row: the edit was applied to the file named, confirmed to have changed
exactly the one place the `old` text occurs (the script refuses an edit whose
text occurs any other number of times, so a match in a comment cannot stand in
for the code), the named tests were run and at least one failed, and the file
was restored and compared by hash with the original (every row restored identical). Tests are named by their leading words; `T3` is
`test/harn-runner-2-t3.test.js`, `U` is `test/optimise-verify.test.js`.

Row `V0` is the mutation AC-QA-3 names: the verdict put back to scoring on shape
alone (every figure check dropped from `checkFigures`), so a heading and a
section heading would be enough. The hollow-report tests then fail
("hollow report (0 ledger records beside a ledger of 6)", "hollow report built by
the real workflow from a ledger emptied in transit", "the old shape-only report").

Not mutated, and why:

- L10, the plan-marker snapshot taken immediately before the session. The test was
  written first and seen red against the old placement (the marker was restored to
  its pre-collection bytes). Moving the snapshot back is a block move, not a
  one-token edit, so no honest single-edit mutation exists; the red run is the proof.
- The `claude_exit -eq 0` half of the placement gate. `verify_run` is handed `-`
  (no session) whenever `claude` did not exit 0, so `PLACE yes` cannot be reached
  and removing the condition changes nothing: an equivalent mutant.
- The runner's loop-end `cleanup_run final`. `on_exit` runs the same clean-up on
  every way out, so removing only the loop-end call changes nothing observable.

| id | guard | the edit | file | named tests that failed |
|---|---|---|---|---|
| V1 | ledger figure comparison (AC-QA-3, AC-SEC-14) | `const wrong = found.find((n) => n !== want)` to `const wrong = found.find(() => false)` | optimise-verify.mjs | "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: hollow report"; "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: hollow report built by the real workflow fro..."; "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: ledger record count FAILs naming the figure,..." |
| V2 | CI run count check (AC-QA-4) | remove `...checkCi(report, col),` | optimise-verify.mjs | "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: CI run count FAILs naming the figure, writes..." |
| V3 | git raw count check (AC-QA-4) | remove `...checkGit(report, col),` | optimise-verify.mjs | "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: escaped-defect raw count FAILs naming the fi..." |
| V4 | shared figure comparison behind the CI and git lines | `if (diff) return [`figure mismatch ${name}` to `if (false) return [`figure mismatch ${name}` | optimise-verify.mjs | "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: CI run count FAILs naming the figure, writes..."; "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: escaped-defect raw count FAILs naming the fi..." |
| V5 | lane status comparison (AC-QA-4) | `} else if (!isObject(said[name]) \|\| said[name].status !== st) {` to `} else if (false) {` | optimise-verify.mjs | "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: a lane reported as failed that the collector..." |
| V6 | failed-lane mode comparison (L6) | `} else if (st === 'failed' && modeToken(said[name].mode) !== modeToken(col.lane[name].mode)) {` to `} else if (false) {` | optimise-verify.mjs | "a session that relabels a failed lane's failure mode FAILs naming both modes" |
| V7 | home directory held wherever it appears (L1) | `if (strict.some((needle) => text.includes(needle))) return true` to `if (false) return true` | optimise-verify.mjs | "a report holding the home directory followed by "-old" is refused with nothing written"; "a report holding the home directory followed by ".bak" is refused with nothing written"; "a report holding the home directory followed by "_x" is refused with nothing written" (and 2 more) |
| V8 | sidecar heading ids are keys (AC-PROD-4) | `if (ids.some((id) => !Object.hasOwn(result.proposal_targets, id)))` to `if (false)` | optimise-verify.mjs | "a proposal heading names an id the sidecar does not hold -- FAIL with a reason naming the..." |
| V9 | NUL byte refusal (AC-QA-11) | `if (report.includes('\u0000'))` to `if (false)` | optimise-verify.mjs | "the report holds a NUL byte -- FAIL with a reason naming the case, nothing placed, the la..." |
| V10 | report size cap (AC-QA-11) | `return bytes > REPORT_CAP ?` to `return false ?` | optimise-verify.mjs | "the report is one byte over the cap -- FAIL with a reason naming the case, nothing placed..." |
| V11 | oversized reply refusal (AC-SEC-13) | `const got = readRepoFile(path.dirname(sessionPath), path.basename(sessionPath), FILE_CAP)` to `const got = readRepoFile(path.dirname(sessionPath), path.basename(sessionPath), Number.MAX_SAFE_INTEGER)` | optimise-verify.mjs | "a session reply one byte over the 64 MiB file cap is refused unread even though it is a c..." |
| V12 | an empty permission_denials list is unknown (M4) | `envelope.permission_denials.length > 0 ? String` to `true ? String` | optimise-verify.mjs | "a session whose envelope lists no denials logs DENIED-TOOLS unknown, never a confident 0"; "an empty permission_denials list is unknown, not a confident zero, and a list with entrie..." |
| V13 | no record count beside a lane that did not run, verifier side (M3) | `reasons: found.length > 0 ? [`figure mismatch ledger: collected none` to `reasons: false ? [`figure mismatch ledger: collected none` | optimise-verify.mjs | "a record count printed beside a ledger lane that did not run FAILs with the figure named,..."; "a ledger record count printed beside a ledger lane that did not run is refused, whatever ..." |
| V14 | no record count printed for a failed ledger lane, workflow side (M3) | `if (!d.ledgerLaneFailed) lines.push(`Ledger records in window` to `if (true) lines.push(`Ledger records in window` | optimise-cycle.js | "a failed ledger lane prints no ledger record count at all, only the lane's fixed reason, ..."; "the report placed for a failed ledger lane holds no ledger record count, only the lane's ..." |
| V0 | the verdict scored on shape only: every figure check dropped (AC-QA-3, the 2026-11-13 shape) | `const reasons = [...checkLanes(result.lanes, col), ...ledger.reasons, ...checkCi(report, col), ...checkGit(re...` to `const reasons = []` | optimise-verify.mjs | "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: hollow report"; "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: hollow report built by the real workflow fro..."; "AC-QA-3/AC-QA-4/AC-SEC-14/AC-QA-13/AC-QA-15: ledger record count FAILs naming the figure,..." (and 2 more) |
| R1 | row check: ci job (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVER_FAILIN...` | optimise-verify.mjs | "a hostile report of one enormous line of row-shaped text is judged in well under a second..."; "a per-job CI count n altered by one is refused with a reason naming that figure"; "a per-job CI failed count altered by one is refused with a reason naming that figure" (and 3 more) |
| R2 | row check: ci repository (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVER_FAILING_LEFT_...` | optimise-verify.mjs | "a per-repository CI fetch-failure count altered by one is refused with a reason naming th..."; "a per-repository CI not-completed count altered by one is refused with a reason naming th..." |
| R3 | row check: gh calls (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVER_FAILING_...` | optimise-verify.mjs | "a gh call count altered by one is refused with a reason naming that figure"; "a gh wall-clock figure altered by one is refused with a reason naming that figure" |
| R4 | row check: wall-clock plan (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVER_FAILING_LEFT_OU...` | optimise-verify.mjs | "a per-plan run count altered by one is refused with a reason naming that figure"; "a per-plan unterminated-waits count altered by one is refused with a reason naming that f..."; "a per-plan wait figure altered by one is refused with a reason naming that figure" (and 1 more) |
| R5 | row check: wall-clock totals (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, NEVER_FAILING, NEVER_FAILING_LEFT_OUT,...` | optimise-verify.mjs | "a wall-clock totals count altered by one is refused with a reason naming that figure" |
| R6 | row check: never-failing rows (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING_LEFT_...` | optimise-verify.mjs | "a never-failing row disagreement count altered by one is refused with a reason naming tha..."; "a never-failing row run count altered by one is refused with a reason naming that figure" |
| R7 | row check: never-failing rows left out (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, LEDG...` | optimise-verify.mjs | "the criteria-rows-left-out count altered by one is refused with a reason naming that figu..." |
| R8 | row check: ledger repository rows (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` | optimise-verify.mjs | "a per-repository ledger record count altered by one is refused with a reason naming that ..." |
| R9 | row check: ledger skipped line (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` | optimise-verify.mjs | "the skipped-lines count altered by one is refused with a reason naming that figure" |
| R10 | row check: trigger accuracy (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` | optimise-verify.mjs | "a trigger-accuracy count altered by one is refused with a reason naming that figure" |
| R11 | row check: rework (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` | optimise-verify.mjs | "a rework disposition count altered by one is refused with a reason naming that figure" |
| R12 | row check: attribution counters (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` | optimise-verify.mjs | "an unattributable-runs count altered by one is refused with a reason naming that figure" |
| R13 | row check: dropped counters (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` | optimise-verify.mjs | "a dropped-values counter altered by one is refused with a reason naming that figure" |
| R14 | row check: orphaned runs (AC-SEC-14, M2) | `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` to `const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVE...` | optimise-verify.mjs | "an orphaned-runs count altered by one is refused with a reason naming that figure" |
| R15 | scoped escaped-defect line (M2) | remove `...checkScoped(report, col),` | optimise-verify.mjs | "the scoped count altered by one is refused with a reason naming that figure"; "the scoped excluded count altered by one is refused with a reason naming that figure"; "the scoped unavailable count altered by one is refused with a reason naming that figure" |
| R16 | proposal adoption and rejection dates (M2) | `...checkProposalOutcomes(report, col)]` to `]` | optimise-verify.mjs | "a proposal's recorded adoption and rejection dates are held to the outcome the ledger hol..." |
| R17 | a row the data does not hold (M2) | `if (want === undefined) { reasons.push(`figure mismatch ${spec.name}: a row the collected data does not hold`...` to `if (want === undefined) return` | optimise-verify.mjs | "a per-job row whose key the data does not hold altered by one is refused with a reason na..." |
| R18 | a row the report leaves out (M2) | `for (const [key, want] of wants) if (!seen.has(key)) reasons.push` to `for (const [key, want] of wants) if (false) reasons.push` | optimise-verify.mjs | "a per-job row left out altered by one is refused with a reason naming that figure" |
| R19 | a row in a shape the check does not know (M2) | `if (report.split('\n').filter(spec.isRow).length !== matches.length)` to `if (false)` | optimise-verify.mjs | "a hostile report of one enormous line of row-shaped text is judged in well under a second..."; "a row written in a shape the check does not know is refused, so a row cannot escape its c..." |
| R20 | row figure comparison (M2) | `if (diff) reasons.push(`figure mismatch ${spec.name}` to `if (false) reasons.push(`figure mismatch ${spec.name}` | optimise-verify.mjs | "a dropped-values counter altered by one FAILs naming that figure, writes nothing, and kee..."; "a gh call count altered by one FAILs naming that figure, writes nothing, and keeps the la..."; "a never-failing row run count altered by one FAILs naming that figure, writes nothing, an..." (and 31 more) |
| S1 | sidecar merge instead of overwrite (M1, L9) | `sidecar: sidecarText(fitSidecar(mergeSidecar(existing.entries, judged.targets)))` to `sidecar: judged.sidecar` | optimise-verify.mjs | "a PASS whose returned sidecar holds fewer entries than the file keeps the file's extra on..."; "a failed ledger lane still replaces the report (AC-PROD-3) and never loses a decided targ..." |
| S2 | an unreadable sidecar on disk stops the run (M1) | remove `if (existing.reason) return { ...judged, reasons: [existing.reason], place: 'no' }` | optimise-verify.mjs | "a sidecar on disk that is a JSON array, or a symlink, is refused the same way and never w..."; "a sidecar on disk that is not valid JSON is left byte for byte, nothing is placed, and th..." |
| S3 | the carry bound drops oldest entries (L9) | `keys.slice(Math.max(0, keys.length - max))` to `keys.slice(0)` | optimise-verify.mjs | "past the carry maximum the oldest entries go first, never the newest, and never before th..." |
| S4 | the size cap on the merged sidecar | `> SIDECAR_CAP) n += 1` to `> Infinity) n += 1` | optimise-verify.mjs | "a merged sidecar over the size cap loses its oldest entries until it fits, and one under ..." |
| S5 | the carry maximum equals the workflow's | `export const SIDECAR_CARRY_MAX = 500` to `export const SIDECAR_CARRY_MAX = 501` | optimise-verify.mjs | "past the carry maximum the oldest entries go first, never the newest, and never before th..." |
| S6 | the sidecar is read through the guarded helper (a symlink is refused) | `if (got.status !== 'ok') return { reason: SIDECAR_UNREADABLE }` to `if (got.status !== 'ok') return { entries: {} }` | optimise-verify.mjs | "a sidecar on disk that is a JSON array, or a symlink, is refused the same way and never w..." |
| S7 | the module spawns nothing (static) | `import { fileURLToPath } from 'node:url'` to `import { fileURLToPath } from 'node:url' import { spawnSync } from 'node:child_process' void spawnSync` | optimise-verify.mjs | "the module is spawn-free and reads only through the reader's guarded helper" |
| N1 | refusal of an installed workflow at contract 1 (AC-OPS-12) | `"$installed_contract" -lt "$REQUIRED_WORKFLOW_CONTRACT" ]; }; then` to `"$installed_contract" -lt 0 ]; }; then` | optimise-cycle-weekly.sh | "an installed workflow at contract 1 stops the run before any collector or session, with a..." |
| N2 | no session launched for a refused digest (AC-OPS-17) | `if [ "${digest_token%%:*}" != ran ]; then echo "TIMING` to `if [ "${digest_token%%:*}" = impossible ]; then echo "TIMING` | optimise-cycle-weekly.sh | "a digest the collector refused is a FAIL with its fixed reason, and no session is launche..." |
| N3 | per-run directory removed after PASS, FAIL and SIGTERM (AC-SEC-12) | `run.??????) rm -rf "$RUNNER_TMP" ;;` to `run.??????) : ;;` | optimise-cycle-weekly.sh | "AC-PROD-1/AC-PROD-4/AC-OPS-7/AC-OPS-9/AC-OPS-17: a correct result is written by the runne..."; "output empty -- FAIL with a reason naming the case, nothing placed, the last good report ..."; "SIGTERM while the collector is running places nothing, removes the per-run directory, res..." (and 1 more) |
| N4 | per-run directory removed on SIGTERM (clean-up on exit) | `local status=$? cleanup_run final` to `local status=$? :` | optimise-cycle-weekly.sh | "SIGTERM while the collector is running places nothing, removes the per-run directory, res..."; "a SIGTERM while the session runs removes the per-run directory and every collected file i..." |
| N5 | stale-directory sweep never follows a symlink | `done < <(find "$RUNNER_PARENT" -mindepth 1` to `done < <(find -L "$RUNNER_PARENT" -mindepth 1` | optimise-cycle-weekly.sh | "the start-up sweep removes only a stale run.XXXXXX directory this user owns -- never a fr..." |
| N6 | the nonce never appears in the log (AC-SEC-5) | `session_prompt="Use the Read tool` to `echo "nonce=$nonce" >> "$LOG" session_prompt="Use the Read tool` | optimise-cycle-weekly.sh | "each repository gets its own fresh nonce of 32 lower-case hex characters, and it never ap..." |
| N7 | no Bash grant in the session's allowed tools (AC-SEC-1) | `--allowedTools "Workflow" "Read(/$RUN_REAL/**)"` to `--allowedTools "Workflow" "Read(/$RUN_REAL/**)" "Bash(git:*)"` | optimise-cycle-weekly.sh | "the session is given exactly the Workflow tool and a Read rule for the per-run directory,..." |
| N8 | no gh or node grant in the session's allowed tools (AC-SEC-1) | `--allowedTools "Workflow" "Read(/$RUN_REAL/**)"` to `--allowedTools "Workflow" "Read(/$RUN_REAL/**)" "Bash(gh:*)" "Bash(node:*)"` | optimise-cycle-weekly.sh | "the session is given exactly the Workflow tool and a Read rule for the per-run directory,..." |
| N9 | a ceiling-hit run never places its report (M5) | `[ "$claude_exit" -eq 0 ] && [ "$ceiling_hit" = 0 ]; then` to `[ "$claude_exit" -eq 0 ]; then` | optimise-cycle-weekly.sh | "a run that hit the background-wait ceiling but printed a complete, correct result FAILs n..." |
| N10 | completeness fields on a repository that stopped early (L4) | `echo "RESULT FAIL $1 $UNKNOWN_FIGURES reason=` to `echo "RESULT FAIL $1 reason=` | optimise-cycle-weekly.sh | "a repository that stopped before it had anything to count still logs the completeness fie..." |
| N11 | the session failure cause class (L5) | `SESSION_CAUSE="$VERIFY_CAUSE"` to `:` | optimise-cycle-weekly.sh | "a session failure by empty names its cause class on the RESULT line"; "a session failure by failed_step names its cause class on the RESULT line"; "a session failure by malformed names its cause class on the RESULT line" (and 1 more) |
| N12 | a timeout or non-zero exit names its cause (L5) | `*) reasons+=("claude exited $claude_exit"); SESSION_CAUSE="exit" ;;` to `*) reasons+=("claude exited $claude_exit") ;;` | optimise-cycle-weekly.sh | "a session failure by non-zero exit names its cause class on the RESULT line" |
| N13 | the sidecar root is the main checkout's (linked worktree) | `root="${root%/*}" if [ -z "$root" ]` to `root="$1" if [ -z "$root" ]` | optimise-cycle-weekly.sh | "for a linked worktree the report lands in the worktree and the sidecar in the main checko..." |
| N14 | one way to fail a repository (L8) | `fail_repo "$repo_label" "cd into repo failed"` to `echo "RESULT FAIL $repo_label reason=\"cd into repo failed\"" >> "$LOG"` | optimise-cycle-weekly.sh | "the runner has one way to fail a repository -- no RESULT FAIL line is echoed outside fail..." |
| N15 | the report path is made ignored and confirmed before anything is written (AC-OPS-9) | `elif ! ensure_ignored "$repo" "$sidecar_root"; then` to `elif false; then` | optimise-cycle-weekly.sh | "when the report path cannot be confirmed as gitignored the repository FAILs with that rea..." |
