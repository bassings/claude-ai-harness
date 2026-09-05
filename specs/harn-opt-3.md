# HARN-OPT-3: turn a hardened harness into measured delivery improvement

> **CLOSED 2026-08-20.** Its two delivery-facing tasks are gone: T2 dropped on
> measurement, T1 parked for want of a demonstrated problem. What remained was
> harness-internal, which this spec's own "Not in scope" section resists, and
> keeping it here would spend future plan and review cycles on tooling under a
> delivery banner. T3 and T4 continue as **`specs/harn-fix-1.md`**, which makes
> no delivery claim. Nothing below is deleted: the criteria, the vetoes and the
> measurements stay readable, and the orphaned-criteria section records which
> are unreachable. Do not run further plan or review cycles against this file.

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft
**Lenses run:** conductor scoping only, from measured state. Full planning
cycle NOT yet run: do that before T3 is built. (T2 has since been dropped
on measurement and T1 parked; see Tasks.)
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
which was necessary.

> **CORRECTED 2026-08-18, after this document's acceptance criteria were
> drafted.** The sentence above originally ended "and is now done". It was
> not. The instrument was not recording *at all*: `ledgerWritePrompt` called
> `Buffer.from(...)`, and `Buffer` does not exist in the dynamic-workflow
> runtime (measured: `typeof Buffer` and `typeof btoa` are both `undefined`).
> The `ReferenceError` fired while evaluating the argument to `agent()`,
> inside `writeLedger`'s catch-everything block, so no agent was ever created,
> nothing reached the journal, and nothing errored. All three cycle workflows
> stopped writing telemetry on **2026-08-12**, through nineteen commits and
> three merged PRs, and nothing noticed.
>
> Fixed in `d3d51b7` and proven end to end. **The 74 criteria below were
> drafted against the premise that the instrument worked and only the delivery
> repos lacked data. That premise was false for all three repos**, so re-read
> them against this before building. T1 in particular is now a smaller task
> than it was scoped as.

The measured position today:

- **The optimiser is blind in three of its five lanes.** `MIN_RECORDS_FOR_PROPOSALS`
  is 5 (`workflows/optimise-cycle.js:25`). The harness repo has 10 ledger
  records; **both delivery repos have zero**. So rework attribution, wall-clock
  decomposition and trigger accuracy produce nothing for the repos that matter,
  and the weekly report correctly says `uninstrumented` for both.
- **Said of You's CI is unmeasured per job.** One workflow collapses several
  jobs into a single number, so the critical path is invisible. *(Job names and
  measured durations redacted 2026-09-05, owner's decision.)*
  **Do not reason from the Actions-budget figure.** An earlier draft cited
  "~610 of ~625 purchased minutes spent" from
  `docs/plans/2026-08-10-audit-remediation.md:2` as a live constraint. That
  line is from 10-11 August and the blocked state is **disproved**: a full CI
  gate succeeded on PR #412's head `4a006d5` at `2026-08-17T20:28:29Z`, so
  runners were starting. The actual balance is **unknown and unreadable by any
  agent** -- both billing endpoints 404. It is an owner action, not a premise.
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

## Constraints established by other sessions

Measured by the `saidofyou-dc` session and verified where noted. These are not
tasks; they are things any task here must not break.

- **`ci.yml`'s missing `push: branches: [main]` trigger is deliberate and
  load-bearing.** `ci.yml:3-17` documents why: it depends on
  `strict_required_status_checks_policy: true` in the `main-protection` ruleset
  (id 17651307, seven required checks, verified true 2026-08-18). If that policy
  is ever turned off, the post-merge run stops being redundant and the trigger
  must return, or a PR can go green against a stale base. **Preserve that
  comment verbatim**; a decomposition change would reflow it away without
  noticing. Surface any ruleset change rather than adjusting it.
- **Said of You runs production out of that repo under an OLD project name.**
  *(Operational detail redacted 2026-09-05, owner's decision: the original
  named the compose file and line, the live project name, every running
  container, the production database volume and the rollback tags. This repo is
  PUBLIC, and that paragraph was a working runbook for destroying someone's
  production. The reasoning it supported is kept because the harness needs it;
  the identifiers are not, because nothing here needs them.)*
  The generalisable point, which is why this survives at all: a repo whose
  compose project name no longer matches its product name is a trap for any
  agent doing housekeeping. Anything that looks like a stale artefact from a
  previous product may be the live stack, and rollback tags read as clutter.
  Before an agent removes anything in a delivery repo, it confirms with the
  owner what is live, by name, in that repo rather than from a spec.
- **`.stryker-tmp` exists holding only `app-incremental.json`.** Deleting it
  loses roughly 7,000 reused mutant results and turns the next mutation run
  from minutes into very long. It is not rubbish; it will not look broken.
- **Sonar baseline, current as of 2026-08-18T03:18:27Z**: 82.1% coverage, 0
  bugs, 0 vulnerabilities, 0 hotspots, 1.1% duplication over 20,589 lines, 430
  code smells. Useful as T2's before-figure; it was six days stale until
  2026-08-18.

## Tasks

- [ ] T1: Instrument the delivery repos so the optimiser has data — state: **PARKED 2026-08-19**
- [~] T2: Per-job CI decomposition for Said of You — state: **DROPPED 2026-08-19, on measurement** (not done; deliberately not built)
- [ ] T3: The correctness debt that can cause a wrong conclusion — state: queued
- [ ] T4: Mechanise the housekeeping that keeps recurring — state: queued

Ordering rationale: T3 and T4 are independent of each other and can run in
parallel; neither depends on T1 or T2, so both remain deliverable with the
spine of the plan stood down.

**That is true of the tasks and false of the objective, and the distinction
matters more than the schedule.** This plan is titled "turn a hardened harness
into measured delivery improvement" and its Problem section opens "none of
that has yet changed how fast anything ships". T1 and T2 were the only two
tasks pointed at that. T3 is correctness debt and T4 is housekeeping; both are
harness-internal, which is precisely what this spec's own "Not in scope"
section resists. **HARN-OPT-3 can no longer deliver its stated benefit.**

The simplicity veto should be revisited rather than left standing. At
planning, `lens-simplicity` observed that eleven of thirteen original criteria
were harness hardening the Not in scope section resists, and the recorded
counter-argument that defeated the veto was `lens-product`'s "lane yield
argues for T2 early too". T2 has now been dropped on measurement, so that
counter-argument has been withdrawn and the veto was never re-run against
what remains.

**Recommendation, for the operator rather than the next agent: close
HARN-OPT-3 and re-raise T3 and T4 as their own small spec under an honest
title.** Keeping them under a delivery-improvement banner means every future
plan and review cycle is spent on harness internals while the register says
delivery is being improved. That is the failure the optimiser exists to name,
and here it is naming its own plan. The earlier rationale ("T1 is cheapest and
unblocks the most, T2 is the original question") no longer holds and is
replaced rather than left to mislead whoever picks up T3 next.

Checkbox convention, stated because the conductor reads these: `[ ]` is
outstanding, `[x]` is delivered, and `[~]` is closed WITHOUT being built.
T2 is `[~]` -- ticking it `[x]` would tell the conductor work shipped that
never existed. **T1 is parked, not queued**, so the no-stall invariant must
not wait on it; if a conducted run treats a parked task as outstanding, park
it out of the task list entirely rather than leaving the loop to block.

### T2 dropped, and why the evidence is against it

T2 existed to find which CI job to cut. Measured 2026-08-19 against real
GitHub Actions history, before any of it was built:

| | Said of You | Couch Potato |
|---|---|---|
| CI duration, median | 3.9 min | 8.4 min |
| CI duration, p90 | 4.1 min | 9.2 min |
| CI cost per PR (two workflows run per PR) | ~7.8 min | ~9.6 min |

Commands: `gh run list --limit 200 --json name,conclusion,createdAt,updatedAt`
per repo, durations from `updatedAt - createdAt`, cycle time from
`gh pr list --state merged --limit 60` plus each PR's first commit date via
`repos/{owner}/{repo}/pulls/{n}/commits`.

**The share figure first stated here was 7%, and it was wrong to lean on it.**
It divided CI by a denominator that the very next section then disqualifies,
and the working was not shown. Both are corrected here rather than quietly
adjusted, because an unreproducible number gets the task re-proposed.

Two CI workflows run per pull request (CI and CodeQL), so CI costs about
7.8 minutes of wall clock per PR at the medians above. Against the Said of You
sample of 60 merged PRs:

| Denominator | CI share |
|---|---|
| All cycle time, 118h (includes dependency PRs) | 6.6% |
| Authored PRs only, 74h | 10.5% |
| The **median authored PR**, 18 min | **43%** |

The last row is the honest one, and it does not support the original
argument: on the basis this document itself goes on to endorse, CI is not a
rounding error in a pull request, it is most of the clock.

**T2 is dropped anyway, on absolute time rather than share.** Eliminating CI
entirely would save 7.8 minutes per PR, about 7.8 hours across the whole
60-PR sample, and per-job decomposition recovers only a fraction of that
because the jobs run in parallel already. Spending a task to reclaim part of
eight minutes on an eighteen-minute pull request is not a good trade while
anything else is open. That is a proportionality judgment, stated as one,
rather than a measurement that closes the question -- and it is the reason
to prefer it over the share argument, which pointed the other way once the
denominator was chosen honestly.

Recorded as a deletion, per the licence to propose demotions and removals.

### T1 parked, and the honest reason

T1 was to instrument the delivery repos so the optimiser had data. The same
measurement removed its motivating premise.

Decomposing the same 60 merged PRs per repo:

| | Said of You | Couch Potato |
|---|---|---|
| Total cycle time | 118h | 1285h |
| Dependency PRs | 37% of it | 50% of it |
| Authored PR, median end-to-end | 18 min | 307 min |
| Review comments per PR, median | 1 | 14 |

The dependency share is not a process cost: the operator states those PRs sat
because an agent had not yet been assigned to review them, which makes them an
outlier of attention rather than a bottleneck. Removing them leaves a median
authored PR of 18 minutes in Said of You, with the aggregate dominated by a
handful of large changes (top 3 PRs are 70% of the remainder there, 49% in
Couch Potato). Large changes taking longer is not a finding.

So there is no demonstrated delivery-speed problem for T1's data to explain.
It is parked rather than dropped, because one real gap remains and is stated
plainly: **every measurement above starts at the first commit**, so the spec,
plan-cycle, RED-test, review and fix-round time is invisible to all of it, and
that is exactly the phase the ledger would cover. The condition for
un-parking is therefore a felt slowness the PR data cannot see, named by the
operator, not a schedule.

**AC-OPS-3 is explicitly NOT parked with T1.** The park would otherwise take a
live defect down with it: the weekly launchd job exits 0 in silence when its
repo list is missing or empty, and two tests currently pin that as correct. A
weekly job doing nothing is then indistinguishable from one that is working --
same empty `StandardErrorPath`, same exit 0, no `RESULT` line to grep -- and
the only way to notice is an operator wondering why no report has appeared.
AC-SIMP-5 already records that T1 "provably needs" this fixed. It moves to T4
(housekeeping), which is not parked, and is the one piece of T1 that survives
the park.

The Couch Potato divergence (14x the review comments, 19x the wait) is
recorded as an observation, not a target. It is uncontrolled for churn, and
the same review comments were the source of nearly all of the day's real
defect findings, so "fewer review comments" is a dangerous thing to optimise
toward on this evidence.

---

## Criteria orphaned by the T1 park and T2 drop (recorded 2026-08-20)

Nineteen of the criteria below are conditioned on T1 or T2 and keep their
original "After T1..." / "After T2..." wording. They are **unreachable**, not
failed, and are recorded here rather than edited in place so the original
contract stays readable.

This follows the convention the "Vetoed at planning" section already states
verbatim: *recorded so they are not silently reconsidered, and so a review
lens does not mark a phantom criterion PASS*. Round-2 review found that the
convention existed in this file and had not been applied to its own park.

- **Conditioned on T1 (parked):** AC-PROD-1, AC-PROD-2, AC-PROD-3, AC-PROD-5,
  AC-QA-4, AC-QA-5, AC-QA-6, AC-SEC-1, AC-SEC-2, AC-ARCH-3, AC-OPS-6,
  AC-SIMP-5
- **Conditioned on T2 (dropped):** AC-PROD-4, AC-SEC-6, AC-SEC-7, AC-ARCH-4,
  AC-SIMP-4
- **Conditioned on either:** AC-DATA-2's T1 half, AC-OPS-9

A review lens encountering any of these should return UNVERIFIABLE citing this
section, never PASS and never FAIL. If T1 is un-parked, this list is the set
to re-read first.

## Acceptance criteria

> Synthesised from seven planning lenses (security, qa, simplicity, product,
> data, architecture, operability); all returned FINDINGS, none returned
> BLOCKED. Where two lenses raised the same criterion the more testable wording
> was kept and the other ID is noted in brackets. Criteria carried from
> HARN-OPT-2 keep their provenance tag but were re-verified by execution at
> planning: two of them turned out to be already closed and are recorded under
> "Vetoed at planning" rather than silently dropped. Security, architecture,
> operability and data criteria are renumbered against their lens's own set, so
> the bracketed tag is the authority on which earlier criterion each carries.
> Each criterion is one line so the review cycle can verify it directly.

### Product

- **AC-PROD-1:** After T1, an `/optimise-cycle` run scoped to each delivery repo renders a Sample completeness section containing "uninstrumented" for neither repo and reporting, per repo, the raw ledger record count, the number of complete start/terminal pairs (at least one per repo), and the newest record's age in days; where a lane is still below `MIN_RECORDS_FOR_PROPOSALS` the report names that lane and the shortfall as a number. A count made entirely of orphans does not satisfy this: measured at planning, this repo's own ledger holds 10 records and exactly 1 paired run, five start-only and two terminal-only orphans. *(supersedes the count-only wording; merges AC-QA-12 and the freshness half of AC-OPS-1)*
- **AC-PROD-2:** T1 states a separate named cause per repo and fixes each, checkable without rerunning a workflow: for Couch Potato either `grep -rc ledger-append ~/repos/CouchPotatoServer/.claude/workflows/*.js` returns non-zero for every file present or that directory no longer exists; for Said of You the spec records which of "no harness run since the ledger shipped" or "the write is failing" was true, with the command output that settled it. Measured at planning: both Couch Potato files are tracked in a PUBLIC repo, return 0 for that grep, and its `review-cycle.js` is 231 lines against this repo's 756, so the spec's stated cause (the ten-day outage fixed by PR #260) is not the operative one.
- **AC-PROD-3:** The harness repo is covered by the same check as the delivery repos: an `/optimise-cycle` run reports at least one complete start/terminal pair in `.claude/harness-ledger.jsonl` dated after T1's first commit merged, and the spec records the diagnosis of the current stoppage. Measured at planning: the newest ledger line is 2026-08-12T07:22:41Z against 13 delivery commits dated 2026-08-17 and 2026-08-18 including several documented review rounds, so treating this repo as the instrumented one is not currently true.
- **AC-PROD-4:** After T2 the **rendered report** lists each real CI job under its own name with its own `n`, its own mean duration, and its failure run ids, and contains no row whose job name equals its workflow name for a workflow with more than one job. The renderer changes too, not only the `gh` query: `workflows/optimise-cycle.js:1043` prints only `n=` today, so the `meanDurationS` already computed at `workflows/lib/optimise-read.mjs:890` never reaches the operator and the failures list carries only gh-unavailability modes, never a failed run id.
- **AC-PROD-5:** The report names the critical-path job and the parallel-workflow relationship it implies, in the form "PR wall-clock is max(CI, CodeQL); the longest job in CI is `<job>` at `<n>`s mean", with the position derived from per-job `started_at`/`completed_at` timestamps and stated as the share of runs in which each job finished last. A largest-mean implementation must fail the fixture, which includes a run where the longest-mean job starts early and finishes before a shorter one does. *(merges AC-QA-10, AC-DATA-6d, the output half of AC-ARCH-5)*
- **AC-PROD-6:** Before T1's first commit merges, the spec carries a dated baseline table per delivery repo with real numbers and the command that produced each, for a metric reconstructible from GitHub history (billed Actions minutes per PR from the **repo-scoped** `/repos/{owner}/{repo}/actions/workflows/{id}/timing` endpoint, never an account-scoped `/settings/billing/` path, or PR-raised-to-merged wall clock), over a stated set of recent PRs, plus the date the after-read is due and who takes it. "Review rounds to clean" is not eligible as the sole metric: both delivery repos have zero ledger records, so its "before" cannot be reconstructed once T1 lands. The after-read half is labelled UNVERIFIABLE-BY-DESIGN in the spec rather than carried as if a merge could prove it. *(replaces the unsourced wording of the old AC-PROD-3)*
- **AC-PROD-7:** Every proposal in the existing 2026-08-17 Said of You report reaches a recorded decision as a `proposal_adopted` or `proposal_rejected` ledger line in that repo, per `skills/optimise-cycle/SKILL.md:137-145`. Today the gitleaks proposal is adopted in the working tree with no ledger line anywhere, and the `claude.yml` trigger proposal is neither adopted nor rejected, so the prior-rejection annotation and the self-retirement cadence brake are both reading an empty file and the optimiser can retire itself while its proposals are in fact being adopted.
- **AC-PROD-8:** Any before/after claim names and excludes improvements already in flight; specifically the gitleaks check in `~/repos/SaidOfYou/.githooks/pre-push`, whose own comment cites the optimiser proposal it came from, is recorded as prior work with its commit date, not as an outcome of this plan.

### QA

- **AC-QA-1:** *(carried, owner-deferred from HARN-OPT-2; merges AC-ARCH-13)* Plan identity resolution is **lexical** and pinned by a data-driven table asserting an exact `plan_key` for: cwd = repo root with `specs/x.md`; cwd = `<repo>/sub` with `specs/x.md` (the identical bucket to the first, where today it records `sub/specs/x.md`); cwd = `<repo>/sub` with `../specs/x.md` via the cwd fallback; `../../../etc/passwd`; an absolute spec under the root; and an absolute spec outside every candidate root. Repo-relative wins for any relative spec with no leading `..`, the cwd fallback applies only to `..`-prefixed forms, the same spec string yields a byte-identical key whether the target exists or not, and no `fs.statSync`/`realpath`/`existsSync` appears in `canonicalPlanKey`'s body (asserted statically, because resolving with an fs call was reverted in round 5 for making plan identity filesystem-state dependent). The change is applied through **one shared helper at both** caller-supplied relative plan sites in `ledger-append.mjs` `main()` -- `payload.spec` (~:1377) and the `conduct_plan_event` `event_scope` plan segment (~:1274) -- proven by writing a `review_cycle` record and a `conduct_plan_event` for the same plan from the same subdirectory and asserting both land in one `${repo}|${plan}` bucket when read back, with occurrence minting still incrementing to 2 rather than resetting.
- **AC-QA-2:** *(carried)* Every guard added by this plan is proven load-bearing and the proof is recorded in `docs/`, following `docs/pr2-mutation-proofs.md`: the mutation diff or a hash proving the edit landed on the intended line, the observed failing test name and message, and the restored suite green. A mutation that leaves the suite green is recorded as a **failed** proof and the guard rewritten, not re-run. **This is not boilerplate:** on HARN-OPT-2 a mutation silently failed to apply three times and returned a meaningless green each time.
- **AC-QA-3:** *(carried)* Any test asserting "is this evidence?" enumerates the valid values in an explicit table and asserts, in the same test, that an unknown value, `null`, `undefined` and an absent key are all treated as non-evidence. It must never match on the shape a fix happens to produce. Seven recurrences of the opposite on HARN-OPT-2, three of them inside verification rather than code.
- **AC-QA-4:** Per-job CI aggregation cannot merge two distinct `(workflow, job)` pairs. Pinned with the measured hostile case: `{workflow:'CI', job:'e2e::deploy'}` and `{workflow:'CI::e2e', job:'deploy'}` today produce ONE bucket keyed `CI::e2e::deploy`, `n=2`, mean 55s averaged from 100s and 10s, because `workflows/lib/optimise-read.mjs:878` keys on the unescaped `${workflow}::${job}` while every other bucket key in this codebase escapes its components. The table also covers `|`, a backslash, an empty job name and a 300-character job name.
- **AC-QA-5:** A job with no usable completion time (in progress, cancelled, or `completed_at` earlier than `started_at`) yields duration `null`, is excluded from the mean, and is counted under an explicit unmeasured-duration counter rendered in the report -- never 0, never negative, never silently dropped from `n`. Repeat attempts of one run are counted exactly once, or keyed by attempt with the report stating which, proven by a fixture holding both a matrix pair and a rerun and asserting `n` exactly (today two entries carrying the identical run id give `n=2` and average their durations). The report states how many jobs fell below `MIN_RUNS_FOR_NEVER_FAILED` as a consequence of decomposition, and the rename-suspect heuristic is suppressed on a job's first appearance in a newly instrumented dataset rather than nulling every job's never-failed evidence on the first per-job window.
- **AC-QA-6:** Per-job evidence survives citation gating in both directions at realistic volume (6 jobs x 100 runs against `CITATION_POOL_SIZE = 50`): a proposal citing a legitimate id is retained, one citing a fabricated id is dropped, and the pool still spans roughly 50 **distinct run ids** rather than 50 job rows covering about 8 runs. Any proposal dropped for want of a citation is counted and printed rather than yielding a silently shorter list. *(merges AC-ARCH-7)*
- **AC-QA-7:** Four per-repo ledger states render distinctly and no rendered string for one state is a substring of another's: uninstrumented (no file), instrumented-but-empty, lane crash, and stale (newest record older than the stated staleness window, the ten-day Couch Potato silence). One test per state asserts its own wording present and the other three absent.
- **AC-QA-8:** `plan-cycle` applies the same override reader as `review-cycle`, and the review-cycle hostile table is replayed against `plan-cycle`: file-exists-but-rules-null aborts, the reverse contradiction aborts, and unrecognised key, non-array value, empty array, empty glob, over-long glob, too many globs and too many wildcards each abort naming the offending key. The logic lives in **one** implementation, proven by a single mutation to it failing tests in BOTH workflows' test files. *(merges AC-ARCH-3, AC-SIMP-3)*
- **AC-QA-9:** `plan-cycle`'s trigger input set is stated in the spec and pinned by test: a scope step returning zero `likely_paths`, or a path list the globs miss entirely, never yields a roster smaller than the mandatory set but either runs the full roster or aborts, asserted on the lens list actually invoked rather than on a log line. A planning run also logs which rule source governed its triggering, mirroring `workflows/review-cycle.js:536`. *(merges AC-ARCH-4)*
- **AC-QA-10:** `node --test "test/*.test.js"` passes three consecutive runs with zero failures and the warm-run wall clock is <= 90s, measured and recorded in the PR body. Baseline measured at planning: 670 tests, 0 failures, 110s cold and 73s / 59s warm, node v26.7.0. Any new test that spawns a subprocess per case states why the cheaper level could not prove it. *(merges the time half of AC-SIMP-12)*

### Security

- **AC-SEC-1:** No repo instrumented by T1 executes a repo-local copy of a harness workflow the harness did not install: per repo, `git ls-files .claude/workflows` returns nothing, or every retained copy is byte-identical to the installed mirror by `diff -rq`. Measured at planning: `bassings/CouchPotatoServer` is PUBLIC and tracks a 231-line `.claude/workflows/review-cycle.js` against this repo's 756-line file, with `grep -c ledger` returning 0, predating the ledger writer, the custom-rules fail-closed logic and the `HARNESS_LEDGER_READONLY` lens guard -- so any merged pull request there changes what runs on the operator's machine.
- **AC-SEC-2:** After at least one real harness run in each instrumented repo, `git check-ignore -q .claude/harness-ledger.jsonl` exits 0, `git log --all -- .claude/harness-ledger.jsonl` prints nothing, and grepping every line of that repo's ledger for the operator's home directory, the OS username, any absolute path outside the repo, or a credential shape (`AIza[0-9A-Za-z_-]{20,}`, `gh[pousr]_`, `github_pat_`, `sk-`, `AKIA`, `xox[abpr]-`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`) returns zero matches. Baseline stated: Said of You's ledger path is not ignored today and this repo's ledger line 1 carries an absolute spec path, so the criterion governs lines written from T1 onward and the pre-existing line is either removed or knowingly retained, stated either way.
- **AC-SEC-3:** *(F9, carried as the old AC-SEC-1)* `canonicalPlanKey` redacts **every** absolute-path form, not only the `/`-anchored one: `file:///Users/<user>/.ssh/id_rsa` and `\\server\share\secret.md` both return `<redacted-path>`, where measured at planning they return `file:/Users/<user>/.ssh/id_rsa` and `server/share/secret.md`, and that value survives the write path (`path.resolve` then `canonicalPlanKey`) into `plan_key`/`spec` and the reader's re-canonicalisation into the report and the synthesis prompt. The same run keeps green one regression case per previously recorded regression of this function: a relative spec containing a space and parentheses, a spec with a non-ASCII segment, and a `../`-prefixed relative spec authored from a subdirectory that names a real in-repo file.
- **AC-SEC-4:** *(carried as the old AC-SEC-3)* A ledger payload whose `trigger_counts`, `verdicts` or `rounds` dictionary carries a hostile **key** -- an absolute path, a string containing the OS username, a key over a stated byte bound, or a key failing a declared key pattern -- is either refused or neutralised with the neutralisation counted in `invalid_record_values_dropped`, and the resulting entry contains no absolute path. Proven by calling the exported `validateEntry`/`degradeEntry` directly with `trigger_counts: {"/Users/<user>/.ssh/id_rsa": 1}`; measured at planning that payload returns an empty error list and `grep -c propertyNames workflows/lib/ledger-append.mjs` returns 0, so only values are constrained today.
- **AC-SEC-5:** *(replaces the old AC-SEC-4)* Every fail-closed decision in a workflow re-checks **in script code** that the field it depends on is present, rather than delegating that to the runtime's enforcement of the schema's `required` list: driving `review-cycle.js` with a runtime double whose schema enforcement is DISABLED and a scope response that OMITS `custom_rules` while reporting `harness_triggers_file_exists: true` must abort with an error naming `custom_rules`, never proceed on harness defaults and never surface as an unrelated `TypeError` (today the only thing that stops it is `Object.keys(undefined)` at `workflows/review-cycle.js:362`, while the mirror case raises a false `HarnessTriggersContradiction` at :348). Separately, **one timeboxed probe** of the production runtime (a schema with a required field, an agent response omitting it) is recorded verbatim in `docs/` and in the PR body with its observed result and date; an unanswerable probe is recorded as unanswered, and `test/helpers/fake-runtime.js`'s modelling comment either matches the observation or names the divergence. A weak result opens a new spec rather than expanding this one. *(merges AC-QA-20, AC-QA-21)*
- **AC-SEC-6:** After T2, the CI lane's requested field set -- every `gh run list --json` field, every `gh api` path and every field read off a jobs response -- contains no person-identifying value (`actor`, `triggeringActor`, `author`, `committer`, any `email`, `displayTitle`, `headBranch`) and no log access (`--log`, `gh run view --log`, any URL ending `/logs`). Enforced as a static test over the built prompt strings that fails on any of those tokens, and confirmed by grepping a real report produced for the PUBLIC delivery repo for a GitHub login other than the repo-owner slug: zero matches.
- **AC-SEC-7:** A prompt-injection canary placed in a field T2 newly ingests -- a per-job name, a step name or a workflow file name, not the field the existing canary at `test/optimise-cycle.test.js:852` already covers -- reaches the synthesis prompt only inside the nonce-tagged UNTRUSTED-DATA block, and a drafting agent scripted to obey it produces no proposal that survives the citation and security-removal filters. The adversary is concrete: Couch Potato is public, so `gh run list` there returns runs whose surrounding text a stranger opening a pull request controls.
- **AC-SEC-8:** The T4 branch-ref sweep never interpolates a ref name into a shell string and deletes only refs matching an anchored, exact pattern. Proven in a throwaway repo carrying branches named `worktree-wf_$(touch <marker-path>)`, `worktree-wf_a;id`, `my-worktree-wf_a`, `worktree-wf_a-keepme` and `main`: afterwards `<marker-path>` does not exist, the last three branches and `main` all survive, and only exact-pattern refs are gone. The sweep touches no remote ref unless a flag explicitly asks for it, proven by a repo with a matching remote-tracking branch still present afterwards.
- **AC-SEC-9:** `git diff origin/main...HEAD` adds no tracked line containing the operator's home path, the OS username, or a live credential's fingerprint (its file location, prefix, length or file mode); and at the end of this plan `grep -rn "AIza\|[A-Z_]*API_KEY" $(git ls-files)` returns no line stating where any live key lives, its prefix, its length or its mode. (Generalised 2026-09-05: the pattern named one specific credential, which is itself a small disclosure in a PUBLIC repo. The check is stronger generalised, not weaker.) Two spec lines did so historically. **This AC recorded both as "purged from history" until 2026-09-05; that was FALSE for eighteen days, was corrected on that date, and the purge was then actually carried out.** Verified from a fresh clone of the public repository rather than the local copy. Measured on 2026-09-05 against `origin/main`: the credential name remains in three commits reachable on the public default branch, ONE of which also names its file. (First stated as "two" on 2026-09-05 and corrected the same day: my own grep counted AC-SEC-9 itself, whose text lists the fingerprint categories in order to forbid them. A check's description of what it bans is not an instance of the thing.) What IS true, and was re-measured the same day: no key VALUE appears anywhere in history, on any ref. See "Residual exposure, stated" below.
- **AC-SEC-10:** The documented deletion procedure names every artefact holding ledger-derived data -- each instrumented repo's `.claude/harness-ledger.jsonl`, each repo's `.claude/optimise-cycle-report.md`, and `~/.claude/logs/optimise-cycle-weekly.log` -- and, executed verbatim, leaves zero matches on disk for a distinctive `run_id` that was in a deleted ledger. The same documentation states in one line what instrumenting a repo begins collecting (run timestamps, spec paths, repo identity, lens verdicts and AC ids), that retention is indefinite with no rotation, and the command that deletes it. Whether the mechanism reaches every artefact is AC-DATA-1's to verify; this is the policy it must satisfy.

### Architecture

- **AC-ARCH-1:** *(restated)* `plan-cycle.js` and `review-cycle.js` agree on where lens triggering comes from, and **the spec states, before T3 starts, which path set the globs are matched against at planning time** (spec-declared affected files, the agent-guessed `likely_paths`, or the union) and what happens when that set is empty. Verified still open: `grep -c "harness-triggers" workflows/plan-cycle.js` returns 0. After the change the rule source (DEFAULT_RULES, the `.claude/harness-triggers.json` read, its shape validation and glob compilation) exists in exactly **one authored form** shared by both workflows -- either a single `workflows/lib/*.mjs` invoked identically by both, or a duplicated inline block pinned byte-for-byte by a static test in the style of the existing run-ledger-helper guard -- proven by `grep -c 'function globToRe' workflows/*.js workflows/lib/*.mjs` totalling 1, or by editing one copy alone making a named static test fail.
- **AC-ARCH-3:** Every per-job CI number the report carries (`n`, mean duration, failure ids, and the critical-path identification AC-PROD-5 asks for) is computed inside `workflows/lib/optimise-read.mjs` and appears as a field of its output; `buildReport` only formats it. Proven by a unit test driving the reader with a per-job fixture and asserting the critical-path field is present in its stdout JSON, plus a diff read showing no new arithmetic over `ciByJob` in `buildReport`. *(lens ID AC-ARCH-5)*
- **AC-ARCH-4:** T2 preserves `aggregateCi`'s two existing contracts against a per-job dataset: `requestedLimit` remains the per-**job** run cap (a fixture of 100 runs x 6 jobs still sets `truncated=true` on each job entry, not false), and a run whose job detail could not be fetched is reported through the existing `CI_LANE_SCHEMA` `failures[] {repo, mode, command, error}` taxonomy, extending the mode enum if needed, rather than through a new error channel or silent absence from `byJob`. The spec also names how many runs' jobs are fetched as an explicit bound, and requires the fetch to be one bounded shell invocation emitting all rows rather than N agent-driven calls, because the weekly runner's background wait ceiling is 1,200,000 ms against a worst measured real run of 515s. *(lens ID AC-ARCH-6)*
- **AC-ARCH-5:** T1 adds no second ledger-writing path: `workflows/lib/ledger-append.mjs` remains the only file in this repo that opens `.claude/harness-ledger.jsonl` for write or append, and instrumenting a target repo is done solely through the installed mirror or plugin, **never** by copying `workflows/`, `hooks/` or `bin/` into that repo. Proven by a static test asserting exactly one write site for `LEDGER_RELATIVE_PATH`, plus T1's instructions in README and the skill containing no "copy workflows into the target repo" step. *(lens ID AC-ARCH-8; the failure this prevents is exactly the Couch Potato fork in AC-SEC-1)*
- **AC-ARCH-6:** The optimiser's one-way dependency edge survives T1-T4: the existing static guard (none of `tdd-task.js`, `review-cycle.js`, `plan-cycle.js`, `ledger-append.mjs`, `conduct-plan/SKILL.md` or `hooks/` references the optimiser) passes with no edit to its target list, and no per-PR path (Stop hook, pre-push hook, any of the three cycle workflows) gains a ledger-liveness check, a report read, or a ref sweep. *(lens ID AC-ARCH-9)*
- **AC-ARCH-7:** Any mechanised worktree/branch-ref sweep from T4 is its own entry point -- a `bin/` script or an explicitly invoked skill -- never called from `hooks/`, a workflow run, or a lens, and it refuses to delete a ref whose worktree is still registered in `git worktree list` or whose committerdate is younger than a stated age threshold. Proven by a temp-repo test with one live registered worktree and one stale ref asserting only the stale ref is deleted, plus a grep showing no hook or workflow invokes the sweeper. This matters because lenses run in parallel under `isolation: 'worktree'`, so `worktree-wf_*` refs are live for the duration of a review and the hazard grows precisely as this plan's concurrency goal is achieved. *(lens ID AC-ARCH-10)*
- **AC-ARCH-8:** `MIN_RECORDS_FOR_PROPOSALS` has one live source of truth: either `workflows/optimise-cycle.js:25` and the `workflows/lib/optimise-read.mjs:91` export are pinned equal by a static test that fails when either moves alone, or the unused export is removed. Today `grep -rn MIN_RECORDS_FOR_PROPOSALS test/` returns nothing and the export has no consumer in its own file, while AC-PROD-1's "by how many records" arithmetic depends on the two agreeing. *(lens ID AC-ARCH-12)*

### Operability

- **AC-OPS-1:** Ledger freshness is a rendered, first-class signal: `optimise-read.mjs`'s per-repo output carries the oldest and newest record timestamp in the window, and the report renders, per repo, the newest record's timestamp and its age in days, with a repo past a single named staleness constant rendering a distinct `**stale instrumentation**` line whose text differs from both the `uninstrumented` line and a healthy record-count line. Proven by running the real reader and the real report builder over two fixtures (all records past the threshold; all records recent) and diffing the two report texts. Measured at planning: `perRepo` carries no timestamp field of any kind, so 78-day-old data renders identically to today's.
- **AC-OPS-2:** An optimiser report read out of band cannot be mistaken for current data: the report states its own generation timestamp and the window's first and last record timestamps within the first ten lines. Proven by two runs producing different generation timestamps and by a fixture whose window dates appear verbatim in the rendered report.
- **AC-OPS-3:** A weekly run that resolves zero repos fails loudly: with `$HOME/.claude/optimise-weekly-repos` absent, empty, or whitespace-only, `bin/optimise-cycle-weekly.sh` writes a `RESULT FAIL` line naming the empty or missing repo configuration, writes one line to stderr, and exits non-zero. Proven by executing all three states; measured at planning, all three exit 0 with empty stderr and no `RESULT` line, and T1 is delivered through exactly that configuration file.
- **AC-OPS-4:** A ledger write failure survives the run that caused it: `plan-cycle.js`, `review-cycle.js` and `tdd-task.js` each consume the terminal `writeLedger` result (discarded today at `review-cycle.js:753`, `tdd-task.js:344` and the equivalent line in `plan-cycle.js`) and return a `ledger_write` field naming the start and terminal write status plus the failure reason when either failed. Proven with the fake runtime: a run whose ledger step reports `write_ok:false` returns `ledger_write.terminal_ok === false` carrying the reason, and a healthy run returns true for both.
- **AC-OPS-5:** The weekly log names a repo that produced no telemetry: when the report the runner has just verified contains the uninstrumented or stale-instrumentation marker, that repo's `RESULT` line carries an explicit telemetry state (`telemetry=absent` / `telemetry=stale` / `telemetry=ok`) and the run writes a stderr summary line worded distinctly from a job failure. Proven with a stub `claude` writing a marked report and a healthy report.
- **AC-OPS-6:** T2's per-job decomposition never presents partial data as complete: every run whose per-job metadata fetch failed is counted per mode (`rate_limited`, `unauthenticated`, `other`) and rendered in the report's CI section with its count and mode, and any job aggregate assembled from fewer runs than the run window covers renders a `partial` qualifier beside the existing qualifiers and never reports "never failed in this window". Proven with a fixture where k of n job fetches fail. *(merges AC-QA-8, AC-PROD-7 of the product lens's set)*
- **AC-OPS-9:** Drift of an installed mirror is detectable from an artefact rather than a remembered `diff`, and detection is **content-derived, not marker-derived**: `bin/optimise-cycle-weekly.sh` writes a content fingerprint of the file that actually ran into the run header beside `version=`, and a test fails when the script's content changes without `SCRIPT_VERSION` changing (today `test/weekly-runner.test.js:662` asserts only `/version=\S+/`). Both directions asserted: editing an installed mirror file's body while leaving its version constant untouched is detected, and an in-sync pair reports in sync. Proven by mutating one behaviour-bearing byte, observing the suite go red, confirming with `git diff` that the edit landed on the intended line, and restoring. *(carries the old AC-OPS-2; merges AC-QA-18)*
- **AC-OPS-10:** Every failure mode this plan introduces has a runbook entry: README's weekly-run section carries a table with, for each of telemetry stale, telemetry absent, zero repos configured, per-job `gh` fetch rate-limited, and installed-mirror drift, the exact literal string the operator will see in the log or report and the first diagnostic command to run. A static test asserts each of those literal strings, as emitted by the code, appears in that table, so a renamed signal breaks the test rather than silently orphaning the runbook entry.
- **AC-OPS-11:** *(carries the old AC-OPS-3)* Documentation states what is a snapshot and what is invariant: every count, duration or date this plan adds to `README.md`, an `AGENTS.md` or the spec carries an inline `as at <date>, from <command>` attribution, or is asserted by a test that recomputes it, enforced by a static test over the sections this plan adds and proven load-bearing by deleting one attribution and watching that test fail. Blast-radius counts in a delivery repo's `AGENTS.md` went stale twice inside one PR purely from prose not following code.

### Data

- **AC-DATA-1:** *(AC-DATA-16, carried)* The retention story enumerates every place ledger-derived figures come to rest and the documented deletion procedure is shown to reach them: seed a distinctive token into a scratch instrumented repo's ledger, run a cycle so it reaches the derived artefacts, run the documented deletion, and grep for the token across `<repo>/.claude/harness-ledger.jsonl`, `<repo>/.claude/optimise-cycle-report.md`, `$HOME/.claude/logs/optimise-cycle-weekly.log` and the plist's `StandardOutPath`/`StandardErrorPath` files for zero hits. Any copy the procedure cannot reach (Claude session transcripts, a deliberately committed line) is named in the docs as unreachable rather than omitted. The command string in the docs and the one under test are compared mechanically so they cannot drift apart. *(merges AC-QA-19)*
- **AC-DATA-2:** With more than one repo instrumented, the ledger window selects the most recent records **across all roots**, not the tail of a concatenated array, and each `perRepo` line reports the number of that repo's records actually aggregated rather than its pre-window file count. Proven with two roots where root A holds the newest records and A+B exceeds the window: every one of A's newest records is present, and `never_failed` is not reported true for an `ac_id` whose only FAIL verdicts live in the dropped set. Measured at planning: repoA's 6 newest FAIL records were dropped, the output emitted `never_failed:true` for that criterion, and the report still printed "6 record(s) in window" for repoA. Latent only because both delivery repos are empty, which is exactly what T1 removes.
- **AC-DATA-3:** Every update to a repo's `.git/info/exclude` is append-only: the harness appends only the missing line with a single `O_APPEND` write and never rewrites the whole file. Proven by executing a concurrent-writer case (an unrelated operator exclusion appended mid-update is still present afterwards) and a kill-mid-update case (the file is either exactly as before or has the new line appended, never truncated or partially written). Applies to both `workflows/lib/ledger-append.mjs:1133-1145` and `workflows/lib/optimise-report-ignore.mjs:35-47`; measured at planning, a concurrent operator append was silently destroyed while the harness's own line survived and the run reported success.
- **AC-DATA-4:** The T1 instrumentation step is re-runnable, destroys nothing that already exists, and is reversible from one documented command each way. Run it twice against a scratch repo that already has a non-empty ledger, a repo-local `.claude/workflows/` copy with a distinctive edit, a `.claude/harness-triggers.json`, and operator lines in `.git/info/exclude`: after both runs the ledger has only grown with every pre-existing line byte-identical and in place, and the other three are byte-identical; exactly one `.git/info/exclude` entry exists; the documented undo removes every artefact the install created, leaving `git status` identical to the pre-install state; and a mirror sync interrupted between `workflows/lib/` and `workflows/` leaves a mixed install detectable from an artefact, with records written by either half still bucketing together. File listings and `git status` are recorded at each step. *(merges AC-OPS-7)*
- **AC-DATA-5:** The plan's own measurement basis survives routine repo cleanup, or is captured somewhere that does: either the ledger lives outside the working tree, or the before/after figures AC-PROD-6 depends on are written into a durable artefact at measurement time and that artefact is shown to still hold them after `git clean -xdf` has run. Measured at planning: `git clean -xdfq` in a repo whose ledger and report are excluded via `.git/info/exclude` removed the entire `.claude/` directory, and runs cannot be replayed.
- **AC-DATA-6:** *(replaces the carried F15 AC-SEC-2, whose premise was refuted by measurement)* Bucket identity is proven with two rows that differ only in the key, in both directions: the same plan recorded from two different working directories (repo root and a subdirectory, and from a linked worktree) lands in exactly one bucket; two different plans whose files share a basename (`specs/a.md` and `docs/a.md`) land in two buckets; the same `ac_id` in two different specs stays in two buckets (already true, measured, and the regression is now locked); and **any aggregation still keyed without the repo segment gains it or the report states in that section that it merges repos** -- `lensDispositionCounts` (`workflows/lib/optimise-read.mjs:171-174, 264`) is keyed by lens alone across every repo and plan, so once T1 instruments two more repos, rework attribution, the optimiser's first lane, starts producing cross-repo conclusions presented as per-repo ones.
- **AC-DATA-7:** The planning cycle's spec write-back cannot destroy content it did not author: run the cycle against a spec containing a hand-written rejected register and carried criteria, with the synthesis step forced to emit a mangled or truncated file, and afterwards the original content is recoverable -- the run refused before editing (spec untracked or dirty), or a pre-edit copy exists, or a post-edit check compared the file minus the AC section against the pre-edit bytes and restored on mismatch. `workflows/plan-cycle.js:254-256` today instructs a model to "preserve the rest of the file byte-for-byte" with no pre-edit copy, no clean-tree precondition and no post-edit verification, and `specs/optimise-cycle.md` (65 KB) is untracked, so git is not the backstop.
- **AC-DATA-8:** Any worktree or branch-ref sweep added by T4 deletes only what it can prove is disposable, and reports what it would delete before deleting anything. Proven against a fixture repo holding a harness-pattern ref reachable from `main`, a harness-pattern ref carrying a commit reachable from nothing else, a harness-pattern ref with a live or locked worktree, and an unrelated ref matching no pattern: exactly one deletion occurs (the first), the other three survive, the commit behind the unreachable one still resolves afterwards, a second invocation reports zero removals, and each case asserts on `git for-each-ref` output rather than on the script's own log. *(merges AC-QA-17, AC-OPS-8's safety half)*

### Simplicity

*Mechanical constraints, verified by the orchestrator directly against the diff at review; no agent needed.*

- **AC-SIMP-1:** No new runtime dependency: the diff adds no `package.json`, no lockfile, no vendored module, and no import or require of a non-builtin module anywhere under `workflows/` or `bin/`.
- **AC-SIMP-2:** At most one file is added under `workflows/`, and only if it is a single shared trigger-override loader imported by both `plan-cycle.js` and `review-cycle.js`. If AC-ARCH-1 does not ship, zero files are added under `workflows/`.
- **AC-SIMP-3:** After the change, the `.claude/harness-triggers.json` parse and shape-validation logic exists in exactly one file: `grep -rc HarnessTriggersShapeInvalid workflows/` shows a non-zero count in exactly one file (currently `workflows/review-cycle.js:366-456`).
- **AC-SIMP-4:** *(amended)* T2's changes to `workflows/lib/optimise-read.mjs` are confined to per-job bucket keying, per-job timestamps and per-job failure counting; no new exported analysis function is added beyond the per-job aggregate itself. The original "empty or comment-only" wording was amended because it would have forbidden the measured bucket-collision fix required by AC-QA-4.
- **AC-SIMP-5:** *(amended)* T1's commits **in this repo** touch only `.md` paths, `specs/`, or paths outside this repository, except for the changes AC-OPS-3 and AC-DATA-2 name; any further code change T1 needs is written into the spec with its reason before it is built.
- **AC-SIMP-6:** AC-DATA-1 adds no script, no CLI subcommand and no ledger field: the documentation half is at most five added lines amending `AGENT-HARNESS.md`'s existing deletion sentence (line 33), because `README.md:486-491` already documents the derived report's retention and its `rm` command.
- **AC-SIMP-7:** AC-OPS-9 deletes the hand-maintained `SCRIPT_VERSION="2026-08-17.2"` constant (`bin/optimise-cycle-weekly.sh:149`) and replaces it with a value derived from the file's own contents, rather than adding a second marker beside it; `bin/` grows by no more than ten net lines.
- **AC-SIMP-8:** Every ref-deleting command in the diff (`git branch -D`, `git update-ref -d`) takes its argument from a list filtered on the literal prefix `worktree-wf_`, within five lines of that filter, and no unfiltered ref deletion appears anywhere in the diff.
- **AC-SIMP-9:** AC-SEC-4 is implemented as one `propertyNames` branch inside `collectErrors` reused by every dictionary-shaped property, plus one declaration per dictionary in `LEDGER_ENTRY_SCHEMA`. No per-dictionary bespoke key validator, and no new regex constant beyond reusing the existing `LENS_PATTERN_STR` shape.
- **AC-SIMP-10:** AC-SEC-3's fix does not modify `ABSOLUTE_PATH_RE` and is confined to `canonicalPlanKey`'s own body; that function stays pure, containing no `fs`, `path.resolve` or `process.env` reference after the change.
- **AC-SIMP-11:** No new configuration surface: `grep -roh 'process\.env\.[A-Z_]*' workflows bin | sort -u` is identical before and after, and no workflow's args contract (`meta.whenToUse`) gains a key.
- **AC-SIMP-12:** The suite adds no more than 25 tests. (The time ceiling is AC-QA-10's.)
- **AC-SIMP-13:** *(amended)* The two vetoed criteria ship no code: the diff contains no lane-failure-reason field on any schema or record in `workflows/optimise-cycle.js`, and no change to the `ac_verdicts` key construction at `workflows/lib/optimise-read.mjs:311`. If either ships anyway, the owning lens has supplied a criterion naming the observed wrong output it prevents.
- **AC-SIMP-14:** *(amended to per-PR)* Excluding `test/`, docs and specs, each PR in this plan touches at most six files: `git diff --name-only <base>...HEAD | grep -v '^test/\|\.md$' | wc -l` <= 6. The whole-plan bound was raised to a per-PR bound because the surviving criteria necessarily span `ledger-append.mjs`, `optimise-read.mjs`, `optimise-cycle.js`, `review-cycle.js`, `plan-cycle.js`, a shared trigger loader, the weekly runner and a sweep script.

### Cross-session provenance

Added 2026-08-18 from a three-session incident, refined by the peer session

Renumbered 2026-08-19 from AC-OPS-10..13: those ids were already in use
above, so review could not resolve a verdict citing one. Caught by the
uniqueness guard in test/static-checks.test.js, not by reading.
whose corrections make it checkable rather than a platitude.

**AC-OPS-14:** A finding passed between sessions, or written to the ledger,
separates **what was measured and by what command** from **what is inferred
from it**. Worked example: the volume hit 131 MiB free with three watchdog
resets. Three sessions held true measurements and offered three different
wrong causes -- Docker build cache (~45 GB), worktree accretion (0.8 GB), and
finally the real one, a claude-mem sparse-file pathology (~170 GB) found by
`sudo fs_usage`. Nobody reported a false measurement; each attached a causal
story to a true one, and **the inference travelled with the same authority as
the evidence**.

**AC-OPS-15:** The provenance marker attaches to the **claim**, not the work
item. An action can be correct while the reason given for it is wrong: the
Docker purge was independently requested, cleared 27 GB of never-purged build
cache and reduced 50 tags to n and n-1 per service. Correct work, wrong causal
story bolted on. If the ledger marks the work rather than the claim, a later
reader who finds the claim false may revert something that was fine -- worse
than the original error, because it is confident and downstream.

**AC-OPS-16:** Where the decisive measurement is one this session **cannot
take**, that is stated *before* a cause is offered, not after. Both sessions
above hit their wall after naming a mechanism.

**AC-OPS-17:** For every failure path, name the **consumer** of its signal. If
there is none, the path is not instrumented no matter how carefully it
reports. Two worked examples from 2026-08-18: a healthcheck recorded 290
consecutive failures nobody looked at, and `writeLedger` returned
`write_ok: false` to nobody at all for six days. This is the criterion the
ledger outage would have been caught by, and it is checkable in review.

Do NOT let these collapse into "be slower to conclude" or "be slower to clean
up". Neither is the lesson.

### Vetoed at planning

Recorded so they are not silently reconsidered, and so a review lens does not
mark a phantom criterion PASS.

- **AC-SEC-2 (F15, carried): "AC ids from different specs cannot collide in the ledger's `ac_verdicts` aggregation."** **Dropped: premise refuted by measurement.** Five lenses independently executed a two-spec probe and all got two buckets. `workflows/lib/optimise-read.mjs:311` already builds the key as `${escapeKeyComponent(r.repo)}|${escapeKeyComponent(planKey)}|${escapeKeyComponent(v.ac_id)}`, `neverFailingAcs` carries repo/spec/ac_id through (:359-385), the renderer prints `${a.repo}/${a.spec} ${a.ac_id}` (`workflows/optimise-cycle.js:1010`), and `test/optimise-read.test.js:395` already pins it. This is a security-owned criterion, so simplicity could not have vetoed it: **the owning lens withdrew it on its own evidence.** F15 is recorded closed with that evidence, and the real key-ignoring aggregation the audit found instead -- `lensDispositionCounts`, keyed by lens alone -- is now AC-DATA-6. That AC-SEC-2 was wrong is itself a finding: the carried list was transcribed from HARN-OPT-2's finding log rather than re-verified, so every carried criterion was re-run at planning before being kept.
- **AC-ARCH-2 (AC-ARCH-12, carried): "a typed failure-reason on the optimiser lane schema."** **Vetoed by `lens-simplicity`; veto upheld.** The owning lens did not defend it: `lens-architecture` agreed the prescribed fix cannot cover the failure mode it names, because the schema is only applied to a response that arrived and the observed failure is `agent()` resolving `undefined`, at which point there is no object for a field to live on. The third state is already rendered distinctly at `workflows/optimise-cycle.js:818-819` ("**Ledger analysis unavailable**: the ledger lane failed to run ... This is NOT the same as an empty ledger"). Capturing a reason requires a change to a runtime that is not in this repo. Mechanically enforced by AC-SIMP-13.
- **AC-ARCH-11 (architecture's replacement: three distinguishable lane states).** **Dropped with AC-ARCH-2**, for the same reason: two of the three states already render distinctly and the third's reason is unobtainable from this repo, so the criterion would ship a schema field that cannot carry a value.
- **AC-QA-16 (per-enum lane-failure-reason lines in the report).** **Dropped as dependent on the two above.**
- **AC-OPS-1 as originally written: "the workflow's own worktree isolation removes its branch refs when it removes the worktree."** **Vetoed as unsatisfiable in this repository and restated.** Nothing under `workflows/`, `bin/` or `hooks/` creates, names or removes a worktree or a branch ref; the only worktree machinery here is the `isolation: 'worktree'` option at `workflows/review-cycle.js:594`, and the refs are created by the Claude Code runtime. The achievable form is a committed, prefix-filtered sweep with its own entry point, now AC-ARCH-7 plus AC-OPS-8's safety half folded into AC-DATA-8. **The data-loss and injection guards on that sweep (AC-DATA-8, AC-SEC-8, AC-ARCH-7) are not vetoable**: a bulk ref deletion sits at precedence rank 1, and an agent's branch ref is often the only copy of its commits. Measurement note: `git for-each-ref | grep -c worktree-wf` returns 0 in this repo and 31 in Couch Potato, against the spec's stated 85 and 89, because both were swept manually on 2026-08-17/18.
- **AC-SIMP-4 as originally written** ("T2's diff to `optimise-read.mjs` is empty or comment-only"): **amended, not adopted.** It would have forbidden the fix for a measured wrong number -- `aggregateCi` keying on the unescaped `${workflow}::${job}` merges two distinct jobs into one bucket averaging 100s and 10s to 55s. A simplicity constraint cannot forbid a correctness fix the spec's own admission gate admits.
- **AC-SIMP-5 as originally written** ("T1 changes no executable code in this repo"): **amended.** T1 provably needs the weekly runner's silent zero-repo exit (AC-OPS-3) and the multi-root window selection (AC-DATA-2) fixed, and the original wording would have been satisfied by leaving both defects in place.
- **AC-SIMP-14 as originally written** (six non-test files for the whole plan): **amended to six per PR**, because the surviving set spans eight production files.
- **Merged rather than vetoed**, so no criterion was lost: AC-QA-8/11/12/17/18/19/20/21 into AC-OPS-6, AC-QA-6, AC-PROD-1, AC-DATA-8, AC-OPS-9, AC-DATA-1 and AC-SEC-5; AC-ARCH-3/4/5/7/13 into AC-QA-8, AC-QA-9, AC-ARCH-3, AC-QA-6 and AC-QA-1; AC-DATA-6/7 into AC-PROD-5, AC-QA-4/5 and AC-DATA-6; AC-OPS-7/8 into AC-DATA-4 and AC-DATA-8; the product lens's AC-PROD-7 into AC-OPS-6.
- **Not vetoed, recorded as a sequencing recommendation:** `lens-simplicity` observed that eleven of the spec's thirteen original criteria are harness hardening the "Not in scope" section says it resists, and that no proposal has yet been produced from real delivery data. Its proposal is to ship T1 and T2, take one weekly cycle's output, then re-derive T3 from what that output actually gets wrong. `lens-product` measured the counter-argument: the CI and git lanes already produced three ranked, citation-backed proposals with zero ledger records, one of which is adopted, so lane yield argues for T2 early too. Every surviving T3/T4 criterion now cites a measured wrong output or a silent loss, which is the spec's own admission gate; the sequencing decision is the owner's.

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

## RESIDUAL EXPOSURE, STATED (2026-09-05)

**History rewritten 2026-09-05 on the owner's decision.** What was published,
what was done, and what is left. This section stays whether or not it reads
comfortably, because the failure it exists to prevent is a redaction note being
tidied away and the repo quietly resuming a claim that an item is closed. That
is exactly what AC-SEC-9 did for eighteen days.

**What had been public since 2026-08-18:** a delivery system's live compose
project name and container prefix, its staging project name, its production
database volume (derivable from the project name by Docker's default naming),
its rollback tags, one credential's name and in one commit its file, and a
named system's destructive permission allow-list entry. Together a working
runbook for destroying someone's production, inside a document arguing for care.

**What was never public, measured on every ref before and after:** any key
value. Zero matches for a key-shaped string anywhere in history. The exposure
was a runbook and a pointer, not a secret.

**What was done:** `git filter-repo` over all refs, replacing each identifier in
both blob content and commit messages, then a force-push of `main`. Branch
protection was relaxed for the push and restored to a byte-identical
configuration immediately after; the four required status checks and the
force-push and deletion prohibitions are all back on. Verified from a FRESH
CLONE of the public repository, not from the local copy: zero occurrences across
every ref, every diff and every commit message.

**What is left, and it is not nothing.** GitHub retains unreferenced objects for
a period and serves them to anyone who already recorded a specific commit
identity. Nobody had forked, starred or watched this repository at any point, so
there is no evidence anyone did, but absence of evidence is the argument this
harness exists to distrust. A rewrite reduces this exposure; it does not prove
it closed. Anyone holding a pre-rewrite clone still holds the original.

**One unredacted copy exists deliberately**, a local mirror taken before the
rewrite. It is off the network and is the only rollback path if this rewrite
turns out to have damaged something. It is not published and must not be.

**The structural cause, which outlives this incident:** every leak guard in this
repo reads `git ls-files`, so all of them measure the working tree and none has
ever looked at a commit older than HEAD. A tip-only scrub therefore passes every
check and reads exactly like a redaction. That is why the first attempt at this
scrub was recorded as complete when it had changed nothing anyone could not
still read, and it is why the 2026-08-18 redaction this one copied as its
pattern made the same mistake.

## Owner actions, not tasks here

- **One credential-hygiene item** (the operator knows which; the credential,
  its file and its identity are all deliberately unnamed here)
  (details deliberately not restated here; see AC-SEC-9. Stating a live key's
  location, prefix, length and file mode on a public branch narrows the search
  for anyone who finds it, which is what the original wording did.)
- **Triage five open Dependabot PRs on Couch Potato** per §3a, with a recorded
  decision each.
- **Decide on Couch Potato's `required_conversation_resolution`.** Merging
  #260 took four review rounds because each push triggers a fresh review that
  opens a new blocking thread. The findings were good; the loop only
  terminates when a push happens to draw no comment.

## Re-read against 2026-08-18, after the ledger fix

The 74 criteria above were drafted while the instrument was silently not
recording. Re-read after `d3d51b7`; this section records what changed, so a
builder does not work from the pre-fix framing.

**T1 is now smaller than scoped.** It was written as "instrument the delivery
repos", on the premise that the harness worked and only they lacked data. The
real cause of at least part of the gap was that **no** repo was recording. The
writer, the reader and the CLI were all sound; only the agent call that
invokes them was broken. So T1's remaining work is to run cycles and confirm
records land, not to build instrumentation.

**Still true and still worth the criteria they generated:**

- `windowRecords` (`optimise-read.mjs:165-169`) slices the array **tail**, not
  by timestamp, and `combinedRecords` is built by concatenating per-repo
  arrays. So with more than one instrumented repo and more than
  `DEFAULT_LEDGER_WINDOW_LINES` (2000) records, one repo's newest records are
  dropped while `perRepo` still reports them as in-window. Verified unchanged
  today. Latent only because the delivery repos are empty -- **which is exactly
  what T1 removes**, so T1 activates it. This is the highest-priority item in
  T3 and should land before or with T1.
- `plan-cycle.js` still does not read `.claude/harness-triggers.json` at all
  (`grep -c` returns 0), so planning-side triggering is not repo-tunable.
- Ledger dictionary **keys** are still unconstrained (`grep -c propertyNames`
  returns 0); only values are validated.

**Withdrawn or answered by the fix:**

- The claim that Couch Potato still carries tracked repo-local workflow forks
  was a **false alarm with an important cause**: the lens read a shared working
  tree that a peer session had checked out on a different branch, predating the
  merge that removed them. On `master` they are gone. **A lens reviewing a
  shared checkout can review the wrong branch entirely and report it with full
  confidence** -- that is a harness defect worth more than the criterion it
  produced, and it has no criterion yet.
- The carried-forward F15 (AC ids colliding in `ac_verdicts`) was refuted by
  measurement, independently, by five lenses: `optimise-read.mjs:311` already
  keys on `repo|planKey|ac_id` and a test already pins it. The owning lens
  withdrew its own criterion on its own evidence, which is the harness working
  as intended.

## Spec gaps found at review

Populated by review round 2, 2026-08-20.

- **The CI workflow and pre-push hook shipped under this plan with no
  acceptance criterion, no task and no entry here.** `.github/workflows/ci.yml`
  and `.githooks/pre-push` are this repo's first CI and first hook; nothing in
  T1 to T4 covers a gate. The work is justified by the standing standards
  (§3 secret scanning wherever CI exists, §4 a local gate mirroring CI) and by
  this repo having already had a credential fingerprint reach its public
  history -- **the defect is the missing contract, not the code.** Recorded
  rather than retrofitted with a criterion after the fact, because a criterion
  written to match what was built verifies nothing.
- **The whole git-environment hardening (PR #7 and PR #8) has no acceptance
  criterion in any spec either.** Round-1 review found the window fix owned by
  AC-DATA-2 and nothing covering the rest. Same shape, same treatment.
- Both are evidence for the conclusion recorded against the task list: this
  plan is accumulating harness work it never scoped, under a title about
  delivery.
