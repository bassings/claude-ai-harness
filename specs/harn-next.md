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

- [ ] **T1: adversarial pass against `main`.** Owner decision 2026-09-05: keep
  the adversarial mutation pass as a standing practice rather than a gate on one
  branch. The shape that worked: a fresh agent picks the mutations, is told to
  assume every mutation the author ran was chosen to succeed, and is told a
  GREEN result is the finding. Scope it to guards NOT covered by the four rounds
  already done, since those were attacked hard. Findings go through the normal
  spec/review gate; nothing is fixed inside the pass.

- [ ] **T2: make the SonarQube coverage number real, or remove it.** The
  dashboard reads 0%, which is not a measurement: SonarQube reads a coverage
  report the scan uploads and none was uploaded, while the suite has 1165
  passing tests. Node's built-in lcov reporter emits an empty file here, so this
  needs a different route (c8, or a reporter that works) or an explicit decision
  to stop publishing a coverage figure at all. **An absence displayed as a fact
  is the defect class this repo exists to catch**, and it is currently doing it
  on its own dashboard.

- [ ] **T3: triage the SonarQube findings that survive correct configuration.**
  192 open after sources and tests were split. Do NOT dismiss to move the
  number. Two things are already known and must be recorded before anything
  else: 14 of the 16 "bugs" are one rule whose recommended fix would introduce a
  real defect (it wants `localeCompare`, which is locale-dependent, on sorts
  feeding a cross-machine drift comparison that must be identical on two
  machines); and one is a genuine find, a raw control byte in source where the
  sibling line uses the readable escape.

- [ ] **T4: the delivery comparison, when there is enough data.** Baseline is 15
  review rounds per real-work PR as at 2026-08-24. Measured 2026-09-05: four to
  five real-work PRs since, not the ten this needs. **Do not compute early.**
  Settle explicitly, before computing, whether the one severe outlier is in or
  out: four rounds, circuit-breaker tripped, the same data-destroying defect
  three times, shipped disabled. At n≈10 that single item moves a median on its
  own.

## Conductor log
