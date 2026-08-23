# HARN-FIX-3 (task 1 of 2): version stamp + consistency check mutation proofs

Scope: `AC-ARCH-1`, `AC-ARCH-3`, `AC-QA-1` through `AC-QA-5`, `AC-SIMP-1`
through `AC-SIMP-3` from `specs/harn-fix-3.md`. `AC-OPS-*` and `AC-ARCH-2`
(the staleness check in `bin/optimise-cycle-weekly.sh`) belong to a separate
task and are not covered here.

Per standard §11: every mutation below was actually applied to the working
file (never "mentally mutated"), confirmed landed on the intended construct
by `diff` against a `cp` snapshot taken before the edit (never `git checkout
--`, which this repo's own hook refuses), run against the suite, the exact
failing set recorded, then restored from the snapshot and reconfirmed
byte-identical and green before the next mutation. Mutations were applied
one at a time, never stacked.

Two bugs were found and fixed by this process, not merely by reading the
code -- both are recorded in their own section below, because a report that
only lists successful mutation proofs and omits what those proofs actually
caught during development would be misleading about how this file was
produced.

## 1. The workflow-level refuse gate (`plan-cycle.js`)

**Guarded by**: the three `AC-QA-1/AC-QA-2` tests added to
`test/plan-cycle.test.js` (inconsistent, blind, and consistency-field-absent
cases).

**Mutation**: `workflows/plan-cycle.js`'s gate --

```js
if (!scope.consistency || scope.consistency.blind || scope.consistency.consistent !== true) {
  throw installConsistencyError(scope.consistency)
}
```

-- had `false &&` prepended to the condition, so it can never fire.

**Confirmed landed**: `diff` against the pre-mutation `cp` snapshot showed
exactly the one intended line changed.

**Result**: exactly 3 of 33 tests in `test/plan-cycle.test.js` failed, all
and only the three `AC-QA-1/AC-QA-2` tests --

```
✖ plan-cycle.js: AC-QA-1/AC-QA-2 -- an inconsistent installed harness (scope.consistency.consistent:false) refuses BEFORE dispatching any lens...
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ plan-cycle.js: AC-QA-1/AC-QA-2 -- blind:true ... is treated exactly like inconsistent...
✖ plan-cycle.js: AC-QA-1/AC-QA-2 -- a scope response missing the consistency field entirely ... refuses rather than assuming clean
```

This is the AC-QA-5 proof for the consistency check's specific wording
("removing the consistency check leaves a mismatched fixture passing"): with
the gate disabled, the mismatched fixture's `runWorkflow()` call resolved
instead of rejecting -- lenses would have dispatched against a mismatched
install.

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical, suite
back to 33/33.

## 2. The workflow-level refuse gate (`review-cycle.js`)

**Guarded by**: the equivalent three `AC-QA-1/AC-QA-2` tests in
`test/review-cycle.test.js`.

**Mutation**: the mirrored gate in `workflows/review-cycle.js` --

```js
if (scope && (!scope.consistency || scope.consistency.blind || scope.consistency.consistent !== true)) {
```

-- had `false &&` prepended immediately after the opening `if (`.

**Confirmed landed**: `diff` against the snapshot showed exactly the one
intended line changed.

**Result**: exactly 3 of 84 tests failed, all and only the three
`AC-QA-1/AC-QA-2` tests for `review-cycle.js`. The gate is also placed
BEFORE the "no changes found" no-op short-circuit, which one of the three
tests exercises directly (an inconsistent install with `files: []` still
refuses, rather than short-circuiting to a silent no-op before the check
runs).

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical, suite
back to 84/84.

## 3. `checkConsistency()`'s verdict computation (`workflows/lib/install-consistency.mjs`)

**Guarded by**: `test/install-consistency.test.js`'s direction-1,
direction-2 and anti-vacuity tests, plus the two `main()`/CLI tests that
depend on the same computation.

**Mutation**: replaced --

```js
const consistent =
  !blind && missingInReviewSchema.length === 0 && missingInPlanSchema.length === 0 && reviewOnlyProps.length === 0 && planOnlyProps.length === 0
```

-- with `const consistent = true`, unconditionally.

**Confirmed landed**: `diff` against the snapshot showed exactly the
intended two-line statement replaced by the one-line hardcode.

**Result**: exactly 7 of 69 tests failed across
`test/install-consistency.test.js` and `test/static-checks.test.js`
combined --

```
✖ checkConsistency (direction 1, H3's own shape) reports the field missing from REVIEW_SCHEMA...
✖ checkConsistency (direction 1, repeated on PLAN_SCHEMA) reports the field missing from PLAN_SCHEMA...
✖ checkConsistency (direction 2, the "vice versa") reports a schema property nothing documents or instructs
✖ ANTI-VACUITY -- an AGENT-HARNESS.md with no ### FINDINGS heading at all is reported blind:true and consistent:false...
✖ ANTI-VACUITY -- a workflow source where the named schema const does not exist ... is reported blind:true...
✖ main() reports consistent:false and names the field when the installed schema is missing an instructed field...
✖ the CLI (spawned as a real subprocess) reads the fixture directory ... and two different fixtures produce two different, correct answers
```

Notably, `test/static-checks.test.js`'s refactored H3 test (which now calls
this same function against the REPO's own tree) did **not** fail under this
mutation: the repo's own tree is genuinely consistent, so `consistent: true`
by hardcode happens to agree with the true answer there. That test's own
assertions read the `missing_in_*`/`*_only_props` arrays directly (still
computed correctly by this mutation, since only the final boolean was
touched), so it is not blind to a real mismatch -- it is simply not the test
that exercises a mismatch case, which is exactly what the dedicated
`install-consistency.test.js` fixtures above are for. Recorded here rather
than omitted, per the standing rule that a mutation's *full* observed effect
matters, not just whether "some test" failed.

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical, both
files back to 69/69.

## 4. The byte-identical preflight-block guard (`test/static-checks.test.js`)

**Guarded by**: the new static test "HARN-FIX-3 -- the install-consistency
preflight block ... is byte-identical between plan-cycle.js and
review-cycle.js".

**Mutation**: in `workflows/review-cycle.js`'s copy of
`INSTALL_CONSISTENCY_INSTRUCTION` only, changed the substring "agrees with
itself" to "agrees with ITSELF-MUTATED", leaving `plan-cycle.js`'s copy
untouched.

**Confirmed landed**: `diff` against the snapshot showed exactly the one
intended substring changed, inside the prompt string, not a comment.

**Result**: exactly 1 of 43 tests in `test/static-checks.test.js` failed --

```
✖ static: HARN-FIX-3 -- the install-consistency preflight block ... is byte-identical between plan-cycle.js and review-cycle.js
  AssertionError [ERR_ASSERTION]: review-cycle.js's install-consistency preflight block has drifted from plan-cycle.js's
```

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical, suite
back to 43/43.

## 5. The pre-commit hook's staging step (`.githooks/pre-commit`)

**Guarded by**: `test/pre-commit-stamp.test.js`, executed against real,
throwaway git repos (never the live checkout).

**Mutation**: removed the `git add "$file"` line from the `stamp_md()`
shell function only (`stamp_js()` untouched), so `AGENT-HARNESS.md` is still
rewritten on disk but never staged into the commit.

**Confirmed landed**: `diff` against the snapshot showed exactly the one
intended line removed.

**Result**: exactly 1 of 8 tests failed --

```
✖ pre-commit: runs UNCONDITIONALLY -- a commit that only touches an unrelated file still re-stamps all three
  files to the NEW parent, and includes that re-stamp in the SAME commit even though only the unrelated
  file was staged by hand
  AssertionError [ERR_ASSERTION]: the unconditional hook must fold the re-stamp into the SAME commit as the
  unrelated change, even though only README.md was staged by hand
  + actual - expected
    [
  -   'AGENT-HARNESS.md',
      'README.md',
      'workflows/plan-cycle.js',
      'workflows/review-cycle.js'
    ]
```

**Known residual gap, surfaced rather than hidden**: the FIRST pre-commit
test ("stamps all three files with the value `git rev-parse HEAD`
reported...") did **not** fail under this mutation, because it reads the
stamp back via `fs.readFileSync` against the WORKING TREE, which the
mutated hook still rewrites correctly -- only the COMMITTED blob is stale
(the file is left modified-but-unstaged immediately after the commit
completes). One test catching a defect class is sufficient to prove the
guard load-bearing per AC-QA-5, but a reader should not conclude every test
in the file independently detects every mutation shape; they do not, and
this is the recorded example of why.

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical, suite
back to 8/8.

## Bugs found and fixed BY this mutation-testing process, not by reading

Both were caught because a test was written first, run, and its failure
message read carefully -- exactly the discipline this exercise exists to
enforce.

### Bug 1: `SOURCE_COMMIT_RE` did not match the real JS const form

`workflows/lib/install-consistency.mjs`'s original
`parseSourceCommitStamp()` used
`/SOURCE_COMMIT[:=]\s*['"]?([0-9a-f]{40})['"]?/` -- requiring `:` or `=` to
follow `SOURCE_COMMIT` with **no intervening space**. The real JS form,
`const SOURCE_COMMIT = '...'`, has a space before `=`, so the regex never
matched it; only the Markdown comment form (`SOURCE_COMMIT: ...`, colon
immediately adjacent) happened to match by coincidence of spelling. Caught
by `test/install-consistency.test.js`'s
"parseSourceCommitStamp reads the JS const form" test, which failed RED
before the fix (not skipped, not mentally verified). Fixed by widening to
`/SOURCE_COMMIT\s*[:=]\s*['"]?([0-9a-f]{40})['"]?/`.

### Bug 2: `git rev-parse HEAD`'s stdout on an unborn branch broke the null-sha fallback

The original hook used
`SHA=$(git rev-parse HEAD 2>/dev/null || echo <null-sha>)`. Measured
directly: on an unborn branch (the very first commit in a repo), `git
rev-parse HEAD` exits 128 but **still prints the literal token `HEAD` to
stdout** before failing (its best-effort echo of the unresolved revision).
Command substitution captures that stdout regardless of exit code, and `||`
then appends the fallback's output on a second line, leaving `SHA` as the
two-line string `"HEAD\n0000...0000"` -- which broke the `sed` calls with
`sed: unescaped newline inside substitute pattern` and failed the commit
outright. Caught by `test/pre-commit-stamp.test.js`'s "the very FIRST commit
in a repo (no parent at all)" test, RED before the fix. Fixed by checking
the command substitution's own exit status directly (`if SHA=$(git
rev-parse HEAD 2>/dev/null); then :; else SHA=<null-sha>; fi`), which
discards whatever the failed command printed rather than trusting it.

## Full-suite state around this work

902/902 (up from the 855/855 baseline at the start of this task), run three
times consecutively with no flakes, both before and after every mutation
above was reverted.
