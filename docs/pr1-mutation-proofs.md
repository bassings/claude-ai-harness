# PR1 mutation proofs

Per AC-QA-3 and standard §11: for the guards below, the guarded behaviour was
actually broken (edited in the working file, not "mentally mutated"), the
suite was run, the exact failing test and message recorded, and the file was
then restored and the suite re-run green. Seventy-four proofs have been
executed across five passes: 17 in the initial build (11 in the first pass,
6 more -- 5 re-verifications plus one new guard -- in the "Rework" section,
after a coordinator probe found workflow scripts cannot import anything in
production), 18 more (proofs 18-35) in the "Review remediation round 1"
section (1 Critical, 5 High, 9 Medium, 6 Low -- 21 findings, all fixed, none
rejected), 32 more (proofs 36-67) in the "Review remediation round 2"
section (0 Critical, 4 High, 6 Medium, 12 Low -- 22 findings; 20 fixed, one
deferred to PR 2 with reasoning recorded (L11), one triaged as a docs-only
addition with a mechanical guard rather than a mutation-proved code guard
(L9, this section itself)), 6 more (proofs 68-73) in the "Review
remediation round 3" section (1 High, 2 Low, plus one self-flagged
test-hygiene item carried over from round 2's own final report -- all
fixed, none rejected), and 1 more (proof 74) in "Review remediation round
3b", which RETRACTS part of round 3: proof 70's own rollback guard was
itself found unsafe under concurrency and removed outright rather than
re-fixed in place (§12 -- a change reverted for being worse keeps the
simpler original).

**Proofs 1, 6 and 7 below reference `workflows/lib/ledger.mjs`, which no
longer exists**: that was accurate at the time each proof was first run, and
is left as the historical record of when each guard was first proven. The
"Rework" section documents where the code (and each guard) actually lives
now, and re-proves the ones that moved.

Restoration was verified after every mutation by re-running the affected
test file(s) (the full suite is `node --test test/*.test.js`, 128/128 as of
the last commit in this worktree, stable across repeated runs and a clean
clone) and by `grep -rn "MUTATION"` across `workflows/`, `test/`, `skills/`,
`AGENT-HARNESS.md` and `README.md` returning nothing (no mutation marker
left behind).

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

## Review remediation round 1 (proofs 18-30)

The full multi-lens review (1 Critical, 5 High, 9 Medium, 6 Low) found real
guard-vacuity holes in the eleven-plus-six proofs above, most pointedly C1
(a validation bug that silently dropped two of four ledger record kinds,
which shipped past all 85 tests because none of them ever piped a
non-empty `lenses_run` into the real script) and H4 (the tdd-task
terminal-verdict loop only ever asserted "the outcome is one of
done/blocked/aborted", which every verdict satisfies). Every finding
(C1; H1-H5; M1-M9; L1-L6, 21 total) was fixed, not rejected. Full detail
and reasoning is in each fix's own commit message; this section is the
proof ledger's continuation, not a duplicate of it.

**18. C1 — `validateEntry`'s array-of-string branch.** Forced the
object-recursion path unconditionally (`if (true)` instead of the
items-schema type check). The two H3 seam tests for `review_cycle` and
`plan_cycle` failed with the exact "expected an object" message from the
finding's own evidence; `tdd_task` and `conduct_plan_event` (no
array-of-string fields) still passed, also matching. Reverted.

**19. H1 — shell-injection via unescaped payload in the ledger-write
prompt.** Proven by direct reproduction rather than a synthetic mutation:
the exact backtick example command from a real `review-cycle.js` prompt,
run verbatim (substituting the shown payload the way a compliant agent
would), created a marker file before the base64 fix and did not after.
See `test/shell-injection.test.js`.

**20. H2 — `redactPaths` not called on `spec`/`task`.** Both call sites
disabled; the AC-SEC-3 fixture's three new H2 tests failed with the exact
"must not contain an absolute /home/ path" message the finding's own
evidence used. Reverted.

**21. L6 — `stripRoot` not called on `write_error`.** Reverted to bare
`e.message`; the dedicated L6 test failed, showing the real absolute
temp-repo path in `write_error`. Reverted.

**22. H4 — the two mutations named in the finding, reproduced verbatim
against production `tdd-task.js`.** `if (green.hashes_match === false)`
deleted (M1 in the finding) and the exhausted-implement `BLOCKED` changed
to `ABORTED` (M2 in the finding): both now caught by the per-case
`expect` verdict and the two new dedicated tests, both with the finding's
own consequence (a mutant proceeds to commit, or returns the wrong
verdict). Reverted.

**23. H5 — `openFindingsRaw` computation, at both ends.**
`review-cycle.js`'s accumulator emptied: the open_findings test failed
(`0 !== 1`). `ledger-append.mjs`'s `computeFindings(payload.open_findings,
'open')` stubbed to a constant empty result: the two ledger-append H5
tests failed on entry count. Reverted both.

**24. M1 — `trigger_counts['lens-product']` reverted to `specHit.length`.**
The exact reproduction test (a UI-only diff triggering lens-product via
`uiHit`) failed with `0 !== 1`, the finding's own shape. Reverted.

**25. M4 — `round_key` hardcoded to the fixture's own SHA constant.** The
mutant's chosen literal (`'abcdef1234567890'`) deliberately matches the
fixture's default SHA, reproducing exactly why the ORIGINAL test survived
this class of mutant; the NEW test (a second run at a different SHA) still
caught it. Reverted.

**26. M5 — `ts` hardcoded to `'not-a-timestamp'`.** Both new M5 tests
(format/parse/proximity and monotonicity) failed. Reverted.

**27. M6 — the `pattern` check in `validateEntry` disabled.** Both canary
tests (a "secret sk-live-CANARY..." lens, a quoted-source-line ac_id)
reverted to passing through unrejected. Reverted.

**28. M7 — `ensureGitignored` reverted to `path.join(root, '.gitignore')`.**
The committed-`.gitignore` fixture failed with the exact evidence from the
finding: the tracked file gained the ledger line and `git status` was no
longer empty. Reverted.

**29. L2 — the throwing-`budget.spent()` catch branch in
`readBudgetSpent` changed to return `0`.** The new L2 test failed with
`0 !== null`. Reverted.

**30. L3 — the schema-validation call in `makeAgentStub` disabled.** The
"missing required field" test, driven against tdd-task.js's real
`write-test` schema, stopped rejecting the malformed fixture. Reverted.
Running the FULL suite after this one (not just its own test file)
surfaced a genuine second-order effect worth recording here as much as in
the commit: `review-cycle.js`'s own AC-QA-13 test deliberately scripts a
synthesis response the real schema forbids (to exercise defensive
fallback code), and the newly-strict stub correctly refused to construct
that fixture too -- not a bug in the L3 fix, but a real design tension
between "enforce schemas strictly" and "test defence-in-depth against a
schema violation". Resolved with a documented, explicit opt-out
(`__bypassSchemaValidation: true`) rather than silently loosening the
check for everyone.

**31-33. M2 — three separate mechanisms, three separate mutations.**
Byte- vs character-based truncation: reverted `truncateBytes` to
`truncate` at the `TRUNCATABLE_FIELDS` call site. The FIRST version of
this test (a single multibyte field) did not catch it -- a single field
character-truncated to 500 tops out at 1500 bytes, comfortably under the
2048 cap regardless of which truncation function ran, so that test was
itself a surviving mutant, found and fixed before trusting the "M2 done"
claim: the corrected test uses TWO maxed-out fields (`task` and `spec`)
totalling 3000 bytes under character-truncation, only then genuinely
distinguishing the two behaviours. Findings bounding: `MAX_FINDINGS`
slicing removed; the dedicated bounding test failed because the
now-unbounded record had to degrade instead of fitting. Degrade-to-
minimal: the whole `if (...) { ... }` overflow-handling block disabled;
the degrade test failed with `entry.degraded === undefined`. All three
reverted.

**34-35. M3 — the conditional-required rule and the dedup-skip, separately.**
`requiredWhen: []`: the missing-event_key test, which had been passing,
failed. Dedup-skip block gated behind `if (false && ...)`: the
duplicate-replay test failed, no longer reporting `duplicate: true`. Both
reverted.

Every mutation above was confirmed applied (via the failing test's message
matching the intended defect, not just "some test failed"), confirmed
reverted (via `git diff --stat` on the touched file showing only the
intended, committed change), and the full suite re-run green after each
revert -- 128/128 as of the last commit in this round, stable across
repeated runs including from a fresh clean clone.

## Review remediation round 2 (proofs 36-67)

A second full multi-lens review (0 Critical, 4 High, 6 Medium, 12 Low --
22 findings) found guard-vacuity holes in the round-1 fixes themselves,
most pointedly H3 (the round-1 M2 findings-bounding test was itself sized
away from the real 2048-byte threshold, so it never actually proved a
realistic review round survives) and H2 (round-1's redaction fix covered
`spec`/`task` by field name, missing the conduct_plan_event route
entirely). Every mutation below was applied to the working file (never
"mentally"), backed up first via `cp` to a scratch path -- never `git
checkout --`, per the lesson recorded at the end of the "Rework" section
above -- restored the same way, and the affected test file(s) re-run green
after every revert. Full detail and reasoning is in each fix's own commit
message; this section is the proof ledger's continuation.

**36. H1 -- ledger-append.mjs resolution order.** `tdd-task.js`'s
`ledgerWritePrompt` step-1 text reverted to the pre-fix repo-local-first
order. Caught independently by three of the ten new
`test/ledger-write-resolution.test.js` assertions (the exact vulnerable
order) AND by the pre-existing L5 static byte-identity check. Reverted.

**37-40. H2 -- four sub-fixes, four separate mutations.** (a) The
`TRUNCATABLE_FIELDS`-loop redaction reverted to the round-1 shape
(`spec`/`task` only): caught by exactly the 3 new tests naming the
newly-covered fields (event_key, round_key, lenses_run/skipped). (b) The
base `type` check in `validateEntry` disabled: caught by exactly the
scalar-type unit test (`task: 42`). (c) The dict-value check
(`trigger_counts`/`verdicts`/`rounds` inner values) disabled: caught by
exactly the hostile-payload integration test and its module-level unit
test. (d) The origin-remote host-form gate disabled (`if (true ||
REMOTE_HOST_RE.test(url))`): caught by exactly the local-path-origin test.
All four reverted; 145/145 green.

**41-42. H3 -- the cap and the progressive-drop loop, separately.** The
progressive-drop loop disabled (`if (false && ...)`): caught by exactly
the calibrated progressive-degrade test. `MAX_LINE_BYTES` reverted to
2048: caught by exactly the three tests measuring against the cap (the
realistic-round test, the progressive-degrade calibration, and the
module-level pinned-value test). Both reverted; full suite run three times
(147/147 each) to rule out flakiness in the calibration loop.

**43-45. H4 -- schema, aggregation and lens-schema, three separate
mutations.** `ac_verdicts`' `additionalProperties: false` loosened to
`true`: caught by exactly the schema-shape and evidence-rejection tests.
The `acVerdicts` aggregation in `review-cycle.js` disabled (`acVerdicts =
[]`): caught by exactly the aggregation test. `ac_id` removed from
`REVIEW_SCHEMA`'s findings items: caught by exactly the
schema-declaration test (reading the real schema off a captured lens
call, not a hand-typed copy). All three reverted; 154/154 green.

**46-47. M1 -- outcome=aborted, both workflows.** `review-cycle.js`'s and
`plan-cycle.js`'s outcome logic each reverted to the pre-fix shape
(computed purely from lens verdicts). Both new "synthesis fails/returns
empty" tests, in each file, failed for the right reason before reverting.
158/158 green after.

**48. M2 -- event_scope occurrence minting.** The minting block gated
behind `if (false && ...)`. Caught by exactly the four new
event_scope-specific tests. Reverted; 162/162 green.

**49-51. M3 -- start-write-first, one mutation per workflow.** Swapped
the start-write/`run()` call order in `tdd-task.js`, `review-cycle.js` and
`plan-cycle.js` in turn. Each swap was caught by exactly the one new test
in that file asserting `calls[0].opts.label === 'ledger:write'`; the
other 16+ tests in each suite stayed green, confirming the assertion is
what detects the regression, not an incidental side effect. All three
reverted; 165/165 green.

**52. M4 -- unconditional exit-hook cleanup.** The `process.on('exit',
...)` handler in `test/helpers/temp-repo.js` disabled. Caught by exactly
the real-child-process test (the only way to actually exercise an `exit`
handler firing). Leftover directory from the mutation removed by hand
before reverting. Full suite run three times (168/168 each) with zero
leftover directories in TMPDIR after each run.

**53-55. M5 -- three per-lens trigger counts, three separate
mutations.** `triggerCounts['lens-operability'] = 999`: caught by exactly
the new lens-operability test. `triggerCounts['lens-data'] =
paths.length`: caught by exactly the new lens-data test. Same for
`lens-product`. All three fixtures are multi-file diffs where the matched
subset is strictly smaller than the total, closing the exact vacuity the
finding named (a single-file fixture cannot distinguish "matched count"
from "total count"). All three reverted; 171/171 green.

**56. M6 -- synthesis schema's required list.** `required: ['report',
'spec_bugs', 'rejected_findings']` reduced to `['report']`. Caught by
exactly the new schema-reading test (deep-equalling `synthesisCall.opts
.schema.required`). Reverted; 172/172 green.

**57. L1 -- check-ignore verification.** The `git check-ignore -q`
refusal after `ensureGitignored` removed. Caught by exactly the new
negation-pattern `.gitignore` test. Reverted; 173/173 green.

**58. L2 -- submodule detection.** `resolveMainCheckoutRoot`'s
`--show-superproject-working-tree` check removed. Caught by exactly the
real-submodule-fixture test (`git submodule add` against a second
`makeTempRepo()`). This test's first draft was itself a near-miss: it
initially asserted `write_ok:false` and a bogus path that turned out to
be the WRONG bogus path (guessed `.git/modules/subrepo/...`; the real one,
found by inspecting the actual directory tree created on disk, was
`.git/modules/.git/info/exclude`) -- the first draft passed against the
UNFIXED code because the round-2 L1 fix (check-ignore) incidentally also
produced `write_ok:false` here, for an unrelated reason (`git check-ignore`
itself failing against the bogus root). Tightened to require the
write_error name "submodule" specifically before it failed for the right
reason. Reverted; 174/174 green.

**59. L3 -- AGENT-HARNESS.md's two added sentences.** Removed. Caught by
exactly the new static test. The test's own first version was also a
near-miss: `/git history/i` failed against the CORRECT prose because
markdown hard-wrapping split "git" and "history" across a line break;
fixed to `/git\s+history/i`. Reverted; 175/175 green.

**60. L4 -- outcome's conditional-required rule.** The three
`requiredWhen` rules (`tdd_task`/`review_cycle`/`plan_cycle`) removed,
`outcome` restored to the unconditional `required` list. Caught by
exactly the two tests exercising the conduct_plan_event-with-no-outcome
path. Reverted; 178/178 green.

**61-63. L5 -- the exact top-level key set, three workflows.** `raw`
returned directly instead of destructuring out `__outcome` in
`review-cycle.js` and `plan-cycle.js` (each caught by exactly the new
test in that file); an extra key (`debug_leak: true`) added to
`tdd-task.js`'s DONE-path return (caught by exactly its new test). All
three reverted; 181/181 green.

**64. L7 -- telemetry.rounds counter swap.** `{test_attempts:
rounds.implement_attempts, implement_attempts: rounds.test_attempts}`.
Caught by exactly the two asymmetric-count tests; the DONE-path test
(both counters equal 1) could not and did not catch it, confirming why
the asymmetric fixtures were necessary. Reverted; 183/183 green.

**65-66. L10 -- findingId's location argument and its normalisation,
separately.** `location` dropped from the hash entirely: caught by
exactly the location-varies test. `trim()`/`toLowerCase()` removed:
caught by exactly the normalisation test. Both reverted; 186/186 green.

**67. L12 -- README's added clause.** The recreates-automatically/no-off-
switch clause next to the "Delete it" instruction removed. Caught by
exactly the new static test. Reverted; 187/187 green.

**L6 (dead code deletion) and L8 (unwritable-directory coverage) carry no
mutation number**: L6 deleted `truncate()` and the unused `makeAgentStub`
export rather than guarding new behaviour, verified instead by the full
suite staying green (180/180, exactly one fewer test than before -- the
deleted `truncate` unit test, nothing else) after the deletion, confirming
nothing else depended on either removed path. L8 added coverage for an
EXISTING guard (the `try`/`catch` around the append, already mutation-proven
in round 1 as proof #7/#15) at a new failure site (EACCES rather than
EISDIR); its own non-vacuity was confirmed by direct reproduction outside
the suite (see its commit message) rather than a fresh mutation of a
guard the test itself introduces. **L9** is this section plus the AC
traceability table below, not a mutation-proved code guard: see its own
subsection. **L11** was triaged as deferred to PR 2, with the reasoning
recorded in its commit; no PR 1 code exists to prove.

Every mutation above was confirmed applied (via the failing test's message
matching the intended defect, not just "some test failed"), confirmed
reverted (via `git diff --stat` on the touched file showing only the
intended, committed change, and via snapshot `cp` rather than `git
checkout --` throughout), and the full suite re-run green after each
revert -- 187/187 as of the last commit in this round.

## AC-to-test traceability (L9, AC-QA-3)

AC-QA-3 requires each acceptance criterion to name its proving test. No
central table existed; this one is derived mechanically (grep across
`test/*.test.js` test names for `AC-[A-Z]+-[0-9]+`, not hand-curated), so
it stays checkable rather than becoming another doc that quietly drifts
from the code. Regenerate it with:

```bash
node -e '
const fs = require("fs"), path = require("path");
const acToTests = {};
const re = /AC-[A-Z]+-[0-9]+/g;
for (const f of fs.readdirSync("test").filter(f => f.endsWith(".test.js"))) {
  const src = fs.readFileSync(path.join("test", f), "utf8");
  const testRe = /\btest(?:\.\w+)?\(\s*(`[^`]*`|"(?:[^"\\]|\\.)*"|\x27(?:[^\x27\\]|\\.)*\x27)/g;
  let m;
  while ((m = testRe.exec(src))) {
    for (const ac of new Set((m[1].slice(1, -1).match(re)) || [])) {
      (acToTests[ac] ||= new Set()).add(f);
    }
  }
}
for (const k of Object.keys(acToTests).sort()) console.log(k, [...acToTests[k]].join(","));
'
```

| AC | Test file(s) (tag present in test name) | Notes |
|---|---|---|
| AC-SEC-1 | ledger-append.test.js | Proof 9, 57 |
| AC-SEC-2 | ledger-append.test.js | Proof 12; findings/ac_verdicts exclusion |
| AC-SEC-3 | ledger-append.test.js, static-checks.test.js | Proof 10, 37-40, 58 |
| AC-SEC-4 | static-checks.test.js | Proof 59 |
| AC-SEC-5 | ledger-append.test.js | Proof 3, 58 |
| AC-SEC-6 | ledger-append.test.js | Proof 2, 19 |
| AC-SEC-7..10 | **no test, PR 2** | Optimiser scope, absent by design |
| AC-QA-1 | **no test tag** -- proven by `test/fake-runtime.test.js`'s static-rejection tests (`runWorkflow rejects a script containing...`), cited in `fake-runtime.js`'s own header comment | Untagged coverage, not a gap |
| AC-QA-2 | **no test tag** -- proven by `test/fake-runtime.test.js`'s schema-validation tests (`a scripted agent response missing a required field is rejected...`) | Untagged coverage, not a gap |
| AC-QA-3 | this table + `docs/pr1-mutation-proofs.md` itself | Was the round-1 and round-2 FAIL (L9); closed by this table |
| AC-QA-6 | ledger-append.test.js | |
| AC-QA-7 | ledger-append.test.js, plan-cycle.test.js, review-cycle.test.js, tdd-task.test.js | Proof 7, 15; L8 adds the unwritable-directory variant |
| AC-QA-9 | ledger-append.test.js, static-checks.test.js | Proof 34-35, 48 |
| AC-QA-10 | **no test tag** -- proven by `ledger-append.test.js`'s `ts is real ISO-8601 UTC with milliseconds...` and `two successive writes have non-decreasing timestamps` (both M5) | Untagged coverage, not a gap |
| AC-QA-11 | ledger-append.test.js, review-cycle.test.js | Proof 65-66 |
| AC-QA-12 | review-cycle.test.js | |
| AC-QA-13 | ledger-append.test.js, review-cycle.test.js | Proof 8, 13, 56 |
| AC-QA-14 | review-cycle.test.js | Proof 53-55 |
| AC-QA-15 | plan-cycle.test.js, review-cycle.test.js, tdd-task.test.js | Proof 6, 14 |
| AC-QA-16, 17, 19, 20, 21, 25 | **no test, PR 2** | |
| AC-QA-23 | tdd-task.test.js | Proof 5 |
| AC-ARCH-3 | plan-cycle.test.js, review-cycle.test.js, tdd-task.test.js | Proof 4, 46-47 |
| AC-ARCH-5 | static-checks.test.js | Single-definition-site check |
| AC-ARCH-8 | static-checks.test.js | Scope-boundary only |
| AC-ARCH-9 | static-checks.test.js | No hardcoded absolute paths |
| AC-ARCH-10 | plan-cycle.test.js, review-cycle.test.js, tdd-task.test.js | Proof 61-63 |
| AC-ARCH-13, 14 | **no test, PR 2** | |
| AC-DATA-1 | ledger-append.test.js | Worktree resolution |
| AC-DATA-2 | ledger-append.test.js | Append-only, no rewrite |
| AC-DATA-3 | ledger-append.test.js | Concurrent writers, atomic write; proof 74's concurrency test additionally guards that a short write on one writer never destroys another concurrent writer's already-committed record |
| AC-DATA-4 | ledger-append.test.js | Checkout survival (checkout half only) |
| AC-DATA-5 | ledger-append.test.js, tdd-task.test.js | Proof 11, 16; start/terminal pairing |
| AC-DATA-7 | tdd-task.test.js | **Also proven, untagged, by H4's new ac_verdicts/ac_id tests in review-cycle.test.js and ledger-append.test.js** (proof 43-45) -- the round-2 effective FAIL this round's H4 closed |
| AC-OPS-3 | ledger-append.test.js | null-vs-zero distinguishability |
| AC-PROD-4, 5, 7 | **no test, PR 2** | |
| AC-PROD-9 | static-checks.test.js | Proof 67 (L12); H3/L12 accuracy gaps closed |
| AC-PROD-10 | static-checks.test.js | Scope-boundary only (no optimiser reference in this PR); substantive criteria are PR 2 |
| AC-SIMP-1, 2, 4, 7, 12 | ledger-append.test.js, static-checks.test.js | Mechanical, checked directly against the diff per harness convention, not by a lens |
| AC-SIMP-10, 11 | **not testable, PR 2** | |

Rows with no `AC-` tag in any test name (AC-QA-1, AC-QA-2, AC-QA-10) are
genuinely covered -- untagged, not un-tested -- as the notes column states;
the fix is optional future tidiness (adding the tag string), not a
coverage gap. Rows marked "no test, PR 2" name real, currently-absent
coverage for criteria this PR does not implement, not a hidden gap in what
it does implement.

## Review remediation round 3 (proofs 68-73)

A third full multi-lens review (0 Critical, 1 High, 2 Low; two arbitrations
recorded) found lens-data's first real finding of the whole PR: appending
after a torn trailing line fuses two records into one unparseable line.
Every mutation below was applied to the working file, backed up first via
`cp` to a scratch path -- never `git checkout --` -- restored the same way,
and the affected test file(s) re-run green after every revert.

**68. HIGH -- the torn-line heal.** The last-byte read and healing '\n'
prefix in `ledger-append.mjs`'s append block replaced with `let healPrefix
= ''` unconditionally. Caught by exactly the torn-trailing-line test
(seeded a real, valid JSON record missing only its trailing newline,
confirmed by a sanity assertion that the naive unhealed concatenation is
genuinely unparseable before trusting the test proves anything). The
regression test (an ordinary two-write sequence, asserting no spurious
blank line) stayed green throughout, confirming the heal only fires when
actually needed.

**69. HIGH -- the short-write check.** `if (written !== buf.length)`
disabled (`if (false && ...)`). Caught by exactly the calibrated
`ulimit -f` test. A genuinely full disk cannot be constructed in this
sandbox; confirmed empirically first that RLIMIT_FSIZE produces a real
short `fs.writeSync` return (not an exception, not a killed process) on
this platform, then calibrated the payload size after a first draft
(a 500-byte truncated `task` field) never exceeded the smallest tried
block limit's ~1024-byte floor and so never actually reproduced a short
write at any size tried -- caught before trusting the "short write
reproduced" claim, the same vacuous-fixture class as earlier rounds.

**70. HIGH -- the short-write rollback.** The `fs.ftruncateSync(fd,
stats.size)` call on a detected short write removed. Caught by the same
calibrated test: without the rollback, the partial bytes already written
by the failed attempt are themselves a fresh torn trailing line, and
`readLedgerLines` correctly surfaces it as one unparseable "line" (no
trailing newline to split on), which the test's `JSON.parse` throws on --
confirmed by reading the actual failure message ("Unterminated string in
JSON at position 1024") to be certain the assertion fired for that reason,
rather than assuming its (conditional on `lines.length`) guard clause
would have been skipped.

**71. LOW -- README's git-clean documentation and arbitration.** Both the
git-clean-deletes-the-ledger sentence and the AC-DATA-4/AC-SEC-1
arbitration paragraph reverted together. Caught by exactly the new static
test (asserting "git clean -xdf" is named with a deletion statement and a
keep-it instruction nearby, and that "arbitration" plus both AC IDs appear
in the document). The keep-it instruction
(`git clean -xdf -e .claude/harness-ledger.jsonl`) was verified by hand
against a real repo before being documented as the fix, not assumed correct.

**72. LOW (speculative) -- fake-runtime's widened Date/Math.random
patterns.** Both new regex entries (bare `Date` token, `Math.random`
without requiring an immediate call) removed from REJECTIONS. Caught by
exactly the three new obfuscation fixtures (bracket access, Date aliased
through a variable, Math.random aliased through a variable); the
Math.floor non-vacuity fixture stayed green throughout, confirming the
widening targets Math.random specifically, not the whole Math object.
Confirmed by grep before adding either pattern that neither "Date" nor
"Math" appears anywhere in the three real workflow scripts, so the
widening introduces no false positive against production code.
"Import used as a bare identifier" (the finding's third obfuscation) was
investigated and rejected with evidence, not silently skipped: `import`
is a reserved word in JS syntax, so aliasing it is a SyntaxError -- no
valid code path could reach this check via that route.

**73. Test hygiene (self-flagged carryover, not one of the three review
findings) -- shell-injection.test.js's marker isolation.** Rather than
mutating the fix itself, this was proven by reproducing the underlying
vulnerability for real: `review-cycle.js`'s `ledgerWritePrompt` reverted
from the base64 transport back to raw JSON embedding (the exact pre-H1
form, the same technique as proof #19). Running `shell-injection.test.js`
in isolation against that reverted code caused both tests to fail for the
right reason (the marker WAS created under the isolated SUITE_TMPDIR,
proving the injection re-triggered exactly as the file exists to detect),
leaving the marker uncleaned mid-process since the assertion threw before
reaching its own `fs.rmSync` line -- exactly the leak shape the old bare-
`os.tmpdir()` code would have left permanently. After the process exited,
TMPDIR was checked and found to hold zero leftover directories, proving
the exit-hook mechanism (shared with M4 via the now-exported
`SUITE_TMPDIR`) closes the leak even under this exact failure path, not
merely on the happy path a simpler test might have exercised.

Every mutation above was confirmed applied (via the failing test's message
matching the intended defect), confirmed reverted (via `git diff --stat`
on the touched file showing only the intended, committed change, and via
snapshot `cp` rather than `git checkout --` throughout), and the full
suite re-run green after each revert -- 195/195 as of the last commit in
this round.

## Review remediation round 3b (proof 74) -- proof 70's rollback retracted

A confirming re-review (lens-data; security, qa and reviewer-verification
all CLEAN) found that proof 70's own rollback -- `fs.ftruncateSync(fd,
stats.size)` on a detected short write, added in round 3 to prevent a
short write from leaving a torn trailing line -- introduced a NEW, worse
defect: `stats.size` is captured by `fstat` BEFORE this writer's own
write attempt, and under the concurrent-writer design AC-DATA-3 requires
(direct invocations, no locking, many processes appending to the same
file), another writer can complete a full `O_APPEND` write in the window
between this writer's `fstat` and its `ftruncate`. The rollback then
truncates the file back to that stale, pre-race size -- deleting the
OTHER writer's already-committed record, a record whose write already
returned `write_ok:true` to its own caller. This is worse than the
torn-line problem the rollback was added to solve: instead of losing only
the interrupted writer's own record, it can silently destroy a third
party's successful one.

**Disposition (§12: a change reverted for being worse keeps the simpler
original): proof 70's rollback is retracted, not merely mutated again --
the `ftruncateSync` call is deleted outright.** The short write is still
detected and reported as `write_ok:false` to the caller (so the run is
correctly recorded as failed, not falsely successful), but the file is no
longer touched to "repair" it. Any partial bytes the failed write did
leave behind are a self-inflicted torn trailing line -- exactly the
pre-existing, already-tolerated case (AC-DATA-5) the heal from proof 68
already fixes on the next append. No locking was added: the fix removes
the unsafe mutation rather than making it safe, per the coordinator's own
instruction, because adding a lock around fstat-through-ftruncate would
undermine the entire lock-free, concurrent-writers-by-design point of the
plain `O_APPEND` approach.

**74. Concurrency: a short write must never destroy a concurrent writer's
already-committed record.** New test drives two real, separately spawned
processes against the same ledger: writer A, constrained via a calibrated
`ulimit -f` (confirmed, as in proof 69, to produce a genuine short
`fs.writeSync` return on this platform rather than an exception); writer
B, an ordinary unconstrained writer, fired 100ms after A starts. Because a
microsecond-scale OS race cannot be relied on to land reliably in a fast,
portable test, `LEDGER_APPEND_TEST_RACE_WINDOW_MS` (a no-op unless this
exact env var is set; never set outside this test) widens the window
between writer A's `fstat` and its write/short-write handling to 300ms,
giving writer B a generous, reliable interval to land its own committed
write inside it.

- **Against the round-3 code (rollback present, confirmed BEFORE removing
  it):** ran 3 times, failed all 3 times for the identical reason --
  writer B's record (`run_id: "writer-b-committed-record"`), already
  reported `write_ok:true` to its own caller, was absent from the ledger
  after writer A's rollback truncated it away. Reproduces the finding's
  own evidence exactly (writer A's stale `fstat` size wins over writer
  B's real, later-landed record).
- **Fix applied (the `ftruncateSync` call deleted).**
- **After the fix:** ran 4 times, passed all 4 times. Writer A still
  correctly reports `write_ok:false` (the short write is still detected
  and surfaced to its caller); writer B's committed record survives
  intact every time.
- **Mutation-proof (formal round-trip, in addition to the natural
  before/after above):** reintroduced the `ftruncateSync` call as an
  explicit mutation into the already-fixed file. The concurrency test
  failed for the identical reason. Reverted from a snapshot copy (never
  `git checkout --`) and confirmed restored via `git diff --stat`.

The single-writer short-write test from proof 69 was updated in the same
change: its old assertion ("a rejected short write must never leave a
torn, unparseable trailing line") encoded the ROLLBACK's behaviour and is
no longer true by design -- a short write may now leave a torn trailing
fragment, which is accepted and left to the next append's heal (proof 68)
to fix, not repaired at write time. The assertion was removed, not
weakened silently: the reasoning is recorded in the test's own comment.

Full suite re-run green after the fix (196/196: 195 from round 3 plus this
one new concurrency test), and again after the mutation-proof revert.

## Caveat

Seventy-three proofs across four passes cover the guards judged
highest-risk (data integrity, injection safety, the single-write-path
invariant, the RED/GREEN control-flow invariant, null-vs-zero telemetry
correctness, and every finding from three full multi-lens reviews) rather
than every assertion in the suite. Genuine findings are left in this
document rather than quietly fixed and forgotten, because a surviving
mutant that gets patched without a record is exactly the kind of
near-miss this process exists to catch: mutation #5 (the original RED-gate
two-condition gap), the M2 byte-truncation test's own first version
(documented under proofs 31-33), which was itself a surviving mutant
against a single-field fixture before being strengthened to a genuinely
discriminating two-field one; from round 2, the L2 submodule test and L3
static-doc test near-misses documented under proofs 58 and 59, both caught
and fixed before being trusted by reading the actual evidence (a real
bogus directory tree on disk; the raw file with its line wrap intact)
rather than assuming the fixture or the regex was correct; and from round
3, proof 69's short-write test, whose first draft (a 500-byte truncated
`task` field under `ulimit -f`) never actually exceeded the smallest tried
block limit's floor and so never reproduced a short write at any size
tried at all -- caught by checking the calibration actually found a
value, not by assuming a small `ulimit` number would obviously be small
enough.

One genuine limitation, stated rather than worked around: proof 69/70's
short-write path could not be tested via a real full disk (not
constructible in this sandbox), so `ulimit -f` (RLIMIT_FSIZE) was used
instead, confirmed empirically first to produce the same observable
behaviour (a real short `fs.writeSync` return, not an exception) on this
platform before being trusted as a stand-in for ENOSPC. This is close to
the real failure mode but is not literally the same kernel code path, and
was not verified on any platform other than the one this session ran on.
