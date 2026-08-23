# HARN-FIX-3 (task 2 of 2): staleness check mutation proofs

Scope: `AC-OPS-1` through `AC-OPS-5`, `AC-ARCH-2` from `specs/harn-fix-3.md`.
`AC-ARCH-1`, `AC-ARCH-3`, `AC-QA-1` through `AC-QA-5` and `AC-SIMP-1` through
`AC-SIMP-3` belong to task 1 and are covered in
`docs/install-consistency-mutation-proofs.md`, not here.

**Editorial note added by task 1's agent, 2026-08-23, surgical (this
section only -- nothing else on this page was touched):** round-one review
found the stamp mechanism this page's sections 7-8 test (`AC-ARCH-2`,
`AC-ARCH-3`, `SOURCE_COMMIT`) generated permanent false drift and could leak
unstaged edits into a commit. `specs/harn-fix-3.md` now withdraws
`AC-ARCH-1`/`AC-ARCH-2`/`AC-ARCH-3` outright (not deferred) in favour of
`AC-ARCH-4`: no such mechanism may exist at all. The two tests sections 7-8
describe below (`weekly runner (AC-ARCH-2/AC-ARCH-3)` and
`weekly runner (AC-ARCH-2)`) and the `INSTALL_SOURCE_COMMIT`/
`install_source_commit=` fields in `bin/optimise-cycle-weekly.sh` they
exercised have been deleted from the shipped test suite and script as part
of that withdrawal. This page's narrative below is left AS WRITTEN -- an
accurate historical record of what this round's own mutation testing
observed at the time -- rather than rewritten or deleted, since the defect
those tests found in their own fixture (section 8) and the mutation
coverage they proved (section 7) are still true statements about the code
as it existed then. Treat any reference below to `AC-ARCH-2`, `AC-ARCH-3`,
or the two named tests as historical, not current.

Per standard §11: every mutation below was actually applied to the working
file (never "mentally mutated"), confirmed landed on the intended construct
by `diff` against a `cp` snapshot taken before any mutation began (never
`git checkout --`, which this repo's own hook refuses), run against the
relevant test file(s), the exact failing set recorded, then restored from
the snapshot and reconfirmed byte-identical and green before the next
mutation. Mutations were applied one at a time, never stacked.

Snapshots: `cp workflows/lib/install-consistency.mjs
/tmp/mutation-snapshots-harnfix3/install-consistency.mjs.orig` and the
equivalent for `bin/optimise-cycle-weekly.sh`, taken once, immediately
before mutation testing began (after the full task-2 implementation was
green), and restored from after each mutation below.

## 1. `checkStaleness()`'s drift-detection comparison (`install-consistency.mjs`)

**Guarded by**: `test/install-consistency.test.js`'s `checkStaleness`/CLI
tests.

**Mutation**: the content-comparison line --

```js
if (!installContent.equals(publishedContent)) drifted.push(rel)
```

-- had `false &&` prepended, so a published file can never be reported
drifted regardless of its install-side content.

**Confirmed landed**: `diff` against the snapshot showed exactly the one
intended line changed.

**Result**: exactly 3 of 40 tests in `test/install-consistency.test.js`
failed --

```
✖ checkStaleness reports a published file with DIFFERENT content in the install as drifted, naming it
✖ checkStaleness reads only -- never writes, creates or deletes anything in EITHER directory it is given (AC-OPS-2)
✖ CLI --check-staleness prints one line of JSON matching checkStaleness()'s own result, ok:true when files were actually compared
```

(The AC-OPS-2 test also asserts `result.drifted.length > 0` as a sanity
check that the run genuinely found drift before checking the hashes stayed
unchanged, so it fails on this mutation too -- correctly, since a
comparison that can never report drift is not proving AC-OPS-2 against a
drift-reporting run at all.)

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical, both
`install-consistency.test.js` (40/40) and `weekly-runner.test.js` back to
green.

## 2. The anti-vacuity `blind` guard (`checkStaleness()` in `install-consistency.mjs`)

**Guarded by**: the ANTI-VACUOUS unit test, the CLI blind test, and (at the
full end-to-end level) the weekly-runner anti-vacuity test below.

**Mutation**: --

```js
const blind = publishedFiles.length === 0
```

-- replaced with `const blind = false`, unconditionally.

**Confirmed landed**: `diff` showed exactly the one intended line changed.

**Result at the unit/CLI level**: exactly 2 of 40 `install-consistency.test.js`
tests failed --

```
✖ checkStaleness is ANTI-VACUOUS -- an empty published tree (zero subset files found) reports blind:true, never "no drift" ...
✖ CLI --check-staleness reports ok:false (never ok:true) when it is blind ...
```

**Result at the full end-to-end level** (same mutation, still live, run
against `test/weekly-runner.test.js`): 1 additional test failed --

```
✖ weekly runner (anti-vacuity, end to end): a "published" remote that clones successfully but has ZERO
  consumer-subset files is reported could-not-check, never as a clean "no drift" -- the guard that finds
  nothing and calls that clean is the failure shape this repo has hit before
```

The failure output showed the exact false-clean shape the guard exists to
prevent: `"published_files_checked":0,"blind":false` logged as `STALENESS
ok`, i.e. a comparison that looked at nothing would have been reported as a
clean pass all the way through to the operator-facing log line, without
this guard.

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical, both
test files back to green (40/40 and 41/41 respectively).

## 3. Directory-prefix pattern matching (`matchesPattern()` in `install-consistency.mjs`)

**Guarded by**: `isConsumerSubsetPath`'s boundary test, specifically its
`workflows/lib_notreally/x.js` case.

**Mutation**: --

```js
if (pattern.endsWith('/')) return relPath === pattern.slice(0, -1) || relPath.startsWith(pattern)
```

-- replaced with the naive, bare-string-prefix form --

```js
if (pattern.endsWith('/')) return relPath.startsWith(pattern.slice(0, -1))
```

This is the exact bug class CLAUDE.md's engineering standards name from
this repo's own history (a `stat -f` chained on exit status, a `workflows/
lib` prefix that would also match a differently-named sibling directory):
`'workflows/lib_notreally/x.js'.startsWith('workflows/lib')` is `true`
under the naive form, even though `workflows/lib_notreally/` is not
`workflows/lib/` at all.

**Confirmed landed**: `diff` showed exactly the one intended line changed.

**Result**: exactly 1 of 40 tests failed --

```
✖ isConsumerSubsetPath matches every pattern shape (literal, single-segment glob, directory prefix at any
  depth) and rejects a user-owned file the repo does not ship
```

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical, back
to 40/40.

## 4. AC-OPS-5's single-definition-site static guard (`test/static-checks.test.js`)

**Guarded by**: the test itself, proven load-bearing by introducing the
exact violation it exists to catch.

**Mutation**: appended a genuine second literal copy of the distinguishing
pattern string to `bin/optimise-cycle-weekly.sh` --

```sh
# duplicate for mutation test: 'agents/lens-*.md'
```

**Confirmed landed**: the line was appended to the real file (not a
snapshot copy); `diff` against the snapshot showed exactly the one
intended line added.

**Result**: the AC-OPS-5 test failed, reporting `bin/optimise-cycle-
weekly.sh` as an unexpected second definition site alongside
`workflows/lib/install-consistency.mjs`:

```
✖ static: the consumer-subset pattern list (AC-OPS-5, ...) has exactly one definition site ...
  AssertionError: Expected values to be strictly deep-equal:
  + actual - expected
    [
      'workflows/lib/install-consistency.mjs',
  +   'bin/optimise-cycle-weekly.sh'
    ]
```

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical,
`bash -n` syntax-checked, suite back to green.

## 5. AC-OPS-3's "never fails the run" invariant (`bin/optimise-cycle-weekly.sh`)

**Guarded by**: nearly every test in `test/weekly-runner.test.js` (the
default `NO_STALENESS_REMOTE` test seam means every pre-existing test in
the file exercises this exact clone-failure branch), plus the two
dedicated AC-OPS-3 tests directly.

**Mutation**: added `overall_fail=1` immediately after the clone-failure
log line --

```sh
log_staleness could-not-check '{"error":"git clone of the staleness remote failed"}'
overall_fail=1
```

**Confirmed landed**: `diff` showed exactly the one intended line added.

**Result**: 19 of 41 tests in `test/weekly-runner.test.js` failed,
including tests with no connection to staleness at all (e.g. "healthy run
-- PASS, exit 0", "a directory that is not a git repo is skipped") --
because every one of them runs with the default nonexistent staleness
remote and, under this mutation, a staleness check that could not run now
fails the ENTIRE weekly run regardless of what any delivery repo did. This
is the load-bearing proof for AC-OPS-3's "does not fail the weekly run":
with the guard removed, a routine, expected, warn-only condition (no
network, or an install not yet configured) turns nearly every real
production run into a false FAIL.

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical,
`bash -n` syntax-checked, suite back to 41/41.

## 6. AC-OPS-1's once-per-invocation placement (`bin/optimise-cycle-weekly.sh`)

**Guarded by**: the "exactly one drift report ... regardless of how many
delivery repos are configured" test (2 repos configured) and, as a
negative control, the "with ZERO delivery repos configured" test.

**Mutation**: added an extra `log_staleness` call inside the `for repo in
...` loop body, immediately after `repo_label=...` is assigned --

```sh
repo_label="$(basename "$repo")"
log_staleness ok '{"drift":[],"mutation":"per-repo bug"}'
```

-- simulating the exact defect AC-OPS-1 exists to prevent: the staleness
report firing once per delivery repo instead of once per invocation.

**Confirmed landed**: `diff` showed exactly the one intended line added.

**Result**: exactly 2 of 41 tests failed --

```
✖ weekly runner (AC-OPS-1/AC-OPS-4): a fixture install with one modified file produces exactly one drift
  report naming that file, regardless of how many delivery repos are configured
✖ weekly runner (anti-vacuity, end to end): ...
```

The second failure is incidental (that test's single configured repo means
the mutation adds a second, differently-shaped `STALENESS ok` line, which
trips the `!/^STALENESS ok /m.test(...)` assertion) rather than a direct
AC-OPS-1 proof, but it is still a genuine, correctly-triggered failure.
The "ZERO delivery repos configured" test, which loops zero times, did
**not** fail under this mutation -- expected and correct, since a mutation
placed inside the loop body cannot fire when the loop never executes; this
is the intended negative control confirming the surviving test targets
loop-count specifically, not some unrelated staleness behaviour.

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical,
`bash -n` syntax-checked, suite back to 41/41.

## 7. Drift visibility: the stderr line (coordinator review, 2026-08-23)

Follow-up round, after the coordinator drove the real script through four
scenarios and found one genuine defect: drift was recorded in the log but
invisible on stderr, and the log line's human-scannable prefix
(`STALENESS ok ...`) was identical for a clean install and a genuinely
drifted one -- the CLI's `ok` field means "the check ran without error",
not "no drift found". Fixed by (a) a three-way status token (`ok` /
`drift` / `could-not-check`, JSON tail unchanged) and (b) one stderr line
on `drift`, naming the log path and a drifted/missing COUNT, never the
file list. `overall_fail` is deliberately untouched -- this is a
visibility fix, not a behaviour-failing one.

**Guarded by**: the new dedicated test ("a run that reports drift ALSO
prints one line to stderr...") plus, for the dispatch logic itself, the
three tests requiring a genuine `ok` verdict.

**Mutation A (the stderr line itself)**: the `echo "weekly optimise-cycle:
consumer install drift ($drift_summary) -- see $LOG" >&2` line was replaced
with a no-op (`: # mutation: drift stderr line silenced`).

**Confirmed landed**: `diff` against a snapshot taken immediately before
this mutation showed exactly the one intended line changed.

**Result**: exactly 1 of 42 tests in `test/weekly-runner.test.js` failed --
the new dedicated drift-visibility test, and only it:

```
✖ weekly runner (drift visibility, coordinator ruling 2026-08-23): a run that reports drift ALSO
  prints one line to stderr naming the log path and a count, never the file list -- "recorded but
  invisible" (log-only) is the exact defect this closes
```

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical,
`bash -n` syntax-checked, suite back to 42/42.

**Mutation B (the three-way dispatch pattern)**: the case pattern deciding
"clean" --

```sh
*'"drift":[]'*) log_staleness ok "$result_json" ;;
```

-- had its match target replaced with a string that can never appear
(`*'"drift":[MUTATED-NEVER-MATCHES]'*`), so a clean, non-drifted result can
no longer reach the `ok` branch and falls through to `drift` instead.

**Confirmed landed**: `diff` against a fresh snapshot showed exactly the
one intended line changed.

**Result**: exactly 3 of 42 tests failed -- every test that requires a
genuinely clean `STALENESS ok` verdict on an install with no drift at all:

```
✖ weekly runner (AC-OPS-4): an identical install reports no drift -- STALENESS ok, drift:[]
✖ weekly runner (AC-ARCH-2/AC-ARCH-3): the installed AGENT-HARNESS.md's SOURCE_COMMIT stamp is
  reported BOTH on the run header line and on the staleness check's own report line
✖ weekly runner (AC-ARCH-2): when the install has no readable stamp at all, both lines say "unknown"
  rather than a stale or fabricated value
```

The three drift-specific tests (which WANT a `drift` token) correctly did
**not** fail under this mutation, since forcing every result through the
`drift` branch cannot break a test that already expects `drift` -- the
correct, silent negative control.

**Reverted**: `cp` from the snapshot, `diff` confirmed byte-identical,
`bash -n` syntax-checked, suite back to 42/42.

## 8. The AC-ARCH-2 stamp test's own fixture defect, found by this review

Not a mutation of the shipped code -- a defect this round's own review
found in a TEST fixture, recorded per standard §11 for the same reason
task 1's mutation-proofs doc records the bugs its own process caught: a
report that only lists successful mutation proofs and omits what the
process actually caught during development would be misleading about how
this file was produced.

The original AC-ARCH-2/AC-ARCH-3 stamp test stamped only the INSTALL's
`AGENT-HARNESS.md` (`<!-- SOURCE_COMMIT: ... -->\nharness contract\n`)
while the published fixture's `AGENT-HARNESS.md` stayed unstamped
(`harness contract\n`). Those two files genuinely differ, which is real
drift -- so before this round's `ok`/`drift` split existed, the test's
`assert.match(logContents, ... 'STALENESS ok ...')` was passing on a run
that, correctly diagnosed, should have said `STALENESS drift`. It is the
same "STALENESS ok" collapsing every non-error outcome into one word that
this whole round exists to fix, just caught inside a test fixture rather
than the shipped script. Fixed by stamping the PUBLISHED fixture's
`AGENT-HARNESS.md` identically to the install's, so the test isolates
stamp-reporting from drift status rather than accidentally exercising both
at once.

## Full-suite re-run after all mutations

`node --test test/*.test.js`, run three consecutive times after every
mutation in sections 1-6 was reverted and confirmed byte-identical against
its snapshot: **926/926, 926/926, 926/926** (no flakiness observed across
repeated runs, relevant here because this task's tests spawn real
subprocesses -- `git clone`, `node`, the weekly script itself -- rather
than only exercising in-process code).

After the coordinator's 2026-08-23 drift-visibility follow-up (sections 7-8
above), re-run three more consecutive times, every mutation there reverted
and confirmed byte-identical: **927/927, 927/927, 927/927** (one net new
test: the drift-visibility stderr test).
