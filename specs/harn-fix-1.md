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

### Detector: a documented setup step with no live verification (added 2026-08-20)

**Authorised by the operator to be BUILT, not merely recorded.** Unscheduled;
it belongs in the optimiser rather than in T3 or T4.

**The class.** An artefact is correct, its documentation is correct, and the
setup step the documentation describes was never performed. Nothing in the
repository or on the host can detect it, by construction: the repo is not
where the gap is. It surfaces only when someone needs the thing and finds it
absent.

**The motivating case, measured on a production host 2026-08-20 by the
CouchPotatoServer session** (cited rather than this repo's own instance,
because it is the one with consequences): `scripts/backup.sh` documented
itself as "nightly from cron" and `docs/development-process.md` carried the
`crontab -e` recipe. On the host there was no cron entry, no `cron.d` file
and no systemd timer, and the newest snapshot was nineteen days old. Correct
script, correct doc, step never taken, and a human-triggered promotion was
the only thing that surfaced it.

**This repo has a milder instance**, which is how the shape was recognised:
`bin/setup-hooks.sh` exists because a committed hook is inert until a clone
sets `core.hooksPath`, and git ignores an unset value silently. A test proves
the script works. Nothing verifies that any given clone ever ran it. The
README's honest answer -- that CI rather than the hook is what actually
gates -- is a demotion, not a detection.

**What a detector would look for**, stated as a starting point rather than a
design: a documented recurring or setup obligation (a cron line, a launchd
plist, a `git config` step, an installed mirror) for which no evidence of
performance exists in the artefacts the optimiser can already read -- the run
ledger, git history, Actions history, or the report's own freshness. The
signal is an obligation with no corresponding trace, and the honest output is
"documented, never observed", not a failure.

**Four traps this must avoid**, each measured rather than imagined:

- **Blind and silent.** It must not report clean when it never looked. The
  AC-uniqueness guard in `test/static-checks.test.js` covered 81 of 245
  definitions and reported no problems, twice, in two different directions.
  A per-source floor is the minimum.
- **No trace versus not looked.** These must be distinguishable in the
  output. Rendering absence of evidence as evidence of absence reproduces the
  exact class the detector exists to find.
- **A coverage metric that moves the WRONG WAY under the failure it detects.**
  Measured by the CouchPotatoServer session on its own AST guard: it collected
  config entry names and group names into two sets, and nothing asserted the
  sets stay distinct. One plausible line folding groups into entries turned the
  guard into a tautology -- and because conflation makes the sweep find MORE,
  every "did I find enough" counter got *happier* while the guard stopped being
  able to fail. Ten passed, with the defect present.

  **This defeats the first trap's remedy**, which is why it is recorded
  separately rather than merged into it. A floor asserts a MINIMUM count; this
  failure mode INCREASES the count, so no floor can see it. The defence is an
  invariant on the shape of what was collected -- here, that the two sets
  remain disjoint -- not a threshold on how much was collected. Any detector
  that reports "how many obligations I checked" needs one, because the
  cheapest way to inflate that number is to stop distinguishing between the
  things being counted.

- **A floor that is non-zero AND permanently unclearable.** Measured on
  CouchPotatoServer's own Sonar scan: it carries one permanent BLOCKER,
  `python:S3516`, raised against a `logging.Filter` subclass whose stdlib
  contract is "return True if the record should be logged" -- so the correct
  implementation always returns True. It cannot be fixed without breaking
  that contract, and it cannot be dismissed under the operator's
  no-dismissal rule (never resolve, dismiss or accept a finding to move a
  number). A threshold on blocker count is therefore not merely offset by
  this instance, it is permanently unsatisfiable: the gate is red forever, on
  a change that introduces nothing new, and a permanently-red gate trains
  everyone to skim the metric so the next real blocker is missed alongside
  it. The safe form is a floor on "blockers OTHER THAN the known
  false-positive instances", which needs the instance list to live somewhere
  the reader, and this detector, can reach -- a data dependency to design in
  when the floor is designed, not retrofitted after the first permanent false
  positive is found. Any obligation-count or coverage floor this detector
  proposes for its own output inherits the same risk and needs the same
  design-time answer.

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
