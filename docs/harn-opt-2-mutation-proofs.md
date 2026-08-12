# HARN-OPT-2 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour
was actually broken (edited in the working file, not "mentally mutated"),
the suite was run, the exact failing test and message recorded, then the
file was restored (`cp` from a pre-mutation snapshot, never `git checkout
--`, which reverts to the last commit and can destroy uncommitted work),
confirmed via `diff <working-file> <snapshot>` returning nothing before the
next mutation. Full suite: `node --test test/*.test.js`. AC-SIMP-10 caps
this file at 200 lines; later rounds compress earlier ones, never drop them.

## PR1 (plan-identity canonicalisation) -- condensed

Merged as PR #3 (squash d6ada19) after 5 fix rounds / 4 review rounds. Root
cause chased across rounds 3-5: write-time REDACTION (lossy) conflated with
canonicalisation, in an append-only unbacked-up file. Round 5's fix (current
shape): lexical root-matching only, no fs touch, `spec_raw` retains the
caller's pre-canonical string as recoverability insurance. 21 proofs, all
load-bearing by mutation: `..`-escape detection, repo-identity fallback,
unattributable/degraded-run exclusion, ci_wait/human_wait key routing, the
single-definition-site guard, zero-extra-git-subprocess guard,
`perRepo[].root` labelling, AC-DATA-6 attribution, the H-A/H-B/H-C round-5
fixes (each confirmed to catch its own named regression, not a neighbour's).
Final suite: 405/405.

## PR2 initial build (start/terminal pairing) -- condensed

Scope: exception escaping `run()` still produces a terminal ledger write
(AC-QA-8/AC-OPS-1); terminal-only orphan class handled distinctly from
start-only (AC-OPS-2); AC-DATA-10 pairing purity (exactly one started + one
terminal, nothing else, is ever measured). 8 proofs, all load-bearing:
the AC-ARCH-9 byte-identity block and the re-throw line (each independently
caught by both a static guard and a behavioural test); the AC-QA-9
return-count pin; the AC-DATA-10 purity gate (reverting it to `pair.length
< 2` alone let two-started/two-terminal pairs fabricate a duration -- 4
tests failed, the genuine-pair test stayed green); the AC-OPS-2 start-only
counter (independently wired from terminal-only, proven by a differential);
the AC-QA-10 seam's real run_id reuse; AC-DATA-9's SIGKILL test (proven
non-vacuous by showing an UNKILLED run genuinely writes 2 lines, not 1);
run_id-reuse strengthened across every return path, not just DONE. Final
suite: 422/422.

## Review round 1 (5 lenses + adversarial, `main...3d33647`) -- 3 High, 4
Medium, 5 Low; L3 (rollback drill) explicitly out of scope, the coordinator's
own action.

**H1** (`agentComputeAbortedPairs`, optimise-read.mjs): a well-formed
start+terminal pair whose terminal outcome isn't 'done' (a crash the
exception guard turns into a pair, or a deliberate BLOCKED/ABORTED) was
counted as a healthy MEASURED completion -- reproduced exactly per the
review's 40-minute repro (2400s/measured=1/unmeasured=0 before; excluded
from agentComputeSeconds, unmeasured=1, abortedPairs=1/2400s after). Fixed:
excluded from agentComputeSeconds/N, counted a SECOND time toward
agentComputeUnmeasuredN (keeps `isUnmeasuredSegmentMotivated`'s safety gate
armed without touching optimise-cycle.js's gate logic), reported under its
own name. Mutation: reverting the `outcome !== 'done'` branch condition
-- 3 of 4 new tests fail, the DONE-path control test stays green.

**H2** (report rendering, optimise-cycle.js): the two AC-OPS-2 orphan
counters and H1's aborted-pairs count reached no operator-read report --
grep confirmed zero matches outside optimise-read.mjs itself. Rendered as
an always-present "Orphaned agent-compute runs" line (real zeros when
clean, by-kind breakdown) and an `aborted n=` segment on the existing
Totals line. Mutation: commenting out each line independently -- each
caught only by its own dedicated tests, confirming they're not the same
guard twice.

**H3** (README.md): AC-OPS-4's re-sync section covered only `workflows/lib/`,
but PR2's whole fix lives in the three TOP-LEVEL workflow scripts, which the
mirror also copies. Widened to a whole-tree command pair, the four files
named explicitly, and an honest statement that the schema_version staleness
signal does NOT cover a stale top-level script (PR2 bumped no schema
version). Proven RED-before-GREEN against the extending static test.

**M1** (byKind serialisation order): the new per-kind orphan maps
serialised in record-encounter order -- the SHIPPED fixture used one kind
per class, so the guard could never fail (confirmed: forward/reversed
differ byte-for-byte with two kinds per class). Fixed by rebuilding both
maps in `RUN_KINDS`' fixed order; fixture widened to two kinds per class
plus the literal two-concurrent-runs-interleaved case AC-QA-13 names.
Mutation: `orderByKind` reduced to `return raw` -- caught.

**M2** (falsy re-throw, all 3 workflows): `if (runError) throw runError`
tested truthiness, not whether the catch fired -- `throw null/undefined/0/
''` resolved instead of propagating, a REGRESSION (every throw reached the
caller before PR2). Fixed via a separate `threw` boolean. Mutation:
`threw` back to `runError` -- caught by both the falsy-value tests (4 per
file) and the AC-ARCH-9 byte-identity guard simultaneously.

**M3** (`invalid_ac_ids_dropped`, ledger-append.mjs): one non-conforming
`ac_id` anywhere in `ac_verdicts`/`findings` failed validation for the
WHOLE entry, recreating exactly the start-only orphan class this PR counts,
with the wrong cause -- reachable from a prompt-injected lens field.
Sanitized before `validateEntry`: `findings[].ac_id` (nullable) is nulled,
`ac_verdicts` entries (not nullable) are dropped, both counted. The
pre-existing M6 test asserting whole-write rejection on a hostile ac_id is
updated to the review's own instruction: the security property (never
written verbatim) survives via nulling, not whole-write refusal. Mutation:
both the `ac_verdicts` filter and the `findings` null-out, independently
reverted -- each caught by its own test AND the updated M6 security test.

**M4** (unattributable/degraded orphans, optimise-read.mjs): an orphan
whose plan identity is unattributable or fully degraded was counted in
NEITHER orphan class (classification sat after the identity `continue`s).
Moved before them -- orphan shape needs no plan key. Mutation: disabling
just the start-only branch -- caught by its own test, terminal-only stays
green (independent wiring).

**L1** (return-count pin widened, static-checks.test.js): only matched the
object-literal `return {` form. Widened to count every real `return`
(comments/strings stripped first, so an agent prompt's "return X" text is
never miscounted) and assert the two counts match. Mutation: reproduced
BOTH of the review's own examples (`return escapeHatch`, `return EARLY`) --
caught (first attempt at a naive `\breturn\b` count overcounted ~10 vs 3
from prompt text; fixed via comment-then-string stripping, in that order --
stripping strings first left comment apostrophes desyncing quote pairing
several hundred bytes downstream, silently swallowing a real return).

**L2** (run_id in failure logs, all 3 workflows): the terminal-write-failure
log named "run unknown" even when the payload itself named the run to
reuse. Falls back to `payload.run_id`. Mutation: fallback removed -- caught.

**L4** (`spec_raw` relativisation, ledger-append.mjs): an absolute IN-REPO
spec retained the caller's literal absolute string in `spec_raw`, leaking
the account name -- AC-SEC-1's headline forbids this; only the enumerated
test cases exempted it (a spec bug). Relativised the same lexical way
`spec` is, deliberately WITHOUT canonicalPlanKey's "../"-collapsing step
(sharing it would make spec_raw merely re-derived from what it exists to
insure against). Two mutations: (1) revert to verbatim -- 4 tests fail;
(2) route through the full `canonicalPlanKey` instead of the narrower
root-strip -- caught ONLY by the dedicated non-vacuous recoverability test,
confirming that test (not the leak-freedom tests) guards this property.

**L5** (throw-path seam proof, ledger-seam.test.js): the AC-QA-8 tests
script the ledger:write response, so the throw path's terminal payload was
never validated by the real writer. Extended to all 3 workflows. Proven
non-vacuous by injecting an undeclared field into tdd-task.js's terminal
payload: the new seam test fails with a real schema error while the
pre-existing fake-runtime-only test stays green.

Full suite after all review-round-1 fixes: 460/460, three consecutive runs,
plus a run from a genuinely separate `git clone`.

## Runtime unwind fact-check (AC-ARCH-9/AC-QA-8 dependency, flagged unproven
at planning by lens-architecture)

- **Agent-step throw**: CONFIRMED to unwind through `try/catch` -- ordinary
  JS async/await semantics, directly exercised by every AC-QA-8/AC-OPS-1
  test, all passing.
- **Budget exhaustion**: UNVERIFIED. Whether production enforces a budget
  cutoff by throwing inside `agent()` (caught) or by externally terminating
  the script (not caught by any JS construct) is not observable from this
  repo. Not assumed either way.
- **Process kill (SIGKILL/forced termination)**: CONFIRMED to NOT unwind --
  no JS-level construct runs once the OS terminates the process. AC-DATA-9's
  guarantee rests on ledger-append.mjs's append-only durability (proven by
  the real-process SIGKILL test), never on the try/catch added for AC-QA-8.
