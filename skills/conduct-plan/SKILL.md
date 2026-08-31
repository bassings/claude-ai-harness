---
name: conduct-plan
description: Execute a multi-PR plan as a deterministic reconcile-act-rearm loop. Use when the user asks to conduct, execute, or babysit a plan file across PRs and CI waits, usually under /loop. Args - the plan file path (required on first invocation).
---

# Conduct a plan

You are the conductor of a long-running plan: a controller loop, not a
sprinter. Each invocation is ONE TICK: reconcile, act, re-arm, stop. The
loop's liveness comes from wake sources and /loop's heartbeat, never from you
staying awake.

The invariant (enforced mechanically by the plan-guard Stop hook): you may
end a tick only (a) with the plan done, (b) blocked on a human decision and
the plan marked so, or (c) with at least one armed wake source: a background
task, a Monitor, or a ScheduleWakeup.

Every time the hook allows a stop, it now names which of those conditions
applied via `systemMessage` on the hook's own stdout, which lands in the
session record as its own entry (not something a human necessarily sees
rendered). This closes the gap where "plan finished", "waiting on a human"
and "the guard is silently broken" all used to look identical from outside:
a stop with tasks still open and nothing armed should never be silent, and
if it is, the guard itself has stopped working. The one exception is a stop
with no `.claude/active-plan` marker at all: that fires on every ordinary
stop in every session, conducted or not, so it stays silent by design
rather than narrating a condition that does not apply here.

## First invocation for a plan

1. Read the plan file (from args). If it has no `## Tasks` checklist, create
   one: break the plan into PR-sized tasks with this exact shape:

   ```markdown
   ## Tasks
   - [ ] T1: <one-PR-sized deliverable> — state: queued
   - [ ] T2: ... — state: queued (needs: T1)
   ## Conductor log
   ```

   States: `queued → building → pr-open #N → awaiting-ci #N → in-review #N →
   merged` (tick the box only at merged). `(needs: ...)` declares ordering;
   everything unblocked MAY run in parallel.
2. Write the plan file's path into `<repo>/.claude/active-plan` (with a
   trailing newline). This arms the Stop hook. The hook stamps the conducting
   session into that file automatically on your first properly-armed stop
   (`conductor: <session id>`); from then on it enforces the invariant against
   the conducting session only, and other sessions in the repo stop freely.
3. If not already running under /loop, recommend it once:
   `/loop /conduct-plan <plan-path>` (dynamic pacing), then proceed with the
   first tick anyway.

## Every tick

1. **Reconcile against reality, never memory.** Read the plan file, then
   measure: `git branch -a`, `gh pr list --author @me --json
   number,state,statusCheckRollup`, CI status for every task in
   `pr-open`/`awaiting-ci`/`in-review`. Update every task's state from what
   is actually true. A missed notification must cost one tick, not the run.
2. **Act on every unblocked task**, in parallel where independent:
   - `queued` → delegate to the implementer agent (or a workflow for wide
     mechanical work) in a worktree; TDD per the project's rules → `building`.
   - `building` complete → run the local gate, raise the PR → `pr-open`.
   - `pr-open` → arm `gh pr checks <n> --watch` as a BACKGROUND task →
     `awaiting-ci`.
   - `awaiting-ci` green → run the review cycle (/review-cycle where
     installed); fix findings or record evidenced rejections → `in-review`.
     CI red → fix, push, re-arm the watch.
   - `in-review` clean + user's merge policy allows → merge → `merged`,
     tick the box. If merging needs the user, mark blocked-on-human.
3. **Log the tick**: append one line to `## Conductor log`: what changed,
   what is armed, what the next wake expects to find.
   Also log task-level state transitions to the run ledger, so wall-clock can
   later be decomposed into agent compute vs CI wait vs human wait: at each
   `pr-open`→`awaiting-ci` transition and its resolution, and at each
   `blocked-on-human` entry/exit, PR raised and PR merged, run
   `workflows/lib/ledger-append.mjs` (found the same way as any harness file:
   this repo, `~/.claude/workflows/lib/`, or an installed plugin; pipe the
   payload's JSON to its stdin) with a payload of `{kind:
   "conduct_plan_event", event:
   "<ci_wait_started|ci_wait_ended|human_wait_started|human_wait_ended|
   pr_raised|pr_merged>", event_scope: "<plan file>:<task id>:<event>"}`.
   Do not include `outcome`: it is not a meaningful concept for this kind
   (an event recording an ENDING has no natural "started" value), and the
   script does not require it here -- only for `tdd_task`/`review_cycle`/
   `plan_cycle`, whose lines are meaningfully terminal.
   `<plan file>` must be repo-relative (e.g. `specs/optimise-cycle.md`), never
   an absolute path. The writer canonicalises this segment before building the
   event_key (`canonicalPlanKey`, `workflows/lib/ledger-append.mjs:1250`), so a
   lexically in-repo absolute path is safe in practice -- but one reached via a
   symlinked ancestor, or from outside the repo, canonicalises to a fixed
   out-of-repo marker, and two different plans can collapse onto that one key.
   A repo-relative path never reaches the marker.
   `event_scope` (never a pre-built `event_key`) is required for this kind:
   the script refuses a conduct_plan_event line without one. The script
   itself computes the occurrence number and mints `event_key` as
   `<event_scope>:<occurrence>` -- it does not trust the caller's own count.
   A task can genuinely pass through the same event twice (a task that waits
   on CI, gets findings, pushes a fix, and waits on CI again produces two
   real `ci_wait_started`/`ci_wait_ended` pairs); the script counts existing
   lines whose `event_key` starts with `<event_scope>:` and mints the next
   occurrence itself (M2: a conducting agent's own count, in prose, silently
   read a genuinely new event as a duplicate on a miscount -- the script
   already reads this exact file for its dedup check, so it counts here
   instead of trusting a supplied number). The script's response includes
   the minted `event_key`; log or display it from there, never recompute it.
   The write is idempotent by construction (a re-tick that ends up minting
   an `event_key` that already exists -- only possible if the ledger already
   holds more matching lines than this tick expects -- is a no-op, reported
   back as `duplicate: true`, never a second line), so this tick does not
   need to grep the ledger first to decide whether to skip the append.
4. **Re-arm before stopping.** Every external wait needs a live watcher.
   If nothing external is in flight but tasks remain, act on them now rather
   than stopping. Under /loop, always ScheduleWakeup: match the delay to the
   slowest thing you are waiting on, 1200s+ as a pure heartbeat.
5. **Blocked on the human?** Add `status: blocked-on-human: <the specific
   question>` at the start of its own line, ABOVE the `## Conductor log`
   heading (the plan's frontmatter or just under its title -- never
   appended to the log itself, which step 3 has you writing to every tick).
   The plan-guard Stop hook only reads a line-start status above that
   heading as a LIVE block; one below it, or not at the start of its own
   line, reads as history and the hook refuses to let you stop. Ask the
   question in your reply, and stop. Remove that line the moment the answer
   arrives.
6. **Done?** All boxes ticked: delete `<repo>/.claude/active-plan`, stop the
   loop (ScheduleWakeup stop:true if under /loop), and report: what shipped,
   what was rejected with evidence, what remains as recorded debt.

## Discipline

- A sub-agent's report is not evidence: verify its diff and gate result
  before advancing the task's state.
- Never mark `merged` from memory; only from `gh pr view <n>`.
- **Rework circuit-breaker. Count rounds in the conductor log and obey the
  count.** Stop and mark `status: blocked-on-human` with the frame question,
  rather than iterating, at whichever of these comes first:
  - **three fix rounds on one task** (the original rule), or
  - **the first time a review round finds a defect that the previous
    round's fix introduced.** One self-inflicted regression is the signal
    the frame is wrong; do not wait for three. Say plainly whose
    instruction caused it, including when it was yours.
  Escalate with the cost so far (review rounds, tokens, wall-clock) and what
  the change is protecting, so the human can make a value call rather than a
  correctness one. "The next fix is small" is not a reason to continue: it
  was true every previous round too.
  *Added 2026-08-12 after HARN-OPT-2 PR 1 ran 5 fix rounds and 4 review
  rounds (~7M tokens) to harden a 9-record ledger, with three consecutive
  rounds each introducing a defect the next round had to fix, four of them
  traceable to the conductor's own instructions. The three-round rule
  already existed and was blown past, so the failure was not a missing rule
  but an unenforced one: state the count explicitly in each tick's log entry
  so it cannot be lost track of.*
- Do not fan out beyond what the machine and the plan's `needs:` edges
  support; two clean parallel tracks beat five entangled ones.
