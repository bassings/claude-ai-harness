# Multi-lens agent harness

The default way non-trivial work is planned and reviewed on every project.

One agent carrying six concerns does the first two well. This splits them into
single-focus lenses that run in parallel, each with one job, one rubric, and no
licence to drift into someone else's.

## The two cycles

**Planning cycle**: before implementation. Each triggered lens reads the
problem statement and produces **numbered acceptance criteria** into the spec
(`specs/<NAME>.md`, per the project convention). The orchestrator synthesises
them into one plan.

**Review cycle**: before the PR. Each triggered lens **verifies its own
criteria** against the built change, and reports anything it finds outside them.
`lens-simplicity` is the exception: it runs at **planning only** (see below).

The contract between them is the AC ID. A review finding with no AC behind it is
a **spec bug**: it means the planning lens missed something. Every workflow
run, conducted or invoked directly, appends a `started` line before work
begins and a terminal line after, paired by `run_id`, to
`.claude/harness-ledger.jsonl` (untracked; see
`workflows/lib/ledger-append.mjs`) -- a run that never completes the pair
(the process killed, or a write refused) is counted separately as a
start-only or terminal-only orphan, never mistaken for a healthy run; see
README.md's "Run ledger" section for the mechanism. Each line records spec
bugs, rejected findings and rounds to clean as structured data: that ledger
is how the harness improves rather than merely runs, read on a weekly cadence
(never per-PR) by `/optimise-cycle` (`skills/optimise-cycle/`), which proposes measured,
cited changes -- it never applies one itself. Retained indefinitely with no rotation;
delete with `rm .claude/harness-ledger.jsonl`; export format is the file
itself (newline-delimited JSON) -- see README.md's "Run ledger" section
for the full field list. Each line's timestamp is an absolute wall-clock
value, not a personal identifier on its own, and is required to compute
the wall-clock durations (CI wait, human wait, rounds to clean) the
ledger exists to measure. If a line is ever deliberately committed (an
explicit opt-in; the file is untracked by default), it survives in git
history like any other tracked change.

## The `implementer` agent

Every lens below is read-only. `implementer` (`agents/implementer.md`) is the
one agent in the roster licensed to write, edit, run and commit -- `tdd-task`
dispatches it for the Test and Implement phases, and `conduct-plan` delegates
queued tasks to it. It ships as a **generic default**, not a fixed
dependency: replace `~/.claude/agents/implementer.md` with your own to change
how implementation is done without touching any workflow script. Because it
is meant to be replaced, it is deliberately excluded from the install
drift comparison (`workflows/lib/install-consistency.mjs`'s
`CONSUMER_SUBSET_PATTERNS`) -- see that file's own comment for why.

## Lens roster

**Always on**

| Lens | Cycles | Owns |
|---|---|---|
| `lens-security` | plan + review | Attack surface, authn/authz, injection, secrets, supply chain, **and privacy**: minimisation, retention, deletion, export, exposure |
| `lens-qa` | plan + review | Happy and unhappy paths, edge cases, how each AC is proven, perf thresholds |
| `lens-simplicity` | **plan only** | Arguing for less. Scope, proportionality, YAGNI |

**Triggered by change surface**

| Lens | Runs when | Owns |
|---|---|---|
| `lens-product` | A spec or user-facing change exists | Problem, user, benefit, and a success measure written as a criterion naming what must exist for it to be observable |
| `lens-design` | UI, templates, styles, copy | Design-system conformance, flows, states |
| `lens-accessibility` | UI, templates, styles, copy | WCAG 2.2 AA, keyboard, focus, AT behaviour |
| `lens-architecture` | New module, boundary, or dependency; **and any UI change, at review only** | Coupling, extension points, scale, and dead code the change created and did not remove |
| `lens-data` | Schema, migrations, destructive ops, personal data | Irreversibility, races, correctness of lookups, and whether a deletion/export mechanism does what `lens-security` requires |
| `lens-operability` | Anything reaching production behaviour | Observability, rollback, failure modes |

Each repo defines its own path globs in its `AGENTS.md`. Absent that, use
judgement, and say in the coverage statement which lenses you ran and why.

`lens-architecture`'s UI trigger is review-side only, and is not overridable by
a repo's `architecture` globs: the merge of `.claude/harness-triggers.json` over
the defaults is key-level, so a repo that names only wiring files under
`architecture` would otherwise switch the lens off for exactly the change class
that leaves orphaned code behind. **The `ui` key still defines the surface, and
that is deliberate**: narrowing a repo's `ui` globs switches off design,
accessibility, product and now architecture together, which is what tuning that
key is FOR. The guarantee is that `architecture` cannot be tuned to exclude UI,
not that UI can never be narrowed.

**When this widening should be reversed.** It buys one lens run on every diff
touching the `ui` globs, and those are wider than "UI" sounds, in two stages.
The harness defaults already include `**/*.css` and `**/e2e/**`, so a colour
token change dispatches it. And a repo REPLACES that key wholesale rather than
extending it, so `ui` means whatever that repo says it means: one delivery repo
lists `.github/workflows/ci.yml` under `ui`, a deliberate choice made for other
reasons that predates this change.

Two different costs live in that example and they must not be confused, because
a reversal argument needs both. Measured 2026-09-05 by driving that repo's real
`harness-triggers.json` through this workflow with `.github/workflows/ci.yml` as
the only changed path: **seven lenses dispatch, and removing this widening takes
that to six.** So the total load on such a diff is seven and the marginal price
of this trigger is exactly one. Three of the seven (`lens-design`,
`lens-accessibility`, `lens-product`) already fired on that diff before this
widening existed, and `lens-operability` fires on its own merits, since
`.github/workflows/**` is in its globs and a CI workflow is squarely what that
lens owns. Only `lens-architecture` is new here, and only it is in scope for
this reversal.

That is a real cost against this file's own proportionality rule, and it is
larger than the default globs suggest. `lens-architecture`'s PLANNING trigger is
unchanged, because the removal duty lives in its review-mode text and belongs at
planning to the lens that owns the area.

The reversal condition, stated now so a later `/optimise-cycle` does not have to
invent a threshold: if over eight weeks `lens-architecture` returns no
structural finding on any diff where the `ui` globs are what woke it, narrow its
UI trigger to `**/components/**` and `**/ui/**`, or drop it and leave the
on-screen half to `lens-design`.

**Restated so the ledger can answer it, and honest about what is still missing.**
The first version of this condition asked whether the lens "returns no
STRUCTURAL finding", and the ledger cannot answer that: findings records carry
`severity` and no category, deliberately, because AC-SEC-2 keeps free text out
of them. Severity IS recorded and enum-constrained, so the condition is:

> Over eight weeks, `lens-architecture` returns no finding above `Low` severity
> on any `review_cycle` line whose `architecture_trigger_source` is exactly
> `['ui-glob']` **and** whose `outcome` is `done`. If so, narrow its UI trigger
> to `**/components/**` and `**/ui/**`, or drop it and leave the on-screen half
> to `lens-design`.

The `outcome` clause is load-bearing: `optimise-read.mjs` iterates every
`review_cycle` record with no outcome filter, so an aborted round would
otherwise be counted as a clean one.

Each review line carries `architecture_trigger_source` as of 2026-09-05: an
array of `arch-glob`, `ui-glob`, `new-module` and `new-dependency`, recorded
where all those inputs are already in scope, and OMITTED entirely when the lens
did not run. **No line written before 2026-09-05 carries it, so the earliest
this window can close is 2026-10-31.**

**What is NOT yet built, stated rather than implied:** nothing reads the field.
`aggregateTriggerAccuracy` looks at `lenses_run`, `trigger_counts` and
`verdicts` and never touches it, so today the raw line records the attribution
and no report aggregates it. Running this condition in eight weeks means either
adding that aggregation first, or reading the lines by hand.

The general rule, which this paragraph has now broken twice in its own history:
**a retirement or reversal condition justified by "the ledger already records X"
is not finished until someone has checked that X answers the question, and that
something actually reads it.** Writing the field is not that check.

**Specialists, invoked as needed**, not part of the standing set.
`reviewer-verification` (adversarial fresh-eyes pass on review, no plan
context; the counterweight to lenses that only check their own criteria) and
`reviewer-experience` (user-facing text at someone's worst moment).

## Output contract

Every lens returns exactly this. No preamble, no summary of the codebase.

```
### VERDICT
CLEAN | FINDINGS | BLOCKED

### MEASURED AT                [review mode only]
head_tree_measured: <output of `git rev-parse <reviewed-tip-sha>^{tree}`>
head_sha_measured:  <output of `git rev-parse HEAD` in your own worktree>

<Both are required. The FIRST is checked: the orchestrator compares it to the
reviewed tip's tree and refuses the whole run if they differ. Its expected value
is deliberately absent from your prompt, because the tip's SHA is given to you
and echoing something you were told proves nothing about what you read.

The SECOND is recorded, never checked. Report it honestly even when your
checkout has drifted from the tip, which is normal and expected: drift is
measured, not punished, and it never fails a run.

Neither command moves your checkout, and you must not move it. These worktrees
can be shared, and checking out a different commit underneath another session is
the incident this check exists to detect.>

### COVERAGE
Examined:      <files, paths, commands: be specific>
Verified by:   <what you executed or read, not what you assumed>
Could NOT check: <what, and why: this field is mandatory>

### ACCEPTANCE CRITERIA        [planning mode only]
AC-<LENS>-<n>: <testable statement: a thing that can be shown true or false>

### AC VERDICTS                [review mode only]
AC-<LENS>-<n>: PASS | FAIL | UNVERIFIABLE: <evidence>

### FINDINGS
[SEVERITY] <one-line claim>: <file:line>
  Evidence:    <how you know: command output, code you read>
  Consequence: <concrete, not "could be a problem">
  Fix:         <smallest change that resolves it>
  Recurrence:  <do you expect more instances of this same class elsewhere in
                the diff or the codebase? say so, even as a guess>
```

`BLOCKED` means you could not do your job: missing context, unrunnable code.
Say so rather than returning a confident CLEAN.

**The `Could NOT check` field is not optional.** A lens returning CLEAN because
it never looked is the failure mode this harness exists to prevent.

**Say whether you expect more of the same.** A rule that only fires on
recurrence cannot fire until round two, which is already the expensive round:
you, the lens, are looking at the whole diff with the finding already in
hand, and you know the class's extent before the author does. Naming that
expectation now lets a second instance get fixed in the SAME round it was
first spotted, instead of surfacing in a fresh review pass as the same policy
drifting into a new paraphrase. Worked example, credited to the
couchpotatoserver-dc session: CouchPotatoServer PR #279 took six review
rounds to close, four of which were the same policy list drifting into a new
paraphrase every round -- it closed only once that list was turned into a
test instead of a prose reminder.

## What a change replaces

Every lens writes criteria for what the change ADDS. Nothing has ever been
asked what it REMOVES, and a replacement is two jobs: put the new thing in,
take the old thing out. Only the first half has ever had a criterion behind
it, so the second half is invisible to review, which verifies criteria.

**The lens that owns the area owns the removal.** `lens-design` owns the
control, screen or copy the new one supersedes; `lens-data` owns the table,
column or file the new shape retires; `lens-architecture` owns the module,
helper or route left with no caller; `lens-operability` owns the metric,
alert, job or runbook entry the old path needed and the new one does not.
No single lens owns removal for the whole change: the specialist who knows
what the new thing does is the only one who knows what it makes redundant.

At planning, for anything your area gains, ask what it displaces, and write
the removal as its own numbered criterion, phrased so review can fail it:

- Good: `AC-DESIGN-4: the secondary dismiss control is gone; the dialog
  renders exactly one close control.`
- Bad: `AC-DESIGN-4: old controls are cleaned up.`

If the change genuinely replaces nothing, say so in one line. An empty
removal list stated is a different claim from one never considered, and this
harness exists because those two look identical from the outside.

At review, verify the removal criteria the way you verify the additions:
against the built change, not the plan's description of it.

**Why this is here and not in one lens's file.** Reported 2026-08-31: a
story-collection screen carried two controls, styled as a choice, that called
the same function with the same arguments. The owner read them as leftovers not
wired to anything. They WERE wired up, which is worse: a dead control is
obvious and gets fixed, while two live controls that quietly mean the same
thing promise the user a decision the app cannot honour. Every acceptance
criterion described the new work, and the new work was correct, so review
passed honestly. The tests drove one control and asserted it worked, which they
did just as happily with its twin sitting beside it.

Note the shape, because it decides where the duty lives: this failure is
invisible to a call-graph reader, since both controls are live and called, and
to a test that clicks one of them. That is why the on-screen inventory belongs
to `lens-design` and not to `lens-architecture`. A contract that said "orphaned
controls were left on screen" would teach the reader to hunt dead things, which
is the easy case and the one that gets found anyway.

*(Corrected 2026-09-05. This paragraph previously dated the incident 2026-09-04
and described the controls as wired to nothing. Both were wrong, and both came
from me: the date was the timestamp of the TELLING rather than of the event,
and the mechanism was the owner's reported symptom adopted as the diagnosis.
Settled by searching the session transcripts for every user-authored mention of
a button since 2026-08-20: three, of which two are this one incident reported
four days apart. Two review rounds did not catch either error, because a review
checks whether the code matches the document, not whether the document's
account of history is true.)*

## Severity

| | |
|---|---|
| **Critical** | Irrecoverable loss, or remote compromise. Stops the release |
| **High** | Data corruption, auth bypass, WCAG blocker, silent failure of the feature |
| **Medium** | Real defect with a workaround, or a guard that cannot fail |
| **Low** | Correct but worse than it should be |

Severity is about consequence, not confidence. An unproven Critical is still a
Critical: mark the confidence in the evidence line.

## Evidence discipline

Applies to every lens, in both cycles.

- **Cite `file:line`.** A finding without a location is an opinion.
- **Verify by executing** where it is possible to execute. "I read the code and
  it looks wrong" is a hypothesis; running it is a finding.
- **Distinguish fact from judgment**, explicitly, in the finding.
- **Prefer five high-confidence findings to twenty speculative ones.**
- **You are licensed to return CLEAN.** A lens that always finds something is
  producing noise, and noise is how real findings get skimmed past.
- **Never modify files.** Lenses analyse. `implementer` builds.

## House style

Your report is an artefact, not advice: keep the output contract above, do not
open with a challenge or a summary of the codebase, and do not add commentary
on top of the evidence lines.

If the adopting user or project defines a house style (spelling variant,
punctuation rules, terminology), it applies to every word of your report,
including findings, criteria and any file you quote into.

## Conflict precedence

Lenses will contradict each other: security wants a confirmation step, product
wants one click; accessibility wants more markup, performance wants less. The
orchestrator arbitrates using this order, highest first:

1. **Irrecoverable data loss**: anything that cannot be undone
2. **Security**: authn/authz, secrets, remote compromise
3. **Accessibility floor**: WCAG 2.2 AA is a floor, not a trade-off
4. **Operability**: can we tell it broke, can we undo it
5. **Product and design intent**
6. **Performance**

Ties above the line are escalated to the human, not resolved silently.

**Simplicity's veto is a different mechanism, not a rank.** `lens-simplicity`
may reject any requirement not traceable to a stated acceptance criterion, and
that rejection stands unless the owning lens supplies the criterion. It cannot
override items 1-3. This is what stops nine specialists inflating every change:
each lens adds requirements, and without a counterweight nothing ever removes
them.

### Why simplicity is planning-only

At review time the code exists, so a simplicity finding is a request for rework
on scope that was already agreed: the re-litigation this harness's exit
condition exists to prevent, arriving after the cost has been paid. Its leverage
is entirely at planning, where a veto is free.

Its criteria are still checked. `AC-SIMP-<n>` constraints are the most
mechanical in the set ("no new dependency", "no new setting", "no abstraction
for a single call site"), so **the orchestrator verifies them directly against
the diff** at review: no agent needed. Write them so that is possible.

The structural half of what simplicity would have caught at review (single-caller
abstractions, premature generality, defensive code for impossible conditions,
dead code the change created) belongs to `lens-architecture` in review mode.
Scope drift from the user's side belongs to `lens-product`. **If neither is
triggered for a given change, the orchestrator does that check itself**; it is
a diff read, not a judgment call.

## Exit condition

A stateless reviewer can always find one more angle.

- A finding that is investigated and shown to be a false alarm is **rejected
  with evidence**, and that rejection is recorded.
- A lens that raises the same finding twice after a documented rebuttal
  **escalates to the human**: it does not repeat.
- Marginal nits on low-risk changes are rejected. Converge on substance.

## Proportionality

The harness scales to the change. A dependency bump does not get nine lenses;
a destructive file operation does. Running everything on everything trains
people to skim the output, which is worse than not running it.

If in doubt, run fewer lenses and say which you skipped.

## Cost note

Nine lenses across two cycles is a lot of invocations. Planning runs **once per
spec**; review runs **per push, scoped to the changed surface**. Prove the
harness on one real change before adopting it as standing process.
