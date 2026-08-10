# PR1 mutation proofs

Per AC-QA-3 and standard §11: for the guards below, the guarded behaviour was
actually broken (edited in the working file, not "mentally mutated"), the
suite was run, the exact failing test and message recorded, and the file was
then restored and the suite re-run green. Seventeen proofs were executed in
this session (11 in the first pass, 6 more -- 5 re-verifications plus one new
guard -- in the "Rework" section below, after a coordinator probe found
workflow scripts cannot import anything in production); the commands and
output are reproduced from those runs.

**Proofs 1, 6 and 7 below reference `workflows/lib/ledger.mjs`, which no
longer exists**: that was accurate at the time each proof was first run, and
is left as the historical record of when each guard was first proven. The
"Rework" section documents where the code (and each guard) actually lives
now, and re-proves the ones that moved.

Restoration was verified after every mutation by re-running the affected
test file(s) (the full suite is `node --test test/*.test.js`, 85/85 as of
the last commit in this worktree) and by `grep -rn "MUTATION"` across
`workflows/`, `test/`, `skills/`, `AGENT-HARNESS.md` and `README.md`
returning nothing (no mutation marker left behind).

## 1. `additionalProperties:false` enforcement — `workflows/lib/ledger.mjs` `validateEntry`

**Guarded behaviour**: an entry with a property outside the declared schema
is rejected (AC-SEC-2 — this is what keeps lens evidence text, finding
locations and the review-cycle report out of the ledger).

**Mutation**: deleted the `additionalProperties === false` loop entirely.

**Result**: 2 tests failed for the right reason —

- `ledger: validateEntry rejects an entry with an unknown top-level property (additionalProperties:false, AC-SEC-2)`
  — `AssertionError: The expression evaluated to a falsy value: assert.ok(errors.length > 0)`
- `ledger-append: rejects a payload with a property outside the schema rather than silently writing it (AC-SEC-2)`
  — `AssertionError: Expected values to be strictly equal: true !== false` (write_ok was true instead of false)

**Reverted**: restored from backup; `ledger.test.js` + `ledger-append.test.js` back to 35/35 green.

## 2. Injection-safe single-line append — `workflows/lib/ledger-append.mjs`

**Guarded behaviour**: the ledger line is built with `JSON.stringify`, which
escapes embedded newlines, so a hostile `task` value containing a literal
newline plus a forged JSON object cannot split into two lines or forge a
second record (AC-SEC-6).

**Mutation**: spliced the `task` field into the line via raw string
concatenation instead of through `JSON.stringify`.

**Result**: 2 tests failed for the right reason —

- `ledger-append: a task string carrying a literal newline plus a forged JSON object does not split or forge a record (AC-SEC-6)`
  — `AssertionError: one run must append exactly one line: 2 !== 1`
- `ledger-append: the path resolves via git rev-parse --git-common-dir, never by interpolating the task string (AC-SEC-5)`
  — `AssertionError: 2 !== 1` (the hostile line count leaked here too)

**Reverted**: restored from backup; `ledger-append.test.js` back to 13/13 green.

## 3. Worktree-safe path resolution — `workflows/lib/ledger-append.mjs` `resolveMainCheckoutRoot`

**Guarded behaviour**: a write issued from inside a worktree lands in the
MAIN checkout's ledger, never the worktree's own `.claude/` (AC-DATA-1,
AC-SEC-5).

**Mutation**: `resolveMainCheckoutRoot` changed to `return cwd` (ignoring
`git rev-parse --git-common-dir` entirely).

**Result**: 1 test failed for the right reason —

- `ledger-append: writing from inside a worktree lands the line in the MAIN checkout, not the worktree (AC-DATA-1, AC-SEC-5)`
  — `AssertionError: the line must land in the main checkout: 0 !== 1`

**Reverted**: restored from backup; `ledger-append.test.js` back to 13/13 green.

## 4. One ledger write reachable from every terminating return — `workflows/tdd-task.js`

**Guarded behaviour**: AC-ARCH-3 — every terminating return of `run()`
reaches the single `writeLedgerEntry` call after it, including the early
`ABORTED`/`BLOCKED` returns, not only the `DONE` path.

**Mutation**: guarded the `writeLedgerEntry` call with `if (result.verdict
=== 'DONE')`.

**Result**: 1 test failed for the right reason —

- `tdd-task.js: every terminating return reaches exactly one ledger write (AC-ARCH-3)`
  — `AssertionError: test-writer agent fails: expected exactly one ledger write, got 0: 0 !== 1`

**Reverted**: restored from backup; `tdd-task.test.js` back to 9/9 green (10/10
after finding #5 below strengthened the suite).

## 5. RED gate requires BOTH `red` and `right_reason` — `workflows/tdd-task.js`

**Guarded behaviour**: AC-QA-23 — the commit step (and the Implement phase)
must be unreachable unless the test both failed (`red: true`) AND failed for
the right reason (`right_reason: true`); a test that fails for the wrong
reason (a typo, a missing import) must still be rejected.

**Mutation**: `if (red.red && red.right_reason) break` → `if (red.red)
break`.

**Result — a genuine gap found and fixed.** The existing AC-QA-23 test used a
fixture with `red: false, right_reason: false` for every attempt, so it never
actually exercised the `right_reason` half of the condition: **the mutation
survived** against the suite as it stood (all 9 tests still passed). This is
exactly the failure mode §11 warns about — a guard that looks like it is
protecting something and isn't, because the test only ever varied `red`, not
`right_reason` independently.

Added a new test, `tdd-task.js: a test that fails (red: true) but NOT for the
right reason (right_reason: false) must still be rejected` (`red: true,
right_reason: false` on all three attempts), which:

- **Failed against the mutation** — `AssertionError: Expected values to be
  strictly equal: 'ABORTED' !== 'BLOCKED'` (the mutant broke out of the RED
  loop on `red: true` alone, proceeded to Implement, and aborted there
  instead of correctly reaching BLOCKED after 3 rejected RED attempts).
- **Passed once the mutation was reverted.**

**Reverted**: restored from backup; `tdd-task.test.js` now 10/10 green,
including the strengthened test, which remains in the suite going forward.

## 6. `budget.spent()` unmeasured is `null`, never `0` — `workflows/lib/ledger.mjs` `safeBudgetSpent`

**Guarded behaviour**: AC-QA-15 / AC-OPS-3 — a missing `budget` or a
throwing `budget.spent()` must record `null`, distinguishable from a real
zero-token run.

**Mutation**: both `return null` branches and the `: null` ternary fallback
changed to `0`.

**Result**: 5 tests failed for the right reason, across all three
instrumented workflows plus the unit tests on `safeBudgetSpent` itself —

- `ledger: safeBudgetSpent returns null (not 0) when budget is undefined (AC-QA-15)` — `0 !== null`
- `ledger: safeBudgetSpent returns null (not 0) when budget.spent() throws (AC-QA-15)` — `0 !== null`
- `tdd-task.js: telemetry.budget_spent is null (not 0) when no budget is supplied (AC-QA-15)`
- `plan-cycle.js: telemetry.budget_spent is null when no budget is supplied, and reflects budget.spent() when supplied (AC-QA-15)`
- `review-cycle.js: telemetry.budget_spent is null when no budget is supplied (AC-QA-15)`

**Reverted**: restored from backup; all four suites back to green (50/50
across the four files run together).

## 7. `writeLedgerEntry` never throws — `workflows/lib/ledger.mjs`

**Guarded behaviour**: AC-QA-7 — a ledger write must never fail the caller's
run, including when the `agent()` call itself throws.

**Mutation**: removed the `try { … } catch (e) { response = null }` around
the `ctx.agent(...)` call.

**Result**: 1 test failed for the right reason —

- `ledger: writeLedgerEntry never throws when the agent call itself throws`
  — the test's own `Error: agent crashed` propagated up through
  `writeLedgerEntry` uncaught, exactly the failure this guard exists to
  prevent.

**Reverted**: restored from backup; `ledger.test.js` back to 22/22 green.

## 8. Spec-bug/rejected-finding counts are `null`, never `0`, on a malformed synthesis — `workflows/review-cycle.js`

**Guarded behaviour**: AC-QA-13 / AC-OPS-3 — if the synthesis agent's
response is missing the required `spec_bugs`/`rejected_findings` arrays
(malformed response), the ledger telemetry must record `null` (unmeasured),
never silently `0` (measured-and-empty).

**Mutation**: `specBugs ? specBugs.length : null` → `: 0` (same for
`rejectedFindingCount`).

**Result**: 1 test failed for the right reason —

- `review-cycle.js: synthesis missing spec_bugs/rejected_findings fields is treated as a failed step, not a ledger line with silently empty arrays (AC-QA-13)`
  — `0 !== null`

**Reverted**: restored from backup; `review-cycle.test.js` back to 12/12 green.

## 9. `.gitignore` is ensured before the first write — `workflows/lib/ledger-append.mjs`

**Guarded behaviour**: AC-SEC-1 — the ledger is untracked by default; before
the first write, `.gitignore` is created or extended to cover it.

**Mutation**: commented out the `ensureGitignored(root)` call.

**Result**: 1 test failed for the right reason —

- `ledger-append: ensures the ledger is gitignored before the first write, and never stages it (AC-SEC-1)`
  — `AssertionError: git check-ignore must exit 0 for the ledger path: 1 !== 0`

**Reverted**: restored from backup; `ledger-append.test.js` back to 13/13 green.

## 10. No personal identifier reaches a real ledger line — `workflows/lib/ledger-append.mjs` `resolveRepoIdentity`

**Guarded behaviour**: AC-SEC-3 — `repo` is a repo-relative identity (an
`owner/repo` slug or a bare directory basename), never an absolute path, and
a real ledger line never contains the operator's git email/name, OS
username, hostname, or an absolute `/Users/`, `/home/`, `/Volumes/` or `C:\`
path.

**Mutation**: `resolveRepoIdentity` short-circuited to `return cwd` (the
absolute working directory) before its real body.

**Result**: 1 test failed for the right reason —

- `ledger-append: a real ledger line contains no personal identifier -- not the operator's git email/name, whoami, hostname, nor any absolute path (AC-SEC-3)`
  — `AssertionError: must not contain the OS username` (the mutant's absolute
  cwd path contains the scratch temp directory, which on this machine embeds
  the OS username)

**Reverted**: restored from backup; `ledger-append.test.js` back to 14/14 green.

## 11. `ledger-append.mjs` reuses a caller-supplied `run_id` — start/terminal pairing

**Guarded behaviour**: AC-DATA-5's start/terminal record protocol only works
if the terminal write's `run_id` can be forced to match the start write's;
otherwise a killed run's start record is an orphan nobody can pair back up.

**Mutation**: `const run_id = typeof payload.run_id === 'string' && ... ?
payload.run_id : randomUUID()` reverted to always `randomUUID()`.

**Result**: 1 test failed for the right reason —

- `ledger-append: reuses a caller-supplied run_id instead of generating a fresh one, so a start record and its terminal record can share identity (AC-DATA-5)`
  — two different UUIDs printed where the same one was expected.

**Reverted**: restored from backup; `ledger-append.test.js` back to 16/16 green.

## A note on this document's own history

Ten proofs were originally written up as "PR1 done" before a late pass
noticed the spec's explicit start/terminal record protocol (AC-DATA-5) had
been understood but never actually wired into the three instrumented
workflows -- only a single terminal write existed, meaning a run killed
mid-flight left no ledger trace at all, exactly the risk the spec's own
"Risks" section names as the reason the protocol exists. That gap is now
closed (workflows/tdd-task.js, review-cycle.js and plan-cycle.js each write
a `started` record before any work begins, and their terminal write requests
reuse of that record's `run_id`), proof #11 above, and every earlier
AC-ARCH-3 test updated from "expects one ledger write" to "expects one start
write plus one terminal write." Recorded here rather than quietly folded in,
because a task list that silently grows after "done" was said is exactly
the kind of thing this file exists to make visible.

## Rework: workflow scripts made fully self-contained (no imports)

A coordinator probe against the live dynamic-workflow runtime found that
both static `import ... from` and dynamic `import()` are rejected at
submission, before execution -- the same static pre-check that already
rejects `Date.now()`/`new Date()`/`Math.random()`. `workflows/tdd-task.js`,
`review-cycle.js` and `plan-cycle.js` each opened with `import { ... } from
'./lib/ledger.mjs'`, so all three would have failed to launch in
production; the fake-runtime test helper had never enforced this because it
ran under real Node, which accepts imports the production loader forbids.

Fixed by: tightening `test/helpers/fake-runtime.js` to statically reject the
same four patterns before compiling anything (proven with new fixtures under
`test/fixtures/rejects-*.js`, one per pattern, plus
`mentions-in-comment-only.js` proving a `//` mention does not trip it);
deleting `workflows/lib/ledger.mjs` and moving everything it held (the
envelope schema -- AC-ARCH-5's single definition site, validation,
`findingId` hashing, truncation) into `workflows/lib/ledger-append.mjs`,
the one real-Node script every workflow was already invoking via Bash;
making each workflow file self-contained (no imports, small inlined
`readBudgetSpent`/`ledgerWritePrompt`/`writeLedger` helpers, duplicated
three times, which AC-SIMP-12 now permits since importing them is
impossible); and moving finding-id computation for `review-cycle.js`'s
spec-bugs/rejected-findings into `ledger-append.mjs`, since workflow
scripts have no `node:crypto` (review-cycle.js now sends the raw
descriptors as payload data instead).

Every guard proof above whose code moved was re-run against its new
location, by the same break/watch-fail/revert method, before being trusted
again:

**Proof 12 (was #1, additionalProperties:false).** Disabled the same check,
now in `ledger-append.mjs`'s `validateEntry`. 2 tests failed for the right
reason (`ledger-append: rejects a payload with a property outside the
schema...` and the relocated `ledger-append module: validateEntry rejects
an entry with an unknown top-level property...`). Reverted; 31/31 green.

**Proof 13 (was #8, spec_bug_count/rejected_finding_count null-not-zero).**
`computeFindings`'s `null` fallback (now in `ledger-append.mjs`, since it
sits next to the relocated finding computation) changed to `0`. 1 test
failed for the right reason (`spec_bugs/rejected_findings sent as null...
yields null counts, not zero`). Reverted; 31/31 green.

**Proof 14 (was #6, `budget.spent()` null-not-zero).** The three `null`
returns in `tdd-task.js`'s now-inlined `readBudgetSpent` changed to `0`. 1
test failed for the right reason (`telemetry.budget_spent is null (not 0)
when no budget is supplied`). Reverted; 13/13 green. (Not re-run for
review-cycle.js/plan-cycle.js: identical duplicated code, same fixture
shape, diminishing return on repeating it a third time.)

**Proof 15 (was #7, ledger write never throws).** The `try`/`catch` around
`agent(...)` in `tdd-task.js`'s now-inlined `writeLedger` removed. 1 test
failed for the right reason: the test's own `Error: agent crashed`
propagated up through `writeLedger` uncaught. Reverted; 13/13 green.

**Proof 16 (was #11, run_id reuse for start/terminal pairing).** `payload.run_id`
reuse in `ledger-append.mjs` reverted to always `randomUUID()`. 1 test
failed for the right reason (two different UUIDs printed where the same one
was expected). Reverted; 31/31 green.

**Proof 17 (new): no-import static check.** Added `import { findingId }
from './lib/ledger-append.mjs'` to the top of `tdd-task.js` (exactly the
regression this whole rework fixes). Three independent layers caught it:
`static-checks.test.js`'s dedicated no-import test failed
(`workflows/tdd-task.js contains a static import declaration`); its
Date/Math/import combined check also failed; and every one of
`tdd-task.test.js`'s 13 tests failed via the fake-runtime helper's own
pre-check, since `runWorkflow` now rejects before compiling. Reverted;
85/85 green across the full suite.

One near-miss during this rework, recorded because it is a genuine
process lesson rather than a code defect: partway through mutation
re-verification, `git checkout -- workflows/lib/ledger-append.mjs` was run
to "revert" a mutation on a file that, at that moment, had substantial
uncommitted rework beyond the mutation itself -- the command silently
discarded all of it back to the last commit. Caught immediately by the
next test run's file-content check, and recovered by rewriting the file
from the version held in this session's own context. From that point on,
every mutation in this rework was backed up with `cp` to a scratch path
before editing and restored the same way, never with `git checkout --`,
specifically because that command reverts to the last COMMIT, not to
"a moment ago," and the two are only the same thing if nothing has been
committed since -- which cannot be assumed mid-task. No data was lost in
the final result, but it is exactly the kind of mistake that would have
been unrecoverable without the file's content still being available.

## Caveat

These eleven cover the guards judged highest-risk (data integrity, injection
safety, the single-write-path invariant, the RED/GREEN control-flow
invariant, and null-vs-zero telemetry correctness) rather than every
assertion in the suite. Mutation #5 is the one genuine finding: it is left in
this document rather than quietly fixed and forgotten, because a surviving
mutant that gets patched without a record is exactly the kind of near-miss
this process exists to catch.
