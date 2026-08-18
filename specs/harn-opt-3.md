# HARN-OPT-3: turn a hardened harness into measured delivery improvement

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft
**Lenses run:** conductor scoping only, from measured state. Full planning
cycle NOT yet run: do that before T2 or T3 is built.
**Skipped so far:** everything. This document is a scope, not a plan.

## Problem

HARN-OPT-1 and HARN-OPT-2 built and hardened the measurement instrument. Three
PRs merged, roughly 9M tokens, and the harness now writes a run ledger, fails
closed on a dropped trigger override, pairs start/terminal records, and has a
weekly optimiser whose rollback has actually been executed.

**None of that has yet changed how fast anything ships.** The original ask was
three questions: get coding agents to need fewer loops, make the pipeline
faster without eroding quality, and run more agents concurrently. HARN-OPT-2
answered none of them. It made the thing that would answer them trustworthy,
which was necessary and is now done.

The measured position today:

- **The optimiser is blind in three of its five lanes.** `MIN_RECORDS_FOR_PROPOSALS`
  is 5 (`workflows/optimise-cycle.js:25`). The harness repo has 10 ledger
  records; **both delivery repos have zero**. So rework attribution, wall-clock
  decomposition and trigger accuracy produce nothing for the repos that matter,
  and the weekly report correctly says `uninstrumented` for both.
- **Said of You's CI is unmeasured per job.** `CI::CI` collapses six jobs into
  one number, so the critical path (e2e 210-229s running in parallel with
  CodeQL 225-236s) is invisible. Its remediation plan is blocked with ~610 of
  ~625 purchased Actions minutes spent.
- **Couch Potato produced no telemetry for ten days** and nothing warned. That
  cause is fixed (PR #260); the effect, an empty ledger, is not.

So the value of everything built so far is gated on data that does not exist
yet. That is what this plan is for.

## Not in scope

**Further hardening of the harness for its own sake.** HARN-OPT-2 ran to eight
fix rounds and four review rounds on one PR, and hit its own circuit-breaker.
The pull to keep polishing the instrument is exactly what this plan resists.
Correctness debt is included below only where it can cause a wrong conclusion
or a silent loss, and each item says which.

To change that: a defect that produces a wrong optimiser proposal, or a silent
lens loss, qualifies. A defect that is merely untidy does not.

**Anything requiring the owner's hand** is listed separately at the end and is
not a task here.

---

## Tasks

- [ ] T1: Instrument the delivery repos so the optimiser has data — state: queued
- [ ] T2: Per-job CI decomposition for Said of You — state: queued (needs: T1)
- [ ] T3: The correctness debt that can cause a wrong conclusion — state: queued
- [ ] T4: Mechanise the housekeeping that keeps recurring — state: queued

Ordering rationale: T1 is cheapest and unblocks the most. T2 is the original
question. T3 and T4 are independent of both and can run in parallel.

---

## Acceptance criteria

### Product

- **AC-PROD-1:** After T1, a subsequent `/optimise-cycle` run against each
  delivery repo reports a non-zero ledger record count and produces at least
  one harness-side proposal, or states precisely which lane is still short of
  `MIN_RECORDS_FOR_PROPOSALS` and by how many records. "Uninstrumented" is no
  longer an acceptable output for either repo.
- **AC-PROD-2:** After T2, the optimiser's CI section lists individual jobs
  (`CI::secrets`, `CI::quality`, `CI::e2e`, ...) with their own n, mean
  duration and failure ids, not one synthetic `CI::CI` row, and the report
  identifies which job is on the critical path.
- **AC-PROD-3:** The plan states, in measured terms, what changed about
  delivery: a before/after on at least one of billed CI minutes per PR, review
  rounds to clean, or wall-clock from PR raised to merged. A plan that ships
  every task and cannot answer this has not delivered its stated purpose.

### QA

- **AC-QA-1:** *(carried, owner-deferred from HARN-OPT-2)* Plan identity
  resolves repo-relative first, falling back to cwd-relative only when the
  repo-relative form escapes the repo. Today the convention is documented but
  the writer resolves cwd-first, so the documented and actual behaviours differ.
- **AC-QA-2:** Every guard added by this plan is proven load-bearing: the
  mutation applied, the test observed failing, `git diff` confirming the edit
  landed on the intended line, and the restored suite green. **This is not
  boilerplate.** On HARN-OPT-2 a mutation silently failed to apply three
  times and returned a meaningless green each time.
- **AC-QA-3:** Any test asserting "is this evidence?" enumerates the valid
  values and asserts everything else is not evidence. It must never match on
  the shape a fix happens to produce. Seven recurrences of the opposite on
  HARN-OPT-2, three of them inside verification rather than code.

### Security

- **AC-SEC-1:** *(F9, carried)* The `spec` field's position-0 segment cannot
  leak an absolute path through `canonicalPlanKey`. Rejected twice with
  evidence on HARN-OPT-2 because that function had three recorded regressions
  in one PR; it is included here because a leak reaches the ledger, the report,
  and the synthesis prompt. Any fix must carry a regression test per prior
  regression, not just for the new case.
- **AC-SEC-2:** *(F15, carried)* AC ids from different specs cannot collide in
  the ledger's `ac_verdicts` aggregation. Today `AC-SEC-1` from two different
  specs is one bucket, so "which AC never fails" silently merges unrelated
  criteria and can retire a guard that does fail.
- **AC-SEC-3:** Dictionary **keys** in the ledger (`verdicts.<lens>`,
  `trigger_counts.<key>`, `rounds.<key>`) are schema-constrained. Verified
  still open: `grep -c "propertyNames" workflows/lib/ledger-append.mjs` returns
  0, so only values are constrained and a hostile key with a valid value
  reaches the ledger untouched. Latent since round 2 of HARN-OPT-2.
- **AC-SEC-4:** The production dynamic-workflow runtime's enforcement of a
  schema's `required` list is verified against the real runtime, not the test
  double. **The entire fail-closed design shipped in PR #6 rests on this** and
  it has only ever been checked against `test/helpers/fake-runtime.js`. If
  production enforcement is weaker, AC-SEC-1 of that spec is unproven and the
  silent-fallback defect is not actually closed.

### Architecture

- **AC-ARCH-1:** `plan-cycle.js` and `review-cycle.js` agree on where lens
  triggering comes from. Verified still open: `grep -c "harness-triggers"
  workflows/plan-cycle.js` returns 0, so planning asks an agent for booleans
  while review reads a repo's override file. A repo that tunes review
  triggering silently gets none of it at planning time.
- **AC-ARCH-2:** *(AC-ARCH-12, carried)* A failed optimiser lane is
  distinguishable from a lane that ran and found nothing. Today
  `ledgerLaneFailed` is a bare boolean because `agent()` resolves to
  `undefined` on failure with no reason captured. The implementer correctly
  stopped rather than pad an unreachable value in; a real fix needs a typed
  failure-reason on the lane schema, which is an agent-facing contract change.

### Operability

- **AC-OPS-1:** The workflow's own worktree isolation removes its branch refs
  when it removes the worktree. Measured twice: 85 stale `worktree-wf_*` refs
  on 2026-08-17, 89 by 2026-08-18, four of them created by that day's own
  review rounds. Swept manually both times, which is precisely the remembered
  rule §9 says to mechanise.
- **AC-OPS-2:** A stale installed mirror is detectable from an artefact rather
  than a remembered `diff`. The `workflows/` mirror self-reports via
  `schema_version`; `bin/` has no equivalent, and its version marker is a
  hand-bumped constant whose test asserts only that some value is present.
- **AC-OPS-3:** Documentation states what is a snapshot and what is invariant.
  Blast-radius counts in a delivery repo's `AGENTS.md` went stale twice inside
  one PR purely from prose not following code.

### Data

- **AC-DATA-1:** *(AC-DATA-16, carried)* The ledger's retention and deletion
  story covers the derived optimiser report, not only the ledger file.
  Deleting `.claude/harness-ledger.jsonl` leaves `optimise-cycle-report.md`
  holding the same figures.

---

## Explicitly rejected, with the reason

Recorded so they are not silently reconsidered:

- **Rewriting `globToRe` to be backtracking-proof.** PR #6 bounded the input
  instead. Rewriting glob compilation is a larger change carrying its own
  risk, and the measured bound (6 wildcards: 8ms, 7: 445ms, 9: 17,375ms) puts
  real use an order of magnitude clear of the cliff.
- **Making the fork ban narrower** (per-filename rather than whole-directory).
  Measured: `.mjs`, nested `lib/`, and uppercase all evade a per-filename rule.
- **A minimum-harness-version assertion against a repo's override file.** No
  mechanism exists for it today, and inventing one is disproportionate to a
  risk that has not yet occurred.

## Owner actions, not tasks here

- **Rotate the plaintext `GEMINI_API_KEY`** in `~/.claude/settings.json`
  (details deliberately not restated; see AC-SEC-9).
- **Triage five open Dependabot PRs on Couch Potato** per §3a, with a recorded
  decision each.
- **Decide on Couch Potato's `required_conversation_resolution`.** Merging
  #260 took four review rounds because each push triggers a fresh review that
  opens a new blocking thread. The findings were good; the loop only
  terminates when a push happens to draw no comment.

## Spec gaps found at review

<Populated by the review cycle. Empty is a claim, not a default.>
