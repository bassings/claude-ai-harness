# HARN-RUNNER-2: the weekly run collects its own data and produces complete reports

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft
**Lenses run:** none yet · **Skipped:** none yet

Carries tasks T34, T31 and the relevant parts of T33 from
`specs/harn-audit-1.md`, whose conducting is stopped.

## Problem

The weekly delivery-optimiser job (`bin/optimise-cycle-weekly.sh`, run by
launchd) is switched off on the owner's machine, and has been since
2026-11-14, because its output could not be trusted.

What was measured, recorded in `docs/release-checklist.md` section 5:

- Before HARN-AUDIT-1 T11 the job ran an unattended session with the safety
  hooks off and permissions bypassed, and produced full reports.
- T11 put the session under an explicit allowlist with the hooks on. The
  allowlist holds: every host-naming, out-of-root and unlisted command probed
  was refused, and the read commands were allowed.
- The first real run under it, three repositories through launchd on
  2026-11-13, was contained and tidy and logged `RESULT PASS` three times.
  Every report was hollow, by each session's own closing text: the
  workflow's report write did not land and the session wrote the file from
  the returned text; one session was refused the shell tool outright, so its
  ledger, git and CI lanes never ran and it reported 0 ledger records against
  a 78-line ledger; another read 0 ledger records where the previous week's
  report showed 467.
- Two causes are measured. A subagent's Write of a report file is refused by
  the CLI whatever the allow rules say ("Subagents should return findings as
  text, not write report files"), and the workflow writes its report through a
  subagent. The runner's verdict checks the report's shape (a first-level
  heading and one section heading) and not its content, so a hollow report
  passes.
- One cause is not measured: why one session was refused the shell tool
  outright while a probe's Workflow-started and Agent-started subagents were
  allowed the same commands under the same flags.

So the job has two honest states today, both unacceptable: full reports from
a session nothing constrains, or a constrained session whose reports are empty
and marked as passes.

For whom: an operator who runs the optimiser unattended. The owner's three
repositories are the first users; no weekly report has been produced since
2026-11-08.

## Direction set by the owner (2026-11-14)

A redesign, not a patch to the allowlist: **the runner collects the ledger,
git and CI data itself, and the unattended session only analyses what it is
handed and returns text; the runner writes the report.** The planning cycle
decides whether the session then needs any Bash rule at all.

What exists to build on:

- `workflows/lib/optimise-read.mjs` already turns raw inputs into the
  aggregates the report uses, as a program: `ledger <roots> --window=N`,
  `escaped-defects` (raw `git log` on stdin), `ci` (run and job lists on
  stdin), and the proposal-id computation. Today an agent runs each of these
  inside the session; nothing about them needs a model.
- `workflows/optimise-cycle.js` (1,637 lines) holds the lanes that run those
  commands, the synthesis step that drafts proposals, the mechanical gates
  that drop a proposal (no resolvable citation, removal without reinstatement
  evidence, an always-on lens, an unmeasured segment), the report assembly and
  the report write. It is also run by hand, as `/optimise-cycle`, in an
  attended session where its lanes work.
- The runner already owns a private per-run directory, places the report and
  sidecar into each repository, restores the plan marker, and notifies on
  FAIL.

## Shapes for the lenses to choose between

**A. The runner collects, the workflow analyses.** The runner runs the three
collectors and the nonce itself and writes their JSON into the per-run
directory. `optimise-cycle.js` gains an input by which the lanes are skipped
when collected data is supplied, keeps synthesis, gates and report assembly,
and returns the report as text; the main session hands that text back and the
runner writes the files. One workflow, two ways in. A workflow script cannot
read files, so the collected JSON reaches it through the session, as
arguments or through one agent that reads the files.

**B. The runner collects and assembles, the session only drafts.** As A for
collection, but the unattended path does not run the workflow at all: one
prompt hands the session the aggregates and asks for draft proposals as
structured text, and a new program applies the gates and assembles the
report. The gates and assembly then exist twice, in the workflow for attended
use and in the program for unattended use, unless the workflow is changed to
call the same program.

**C. As A, and the attended `/optimise-cycle` uses the collectors too**, so
there is one collection path and the lane agents go away entirely.

## Not in scope

- Changing what the optimiser measures or proposes.
- Applying any proposal. The optimiser stays read-only.
- The other T33 items that do not touch this path.
- Switching the weekly job back on. That happens on the owner's machine, by
  the owner's decision, after a real run is recorded.

## What this replaces

To be completed by the planning cycle: at least the subagent report write,
the shape-only verdict, and whichever Bash allow rules the unattended session
no longer needs.

| What goes | Owning lens | Removal criterion |
|---|---|---|
| | | |

---

## Acceptance criteria

*To be written by the planning cycle.*

---

## Open questions for the planning cycle

1. Which shape, A, B or C, and how does collected data reach a workflow
   script that cannot read files without an agent retyping a large JSON
   document and getting it wrong?
2. With collection moved out, which tools does the unattended session need:
   Read of the per-run directory and nothing else, or still some Bash? What
   is removed from the allowlist, and what does the session lose the ability
   to do that it could do before?
3. The collectors run `gh` and `git` as the operator, outside any session.
   What bounds them: timeouts, the repository root, which host `gh` may talk
   to, and what happens to one repository when its collection fails?
4. What makes a report complete enough to PASS? Each lane's result says
   whether it ran; a report in which the ledger lane read nothing while the
   ledger file is non-empty is hollow. What is the verdict when one of three
   lanes could not run for a reason outside the runner's control, such as
   `gh` being unauthenticated?
5. The unexplained shell refusal. Does the redesign make the question moot by
   removing the session's need for the shell, and if so how is that shown
   rather than assumed? If not, what is the first measurement?
6. How is the change proven for real, given that the suite drives a stub
   `claude` and every earlier real defect on this path was invisible to it?
   What is recorded in `docs/release-checklist.md`, and what is the rollback
   on the owner's machine?
7. The session's output is model text that the runner will write into a
   tracked-adjacent file and score. What stops it carrying something the
   runner should not write, and how large may it be?

## Vetoes and trade-offs

| Item | Raised by | Decision | Rationale |
|---|---|---|---|
| Redesign: the runner collects, the session only analyses, the runner writes the report | owner, 2026-11-14 | accepted | Patching the allowlist had gone four review rounds; the measured failure was the session's need to act |
| This work before any further rules-table work | owner, 2026-11-21 | accepted | The weekly job has produced nothing since 2026-11-08 |

## Risks

To be ranked by the planning cycle.

## Affected files

| Path | Change |
|---|---|
| `bin/optimise-cycle-weekly.sh` | collects the data, hands it over, writes the report, scores it on content |
| `workflows/optimise-cycle.js` | per the shape chosen |
| `workflows/lib/optimise-read.mjs` | possibly a completeness summary for the verdict |
| `skills/optimise-cycle/SKILL.md`, `README.md` | what the unattended run now does and needs |
| `docs/release-checklist.md` | the real-run record |
| `test/` | tests, including one that fails a hollow report |
