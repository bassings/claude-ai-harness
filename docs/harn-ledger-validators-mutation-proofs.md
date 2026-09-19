# specs/harn-ledger-validators.md -- mutation proofs

## Scope

This document covers the guards **fix round 3** added or changed on
`fix/ledger-validators-discard-valid-data`: the round-2 review's H1-H4,
M1-M6 and L1-L2/L4 findings (M2/L3 are single-definition-site refactors,
covered below by regression evidence rather than a behavioural mutation).
It does not re-verify guards from fix rounds 1 and 2 (the original D1-D4
validator work, the `findings_by_lens` tally, the no-spec reclassification
itself) -- those were not touched by this round's own changes, and this
round did not re-run their mutations. A fuller retrospective covering the
whole branch, if wanted, is a separate task from closing round 2's own
findings.

Per standard §11: every mutation below was actually applied to the working
file, confirmed to fail for the stated reason, then restored and confirmed
byte-identical by `diff` against the file as it stood before the mutation
(never `git checkout --`). Where the guard is a genuinely new test added
this round (rather than an existing test whose target this round changed),
the RED evidence is the test failing against the pre-fix code, and GREEN is
the same test passing once the fix landed -- the TDD record already is the
mutation proof for a construct that did not exist to mutate beforehand.

## 1. H1 -- the byte-rescue loop shrinks `ac_verdicts` before the envelope collapse

**Guarded by**: `test/ledger-append.test.js`, "a worst-case round (8 lenses,
MAX_FINDINGS findings, MAX_AC_VERDICTS verdicts of the widest accepted
prefixed form) does not collapse to the envelope-only form".

**RED**, against the pre-fix code (the byte-rescue loop only ever shrank
`findings`):

```
AssertionError [ERR_ASSERTION]: the record must not collapse to the
envelope-only form -- lenses_run, verdicts and findings_by_lens must all
survive
    actual: false
    expected: true
```

**GREEN**, after extending the loop to shrink `ac_verdicts` (recording the
loss in `ac_verdicts_truncated`) before the minimal-envelope fallback:
`node --test test/ledger-append.test.js` -- 256/256 passing, including the
new test.

## 2. M6 -- the AC-SEC-4 ReDoS guard can now fail on a nested quantifier

**Guarded by**: `test/ledger-append.test.js`, "the pattern stays linear
against inputs AMBIGUOUS for a nested/optional-separator quantifier, with a
growth bound between lengths". This is a NEW test, added this round because
the existing AC-SEC-4 test's hostile input (`'A-'.repeat(n/2)`) is an
unambiguous match for a nested-quantifier candidate and cannot trigger
catastrophic backtracking.

Snapshot taken first (`cp workflows/lib/ledger-append.mjs
/tmp/ledger-append.mjs.bak`).

**Mutation**: `AC_ID_PATTERN_STR` replaced with the nested-quantifier shape
the round-2 report itself measured as dangerous:

```js
export const AC_ID_PATTERN_STR = '^([A-Za-z0-9]+[-/ ]?)*AC-[A-Z0-9]+-[0-9]+$'
```

**Result**, running the new test in isolation (the full file was not run
against this mutation: several other, unrelated fixtures in the same file
also feed long hostile strings through this pattern, and against a
catastrophic-backtracking mutant those would not finish in a reasonable
time -- the point of this proof is that THIS guard fails, not that the
whole suite survives a known-dangerous regex):

```
AssertionError [ERR_ASSERTION]: "AAAAAAAAAAAAAAAAAAAAAAAAAA!" (length 26)
took 33.221ms, over the 10ms bound
```

Restored via `cp /tmp/ledger-append.mjs.bak workflows/lib/ledger-append.mjs`;
`diff` against the backup reported no difference. `node --test
test/ledger-append.test.js` back to 257/257 green (256 plus the new test).

## 3. L2 -- accepted AC prefixes are derived from the shipped agents and specs

**Guarded by**: `test/ledger-append.test.js`, "every AC prefix actually used
across agents/lens-*.md and specs/*.md is accepted by the writer's
pattern". A new test: the previous accept-list (`NEW_AC_ID_ACCEPTS`) was
hand-picked, so a future lens whose prefix the pattern does not cover could
narrow the pattern with every existing test still green.

Snapshot taken first (same backup as above).

**Mutation**: `AC_ID_PATTERN_STR` narrowed back to the pre-D1 shape (blind
to a digit inside the lens segment, exactly the original defect this whole
spec exists to fix):

```js
export const AC_ID_PATTERN_STR = '^(?:[A-Za-z0-9_.-]{1,40}[ /])?AC-[A-Z]+-[0-9]{1,6}$'
```

**Result**:

```
AssertionError [ERR_ASSERTION]: AC-A11Y-1 (a prefix actually used in this
repo's own agents/specs) must be accepted by AC_ID_PATTERN_STR
```

Restored via `cp`; `diff` confirmed clean. `node --test
test/ledger-append.test.js` back to 258/258 green (with L2's own test also
in the file by this point).

## 4. H2 -- `fixed` findings read via `findings_by_lens` are deduped across rounds

**Guarded by**: `test/optimise-read.test.js`, "a fixed disposition read via
findings_by_lens is deduped across rounds the same way the per-finding
fallback path is, not double-counted". New test: the existing dedupe tests
all used fixtures without `findings_by_lens`, so they passed whether or not
the tally path applied the dedupe.

**RED**, against the pre-fix code (the tally path read `fixed` straight
from the per-lens counts, with no per-id dedupe available to it):

```
AssertionError [ERR_ASSERTION]: the same finding id confirmed fixed twice
across rounds must count once, even when both lines carry findings_by_lens

2 !== 1
```

**GREEN**, after skipping `fixed` in the tally loop and reading it instead
from the per-finding array through the existing dedupe-aware logic:
`node --test test/optimise-read.test.js` -- 169/169 passing.

## 5. M1 -- `spec_bug_count` is null on a no-spec run even when `spec_bugs` was empty

**Guarded by**: `test/review-cycle.test.js`, "when NO spec was in play and
synthesis returns an EMPTY spec_bugs array, spec_bug_count is null, not a
measured zero", plus the split "declares ... REQUIRED ... when NO spec is
in play" / "... when a spec IS in play" pair for the prompt/schema half.

**RED** (the count bug), against the pre-fix code (the null-out was gated
on `specBugsRaw.length > 0`):

```
AssertionError [ERR_ASSERTION]: null (not measured), never 0 -- an empty
spec_bugs array on a no-spec run is the SAME "not measured" case as a
populated one

0 !== null
```

**RED** (the conditional-schema half), against the pre-fix code (`required`
always included `spec_bugs`):

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
  [
    'rejected_findings',
    'report',
+   'spec_bugs'
  ]
```

**GREEN**, after making the null-out unconditional on `noSpecWasInPlay` and
the prompt clause/schema `required` entry conditional on a spec being in
play: `node --test test/review-cycle.test.js` -- 188/188 passing.

## 6. H3 -- truncation counters are summed, a truncated window taints `never_failed`, and the report renders both

**Guarded by**: `test/optimise-read.test.js`'s H3 tests (sums,
`neverFailingAcs` taint, "not over-broad", "backward compatible") and
`test/optimise-cycle.test.js`'s H3 render tests ("None recorded" carries
`invalid_ac_ids_dropped"; "Rework attribution" carries the three drop
counts; the clean-zero case; the stale-reader "unavailable" case).

**RED** (reader sums), against the pre-fix code (the fields were written by
the ledger writer and read by nothing):

```
AssertionError [ERR_ASSERTION]: expected values to be strictly equal
    actual: undefined
    expected: 0
```

(one such failure per new field: `findingsTruncated`, `acVerdictsTruncated`)

**RED** (the taint), against the pre-fix code (`neverFailingAcs` had no
`truncatedBuckets` option):

```
AssertionError [ERR_ASSERTION]: a truncated verdicts array in this window
could have dropped the FAIL

'false' !== 'null' (never_failed)
```

**RED** (the render layer), against the pre-fix code (the section existed
but never named the drop counts):

```
AssertionError [ERR_ASSERTION]: expected findings_truncated=12 in the
section, got:
## Rework attribution (source: ledger)
- lens-qa: fixed=0, rejected=1, spec_bug=0, open=2
```

**GREEN**, after the reader-side sums/taint and the render-layer additions:
`node --test test/optimise-read.test.js test/optimise-cycle.test.js` --
178/178 and 103/103 passing respectively.

## 7. H4 -- no-spec review runs and their reclassified findings are counted and rendered

**Guarded by**: `test/optimise-read.test.js`, "aggregateRework counts
no-spec review runs and the findings reclassified on them" (plus the
findings_by_lens variant), and `test/optimise-cycle.test.js`'s "Rework
attribution names no-spec review runs ... as their own line" (plus the
clean-zero case).

**RED** (reader), against the pre-fix code:

```
AssertionError [ERR_ASSERTION]: exactly one record had no spec in play

undefined !== 1
```

**RED** (render), against the pre-fix code (no such line existed):

```
AssertionError [ERR_ASSERTION]: expected a line naming no-spec review runs,
report was:
...
```

**GREEN**, after `noSpecReviewRuns`/`noSpecFindingsReclassified` were added
to `aggregateRework`'s return and rendered: same suite runs as item 6,
178/178 and 103/103 passing.

## 8. M3 -- findings tallied under the writer's `unattributed` sentinel are counted

**Guarded by**: `test/optimise-read.test.js`, "findings tallied under the
writer's unattributed sentinel are counted, not silently dropped", plus a
hostile-key control ("a hostile key that merely fails LENS_RE ... is still
NOT counted as unattributed") proving the fix recognises the EXACT sentinel
by string equality, not merely "anything that fails the lens pattern".

**RED**, against the pre-fix code (the `LENS_RE` gate dropped the sentinel
bucket uncounted):

```
AssertionError [ERR_ASSERTION]: both the open and rejected counts under the
sentinel must be counted

undefined !== 6
```

**GREEN**, after the reader recognised `UNATTRIBUTED_LENS` (imported from
`ledger-append.mjs`) by exact string comparison and summed it into a new
`unattributedFindings` counter, on both the tally and per-finding fallback
paths: `node --test test/optimise-read.test.js` -- 178/178 passing. The
hostile-key control stayed green throughout (it asserts a NEGATIVE: a
value that is not the sentinel must not be counted), confirming the fix
does not fold every `LENS_RE` failure into this bucket.

## 9. L1 -- the installer's destination-safety guard is on by default

**Guarded by**: `test/install-sync.test.js`, "refuses an unfamiliar
destination by DEFAULT -- no environment variable set at all, matching
production".

**RED**, against the pre-fix code (`${HARNESS_INSTALL_REQUIRE_MARKER:-0}`):

```
AssertionError [ERR_ASSERTION]: the default path (no env var set) must
refuse an unfamiliar destination, matching what a real operator actually
runs
    actual: 0
    expected: 0
    operator: '!='
```

(the installer exited 0 and wrote its files; the assertion is on `status
!= 0`, so `0 != 0` failing is the guard NOT firing)

**GREEN**, after flipping the default to `${HARNESS_INSTALL_REQUIRE_MARKER:-1}`:
`node --test test/install-sync.test.js` -- 9/9 passing at the time (later
11/11 once M4's tests were added).

## 10. M4 -- `install.sh --check` calls `checkStaleness()` instead of a second drift detector

**Guarded by**: `test/install-sync.test.js`, "--check does not report drift
when an OPTIONAL consumer-subset file is absent from the destination".

**RED**, against the pre-fix code (the shell loop counted any missing
destination file as drift, optional or not):

```
AssertionError [ERR_ASSERTION]: --check must still pass with an optional
file missing, matching checkStaleness's own exemption:
missing: bin/optimise-cycle-weekly.sh
missing: bin/redact-transcript.mjs
missing: hooks/hooks.json
install --check: 3 file(s) drifted or missing in <tmp>. Run bin/install.sh
```

**GREEN**, after `--check` was rewritten to call `checkStaleness(repo,
dest)` directly: `node --test test/install-sync.test.js
test/install-consistency.test.js` -- 11/11 and 67/67 passing.

## 11. M2/L3/L4 -- single definition sites (regression evidence, not a behavioural mutation)

These are structural refactors (named groups on `AC_ID_PATTERN_STR` reused
by `stripOwnSpecPrefix`; `DISPOSITIONS` and `UNATTRIBUTED_LENS` exported and
reused; `wasNoSpecInPlay` exported and reused by the reader), not new
behaviour, so there is no "break it and watch it fail" mutation to record
in the same shape as the items above -- the property being proven is "no
behaviour change for any currently-accepted form", which a passing suite
demonstrates directly.

**Regression evidence**: `node --test test/ledger-append.test.js
test/optimise-read.test.js` -- 424/424 passing both before and after the
refactor, including a new `stripOwnSpecPrefix` test covering every
prefixed-accept-form shape (space- and slash-separated, including a
hyphen-and-digit-bearing spec basename).

**Single-source proof actually executed**: widened `AC_ID_PATTERN_STR`'s
prefix bound from 40 to 60 characters and confirmed, via a one-off Node
script against `aggregateRework`, that a 50-character prefix (over the old
bound, under the new one) stripped correctly with ZERO change to
`optimise-read.mjs` -- the reader picked up the wider bound automatically
because it now reads the same pattern the writer exports, rather than its
own independent copy. Reverted; `diff` against the pre-widen file reported
no difference.

## Full-suite result after all restores

`node --test test/*.test.js`: 1263/1263 passing at the close of this fix
round, run three times with no flake observed (see the round's final gate
for the third and fourth runs). `python3 -m unittest discover -s hooks -p
'test_*.py'` is unaffected by this round: `hooks/` was out of bounds for
this task (a parallel branch owns those files), and no test under `hooks/`
was added, removed or edited.
