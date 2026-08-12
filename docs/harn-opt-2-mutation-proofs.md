# HARN-OPT-2 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour
was actually broken (edited in the working file, not "mentally mutated"),
the suite was run, the exact failing test and message recorded, then the
file was restored (`cp` from a pre-mutation snapshot, never `git checkout
--`, which reverts to the last commit and can destroy uncommitted work),
confirmed via `diff <working-file> <snapshot>` returning nothing before the
next mutation. Full suite: `node --test test/*.test.js`. AC-SIMP-10 caps
this file at 200 lines; later rounds compress earlier ones, never drop them.
From review round 2 on: every fix also records whether `main` handled the
same input correctly and whether the fix preserves that (Scott's standing
instruction, prompted by two regressions -- PR1's realpath, round 1's own
ac_id sanitiser -- each breaking a case main got right).

## PR1 (plan-identity canonicalisation) -- condensed

Merged PR #3 (squash d6ada19), 5 fix / 4 review rounds. Root cause chased
across rounds 3-5: write-time redaction (lossy) conflated with
canonicalisation in an append-only unbacked-up file. 21 proofs, all
load-bearing: `..`-escape detection, repo-identity fallback,
unattributable/degraded-run exclusion, ci_wait/human_wait key routing,
single-definition-site guard, `perRepo[].root` labelling, AC-DATA-6
attribution, the H-A/H-B/H-C round-5 fixes. Final suite: 405/405.

## PR2 initial build (start/terminal pairing) -- condensed

AC-QA-8/AC-OPS-1 exception guard; AC-OPS-2 terminal-only orphan class;
AC-DATA-10 pairing purity (exactly one started + one terminal is ever
measured). 8 proofs, all load-bearing: AC-ARCH-9 byte-identity block + the
re-throw line; AC-QA-9 return-count pin; the purity gate (reverted to
`pair.length < 2` alone -- 4 tests failed, genuine-pair test stayed green);
start/terminal-only counters proven independently wired; AC-QA-10 seam's
real run_id reuse; AC-DATA-9's SIGKILL test proven non-vacuous. Final
suite: 422/422.

## Review round 1 (5 lenses + adversarial, `main...3d33647`) -- condensed

3 High, 4 Medium, 5 Low; L3 (rollback drill) explicitly the coordinator's
own action, out of scope here.

- **H1**: an aborted/blocked pair counted as a healthy measured completion.
  Excluded from `agentComputeSeconds`/N, counted separately as
  `agentComputeAbortedPairs`. Mutation: revert the `outcome !== 'done'`
  branch -- 3/4 new tests fail, DONE-path control stays green.
- **H2**: orphan/aborted counts computed but never rendered. Added to the
  report. Mutation: comment out each line independently -- each caught
  only by its own test.
- **H3** (README): AC-OPS-4 covered only `workflows/lib/`, not PR2's
  top-level scripts. Widened to whole-tree, RED-before-GREEN against the
  extending static test.
- **M1**: per-kind orphan maps serialised in encounter order, not fixed
  order -- the shipped fixture had one kind per class so this could never
  fail. Fixed; fixture widened to two kinds per class. Mutation:
  `orderByKind` reduced to `return raw` -- caught.
- **M2**: `if (runError) throw runError` tested truthiness, not whether the
  catch fired -- `throw null/undefined/0/''` resolved instead of
  propagating, a regression (every throw reached the caller pre-PR2).
  Fixed via a separate `threw` boolean, all 3 workflows. Mutation: `threw`
  reverted to `runError` -- caught by the 4 falsy-value tests AND the
  byte-identity guard simultaneously.
- **M3**: one non-conforming `ac_id` anywhere in `ac_verdicts`/`findings`
  failed validation for the WHOLE entry -- recreating a start-only orphan
  with the wrong cause, reachable from a prompt-injected lens field.
  Sanitised before `validateEntry`. Mutation: revert the filter/null-out --
  caught by both the new test and the updated hostile-ac_id security test.
- **M4**: an unattributable/degraded orphan counted in neither orphan
  class. Classification moved before the identity `continue`s. Mutation:
  disable the start-only branch -- caught, terminal-only stays green.
- **L1/L2/L4/L5**: return-count pin widened past the object-literal form
  (reproduced both review examples); `run_id` fallback in failure logs
  (mutation: fallback removed -- caught); `spec_raw` relativised without
  the `..`-collapsing step (2 mutations, caught only by the dedicated
  non-vacuous test); throw-path seam extended to all 3 workflows, proven
  non-vacuous via an injected undeclared field.

Full suite after round 1: 460/460, three consecutive runs, plus a run from
a genuinely separate `git clone`.

## Runtime unwind fact-check (flagged unproven at planning)

Agent-step throw: CONFIRMED to unwind through `try/catch` (every AC-QA-8
test exercises this directly). Budget exhaustion: UNVERIFIED -- whether
production throws (caught) or externally terminates the process (not
caught by anything JS-level) is not observable from this repo. Process
kill: CONFIRMED to NOT unwind -- AC-DATA-9 rests on ledger-append.mjs's
append-only durability, never on PR2's try/catch.

## Review round 2 (1 High, 7 Medium, 9 Low, `main...e3148cd`, plus a new
harness-level finding) -- full fix round, main-comparison recorded per fix

- **M-2** (ledger-append.mjs): round 1's own ac_id sanitiser crashed on a
  null/non-object element in `findings`/`ac_verdicts` (`f.ac_id` on
  `null`). **Main comparison**: `git show main:workflows/lib/ledger-append.mjs`
  fed the identical payload, in a real temp repo, returns a clean
  `write_ok:false` (whole-entry schema rejection) -- reproduced directly,
  not inferred. Fixed with a type guard before any `.ac_id` access,
  leaving the malformed element for `validateEntry` to reject exactly as
  main does. Mutation: removing the guard -- both new tests crash again
  (uncaught TypeError), confirmed against a pre-mutation snapshot diff.
- **H-1** (optimise-cycle.js, optimise-read.mjs): `?? 0` on a MISSING
  totals field rendered a confident 0 instead of "not computed". **Main
  comparison**: not applicable -- these fields do not exist on main at
  all; this is PR2's own round-1 shipped code regressing against itself,
  not against main. Fixed: `fmtCountOrUnavailable`/`UNAVAILABLE_STALE_READER`;
  a reader-to-report SEAM test built from the real CLI's own output (not a
  hand fixture), reproducing the review's exact field-rename mutation --
  only the seam test fails, all hand-fixture tests stay green under the
  same mutation (the gap the finding named).
- **M-4** (optimise-read.mjs): `outcome !== 'done'` misclassified
  `blocked`/`no-op` (legitimate completions) as aborted. **Main
  comparison**: main has no outcome-aware branch at all -- ANY complete
  pair is measured, so main would have made the same M-4 mistake had it
  ever seen a `blocked`/`no-op` pair; not a regression, a genuine bug fix.
  Fixed: gate flipped to `outcome === 'aborted'` only, enumerated
  explicitly. Mutation: exhaustive 4-outcome test (done/blocked/no-op/
  aborted) individually asserted, each caught by reverting the gate.
- **M-3** (write+read+render+log, all 6 files): a non-conforming `ac_id`
  was dropped permanently, feeding `neverFailingAcs` a false "never fails"
  signal. **Main comparison**: main has neither the sanitiser nor
  `ac_verdicts`/`findings` retention at all (round 1's own addition), so no
  main behaviour to regress. Retained (bounded, `ac_id_raw`, 32 bytes --
  long enough for a realistic citation, short enough to truncate the M6
  hostile payload's secret substring) instead of dropped; counted at every
  boundary (write, CLI projection, `aggregateRework`, CLI projection again,
  report render, workflow log). Mutation, each boundary independently:
  CLI projection gap (reverted -- caught only by the end-to-end CLI test);
  render line (commented out -- caught); workflow log condition (forced to
  `if (false)` -- caught in all 3 workflow test files, nothing else moves).
  Also fixed proactively (not review-flagged): a nulled `ac_id` stringifies
  to `"null"`, merging every sanitised verdict from every plan into one
  fake shared bucket -- guarded, tested.
- **M-5/M-6/M-7** (README.md, docs only): deleted the stale per-PR
  four-file enumeration (already wrong by the time round 2 alone touched
  six); corrected the "added no ledger field" claim
  (`invalid_ac_ids_dropped`/`ac_id_raw` are new, additive fields);
  documented the sync-ordering constraint. **Main comparison**: verified
  directly -- a crash-produced pair (only possible under PR2's exception
  guard) fed through main's `aggregateWallClock` reports
  `agentComputeMeasuredRuns:1` (a crash reading as a healthy 5s run); the
  current reader reports `agentComputeAbortedPairs:1,
  agentComputeMeasuredRuns:0`. Executed (not described) a rollback drill
  against a scratch mirror: a partial reader-only sync still leaves
  `diff -rq` reporting 5 further drifted files.
- **L-1** (review-cycle.js, plan-cycle.js): `lenses_run` read from
  `result.lenses`, undefined on any throw (`run()` never returns) --
  reported `[]` even when every lens had genuinely reported back before a
  LATE throw (e.g. synthesis crashing). **Main comparison**: not
  applicable, the whole exception-guard mechanism is PR2's own addition.
  Fixed with a `lensesRunRaw` accumulator set as soon as lens reports
  exist, mirroring `openFindingsRaw`/`acVerdicts`. Mutation: reverted to
  `result.lenses || []` in each file independently -- caught by exactly
  the corresponding new seam test (throw at the LAST agent step, piped
  through the real writer), nothing else moves.
- **L-2** (all 3 workflows): the exception guard's log line printed a
  thrown error's message verbatim, no root-stripping (workflow scripts
  have no fs/child_process access, so no `stripRoot` equivalent exists).
  **Main comparison**: not applicable, same reason as L-1. Added
  `redactLogText` (bounds length, strips `/Users/`|`/home/` segments),
  applied only to this console log, never to the ledger file. Mutation:
  reduced to an identity function -- fails exactly the 2 new tests per
  workflow (path leak, length cap), 6 total, nothing else moves.
- **New harness finding** (review-cycle.js, ledger-append.mjs): a lens
  wrote 2 test-fixture records into the LIVE ledger while probing the
  writer mid-review -- `ledger-append.mjs` resolves the main checkout via
  `--git-common-dir` regardless of which worktree invokes it. Added
  `HARNESS_LEDGER_READONLY`: when truthy, the writer performs no write,
  returns `write_ok:false` before any stdin/git/fs work; wired into every
  lens's prompt as an instruction to export it first. Documented as
  prompt-enforced at the lens boundary, not fully mechanical. Mutation:
  env-check removed -- caught by the writer's own filesystem-untouched
  (sha256 manifest) test; prompt instruction removed -- caught by the new
  prompt-content test.
- **L-5** (sigkill-orphan.test.js, test-only): fixed 800ms sleep before
  SIGKILL, guessed long enough for a real subprocess's synchronous write.
  Replaced with a bounded poll (15ms/10s) on the actual condition.
  Verified: 5 consecutive runs green in 215-320ms; separately forced the
  write to never land within a shortened 200ms cap and confirmed an honest
  timeout failure (not a hang or silent pass) in ~280ms, then restored.
- **L-8** (optimise-read.test.js, test-only): `AC-QA-13` names two
  unrelated criteria depending on the spec (a pre-existing null-vs-zero
  criterion in ledger-append.test.js/review-cycle.test.js vs this PR's own
  order-independence criterion here) -- a genuine, verified collision, not
  mere reuse. Namespaced the 10 occurrences in this one file as
  `harn-opt-2:AC-QA-13`. Scoped narrowly: not a repo-wide rename, out of
  proportion for a PR2-sized change and touching specs this branch cannot
  see. Cosmetic only: 100/100 unchanged before and after.
- **L-9** (AC-DATA-16, window drops whole repos): explicitly left unfixed,
  owner-deferred. Not marked passing anywhere in this file or the README.
- **L-10/L-11**: L-10 explicitly pre-existing on main, out of scope this
  round. L-11 has no scheduled PR.

Full suite after every round-2 fix: 498/498, run twice consecutively.
