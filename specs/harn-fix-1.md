# HARN-FIX-1: harness correctness debt and mechanised housekeeping

<!-- no-acceptance-criteria: this spec defers them to /plan-cycle -->

**Status:** open, unscheduled. Acceptance criteria are deliberately absent:
run `/plan-cycle {"spec": "specs/harn-fix-1.md"}` when this is picked up. The
criteria carried in HARN-OPT-3 were written for a different plan shape and
should be re-derived rather than transplanted.

## Why this spec exists separately

It carries T3 and T4 out of HARN-OPT-3, which is closed. That plan was titled
"turn a hardened harness into measured delivery improvement" and opened "none
of that has yet changed how fast anything ships". Its two delivery-facing
tasks are gone: T2 dropped on measurement (CI is 3.9 min median in Said of
You, at most a tenth of cycle time, so decomposing it cannot help) and T1
parked (stripping out dependency PRs leaves a median authored PR of 18
minutes, so there is no demonstrated delivery problem for its data to
explain).

What remained was harness-internal, which HARN-OPT-3's own "Not in scope"
section resists. Keeping it under a delivery banner would mean every future
plan and review cycle spent on harness internals while the register claims
delivery is improving.

**So this spec makes no delivery claim.** It is correctness debt and chores in
the tooling. The justification is the admission gate HARN-OPT-3 set for
itself, and every item below meets it: *a defect that produces a wrong
optimiser proposal, or a silent lens loss, qualifies; a defect that is merely
untidy does not.*

## Problem

### Correctness debt (was T3) -- each can produce a wrong conclusion

1. **Plan identity is not lexically stable.** The same spec recorded from a
   subdirectory lands in a different `plan_key` bucket, so one plan's
   telemetry splits in two and every per-plan aggregate is wrong. Measured at
   HARN-OPT-3 planning.
2. **`canonicalPlanKey` redacts only `/`-anchored absolute paths.**
   `file:///Users/<user>/.ssh/id_rsa` and `\\server\share\secret.md` survive
   into `plan_key`, the report and the synthesis prompt. Measured.
3. **Ledger dictionary KEYS are unconstrained.** `grep -c propertyNames
   workflows/lib/ledger-append.mjs` returns 0, so only values are checked; a
   `trigger_counts` key containing an absolute path is accepted today.
4. **Fail-closed decisions delegate to the runtime's schema enforcement.**
   Driven with schema enforcement disabled, `review-cycle.js` proceeds on
   harness defaults instead of aborting, and the mirror case raises a false
   `HarnessTriggersContradiction`. The only thing stopping the first today is
   an incidental `Object.keys(undefined)`.
5. **`plan-cycle.js` never reads `.claude/harness-triggers.json`.**
   `grep -c "harness-triggers" workflows/plan-cycle.js` returns 0, so a repo
   that tunes review triggering gets no matching planning behaviour, and the
   asymmetry is undocumented. This is the silent-lens-loss class the
   custom-rules fail-closed work already addressed on the review side.

### Housekeeping (was T4) -- each has recurred more than once

6. **Worktree and branch-ref accumulation.** Observed repeatedly: five
   leftover worktrees totalling 2.6 GB on a volume at 99%, and fourteen
   merged `worktree-agent-*` branches on a remote, one of which carried a
   commit whose history had been rewritten so its PR could pass. Wants a
   committed, prefix-filtered sweep. **Any such sweep is a bulk ref deletion
   at precedence rank 1**: an agent's branch ref is often the only copy of
   its commits, so injection safety and an anchored exact-match pattern are
   not optional.
7. **AC-OPS-3, carved out of the parked T1.** The weekly launchd job exits 0
   in silence when its repo list is missing or empty, and two tests currently
   pin that as correct. A weekly job doing nothing is indistinguishable from
   one that is working: same empty `StandardErrorPath`, same exit 0, no
   `RESULT` line to grep. This was parked by accident with T1 and does not
   belong there.

## Affected files

`workflows/lib/ledger-append.mjs`, `workflows/plan-cycle.js`,
`workflows/review-cycle.js`, `bin/optimise-cycle-weekly.sh`, plus a new sweep
entry point under `bin/`.

## Sequencing note carried forward

`lens-simplicity` proposed at HARN-OPT-3 planning that T3 be re-derived from
what a real weekly cycle's output actually gets wrong, rather than from a
list written in advance. The counter-argument recorded against it was
`lens-product`'s "lane yield argues for T2 early too" -- and T2 has since
been dropped on measurement, so **that counter-argument has been withdrawn
and the veto was never re-run.** Treat the simplicity proposal as live: the
cheapest version of this spec may be to run one optimiser cycle first and
keep only the items its output actually trips over.
