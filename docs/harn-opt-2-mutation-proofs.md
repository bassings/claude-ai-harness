# HARN-OPT-2 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour was
actually broken (edited in the working file, not "mentally mutated"), the
suite was run, the exact failing test recorded, then the file was restored
(`cp` from a pre-mutation snapshot, never `git checkout --`, which reverts to
the last commit and can destroy uncommitted work), confirmed via
`diff <working-file> <snapshot>` returning nothing before the next mutation.
Full suite: `node --test test/*.test.js`. AC-SIMP-10 caps this file at 200
lines; later rounds compress earlier ones, never drop them. From review
round 2 on: every fix records whether `main` handled the same input correctly
and whether the fix preserves that.

## PR1 (plan-identity canonicalisation) -- condensed

Merged PR #3 (squash d6ada19), 5 fix / 4 review rounds. Root cause: write-time
redaction (lossy) conflated with canonicalisation. 21 load-bearing proofs
(`..`-escape detection, repo-identity fallback, orphan exclusion, ci_wait/
human_wait routing, the H-A/H-B/H-C round-5 fixes). Final suite: 405/405.

## PR2 initial build (start/terminal pairing) -- condensed

AC-QA-8/AC-OPS-1 exception guard; AC-OPS-2 terminal-only orphan class;
AC-DATA-10 pairing purity. 8 load-bearing proofs (byte-identity block +
re-throw line; return-count pin; the purity gate; start/terminal-only
counters; SIGKILL test proven non-vacuous). Final suite: 422/422.

## Review round 1 (5 lenses + adversarial, `main...3d33647`) -- condensed

3 High, 4 Medium, 5 Low, each mutation-proved (revert/disable, confirm exactly
its own test(s) fail, restore, confirm green): aborted/blocked pairs excluded
from measured wall-clock (H1); orphan/aborted counts rendered (H2); README's
AC-OPS-4 widened to the whole tree (H3); per-kind orphan maps in fixed order
(M1); falsy-safe re-throw across all 3 workflows (M2, a real pre-PR2
regression); a non-conforming `ac_id` sanitised, not entry-destroying (M3);
unattributable/degraded orphans classified before the identity `continue`
(M4); four Lows (return-count pin, run_id fallback, spec_raw relativised,
throw-path seam). Full suite after: 460/460, three runs plus a fresh clone.

## Runtime unwind fact-check

Agent-step throw: CONFIRMED to unwind through `try/catch`. Budget exhaustion:
UNVERIFIED (not observable from this repo). Process kill: CONFIRMED to NOT
unwind -- AC-DATA-9 rests on ledger-append.mjs's append-only durability.

## Review round 2 (1 High, 7 Medium, 9 Low, `main...e3148cd`) -- condensed

Full fix round, main-comparison recorded per fix: a null/non-object findings
element no longer crashes the ac_id sanitiser (M-2); `?? 0` on a missing
totals field no longer renders a confident 0 (H-1, `UNAVAILABLE_STALE_READER`);
`outcome !== 'done'` no longer misclassifies blocked/no-op as aborted (M-4,
gate flipped to `outcome === 'aborted'`); a sanitised `ac_id` is retained
(`ac_id_raw`, bounded) and counted at every boundary instead of dropped
(M-3); README's stale per-PR enumeration and "no new field" claims corrected
(M-5/6/7); `lenses_run` self-consistent on a late throw (L-1); the exception
guard's own log line redacted (L-2, `redactLogText`); `HARNESS_LEDGER_READONLY`
added so a lens probing the writer mid-review cannot write into the live
ledger (new harness finding); a fixed 800ms pre-SIGKILL sleep replaced with a
bounded poll (L-5); a cross-spec `AC-QA-13` collision namespaced (L-8, cosmetic
only). L-9 (AC-DATA-16) and L-10/L-11 explicitly deferred, not marked passing.
Full suite after every fix: 498/498, twice.

## Coordinator triage, post round-2 (ledger-append.mjs, 2 High)

Both confirmed pre-existing on `main` (`git show main:...`), not regressions:
a null/non-object element in the findings arrays crashed `computeFindings()`
before validation ran, fixed once in the shared function (FINDING 1); `isMain`
compared a symlink-resolved URL against an unresolved argv path, so
`node <symlinked-path>` silently produced zero output and no write anywhere a
resolved script path crosses a symlinked ancestor (FINDING 2, fixed with
`fs.realpathSync.native`). Full suite after both: 504/504, twice, plus a
fresh clone.

## Rounds 3-8 -- guards re-verified at the current tip (963714c)

Per the owner's documentation-currency gate: this section does not narrate
each round's history (see `git log` and each commit message for that). It
lists every guard from rounds 3-8 that is load-bearing **in the code shipping
at 963714c**, each mutated and proved fresh THIS round -- none transcribed
from a commit message. Full suite before and after every mutation: 597/597.

| # | Guard | Location | Mutation | Result |
|---|---|---|---|---|
| 1 | F1 verdict-evidence test | optimise-read.mjs:335 | `!KNOWN_VERDICTS.has(v.verdict)` -> round-6's shape check (`v.verdict===null && v.verdict_raw!=null`) | 123 tests, 121 pass, 2 fail (bare-null and junk-string NEUTRALISED-VALUE-TABLE rows) |
| 2 | F1 lens-evidence test | optimise-read.mjs:264 | value-based `LENS_RE` check -> shape check (`f.lens===null && f.lens_raw!=null`) | 123 tests, 120 pass, 3 fail (bare-null, junk-string, no-false-merge rows) |
| 3 | F4 dual-corruption taint | optimise-read.mjs:305 | `v.verdict!=='PASS' && v.verdict!=='UNVERIFIABLE'` -> literal `v.verdict==='FAIL'` | 123 tests, 122 pass, 1 fail (dual-corruption row) |
| 4 | F3 item-level required drop | ledger-append.mjs:633 | `!itemDropPathParts(...)` -> `true` (required always structural) | 203 tests, 200 pass, 3 fail (ac_verdicts-missing-ac_id x2, findings-missing-id) |
| 5 | F2 undefined-sibling guard | ledger-append.mjs:739 | removed the `rawValue !== undefined` condition | 203 tests, 202 pass, 1 fail (omitted-`lens` test) |
| 6 | degradeEntry structural/value split, fwd | ledger-append.mjs:689 | `errs.some(isStructuralError)` -> `true` (refuse on any error) | 597 tests, 548 pass, 49 fail; zero structural-precedent tests among them |
| 7 | degradeEntry structural/value split, rev | ledger-append.mjs:689 | same condition -> `false` (never refuse) | 597 tests, 586 pass, 11 fail -- exactly the structural-precedent set, disjoint from #6 |
| 8 | explicit-null `verdict` counter | ledger-append.mjs:1554 | condition -> `false` | 203 tests, 202 pass, 1 fail (own test) |
| 9 | explicit-null `ac_id` counter (writer half) | ledger-append.mjs:1553 | condition -> `false` | 203 tests, 202 pass, 1 fail (own test) |
| 10 | suppression-gate boundary | optimise-cycle.js:561 | `>=` -> `>` | 89 tests, 88 pass, 1 fail (exactly-20%-boundary test) |
| 11 | suppression-gate fail-open on missing fields | optimise-cycle.js:561 | dropped the `share === null \|\|` clause | 89 tests, 87 pass, 2 fail (fails-closed test, drop-reason-detail test) |
| 12 | Filtering percentage rounding | optimise-cycle.js:1090 | `Math.floor` -> `Math.round` | 89 tests, 88 pass, 1 fail (own boundary-contradiction test) |
| 13 | raw-field redaction pipeline | ledger-append.mjs:740 | dropped `redactRawField(...)` around the sibling write | 203 tests, 200 pass, 3 fail (ac_id_raw x2, lens/severity_raw) |
| 14 | same-command-line ledger guard | plan-cycle.js:227 | reverted prompt text to the separate-`export` form | 22 tests, 21 pass, 1 fail (own prompt-content test) |

Not re-proved because the code no longer exists, by design: round-6's
`isNeutralised(obj, field)` helper (the shape-based predecessor to #1/#2) was
deleted in round-7 (963714c) when it was replaced with the value-based checks
above -- no proof recorded for it. Likewise round-4's per-field lens/severity
sanitiser loop (from commit e60cdf7) was deleted in round-5, superseded by
the general `degradeEntry` mechanism #6/#7 prove above.

## Standing test rule (must outlive this PR)

An "is this evidence?" test must enumerate the VALID values and assert that
everything else is not evidence. It must never match on the shape a
particular fix happens to produce.

Violated twice on this PR: round-6's `isNeutralised(obj, field)` asked "is
this null AND does a `*_raw` sibling happen to be present" -- the shape
`degradeEntry` produces -- instead of "is this a value that can be treated as
evidence"; a bare `verdict: null` with no sibling sailed straight past it and
reproduced the inversion. And the conductor's own round-7 verification made
the identical mistake in test form: its fixture paired every null with a
`*_raw` sibling, pinning the same shape the fix was built to handle, and
reported the bug fixed while the value-based gap was still live. Removing the
bare-null or junk-value rows from `test/optimise-read.test.js`'s
NEUTRALISED-VALUE TABLE is this exact mistake recurring.
