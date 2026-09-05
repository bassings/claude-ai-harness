# HARN-NEXT: the work standing after 2026-09-05

**Status:** agreed
**Why this file exists:** four PRs merged today were executed inline from
conversation, against the standard's own routing rule that multi-PR work with CI
and review waits runs under the conductor. Scott had to ask three times whether
I was still working, and each time I had stopped with work outstanding. The
no-stall guard only arms while a plan is active, and no plan was active. This is
the plan.

## Not in scope

Anything the 2026-09-05 adversarial pass named as unreached: `neutralise()`,
`redactLogText()`, the glob complexity limits, the install-consistency
preflight, `conduct-plan`, `tdd-task`, the weekly runner. Owner decision, same
day: that is a list of things nobody has attacked yet, not a list of things
believed broken, and treating it as urgent is how a four-round branch becomes a
six-round one.

Couch Potato's SonarQube sweep. Scott gave that instruction to that repo's
session on 2026-09-05 at 01:19, and I misattributed it once already today.

## What this replaces

Nothing. This is new work, so the removal list is empty, stated rather than
omitted.

---

## Tasks

- [x] T1: adversarial pass against `main` — state: merged — Owner decision 2026-09-05: keep
  the adversarial mutation pass as a standing practice rather than a gate on one
  branch. The shape that worked: a fresh agent picks the mutations, is told to
  assume every mutation the author ran was chosen to succeed, and is told a
  GREEN result is the finding. Scope it to guards NOT covered by the four rounds
  already done, since those were attacked hard. Findings go through the normal
  spec/review gate; nothing is fixed inside the pass.

- [x] T2: make the SonarQube coverage number real, or remove it — state: merged — The
  dashboard reads 0%, which is not a measurement: SonarQube reads a coverage
  report the scan uploads and none was uploaded, while the suite has 1165
  passing tests. Node's built-in lcov reporter emits an empty file here, so this
  needs a different route (c8, or a reporter that works) or an explicit decision
  to stop publishing a coverage figure at all. **An absence displayed as a fact
  is the defect class this repo exists to catch**, and it is currently doing it
  on its own dashboard.

- [x] T3: triage the SonarQube findings that survive correct configuration — state: merged —
  192 open after sources and tests were split. Do NOT dismiss to move the
  number. Two things are already known and must be recorded before anything
  else: 14 of the 16 "bugs" are one rule whose recommended fix would introduce a
  real defect (it wants `localeCompare`, which is locale-dependent, on sorts
  feeding a cross-machine drift comparison that must be identical on two
  machines); and one is a genuine find, a raw control byte in source where the
  sibling line uses the readable escape.

- [ ] T4: the delivery comparison, when there is enough data — state: blocked-on-data — Baseline is 15
  review rounds per real-work PR as at 2026-08-24. Measured 2026-09-05: four to
  five real-work PRs since, not the ten this needs. **Do not compute early.**
  Settle explicitly, before computing, whether the one severe outlier is in or
  out: four rounds, circuit-breaker tripped, the same data-destroying defect
  three times, shipped disabled. At n≈10 that single item moves a median on its
  own.

## Conductor log

- 2026-09-05 tick 1: **T2 done.** The 0% was an absence displayed as a fact: no
  coverage report had ever been uploaded. Real figure now **95.9% over 4,816
  measurable lines**, with six files marked EXCLUDED rather than falsely reading
  0%. Route: c8 for JS (Node's own lcov reporter emits an empty file here),
  coverage.py for Python. Two structural limits found and recorded rather than
  papered over: `workflows/*.js` (3,865 lines) are compiled from source text at
  run time, in production and test alike, so V8 attributes no coverage to a
  file; and two hooks are driven by ~120 Node tests that SPAWN them, which
  coverage.py cannot see. Together roughly 4,265 tested-but-unmeasurable lines.
  `hooks/plan-guard-stop.py` IS measured, at 78%, because its tests import it.
  **Residual, stated:** a dashboard reader sees 95.9% and not the exclusions.
  The properties file carries the caveat; the dashboard cannot.
  **Recorded debt:** subprocess coverage is obtainable via COVERAGE_PROCESS_START
  and a sitecustomize hook. Judged out of proportion today, not resolved.
  Two of my own config errors on the way: a test file indexed as both source and
  test (scanner refused, correctly), and an earlier scan with no sources/tests
  split at all.
  **T1 deliberately not started.** Scott chose both "adversary runs on main
  after" and "nothing now" on the areas it had not reached. Those only conflict
  if T1 is treated as urgent, since the unreached areas ARE what an adversary
  would attack. Read together: a standing practice, not this tick's work.
  Rework rounds this tick: 0. T3 unblocked. T4 still blocked on data (4-5 of 10
  real-work PRs). Armed: ScheduleWakeup.

- 2026-09-05 tick 2: **T3 part done, bugs cleared.** Owner approved dismissing
  the 14 sort-rule findings; each carries its reasoning and an expiry condition.
  **I corrected my own justification before acting on it**: I had told Scott the
  tool's fix would introduce locale-dependent ordering into a cross-machine
  comparison. Overstated. Those sorts format the returned report AFTER the
  comparison runs, within one process, on ASCII field names where localeCompare
  would order identically. The real reason is simpler and true: the rule targets
  NUMERIC sorts, and every array flagged holds strings, verified from a live run.
  The wrong reason is recorded in the dismissal comments beside the right one.
  Of the two remaining bugs, one was genuine: three RAW C0 bytes in
  optimise-read.mjs, converted to escapes, with a static guard now failing the
  build on any raw C0 byte in tracked source. The other already used the escape
  and is dismissed with evidence. Bugs 16 -> 0; open findings 192 -> 179.
  The guard's first mutation proof SILENTLY FAILED TO APPLY and looked green;
  caught by checking, re-planted, confirmed. That is the third time today a
  mutation result would have been misread without that check.
  Rework rounds this tick: 0. Remaining: 173 code smells and 6 vulnerabilities,
  none yet examined. Armed: ScheduleWakeup.

- 2026-09-05 tick 3: **T3 continued.** Owner ruled on both open questions.
  The four PATH findings are ACCEPTED, not dismissed: the finding is accurate
  (git resolves through PATH), and the reasoning plus an expiry is recorded on
  each. Marked `accept` rather than `falsepositive` deliberately -- "we looked
  and this is not real" and "we looked, it is real, and we are living with it"
  are different claims, and collapsing them destroys the signal the tool exists
  to give.
  Complexity triage done and reported: the four worst are ledger-append main()
  at 739 lines, optimise-cycle buildReport() at 348, optimise-read
  aggregateWallClock() at 344, and review-cycle run() at 734. The structural
  fact that decides the triage: workflow scripts CANNOT import (production
  rejects it statically and a test enforces it), so review-cycle's run() and its
  siblings are inline BY CONSTRUCTION, not by choice -- the tool's usual advice
  is unavailable there. ledger-append's main() is a real module and is the trust
  boundary for the durable ledger, which makes its complexity a correctness risk
  rather than a readability one. That is the one worth attention.
  Rework rounds this tick: 0. Open findings 179 -> 175. Armed: ScheduleWakeup.

- 2026-09-05 tick 4: **T3 done. Plan has no actionable work left.**
  T4's precondition MEASURED here rather than relayed: non-dependabot PRs merged
  in CouchPotatoServer since the 2026-08-24 baseline are #291, #292, #300, #301,
  #302 -- five, or seven counting the two that merged on the baseline day
  itself, or eight counting the dependency triage. The threshold is ten real-work
  PRs. Three of these (#300, #301, #302) merged TODAY and were not in the count
  the CouchPotato session gave me earlier, which is why measuring beat relaying.
  Still short, and the gap closes on a multi-day timescale, not a 20-minute one.
  T3's remaining findings are the mechanical style class (55 optional-chaining,
  14 nested ternary, and similar). Owner declined bulk application; the triage
  outcome for them is "no action", recorded rather than left ambiguous.
  One item identified as genuinely worth doing and NOT done: ledger-append's
  main(), 739 lines at the trust boundary between agent-supplied text and the
  durable ledger, in the same file today's adversarial pass found two validator
  holes in. That is a real change with tests, not a refactor to move a number,
  and it is not in this plan's scope.
  Rework rounds this tick: 0. Blocked on human, question above the log heading.

- 2026-09-05 tick 5: **T1 dispatched, and I corrected my own earlier reading.**
  Last tick I held T1 back, reading Scott's two answers as conflicting. They were
  not. He chose "merge now, adversary runs on main AFTER" and separately "nothing
  now" on the specific unreached list. The first is a decision about T1; the
  second is about me starting that work myself. An adversarial pass finding
  something in those areas is INFORMATION, not work started. Re-running the loop
  rather than answering the blocked question resolved it: keep going.
  Agent briefed to prioritise by consequence, with the four rounds' territory
  named as low-yield rather than fenced off, and with the two disciplines that
  bit me today written in: confirm green before each mutation, and check the
  mutation actually landed before believing a green run.
  Rework rounds this tick: 0. T1 building. Armed: the background agent.

- 2026-09-05 tick 6: **T1 done.** ~97 mutations, ~53 green. Four fixed here, in
  consequence order, each verified before acting rather than relayed.
  1. **Every hook could be replaced by a no-op** (`command: "true"`) with
     1182/1182 green -- all three guards off in a three-word edit. The existing
     wiring test checked REGISTRATION and never that the command runs the script:
     section 11's wrapper-not-capability shape, aimed at the guards' own wiring.
  2. **The local gate did not mirror CI** (section 4). pre-push ran only the Node
     suite; plan-guard-stop.py has zero Node coverage; its only tests ran in CI.
     The no-stall guard could be broken outright with pre-push reporting success.
     One line, and it closes the class for every Python hook, not one instance.
  3. **The destructive-git guard had three independent defeat routes** -- wiring,
     the keyword-stripping parser stage, and an escape hatch where `=0` would
     have DISABLED it. The code was correct throughout; nothing pinned it. This
     is the guard protecting the shared checkout.
  4. **The transcript reader had no coverage at all**, and the reason was worse
     than the report's "unpinned window": every test injects a list and bypasses
     the file-reading function entirely.
  **One relayed claim did not reproduce** (widening WAKE_MARKERS: fails six
  tests). Checked rather than accepted.
  **Recorded, not done:** the flaky timing tests. Three attackers and I each took
  at least one false reading from them today; 6/6 green quiet, 2/5 red under
  load. Until that is closed, every green/red reading taken while other work runs
  is unreliable -- including the ones above, which is why each was re-verified
  from a confirmed baseline.
  Rework rounds this tick: 0. T4 remains blocked on data. Armed: ScheduleWakeup.
