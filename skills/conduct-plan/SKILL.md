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
   "conduct_plan_event", outcome: "started", event:
   "<ci_wait_started|ci_wait_ended|human_wait_started|human_wait_ended|
   pr_raised|pr_merged>", event_scope: "<plan file>:<task id>:<event>"}`.
   `<plan file>` must be repo-relative (e.g. `specs/optimise-cycle.md`), never
   an absolute path: the ledger writer redacts an absolute path it finds
   embedded in the resulting event_key, and a redacted-away path can collide
   across two different plans, which a repo-relative one never does.
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
   question>` to the plan file, ask the question in your reply, and stop.
   Remove that line the moment the answer arrives.
6. **Done?** All boxes ticked: delete `<repo>/.claude/active-plan`, stop the
   loop (ScheduleWakeup stop:true if under /loop), and report: what shipped,
   what was rejected with evidence, what remains as recorded debt.

## Discipline

- A sub-agent's report is not evidence: verify its diff and gate result
  before advancing the task's state.
- Never mark `merged` from memory; only from `gh pr view <n>`.
- After three failed fix rounds on one task, mark it
  `status: blocked-on-human` with the frame question instead of a fourth
  attempt.
- Do not fan out beyond what the machine and the plan's `needs:` edges
  support; two clean parallel tracks beat five entangled ones.
