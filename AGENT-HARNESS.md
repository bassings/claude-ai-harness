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
| `lens-product` | A spec or user-facing change exists | Problem, user, benefit, success measure |
| `lens-design` | UI, templates, styles, copy | Design-system conformance, flows, states |
| `lens-accessibility` | UI, templates, styles, copy | WCAG 2.2 AA, keyboard, focus, AT behaviour |
| `lens-architecture` | New module, boundary, or dependency | Coupling, extension points, scale |
| `lens-data` | Schema, migrations, destructive ops, personal data | Irreversibility, races, correctness of lookups, and whether a deletion/export mechanism does what `lens-security` requires |
| `lens-operability` | Anything reaching production behaviour | Observability, rollback, failure modes |

Each repo defines its own path globs in its `AGENTS.md`. Absent that, use
judgement, and say in the coverage statement which lenses you ran and why.

**Specialists, invoked as needed**, not part of the standing set.
`reviewer-verification` (adversarial fresh-eyes pass on review, no plan
context; the counterweight to lenses that only check their own criteria) and
`reviewer-experience` (user-facing text at someone's worst moment).

## Output contract

Every lens returns exactly this. No preamble, no summary of the codebase.

```
### VERDICT
CLEAN | FINDINGS | BLOCKED

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
