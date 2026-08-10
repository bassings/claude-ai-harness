# PR1 mutation proofs

Per AC-QA-3 and standard §11: for the guards below, the guarded behaviour was
actually broken (edited in the working file, not "mentally mutated"), the
suite was run, the exact failing test and message recorded, and the file was
then restored and the suite re-run green. All nine were executed in this
session; the commands and output are reproduced from that run.

Restoration was verified after every mutation by re-running the full suite
(`node --test test/*.test.js`) and confirming 77/77 pass, and by `grep -rn
"MUTATION"` across `workflows/`, `test/`, `skills/`, `AGENT-HARNESS.md` and
`README.md` returning nothing (no mutation marker left behind).

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

## Caveat

These ten cover the guards judged highest-risk (data integrity, injection
safety, the single-write-path invariant, the RED/GREEN control-flow
invariant, and null-vs-zero telemetry correctness) rather than every
assertion in the suite. Mutation #5 is the one genuine finding: it is left in
this document rather than quietly fixed and forgotten, because a surviving
mutant that gets patched without a record is exactly the kind of near-miss
this process exists to catch.
