# HARN-OPT-5: the repairs HARN-OPT-4 exposed in the harness itself

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft (plan-cycle not yet run)
**Lenses run:** none yet · **Skipped:** design and accessibility expected (no UI)
**Supersedes:** `specs/harn-escalate.md` (draft of 2026-10-12), folded in as T1 and T2.
**Applies to:** this harness. The Codex harness carry is tracked in `codex-ai-harness` `specs/PLAN-harness-parity.md`, not here.

## Problem

HARN-OPT-4 (eight tasks, PRs #5 to #11, 47 conductor ticks, 22 review rounds) shipped on 2026-10-12. Its conductor log and review record expose seven defects in the harness that ran it, each measured during the plan rather than inferred:

1. **No stronger attempt before the owner is woken.** The conductor skill's circuit-breaker (`skills/conduct-plan/SKILL.md:346`) stops at three fix rounds or the first self-inflicted regression and writes the block for a human. `~/.claude/CLAUDE.md` §2 (lines 206 to 208) says rounds 4 and 5 go to a fresh implementer on a more capable model. The breaker always fires first, so that rung has never run. Every roster agent is pinned `model: opus`; no workflow passes a `model` option (`workflows/tdd-task.js:251,316` dispatch `agentType: 'implementer'` with no model); the ledger records no model. T6 waited about six hours overnight for a decision the harness had not tried its strongest tool on. Asked for by the owner on 2026-10-12: "Can you fix that so it happens."
2. **The build workflow has no honest exit for "the test is wrong" or "this is a guard".** `workflows/tdd-task.js` tells the implementer "if the test is wrong, stop and say so" (line 312) but its schema (`required: ['summary', 'files_changed']`) has no way to say so, and the RED gate rejects any test that passes on unmodified code. Four runs this plan ended BLOCKED for those reasons (T4 indent, T6 legacy id, T6 schema type, T8 fix round 1 guard-only) and the conductor overrode each by hand.
3. **Review lenses share one scratch directory.** Lenses run in isolated worktrees (`workflows/review-cycle.js:1155`, `isolation: 'worktree'`), but when the worktree has drifted they extract the reviewed tip with `git archive` into the session scratchpad under a generic name (`tip/`). On 2026-10-12 all three lenses read one lens's live mutation (T7 round 3 L4) and discarded a first run each. A lens also left `.claude/workflows/optimise-cycle.js` (a copy of main at 7fd9c26) inside the main checkout, where a repo-local workflow copy wins on name collision; the conductor removed it after verifying it matched a committed version.
4. **The workflows' own ledger writes are blocked by the safety classifier.** The `ledger:write` step pipes a base64 payload through a shell command (`printf '%s' '<base64>' | base64 -d | node ledger-append.mjs`, `workflows/review-cycle.js:596` and the two byte-identical copies). Nine of about 24 terminal writes in HARN-OPT-4 were stopped before they ran; the conductor wrote each row from the returned telemetry, and two of those rows carried no finding descriptors, so no finding ids were minted and `prior_findings` could not be passed to the next round.
5. **The ledger writer loses lines under concurrent writes.** `ensureGitignored` (`workflows/lib/ledger-append.mjs:1648`) does a read-modify-write of `.git/info/exclude` per writer; a concurrent `git check-ignore` can see a truncated file and the writer refuses with `write_ok:false`, exit 0. CI's hostile-git step flaked twice at 43 of 50 writers landed. The AC-DATA-3 test (`test/ledger-append.test.js:200`) does not assert `write_ok` per writer.
6. **The weak-CI brake enumerates flags by hand.** `isWeakCiEvidenceRemoval` (`workflows/optimise-cycle.js:835`) reads five named flags; T7 round 1 M1 asked for `neverFailed !== true`, which closes the class for any future flag, but two older controls (`test/harn-opt-4-t6.test.js` ~994 and the AC-SEC-13 tests) feed `neverFailed` null or false with every flag false and require the removal to survive.
7. **Re-runs suppress every CI proposal.** On this repo's real window two runs have `attempt: 2`, so every job row is re-run qualified with `neverFailed` null and the brake drops every CI removal (T7 round 3 L6). AC-OPS-10 asked for the conservative direction, but a repo where re-runs are routine (CouchPotatoServer) will never produce a CI proposal.

Also recorded during the plan: the T6 human wait has an end event but no start event in the ledger, because the conductor skill lists `human_wait_started` under tick logging (line 219) and not as a numbered step of the block procedure (line 270), so the six hours are in the plan log only.

## Not in scope

- The Codex harness implementation of any of this (parity plan, other repo).
- Changing which model the review lenses run on; lenses stay on Opus.
- Merging without a clean review: the escalation round still goes through the review cycle.
- The redaction regex follow-up from PR #5 round 2 L1: `ledger-append.mjs:1346` carries its own history of three regressions from widening, and the dict-key gap was closed at the segment level (line 1068); without a concrete failing input there is nothing to build.
- A cache for `gh` results, a new optimiser argument, or any new review-cycle argument.

## What this replaces

| What goes | Owning lens | Removal criterion |
|---|---|---|
| CLAUDE.md §2 rows "4 to 5" and "At 5" as written (superseded by one escalation round at the breaker, then adjudication) | product | AC-PROD-n |
| The skill's breaker paragraph's direct hand-off to the human with no escalation round | operability | AC-OPS-n |
| The base64-in-shell ledger write in all three workflows (replaced by a payload file) | security | AC-SEC-n |
| The read-modify-write of `.git/info/exclude` in `ensureGitignored` | data | AC-DATA-n |
| The five-flag OR in `isWeakCiEvidenceRemoval` (replaced by the never-failed verdict) | qa | AC-QA-n |
| The shared `tip/` extraction name in the lens prompt | operability | AC-OPS-n |

## Decisions taken up front

- **One escalation round, never two.** At the breaker the conductor dispatches exactly one further build to a fresh implementer on the stronger tier, reviews it, and merges if clean; otherwise it blocks for the owner with that round's result in the note. Rounds 4 and 5 of the CLAUDE.md table collapse into this one round. The owner applies or approves the CLAUDE.md edit; the spec carries the exact replacement text.
- **`model` is the only new build argument**, optional, a bounded lowercase token, passed to both implementer dispatches, recorded on the `tdd_task` row as `model` (string or null) with one SCHEMA_VERSION bump (5 to 6) that also covers the new `blocked_reason` value `test_defect`. No `review_cycle` or `plan_cycle` field.
- **"The test is wrong" is a structured return**, not prose: the implement phase may return `test_defect: {file, reason}` instead of code, and the workflow ends BLOCKED with `blocked_reason: test_defect`, never a fabricated done.
- **A guard-only change is RED by mutation.** The test author may supply `red_mutation: {file, search, replace}`; the RED verifier applies it in the worktree, runs the test, requires failure for the stated reason, restores the file and confirms the production hash is unchanged. Without a mutation the gate behaves exactly as today.
- **The ledger payload travels as a file, not a shell string.** The `ledger:write` step writes the JSON with its file tool to a private scratch path named by run id, runs `node <ledger-append.mjs> < <file>`, and deletes the file. The three copies stay byte-identical (static L5 guard updated). The threat the base64 form addressed (hostile text in a shell command, AC-SEC-6) is addressed the same way: the payload never appears on a command line.
- **Each lens gets a private scratch root** named from the run id and lens name, is told never to write under any repo root or `.claude/`, and the synthesis step reports any lens that did.
- **Exclude-file writes are idempotent and atomic**: check `git check-ignore` first, write only when needed, via temp file and rename.
- **The brake reads the verdict.** The two older controls are restated so a row with `neverFailed` null is weak evidence by definition; `isWeakCiEvidenceRemoval` keys on `neverFailed !== true`.
- **Re-run qualification is per job.** For a run with `attempt > 1` the lane also fetches `gh run view <id> --attempt 1 --json jobs`; the reader marks `reRun` only on jobs whose earlier attempt was not a success.

## Tasks

- [ ] T1: `workflows/tdd-task.js`, `workflows/lib/ledger-append.mjs`, `workflows/lib/ledger-schema-fields.json`: optional `model` argument validated as a bounded lowercase token, passed to both implementer `agent()` calls, recorded as `model` on the `tdd_task` row; `blocked_reason` enum gains `test_defect`; SCHEMA_VERSION 5 to 6 with the reason in the comment. — state: queued
- [ ] T2: `skills/conduct-plan/SKILL.md` and the CLAUDE.md §2 text: the breaker dispatches one escalation round (fresh implementer, stronger tier, via `/tdd-task` with `model`) before any block note; `human_wait_started` becomes a numbered step of the block procedure; the §2 table's rows 4 to 5 and "At 5" are replaced by the escalation round and adjudication; static tests pin the skill text. — state: queued (needs: T1)
- [ ] T3: `workflows/tdd-task.js`: the implement phase accepts `test_defect` and ends BLOCKED with that reason; the test phase accepts `red_mutation` and the RED verifier proves RED by applying it, restoring, and checking the production hash. — state: queued (needs: T1)
- [ ] T4: `workflows/review-cycle.js`: a private scratch root per lens in the lens prompt, a prohibition on writing under any repo root or `.claude/`, and a synthesis report line for any lens that did. — state: queued
- [ ] T5: `workflows/tdd-task.js`, `workflows/review-cycle.js`, `workflows/plan-cycle.js`: the `ledger:write` step writes the payload to a private file and pipes it from there; byte-identical across the three; the static L5 guard updated. — state: queued
- [ ] T6: `workflows/lib/ledger-append.mjs`: `ensureGitignored` checks first, writes only when needed, atomically; the AC-DATA-3 test asserts `write_ok` for every writer. — state: queued
- [ ] T7: `workflows/optimise-cycle.js`, `workflows/lib/optimise-read.mjs`: the brake keys on the never-failed verdict with the two controls restated; per-job re-run qualification from attempt-1 jobs. — state: queued
## Conductor log

## Acceptance criteria

*To be written by plan-cycle.*

## Vetoes and trade-offs

| Item | Raised by | Decision | Rationale |
|---|---|---|---|
| | | | |

## Spec gaps found at review

*(none yet)*
