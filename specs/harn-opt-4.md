# HARN-OPT-4: make the ledger record what the review actually found, and the optimiser measure the repo it was pointed at

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** agreed (83 ACs; planning run `wf_41a4c6dc-691`, 2026-10-11)
**Lenses run:** security, qa, simplicity, product, data, operability · **Skipped:** design, accessibility (no user-facing surface: workflow scripts, a JSONL ledger, a skill file and an operator-read report), architecture (no new module, boundary or dependency; not triggered)

> **Tasks and Decisions below were rewritten after planning** to match the
> arbitrations and vetoes recorded under "Acceptance criteria". The original
> draft proposed a per-lens tally (T2), an escalated fourth TDD attempt (T5),
> a lens on each AC verdict (T3), a `spec_absent` flag (T4), a `lens_also`
> list (T1), an optimiser install check (T6) and a `budget_counter` field
> (T8). Every one was vetoed with a recorded reason; see "Vetoed at
> planning". The problem table is unchanged: it is the measurement, and the
> vetoes are about the remedy.

## Problem

Two `/optimise-cycle` runs on 2026-10-11, one against this repo (85 ledger
records, run `wf_c0624212-437`) and one against CouchPotatoServer (74 records,
run `wf_bb154cc5-ca4`), each produced a ranked proposal list. Read together,
the proposals say one thing: the ledger does not hold what the review found,
so every ranking the optimiser can produce is built on a biased sample, and
two of the optimiser's own lanes measure the wrong thing. The measurements,
all from the two reports (copies in the session scratchpad; the repo copy at
`.claude/optimise-cycle-report.md` is overwritten each run):

| Defect | Scale in the window | Where |
|---|---|---|
| Review findings are capped at `MAX_FINDINGS` (15) per record and the overflow never reaches the per-lens counts | 22 of 27 completed reviews hit the cap; `findings_truncated` sums to 396 against 354 recorded, so 53% of findings are invisible to rework attribution | `workflows/lib/ledger-append.mjs:85` |
| A finding whose lens label names two lenses (`lens-security + lens-architecture`) fails `LENS_PATTERN_STR` and is nulled | 63 of 354 findings (18%) have `lens: null`; every retained `lens_raw` is a compound label | `workflows/lib/ledger-append.mjs:177` |
| `ac_verdicts` drop the lens that issued them, so one AC verified by two lenses is counted twice, and a PASS and a FAIL for the same AC coexist in one record | 121 of 538 verdicts (22%) are duplicates; harn-fix-3 AC-QA-1 shows n=8 from 3 reviews | `workflows/review-cycle.js:1187` |
| Reviews run with no spec under a conducted plan, so findings have no AC to anchor to and `spec_bug` is meaningless | 17 of 27 reviews here (87% of findings unanchored); on CouchPotato the 30 Aug review ran with `spec: null` the same morning three plan-cycles completed | `conduct-plan` SKILL.md step 2 names no `spec` argument |
| `tdd-task` stops at `MAX_ATTEMPTS` (3) with `blocked` and no escalation, and the work is then finished by hand with no ledger trace | CouchPotato: 5 of 30 runs blocked, consuming 25.5% of all TDD compute; two of them (A11Y-002, BUG-018) merged as #302 and #303 with no further `tdd_task` or `review_cycle` row | `workflows/tdd-task.js:21` |
| The optimiser's escaped-defect brake runs `git log` in the invoking repo, not the roster repo | Both 11 Oct reports show the identical figure, 26 of 73, because the CouchPotato run counted this repo's commits | `workflows/optimise-cycle.js:383` |
| Proposal ids are derived from a `target` object the drafting agent shapes freely, so the same idea re-proposed gets a new id and the AC-DATA-10 outcome lookup can never match | The 5 Oct run (`wf_d57d2c19-76d`) keyed targets as `{workflow_component, feature}`; the 11 Oct run keyed them as `{component, concern}`; two 11 Oct proposals say in prose that they "reinstate" a 5 Oct proposal the id lookup could not see | `workflows/optimise-cycle.js:636` |
| The CI lane aggregates by workflow name, so a workflow's jobs are one row, per-PR job names are one row each, and `renameSuspect` fires on any job absent from the window's very first run | CouchPotato: 16 of 17 rows rename-suspect, including `CI::CI` at n=26 with no failures; here, 2 failed runs in 20 (a test matrix and the scheduled gitleaks job) are invisible | `workflows/optimise-cycle.js:365`, `workflows/lib/optimise-read.mjs:1195` |
| `budget_spent` looks like a session-cumulative counter, not this run's cost | Five consecutive 5 Sep reviews recorded 1.70M, 1.89M, 2.16M, 2.40M, 2.65M; a new session reset to 1.43M | `workflows/review-cycle.js:509` reads `budget.spent()` once, at the end |

Who pays: the operator, who reads a ranked list that cannot rank; the next
optimiser cycle, which the skill's own decaying-cadence rule would now halve
to fortnightly because two cycles produced no adopted proposal, when the dry
cycles are caused by broken instruments rather than by nothing to find; and
every CouchPotato task that blocks at the TDD cap and silently leaves the
harness.

## Not in scope

- **The Codex harness.** Every defect above has a counterpart in
  `codex-ai-harness` by design, since its ledger copies this one's field
  names. Those land through `specs/PLAN-harness-parity.md` tasks C1 (ledger
  alignment) and K2 (optimiser reads `.codex/harness-ledger.jsonl`), both
  held by the owner since 2026-09-20. This spec does not touch that repo and
  does not un-hold that plan. Each task below names which of its changes the
  parity plan must carry across, so nothing is lost when it resumes.
- **Removing, demoting or skipping any lens or check.** Nothing here reads
  the escaped-defect counter-metric as licence for a removal; the skill
  forbids it and no proposal in either run asked for one.
- **A scheduled optimiser routine.** None exists today. Whether to create
  one is an operator decision after this spec lands and the first cycle on
  the repaired ledger has run.
- **Rewriting existing ledger rows.** Old rows stay as written; readers
  label and count what they cannot interpret, as the ledger's own
  conventions already require.

## What this replaces

| What goes | Owning lens | Removal criterion |
|---|---|---|
| The free-shape `target` object in the proposal drafting schema (`optimise-cycle.js` synthesis:proposals), replaced by a fixed key set the id is derived from | lens-architecture | AC-ARCH-<n> |
| The git lane's "In the CURRENT repo" instruction, replaced by a per-roster-repo loop keyed by repo | lens-data | AC-DATA-<n> |
| The CI lane's `gh run list`-only aggregate, replaced by per-run job metadata | lens-operability | AC-OPS-<n> |
| The whole-window `renameSuspect` heuristic in `optimise-read.mjs`, replaced by a per-workflow one | lens-qa | AC-QA-<n> |

Nothing else is removed. `findings_truncated`, `lens_raw` and the capped
`findings` array all stay: the tally proposed in T2 is additional to the
shortfall report, never a replacement for it.

## Decisions taken up front

- **No per-lens tally (T2 as drafted was vetoed).** `findings_by_lens` was
  removed at fix round 4 of `harn-ledger-validators` after it produced a
  defect in every round it existed. The draft proposed reinstating it with
  roster-bounded keys. `lens-simplicity` vetoed it (AC-SIMP-1) and
  `lens-data` independently found the tally cannot apply the cross-round
  fixed dedupe because it carries no ids, the same recorded defect. The
  measured cause of the 53% shortfall is the cap of 15 against a measured
  maximum of 50 findings per review, so T2 is now a raised `MAX_FINDINGS`
  (at least 60) and nothing else. Proposal 5d33f4b72416bb74 is recorded
  rejected with this reason.
- **No escalated TDD attempt (T5 as drafted was vetoed).** CLAUDE.md §2's
  rounds 4 to 5 escalation stays prose for now. `lens-simplicity` vetoed
  the scripted fourth attempt (AC-SIMP-5) on four grounds: no workflow
  passes a model option and the fake runtime cannot prove the real one
  honours it; the revert test needed ten or more cap hits where CouchPotato
  produced five; the draft contradicted itself on the terminal outcome; and
  `lens-product` called it a delivery change inside a measurement spec. T5
  keeps the visibility half: a closed-enum `blocked_reason` on every
  terminal row (verified non-derivable: the tests-modified exit and the cap
  exit both record `implement_attempts: 3`) and a ledger-only
  blocked-unresolved metric labelled as an upper bound. Proposal
  d0930db0fc75d6c4 is recorded partially adopted with the escalation named
  as declined, so the next cycle may re-propose it under its own id once
  there are enough cap hits to test it.
- **`budget_spent` is confirmed before it is changed (T8).** The
  session-cumulative shape is an inference from data. The first step of T8
  instruments one run with a start and end read and records what the
  runtime actually returns; the field change follows only if the inference
  holds, and the finding is recorded in the task log either way.
- **Cadence.** By the optimise-cycle skill's rule this is the second
  consecutive dry cycle and the cadence should halve. Overridden for one
  cycle: both dry cycles are explained by the defects this spec fixes. The
  next cycle runs after this spec ships, at weekly, and states the override
  in its own report (AC-PROD-12). Nothing is written into the skill file
  (AC-SIMP-13); if that cycle is itself dry, the decay rule applies from it.
- **Proposal outcomes are recorded as each task merges** (AC-PROD-11). The
  conductor appends one `proposal_adopted` or `proposal_rejected` event per
  optimiser proposal a merged task acts on, using
  `workflows/lib/ledger-append.mjs` exactly as the skill documents, with the
  11 Oct id listed per task below. At T6's merge tick each event is
  re-recorded under the id the new derivation gives the same target, and
  the old events stay as written (AC-DATA-14).
- **Proportionality, recorded for the conductor** (lens-simplicity): T1 and
  T2 ship as one PR; T3 and T8 are reviewed with `lens-security` and
  `lens-qa` only; T4, T5, T6 and T7 get the full triggered set.
- **`SCHEMA_VERSION` is bumped once in the first PR to merge** (AC-OPS-3,
  AC-PROD-10), so every post-change row is separable from the 85 and 74
  legacy rows, and again in T8 only if T8 changes what `budget_spent` means.

---

## Tasks

Each task is one PR. State transitions and the conductor log follow
`~/.claude/skills/conduct-plan/SKILL.md`.

- [ ] T1: `ledger-append.mjs` (one PR with T2): parse a compound lens label (`a + b`, `a, b`, `a and b`) to its first roster lens as `lens` before validation, input length capped before any regex, so the finding is attributed instead of nulled; `lens_raw` keeps the original label under today's bound; no new field (AC-SIMP-2); finding ids unchanged (AC-QA-3); `SCHEMA_VERSION` bumped in this PR (AC-OPS-3). Adopts 11616d2e34021f6c. — state: queued
- [ ] T2: `ledger-append.mjs` (same PR as T1): raise `MAX_FINDINGS` to at least 60 and nothing else (AC-SIMP-1); prove by execution that a 50-finding, 96-verdict payload writes `findings_truncated: 0` within `MAX_LINE_BYTES` (AC-QA-5) and that 400 hostile findings still write a full envelope (AC-SEC-3). Records 5d33f4b72416bb74 rejected. — state: queued
- [ ] T3: `optimise-read.mjs` only (AC-SIMP-3; security and qa review): count at most one verdict per (repo, run_id, canonical ac_id) with worst-of precedence (FAIL over UNVERIFIABLE over PASS), a separate disagreement counter, never trusted on a truncated verdict array (AC-DATA-8); corrects the 121 historical duplicates on read. Adopts b1ada9729ad2b0f7. — state: queued
- [ ] T4: `review-cycle.js` and `skills/conduct-plan/SKILL.md`: review-cycle gains a validated integer `round` argument written to the row (null when absent, never 0; AC-QA-13) and its report states the no-spec consequence; `spec: null` stays the only no-spec signal (AC-SIMP-4); the conductor's review step names both `spec` (the task's spec or the plan file, repo-relative) and `round`, pinned by a static test (AC-QA-14); the reader separates no-spec reviews with a `round` (conducted) from those without (AC-OPS-4). Adopts 8d9f17f50d553916; partially adopts fa0b22e6f33dd9d1 (its `prior_findings` half is already in the skill and is a conductor-compliance matter, named as declined). Parity: the Codex conduct skill has the same gap. — state: queued
- [ ] T5: `tdd-task.js` and `optimise-read.mjs`: a closed-enum `blocked_reason` {`test_attempt_cap`, `implement_attempt_cap`, `tests_modified`} on every terminal row, null on done or aborted, one value per existing BLOCKED exit, free text neutralised (AC-OPS-5, AC-QA-17); no escalation, no `attempt_cap_hit`, `MAX_ATTEMPTS` stays 3 (AC-SIMP-5); the reader reports blocked rows with no later `done` row for the same (repo, spec, task) as an upper bound (AC-QA-18, AC-DATA-9); a stale installed writer cannot cost the terminal row (AC-DATA-2). Partially adopts d0930db0fc75d6c4, escalation named as declined. Parity: C3's `tdd_gate.py`. — state: queued
- [ ] T6: `optimise-cycle.js` and `optimise-read.mjs`: the git lane runs per roster repo, each result matched script-side to its `scope.resolved` root and rendered by label never path, a mismatch reported not merged (AC-DATA-11, AC-SEC-10, AC-OPS-13); the drafting schema requires the fixed target key set `{kind, component, concern, lens, workflow, job, touches_always_on_lens, security_purposed}` and the id derives from the six string fields case-folded and trimmed, `repo` excluded (AC-QA-20, AC-DATA-15); the removal gates still see every key they need (AC-SEC-9, AC-QA-21); no install-consistency check (AC-SIMP-7); at this task's merge tick every outcome event recorded under an 11 Oct id is re-recorded under its new id (AC-DATA-14). Adopts 07334cfa3dda840d; closes the id defect found in the 5 Oct and 11 Oct journals; af4ba12ff078481a partially adopted with the install check named as declined. — state: queued
- [ ] T7: `optimise-cycle.js` and `optimise-read.mjs`: the CI lane lists run ids, attempt and status with `gh run list`, then fetches `gh run view <id> --json jobs` per run, digits-only ids, never logs (AC-SEC-11, AC-OPS-12); rows are (repo, workflow, normalised job) with n, failure count, failed run ids and mean (AC-OPS-9, AC-DATA-13); instance suffixes normalised by a bounded regex (AC-QA-24, AC-SEC-12); `renameSuspect` per workflow (AC-QA-25); re-runs and partial fetches can never yield never-failed (AC-OPS-10, AC-OPS-11); no cache (AC-SIMP-12); no actor or title fields requested (AC-SEC-14). Adopts e72a9f3258e34591, 41b77671f3894a54, 7edd6a77f91faa17. — state: queued
- [ ] T8 (security and qa review): first, instrument one real run with a start and end `budget.spent()` read and record the raw readings and the conclusion in the Conductor log before any field change (AC-QA-27); if session-cumulative, each of the three workflows records end minus start as `budget_spent`, null on a reset or a missing start read (AC-DATA-17), proven with a stateful stub (AC-QA-28), with a second `SCHEMA_VERSION` bump; no `budget_counter` (AC-SIMP-8); if per-invocation, record the finding, touch nothing under `workflows/`, and record 72080e02c7178e0d rejected. — state: queued

## Risks

Ranked by recoverability.

- **Expensive: T2 repeats the `findings_by_lens` history.** Mitigation is in
  the design (fixed roster keys, so the line size is bounded by
  construction) and in AC-QA criteria the planning lens writes: a record
  with 400 distinct synthesis lens names must still write a full line.
- **Expensive: T4 changes the conductor skill, which is prose.** A conductor
  that forgets to pass `spec` is the failure this task exists to fix; the
  `spec_absent` flag on the ledger line is the enforced half, and the next
  optimiser run is the check.
- **Cheap: T6 breaks id continuity.** Recorded per task above; the old ids
  are written as adopted so nothing is lost, and the mapping is in T6's PR.
- **Cheap: T7 multiplies `gh` calls.** One `gh run view` per run in the
  window, up to 100 per repo. Rate limiting is already a named, non-fatal
  lane outcome; T7 adds caching only if the next run shows it is needed.
- **Cheap: T8 is withdrawn.** That is a legitimate outcome and is recorded.

## Affected files

| Path | Change |
|---|---|
| `workflows/lib/ledger-append.mjs` | T1 compound lens parse; T2 bounded tally field and schema |
| `workflows/lib/optimise-read.mjs` | T2 tally reader; T3 verdict dedup and disagreement counter; T5 blocked-then-merged metric; T6 id derivation and per-repo git lane result; T7 per-job CI aggregate, name normalisation, per-workflow renameSuspect |
| `workflows/review-cycle.js` | T3 verdict carries lens; T4 `spec_absent` and `round`; T8 budget delta |
| `workflows/tdd-task.js` | T5 escalated attempt, `attempt_cap_hit`, `blocked_reason`; T8 budget delta |
| `workflows/plan-cycle.js` | T8 budget delta |
| `workflows/optimise-cycle.js` | T6 git lane per repo, fixed-key proposal target, install-consistency check; T7 CI lane per-job fetch |
| `skills/conduct-plan/SKILL.md` | T4 pass `spec`, record `round` |
| `skills/optimise-cycle/SKILL.md` | T6 id derivation and install check documented; cadence override recorded |
| `workflows/lib/ledger-schema-fields.json` | T1, T2, T4, T5, T8 new fields exported |
| `test/*.test.js` | one test file per task, RED before GREEN per §1 |
| `specs/PLAN-harness-parity.md` | T4, T5 add a note under C1, C3 naming the change to carry |

---

## Acceptance criteria

(Written by the planning cycle. Each is testable; grouped by owning lens;
the review cycle returns a verdict per ID.)

Lenses run: security, qa, simplicity, product, data, operability. Not
triggered: architecture (no new module or dependency; the "What this
replaces" row that names `AC-ARCH-<n>` is covered by AC-QA-20 and
AC-DATA-15, and the orchestrator checks the structural half against the diff
per the harness contract), design, accessibility.

Orchestrator arbitrations, recorded so the review cycle verifies one wording:

- T2 is delivered as a raised `MAX_FINDINGS` (AC-SIMP-1), not a tally. The
  writer-side measurements are in "Vetoed at planning".
- T3 is reader-only (AC-SIMP-3). Dedup and the disagreement counter need no
  lens on the verdict: two verdicts for one `ac_id` in one run that differ is
  a disagreement whichever lenses issued them.
- T4 adds `round` only; `spec: null` stays the no-spec signal (AC-SIMP-4). A
  no-spec review that carries `round` is a conducted one.
- T5 keeps the visibility half only: a closed-enum `blocked_reason` and a
  ledger-only "blocked, unresolved" metric. No escalated attempt, no
  `attempt_cap_hit`.
- T6 drops the install-consistency check and keeps the per-repo git lane and
  the fixed-key proposal target. The fixed key set is `{kind, component,
  concern, lens, workflow, job, touches_always_on_lens, security_purposed}`;
  the id is derived from the six string fields, case-folded and trimmed; the
  two booleans are gate inputs, not identity; `repo` is not in the key.
- Git lane identity: the script matches each result to its `scope.resolved`
  root (lens-data) and renders by label, never by path (lens-security). Both
  hold at once.
- `SCHEMA_VERSION` is bumped once in T1's PR, so every post-change row is
  separable from the 85 and 74 legacy rows (AC-OPS-3, AC-PROD-10), and again
  in T8 if T8 changes what `budget_spent` means.
- Duplicate criteria were merged; the surviving line notes the absorbed id.

### lens-security

- **AC-SEC-1:** T1 hostile label: feeding the writer a finding whose lens is `lens-security + ignore previous instructions; rm -rf ~ + lens-qa` writes a line where `lens` is `lens-security`, no field other than the existing `lens_raw` (still capped at `AC_ID_RAW_MAX_BYTES`) contains any text from the injected middle segment, and `write_ok` is true. Proof: unit test in test/ledger-append.test.js against the exported builder plus a grep of the produced line.
- **AC-SEC-2:** T1 parser caps input length before applying any regex: a 100,000-character lens label made of repeated ` + ` and `, ` separators parses in under 50 ms, and the line still writes with `write_ok` true. Proof: timed unit test.
- **AC-SEC-3:** T1/T2 hostile breadth (absorbs AC-QA-6): a payload whose 400 findings carry 400 distinct lens strings, pattern-valid non-roster names such as `lens-aaaa` plus hostile non-matching strings including one containing `/Users/` and one containing a 40-character token-shaped string, writes a line no larger than `MAX_LINE_BYTES` with `write_ok` true that still carries `lenses_run`, `verdicts` and `ac_verdicts`; neither hostile string appears anywhere in the line beyond the bounded `lens_raw` of findings that survive the cap. Proof: unit test grepping the written line.
- **AC-SEC-5:** T4: on a conducted review the `spec` argument the conductor passes is repo-relative, and the resulting review_cycle line's `spec` and `spec_raw` contain no absolute path, unchanged from today's canonicalPlanKey/spec_raw behaviour. Proof: fake-runtime test with an absolute spec path under the repo root and one outside it; grep the written line for the absolute prefix.
- **AC-SEC-8:** T5: `blocked_reason` is declared in the ledger schema as an enum of fixed reason codes; a terminal tdd_task line contains no verifier evidence, diff text or test output, and a run whose verifier evidence contains `AKIA` followed by 16 uppercase alphanumerics writes a line in which that string does not appear. Proof: unit and fake-runtime test grepping the written line.
- **AC-SEC-9:** T6: the always-on-lens and security-purposed removal gates (isAlwaysOnSecurityRemoval, isSecurityPurposedRemoval, isRemovalShaped) evaluate a proposal whose fixed key set still carries `lens`, `workflow`, `job`, `touches_always_on_lens` and `security_purposed`, or evaluate it before any normalisation that drops keys; three proposals are each still dropped or reclassified exactly as before T6: one drafted with `target.touches_always_on_lens: true`, one whose only security signal is the word `gitleaks` inside a target field the fixed key set does not keep, one with `target.lens: "lens-security"`. Proof: existing optimise-cycle.test.js gate cases re-run against the new schema, plus the dropped-key case as a new test.
- **AC-SEC-10:** T6: the git lane is invoked only for roots in `scope.resolved`, which have passed the existing SHELL_METACHAR_RE check; a git-lane result whose repo identity is not one the script itself attached from `scope.resolved` is rejected, not merged into another repo's figure; the rendered report keys repos by label, never by root path, and contains no string from `scope.resolved[].root`. Proof: fake-runtime test with two roots and a forged third repo key; grep the report for the root paths.
- **AC-SEC-11:** T7: the CI lane prompt instructs `gh run view <id> --json jobs` only with `<id>` taken from the `databaseId` of that repo's own `gh run list` output and required to be all digits; the prompt contains no `--log`, `--log-failed` or `/logs`; optimise-read.mjs `ci` ignores any run whose id is not an integer or digit string. Proof: static test on the lane prompt plus a unit test on runCiCommand with a non-numeric id.
- **AC-SEC-12:** T7: the instance-suffix normaliser is a bounded, non-nested regex; a 10,000-character job name of repeated ` - Update #1` normalises in under 50 ms; job names, which can be authored by whoever controls a workflow file, reach the synthesis prompt only inside the nonce-wrapped `ci-aggregate` block. Proof: timed unit test plus static check of the synthesis prompt.
- **AC-SEC-13:** T7: after the per-workflow renameSuspect change, a demotion or removal proposal whose target names a job matching SECURITY_CHECK_KEYWORDS_RE (for example the scheduled gitleaks job, now visible with its own failures) is still placed in the flagged security-removal category and requires reinstatement_evidence, even when that job's aggregate is neither insufficientData, truncated nor renameSuspect. Proof: fake-runtime test in test/optimise-cycle.test.js.
- **AC-SEC-14:** Privacy minimisation: the T7 CI lane requests no actor, triggering_actor, author, displayTitle, headBranch or commit-message field from `gh`, and no such field is present in the `runs` payload optimise-read.mjs aggregates or in the report; the change adds no new personal-data field to the ledger, and every new field (`round`, `blocked_reason`) is an integer or an enum. Proof: static test on the lane prompt field list plus a schema test asserting each new field's type.
- **AC-SEC-15:** Removals: this change replaces nothing in the security area; no existing sanitiser, gate, free-text exclusion, root metacharacter check or wrapAsData use is removed, and the existing shell-injection, static-checks and optimise-cycle gate tests pass unmodified except where a test's target shape changes for T6, where the same assertion survives. Proof: diff review plus full test run.

### lens-qa

- **AC-QA-1:** T1: each of the labels `lens-security + lens-architecture`, `lens-security, lens-architecture` and `lens-security and lens-architecture`, written as a finding's lens, produces `lens: "lens-security"` on the written line, with `lens_raw` holding the original label under today's bound exactly as it does for any label that is not a bare roster lens; the same test run against main at 7f3df10 fails because `lens` is null. Proof: unit (ledger-append.mjs, in-process entry builder).
- **AC-QA-2:** T1 hostile labels: `lens-qa + lens-qa` gives `lens: "lens-qa"`; a label containing a newline, backtick or pipe, the empty string, and a bare `+` each give `lens: null` with `lens_raw` retained; for every one of these `write_ok` is true and `lenses_run`, `verdicts` and `ac_verdicts` are still on the line, so no record degrades to envelope-only. Proof: unit.
- **AC-QA-3:** T1 does not change finding ids (absorbs AC-DATA-3): findingId for a compound-label finding is byte-identical to the id main at 7f3df10 computes for the same (label, location, claim), today `7c35753185a55bf1` for (`lens-security + lens-architecture`, `a.js:1`, `c`); a prior_findings entry carrying the pre-T1 id is still confirmed as disposition `fixed` by a post-T1 round, with invalid_prior_ids_dropped and invalid_fixed_ids_dropped both 0. Proof: unit plus integration (review-cycle via fake runtime).
- **AC-QA-4:** T1 reader (absorbs AC-DATA-4): a compound-label finding is counted once, under its primary lens only; for any fixture the sum of every lensDispositionCounts bucket plus unattributedFindings equals the number of findings in the window; a fixture with 3 compound findings lowers unattributedFindings by exactly 3 compared with the same fixture read by the pre-T1 reader. Proof: unit (aggregateRework).
- **AC-QA-5:** T2 writer: a review_cycle payload with 400 findings spread across the roster writes a line with `write_ok` true, `findings.length` at most `MAX_FINDINGS`, `findings_truncated` equal to 400 minus the number kept, and the line no larger than `MAX_LINE_BYTES`; a payload with 50 findings each of the measured maximum size (144 bytes serialised) plus 96 ac_verdicts, the busiest shape in this repo's ledger, writes `findings_truncated` 0, proven by execution, not computed from record sizes. Proof: unit.
- **AC-QA-10:** T3 reader dedup: within one run, PASS from one entry plus FAIL from another for the same ac_id counts n=1 and fail=1, gives never_failed false where n meets the minimum, and adds 1 to the disagreement counter; the result is identical in both input orders; UNVERIFIABLE plus PASS counts as UNVERIFIABLE; three runs that each carry a duplicated verdict give n=3, not 6; two different runs for the same AC give n=2. Proof: unit (aggregateRework plus neverFailingAcs).
- **AC-QA-11:** T3 dedup preserves the existing taints: within one run, `FEAT-1 AC-QA-1` and `AC-QA-1`, for a record whose spec is specs/FEAT-1.md, collapse to one verdict after stripOwnSpecPrefix; a null-ac_id FAIL in the same run still marks the bucket unattributed_fail_in_window; rows written before this change are deduplicated by the same (run, ac_id) rule, so the 121 historical duplicates are corrected on read. Proof: unit.
- **AC-QA-12:** T4: review-cycle invoked with no spec completes with an outcome other than aborted, its terminal ledger line carries `spec: null` exactly as today, and its returned report contains the stated consequence sentence (no spec was supplied, so findings are not anchored to any AC); invoked with a spec, the line carries the canonical spec key. Proof: integration (fake runtime).
- **AC-QA-13:** T4 round: review-cycle given `round: 2` writes `round: 2`; given no round it writes null, never 0; given `"2; rm -rf"`, -1 or 1.5 it writes null and that value is counted in invalid_record_values_dropped, while `write_ok` stays true and the rest of the record is intact. Proof: integration (fake runtime) plus unit (schema).
- **AC-QA-14:** T4 conductor: a static test asserts that the conduct-plan SKILL.md review-invocation step names both the `spec` and `round` arguments, and fails when either is removed from that step; because the skill is prose, the behavioural proof is the first optimiser run after merge, which reports the count of no-spec review_cycle rows that carry `round`, and that count is 0 for rows written after T4. Proof: static test plus operational measurement.
- **AC-QA-17:** T5 keeps the frozen-test gate: when a GREEN verifier reports hashes_match false, tdd-task returns BLOCKED with `blocked_reason: "tests_modified"` and makes no commit call; a RED-cap block never invokes the implementer and carries `blocked_reason: "test_attempt_cap"`; three failed implement attempts carry `blocked_reason: "implement_attempt_cap"`, and a hash mismatch on attempt 3 carries `tests_modified`, not the cap value; a run that goes green carries `blocked_reason: null`; `blocked_reason` is a closed schema enum, and a free-text value is neutralised to null and counted in invalid_record_values_dropped with `write_ok` true. Proof: integration (fake runtime) plus unit (schema).
- **AC-QA-18:** T5 reader (absorbs AC-OPS-8 and AC-PROD-6): the blocked-unresolved metric is a blocked tdd_task row for (repo, canonical spec key, task) with no later `done` tdd_task row for the same key, computed from ledger rows alone; a fixture with a blocked row then a later done row for the same key gives 0, a blocked row alone gives 1, and a fixture shaped like CouchPotato A11Y-002 (blocked row, hand merge, no further row) appears in the list with its spec and task named; the report states that a task finished by hand leaves no resolution row, so the figure is an upper bound. Proof: unit (optimise-read).
- **AC-QA-19:** T6 git lane: given two temp repos with different counts of `fix:` commits, the escaped-defect figures come out keyed by repo and differ, each matching that repo's own `git log`; the repo identity on the result is attached by the script from its resolved root, not supplied by the agent; a result whose identity does not match the ledger record's repo is discarded, and the report renders "not measured" with the reason instead of a number; this test fails against 7f3df10, which reports the invoking repo's figure for both. Proof: CLI integration (optimise-read escaped-defects) plus integration (optimise-cycle via fake runtime).
- **AC-QA-20:** T6 ids: targets that differ only in key order, letter case or surrounding whitespace of the fixed keys produce the same proposal_id; targets that differ in any identity key's value produce different ids; a drafted target missing a required key, or carrying an extra key, is rejected by the drafting schema and listed as rejected in the report, and is never given an id computed from a partial target. Proof: unit (stableProposalId / ids command) plus integration (optimise-cycle).
- **AC-QA-21:** T6 must not disarm the weak-CI-evidence removal brake: a removal-shaped proposal in the new fixed-key form, targeting a CI job whose aggregate is renameSuspect, insufficientData or truncated, is still dropped into droppedWeakCiEvidence; the existing test for this brake is re-pointed to the new key form, not deleted, and fails if ciJobEntryFor stops resolving the job. Proof: integration (optimise-cycle via fake runtime).
- **AC-QA-23:** T7 rows are jobs: job-level input for one workflow `CI` with 3 jobs across 10 runs produces 3 rows each with n=10, no `CI::CI` row and no single row with n=30; a fixture reproducing this repo's window, 20 runs with 2 failures in a matrix leg and the scheduled gitleaks job, shows those two jobs with neverFailed false and the failing run ids in their failure lists. Proof: unit (aggregateCi via the ci command).
- **AC-QA-24:** T7 normalisation (absorbs AC-DATA-13's name cases): `Deploy on PR #301` and `Deploy on PR #302` aggregate to one row with n=2, `Bump x - Update #45` and `#46` aggregate to one row, `build on PR #12` and `build on PR #13` merge into one `build` row, matrix legs `test (18.x)` and `test (20.x)` remain two rows, a name containing `#` anywhere other than the anchored suffix is left unchanged, and a name that would be empty after normalisation is kept under its original name or counted as invalid, never merged into an empty-string key. Proof: unit.
- **AC-QA-25:** Removal (owned by lens-qa): the window-wide renameSuspect comparison (overallEarliestMs in aggregateCi) is gone; workflow A runs from day 1 and workflow B first runs on day 10 with all its jobs present in every run, and no B job is renameSuspect, which fails against 7f3df10; a job that first appears in A's day-5 run is renameSuspect true with neverFailed null; the PROBE3 test at optimise-read.test.js:541 is rewritten to per-workflow semantics, not deleted. Proof: unit.
- **AC-QA-27:** T8 precondition (absorbs AC-OPS-16): the spec's Conductor log records one real run's id, its raw start and end budget.spent() readings, and the conclusion drawn (session-cumulative or per-invocation), before any field change; a T8 PR that changes budget_spent without that record fails review, and if the conclusion is per-invocation T8's PR touches no file under workflows/. Proof: operational evidence in the Conductor log plus diff inspection.
- **AC-QA-28:** T8, if it proceeds (absorbs AC-OPS-15), applies to each of tdd-task.js, review-cycle.js and plan-cycle.js: with a stateful budget stub returning 1000 on the first read and 1250 on the last, the line carries `budget_spent: 250`; a constant-valued stub is not accepted as proof, because it gives 0 whether or not a delta is computed; no budget object gives null; a start read that is null or throws gives `budget_spent: null`, never the end reading; the L5 byte-identical guard covers the start-read code. Proof: integration (fake runtime, each workflow) plus static (L5).
- **AC-QA-29:** Every new field (`round` on review_cycle rows, `blocked_reason` on tdd_task rows) is in ledger-schema-fields.json and the existing drift test passes; each field has a test showing that a wrong-typed value is neutralised and counted while `write_ok` stays true and the rest of the record is intact. Proof: unit.
- **AC-QA-30:** Old rows: a fixture ledger of pre-change rows, one per kind, with shapes taken from the existing test fixtures, aggregates without throwing, and every new metric (verdict disagreements, no-spec-with-round count, blocked-unresolved) reports null or "not recorded" for those rows, never a measured 0. Proof: CLI integration (optimise-read ledger).
- **AC-QA-31:** Each task's new or changed tests are shown RED against main at 7f3df10 by the tdd-task verifier, with a failure message naming the behaviour, not an import or syntax error, and the RED evidence is quoted in the PR body. Proof: process evidence (tdd-task RED record).
- **AC-QA-32:** Performance: no threshold is set, because no baseline exists; the first optimiser run after T7 merges records the CI lane's wall-clock time and gh call count per repo in its report, and any later caching proposal must cite that measured number. Proof: operational measurement.

### lens-simplicity

- **AC-SIMP-1:** T2 is delivered as a change to the `MAX_FINDINGS` constant in workflows/lib/ledger-append.mjs, raised to at least 60 (measured worst case is 50 findings per review), and nothing else: neither ledger-append.mjs nor ledger-schema-fields.json contains `findings_by_lens` or any other per-lens tally or disposition-count field, and `findings_truncated` and the existing byte-rescue loop are unchanged. Proof: mechanical: grep the diff for findings_by_lens/tally field names; diff of the MAX_FINDINGS line.
- **AC-SIMP-2:** T1 adds no `lens_also` field and no other secondary-lens field; a compound label resolves to exactly one `lens` value, and the schema's property list for a finding gains no key. Proof: mechanical: grep for lens_also; diff of the finding schema properties in ledger-append.mjs and ledger-schema-fields.json.
- **AC-SIMP-3:** T3 changes only workflows/lib/optimise-read.mjs; the ac_verdicts entries written by review-cycle.js keep exactly the keys {ac_id, verdict}; the disagreement counter is computed reader-side from those rows (its consumer is AC-PROD-3's report line). Proof: mechanical: T3's PR touches no workflows/review-cycle.js or ledger-append.mjs line.
- **AC-SIMP-4:** No `spec_absent` field exists anywhere in workflows/ or in ledger-schema-fields.json; a review row's existing `spec: null` stays the only no-spec signal. Proof: mechanical: grep -r spec_absent workflows/ returns nothing.
- **AC-SIMP-5:** workflows/tdd-task.js dispatches no implementer after MAX_ATTEMPTS: MAX_ATTEMPTS stays 3, both attempt loops keep their bound, no model override or escalation dispatch is added, the count of agent dispatch sites is unchanged, and the terminal row gains no `attempt_cap_hit`; `blocked_reason` is the one field added, because the tests_modified exit at attempt 3 (tdd-task.js:345) is indistinguishable from the cap exit (tdd-task.js:350) by outcome plus rounds. Proof: mechanical: grep tdd-task.js for attempt_cap_hit, escalat, model:; count of agent dispatch sites unchanged.
- **AC-SIMP-6:** The T5 reader metric is computed from ledger rows alone, and the function that computes it adds no git, gh or other subprocess call. Proof: mechanical: the new function in optimise-read.mjs contains no exec/spawn/gh/git call.
- **AC-SIMP-7:** workflows/optimise-cycle.js adds no install-consistency invocation; the diff contains no reference to install-consistency.mjs or checkConsistency. Proof: mechanical: grep the diff of optimise-cycle.js for install-consistency.
- **AC-SIMP-8:** No `budget_counter` field is added; if T8 confirms session-cumulative semantics, the only ledger change is that budget_spent records the delta; if T8 withdraws, T8's PR touches no file under workflows/. Proof: mechanical: grep for budget_counter; T8 diff file list.
- **AC-SIMP-9:** ledger-schema-fields.json gains exactly two fields across the whole spec: `round` on review_cycle rows (T4) and `blocked_reason` on tdd_task rows (T5). Proof: mechanical: diff of ledger-schema-fields.json at the end of the plan.
- **AC-SIMP-10:** No new dependency: the dependencies and devDependencies in package.json are byte-identical before and after every task. Proof: mechanical: git diff package.json is empty.
- **AC-SIMP-11:** No new workflow argument or environment variable is introduced beyond `round` on review-cycle: the whenToUse argument lists of tdd-task.js, plan-cycle.js and optimise-cycle.js are unchanged, review-cycle.js's gains only `round`, and the conductor passes `spec` through the argument that already exists. Proof: mechanical: diff of the whenToUse lines; grep the diff for new process.env reads.
- **AC-SIMP-12:** T7 adds no response cache and fetches no logs: optimise-cycle.js contains no `--log` flag and no cache file or cache map for gh results. Proof: mechanical: grep for --log and cache in the T7 diff.
- **AC-SIMP-13:** The cadence override is not written into skills/optimise-cycle/SKILL.md; that file's diff contains no reference to this spec, to "override", or to the 11 Oct runs. Proof: mechanical: grep the SKILL.md diff.
- **AC-SIMP-14:** Removal list for this lens: nothing in the simplicity area is replaced; the cuts recorded under "Vetoed at planning" are vetoes on additions, not removals of existing code. Proof: stated.

### lens-product

- **AC-PROD-1:** Benefit, stated once: for any review_cycle row written after T1 and T2 whose finding count is at or under the raised `MAX_FINDINGS`, which covers every review measured in this repo's ledger (maximum 50), the report's rework-attribution rows for that run (named roster lenses plus unattributed) sum to the run's full finding count; a review over the cap is labelled with its `findings_truncated` shortfall; a fixture review with 50 findings, 10 of them two-lens labels, yields per-lens counts that sum to 50 with an unattributed figure of 0. Proof: test on an optimise-read fixture plus one real post-ship report.
- **AC-PROD-2:** A finding whose lens label names two roster lenses (`lens-security + lens-architecture`, `a, b`, `a and b`) appears in the report's rework table under a named roster lens and is not counted in the unattributed figure; the unattributed figure counts only labels that name no roster lens at all. Proof: test.
- **AC-PROD-3:** In the report's never-failing-AC and verdict sections, an AC verified by two lenses in one review run counts as one verdict for that run, and a run where two entries returned different verdicts for the same AC is shown in a named, separately reported disagreement count. Proof: test.
- **AC-PROD-4:** Success signal for T4's prose half: the report's no-spec review line separates no-spec reviews that carry a conductor-recorded `round` (conducted) from those that do not (direct); in the first post-ship cycle on each repo, the conducted-and-no-spec count for rows written after T4 is 0. Proof: test plus first post-ship report.
- **AC-PROD-7:** An optimiser run with repos=[X], invoked from a checkout of a different repo Y, reports escaped-defect figures computed from X's history, and the report names the repo each figure came from; two runs over repos with different `fix:` commit histories no longer report the same figure. Proof: test plus rerun.
- **AC-PROD-8:** A proposal re-raised in a later cycle against the same target gets the same proposal_id however the drafting agent words it; a proposal whose id already has a proposal_adopted event shows in the next report annotated with its adoption date instead of being ranked as new; a fixture with two drafts of one target that differ only in wording and key order derives one id. Proof: test.
- **AC-PROD-9:** The report's CI section shows one row per real job, not per workflow name; a job that failed in the window shows its own failure count of at least 1, so for this repo the failed test-matrix job and the scheduled gitleaks job from the 11 Oct window are both visible as failures; per-PR instance names collapse into one row with combined n; a job is marked rename-suspect only when it is missing from its own workflow's earliest run in the window. Proof: test plus first post-ship report.
- **AC-PROD-10:** Success measure: the first optimiser cycle after the last task merges is run on both this repo and CouchPotatoServer, and its sample-completeness section reports, for rows at the new SCHEMA_VERSION kept separate from older rows, the findings invisible to attribution, compound-label findings left unattributed, duplicate verdicts per (run, ac_id), and conducted reviews with no spec, each of which is 0 by construction on post-change rows; if the report cannot separate post-change rows from the 85 and 74 old rows, this criterion fails; the data lands only in the operator's local, untracked report and ledger, and no new field identifies a person. Proof: first post-ship optimiser report, read by the operator.
- **AC-PROD-11:** Every optimiser proposal this spec acts on has exactly one outcome event in the ledger by the time its task merges: proposal_adopted for 11616d2e34021f6c, b1ada9729ad2b0f7, 8d9f17f50d553916, 07334cfa3dda840d, e72a9f3258e34591, 41b77671f3894a54 and 7edd6a77f91faa17; proposal_rejected with the reason for 5d33f4b72416bb74 (the tally was vetoed; the raised cap is a different change); proposal_adopted for the partially adopted ids fa0b22e6f33dd9d1, af4ba12ff078481a and d0930db0fc75d6c4 with the declined part named in the PR body so the next cycle may re-propose it under its own id; proposal_adopted or proposal_rejected for 72080e02c7178e0d per T8's outcome; and at T6's merge tick each of these events is re-recorded under the proposal's new id (AC-DATA-14). Today this repo's ledger holds zero proposal_* events, so this is checkable with grep. Proof: grep of the ledger after each merge.
- **AC-PROD-12:** The next cycle's report states its cadence as weekly and gives the override reason: both earlier dry cycles are explained by the instrument defects HARN-OPT-4 fixed; the override applies to that one cycle only, and if the first post-ship cycle is itself dry the skill's decay rule applies from that cycle with no further override, and the report says so. Proof: read the report.
- **AC-PROD-13:** Removal list for lens-product: none; the one-off cadence override in AC-PROD-12 is an exception, not a removal of the decay rule, and the decay rule text in skills/optimise-cycle/SKILL.md is unchanged. Proof: diff of the SKILL.md cadence section.

### lens-data

- **AC-DATA-2:** An out-of-date installed writer cannot silently cost tdd-task its terminal record: either tdd-task gains the same install-consistency preflight that plan-cycle and review-cycle have, or a terminal row the writer refuses is retried once with only the pre-change fields; test by driving the fake runtime against a writer that rejects `blocked_reason` and asserting that a tdd_task terminal row with outcome blocked is still written, or that the run reports the install inconsistency before the RED phase starts. Proof: execute.
- **AC-DATA-7:** T3 counts at most one verdict per (repo, run_id, canonical ac_id), where canonical means stripOwnSpecPrefix has been applied: in one run, `AC-QA-1` FAIL and `FEAT-011 AC-QA-1` PASS, with the spec being FEAT-011, give n=1, fail=1 and a disagreement count of 1; `OTHER-002 AC-QA-1` in the same run stays in its own bucket; the same AC id in two different runs gives n=2; a null or unknown verdict never wins worst-of and is still counted in unattributedVerdicts. Proof: execute.
- **AC-DATA-8:** T3 worst-of is never trusted on a truncated verdict array: where ac_verdicts_truncated is non-zero for a record, its (repo, plan) bucket is in truncatedBuckets and neverFailingAcs does not report a never-failed result for it. Proof: execute.
- **AC-DATA-9:** T5's blocked-unresolved metric is keyed by (repo, canonical spec key, task), not by spec alone: tasks A and B under the same spec both block and task B later has a done row, and task A is still reported, never cleared by B's done row; the evidence the reader uses for "resolved" (a later done tdd_task row for the same key) is named in the code and in a test. Proof: execute.
- **AC-DATA-11:** T6's git lane result is matched by the resolved repo root the script attached, never by the display label: each per-repo result is accepted only when its root equals a root in `scope.resolved` and its ledger repo identity matches that root's ledger `repo`; a two-repo run whose histories have different fix counts produces two different escaped-defect figures, each attached to the right repo; two uninstrumented roots, which both get REDACTED_PATH_MARKER as their label, never merge or cross-match and are distinguished in the report by roster position, never by path; a result with no root, or a mismatched one, is reported as unmatched and is not counted. Proof: execute.
- **AC-DATA-12:** Removal: gitLanePrompt in workflows/optimise-cycle.js no longer contains the instruction "In the CURRENT repo", and GIT_LANE_SCHEMA's top level is a per-repo array or map; a grep for "In the CURRENT repo" inside gitLanePrompt returns nothing, and a single unkeyed object fails the schema. Proof: execute.
- **AC-DATA-13:** T7 CI rows are keyed by (repo, workflow, normalised job): the same workflow and job in two repos give two rows, where today's aggregateCi merges 6 a/one runs and 6 b/two runs into one `CI::test` row with n=12; the same job name under two workflows gives two rows. Proof: execute.
- **AC-DATA-14:** T6 keeps prior proposal outcomes visible as ledger data, not PR prose: at T6's merge tick, every proposal_adopted or proposal_rejected event recorded under an 11 Oct id is re-recorded under the id the new derivation gives the same target, the old events stay as written, and a re-proposal of that target in the next cycle finds prior_rejection_ts or the adoption annotation non-null through the new-id event. Proof: execute.
- **AC-DATA-15:** T6's fixed proposal key set excludes `repo` from identity, and a test pins the choice: two proposals identical except for repo get the same id, and aggregateProposalOutcomes behaves as the skill documents for a rejection recorded in one roster repo. Proof: execute.
- **AC-DATA-17:** T8 (only if not withdrawn): budget_spent is end minus start only when both reads are finite numbers and end is at least start, otherwise null; a simulated counter reset mid-run (start 2.65M, end 1.43M) gives null, never a negative number; rows written before and after T8's SCHEMA_VERSION bump are never added or averaged together by any reader, and the only reader of budget_spent is the operator. Proof: execute.
- **AC-DATA-19:** No task in this spec rewrites, truncates or reorders an existing ledger line: the ledger's byte prefix before each new-path write (T1 to T5 and T8 payloads) is identical afterwards, and each write adds exactly one line. Proof: execute.

### lens-operability

- **AC-OPS-1:** Deploy shape (absorbs AC-DATA-1): for every field a workflow newly writes (`round` from review-cycle.js, `blocked_reason` from tdd-task.js), a test captures that workflow's actual terminal ledger payload through test/helpers/fake-runtime.js and extract-ledger-payload.js, then passes it to the same commit's ledger-append.mjs degradeEntry and asserts ok:true and invalid_record_values_dropped 0; no PR adds a written field without also adding it to LEDGER_ENTRY_SCHEMA and ledger-schema-fields.json in that PR; the same payload against the writer at 7f3df10 returns ok:false, so the test fails before the schema change. Proof: automated test.
- **AC-OPS-2:** Rollback: main's optimise-read.mjs at 7f3df10, run as `node optimise-read.mjs ledger <root>` against a fixture ledger with at least one new-shape row from every task, exits 0, and every input line is either counted in n or listed in skipped with a reason, so lines in equals n plus skipped.length and no row vanishes. Proof: automated test.
- **AC-OPS-3:** SCHEMA_VERSION in ledger-append.mjs is bumped in T1's PR, the first to merge, so every row written by this spec's changes is separable from the legacy rows, and bumped again in T8's PR if T8 changes what budget_spent means; an optimiser report over a fixture mixing old and new rows shows both versions in its schema-versions-seen output. Proof: automated test.
- **AC-OPS-4:** T4: a review-cycle run with no spec argument writes `spec: null` and returns a report containing a sentence saying no spec was supplied, so findings are not anchored to any AC; the optimiser report prints two counts separately: no-spec reviews that carry a conductor-recorded `round` and no-spec reviews without one. Proof: automated test.
- **AC-OPS-5:** T5: every tdd_task terminal row with outcome blocked carries `blocked_reason` from the closed enum {`test_attempt_cap`, `implement_attempt_cap`, `tests_modified`}, one value per existing BLOCKED exit (tdd-task.js:288, :346, :351), and a row with outcome done or aborted carries null. Proof: automated test.
- **AC-OPS-9:** T7: every CI row the reader emits comes from per-job data out of `gh run view <id> --json jobs`, keyed by repo, workflow and normalised job name; the CI report line for each row prints n, the failure count, the ids of failed runs and the mean duration; given a fixture of 20 runs where one job in each of two workflows failed once, the rendered CI section shows both failures, each against its own job. Proof: automated test.
- **AC-OPS-10:** T7: a run whose gh `attempt` is greater than 1 cannot make its jobs read as never failed: every job row that includes such a run carries a re-run qualifier in the report and has neverFailed null, and a run whose status is not completed is left out of the aggregate and counted per repo in the report. Proof: automated test.
- **AC-OPS-11:** T7 partial fetch (absorbs AC-QA-26): each per-run `gh run view` that fails is counted per repo with its failure mode (rate_limited, unauthenticated, other) and rendered in the CI section; any workflow with at least one failed per-run fetch has neverFailed null on all its job rows with a "jobs partially fetched" qualifier, so a fixture where the unfetched run is the only failing one never yields neverFailed true; a rate limit hit partway through one repo does not abort the other repos. Proof: automated test.
- **AC-OPS-12:** Removal (T7): the CI lane prompt in optimise-cycle.js no longer tells the agent to build rows with `job: <name>` from `gh run list` output; `gh run list` is used only to list run ids, attempt and status; a static test asserts the prompt contains `gh run view` with `--json jobs`, contains no `--log` and no `/logs`, and does not map run list `name` or `displayTitle` to `job`. Proof: automated test.
- **AC-OPS-13:** T6: the escaped-defect section of the optimiser report prints one figure per roster repo, each labelled with its repo; a repo whose git lane failed, or whose result was rejected because its identity did not match the ledger's `repo`, gets its own line naming the repo and the reason, including both repo values on a mismatch; with two roster repos and one failing, the section has exactly two repo lines. Proof: automated test.
- **AC-OPS-17:** Runbook: the "Reading the report" section of skills/optimise-cycle/SKILL.md names every new report label this spec adds (re-run, jobs partially fetched, runs excluded as incomplete, repo mismatch, conducted review without spec, verdict disagreement, blocked unresolved, review over the findings cap), and for each says what it means and what the operator does next. Proof: manual inspection.

### Vetoed at planning

Simplicity's veto applies to anything not traceable to the spec's stated
defects and outside the data-loss, security and accessibility ranks. Each
drop below records the reason and the criteria it removed. Where a lens
supplied a criterion that overturns a veto, that is recorded too.

- Dropped: T2 per-lens tally (vetoed by lens-simplicity, AC-SIMP-1). The measured cause of the 53% is the cap of 15 against a measured maximum of 50 findings per review; raising `MAX_FINDINGS` recovers the same findings with no new field. lens-data independently found the tally cannot apply the cross-round fixed dedupe because it carries no ids, which is the recorded defect that got `findings_by_lens` removed. Removed: AC-QA-7, AC-QA-8, AC-DATA-5, AC-DATA-6, and the tally clauses of AC-SEC-3, AC-QA-5, AC-QA-6, AC-PROD-1. Proposal 5d33f4b72416bb74 is recorded rejected with this reason.
- Dropped: T5 escalated fourth implement attempt (vetoed by lens-simplicity, AC-SIMP-5; lens-product flagged it as a delivery change inside a measurement spec and asked for the split). Four independent reasons: the stated harm is visibility, which the surviving half fixes; no workflow passes a model option and the fake runtime cannot prove the real one honours it, so the "more capable model" is unverified; the spec's own revert test needs ten or more cap hits and CouchPotato produced five in its whole window; the spec contradicts itself on the terminal outcome ("blocked either way" versus a rescue rate). The script's own BLOCKED text and CLAUDE.md §12 place the frame question at three failures. Removed: AC-SEC-6, AC-SEC-7, AC-QA-15, AC-QA-16, AC-OPS-6, AC-OPS-7, AC-DATA-10, AC-PROD-5, and the escalation clauses of AC-OPS-5, AC-OPS-8, AC-QA-17, AC-QA-18. Not vetoed: `blocked_reason`, because lens-operability supplied AC-OPS-5 and the orchestrator verified the tests_modified exit at attempt 3 is indistinguishable from the cap exit by existing fields. Dropped with the escalation: `attempt_cap_hit`, derivable as `blocked_reason === "implement_attempt_cap"`.
- Dropped: T3 writer half, `lens` on each ac_verdict (vetoed by lens-simplicity, AC-SIMP-3). Dedup by (run, ac_id) and the disagreement count both work on today's {ac_id, verdict} rows, the reader-only change also corrects the 121 historical duplicates, and it removes the whole-record refusal risk lens-data found for a nested field on a stale installed writer. Removed: AC-SEC-4, AC-QA-9. Kept: the reader-side disagreement counter, because lens-product supplied its consumer (AC-PROD-3).
- Dropped: T4 `spec_absent` flag (vetoed by lens-simplicity, AC-SIMP-4). `spec: null` already carries the fact and optimise-read.mjs already reclassifies on it. The conducted-versus-direct split lens-product and lens-operability need comes from `round`, which is kept. Removed: AC-DATA-18, and the spec_absent clauses of AC-SEC-5, AC-QA-12, AC-OPS-4, AC-PROD-4.
- Dropped: T1 `lens_also` (vetoed by lens-simplicity, AC-SIMP-2). Nothing consumes it: attribution is primary-lens-only (AC-QA-4) and the original label stays visible in the existing bounded `lens_raw`. Removed: the lens_also clauses of AC-SEC-1, AC-QA-1, AC-QA-2.
- Dropped: T6 optimiser install-consistency check (vetoed by lens-simplicity, AC-SIMP-7). No row of the problem table names a stale install in the optimiser, and the SCHEMA_VERSION bump already makes a stale writer visible in the report. Removed: AC-QA-22, AC-OPS-14, AC-DATA-16. af4ba12ff078481a stays partially adopted with this part named as declined.
- Dropped: T8 `budget_counter` (vetoed by lens-simplicity, AC-SIMP-8). The old-versus-new meaning of budget_spent is separated by T8's SCHEMA_VERSION bump (AC-OPS-3), which is the precedent the writer already records. Removed: the budget_counter clauses of AC-QA-28, AC-OPS-15, AC-DATA-17.
- Dropped: cadence override written into skills/optimise-cycle/SKILL.md (vetoed by lens-simplicity, AC-SIMP-13). The override is a one-cycle decision and belongs in that run's report, as the spec's own Decisions section says.
- Dropped: the "blocked runs whose spec later merged" join (lens-qa, lens-product and lens-data all found no merge signal exists for the motivating cases, which were finished by hand). Replaced by the ledger-only blocked-unresolved metric (AC-QA-18, AC-DATA-9, AC-SIMP-6), labelled as an upper bound.
- Dropped: the old-to-new proposal id mapping as PR-body prose (lens-simplicity and lens-data agree it matches nothing). Replaced by re-recording outcome events under the new ids at T6's merge tick (AC-DATA-14, AC-PROD-11).
- Not vetoed, recorded for the conductor (lens-simplicity proportionality finding): T1 and T2 ship as one PR; T3 and T8 are reviewed with lens-security and lens-qa only; T4, T5, T6 and T7 get the full triggered set.

---

## Vetoes and trade-offs

| Item | Raised by | Decision | Rationale |
|---|---|---|---|
| | | | |

## Conductor log

(Appended by the conductor.)

## Review cycle

(Appended per round.)
