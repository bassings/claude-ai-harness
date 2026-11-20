# HARN-RULES-1: builders are handed the analyser rules this repository actually trips

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft
**Lenses run:** none yet · **Skipped:** none yet

## Problem

Code built through the harness passes its tests and its review and then fails
the repository's static analyser after it merges. The clean-up arrives as a
second pull request. Measured in a sibling repository that runs this harness
with a self-hosted SonarQube, 2026-11-13 to 2026-11-21: of eleven post-merge
scans, four found new issues (5, 1, 5 and 1) and each was followed by its own
fix PR. In this repository the three merges of 2026-11-13 created three new
issues, and 150 are open.

What that repository's conducting session learned, reported by it on
2026-11-21 and not yet written into any file there:

1. Telling a builder "this must pass SonarQube" changed nothing. The ruleset is
   thousands of rules and the instruction primes none of them.
2. Naming the handful of rules that repository trips, in the builder's brief,
   did help: the last three feature merges scanned clean. The sample is small,
   the PRs differ in size and language, and there is no controlled comparison,
   so this is an indication and not a proof.
3. A list kept by hand only ever prevents the last mistake. Both five-issue
   scans followed a brief that did not yet name the rule that fired. Nothing
   handled the list going stale.
4. The list was built reactively from two queries against the analyser: the
   issues in the new-code period after each merge, and the open issues faceted
   by rule. Two traps: every query must ask for unresolved issues only, and an
   issue's line number describes the commit last analysed, not the working
   tree.
5. Nothing was enforced by a tool. Some analyser rules have a linter
   equivalent that would fail the build earlier; none had been tried.

The owner's global standards already say to name the environment code will be
judged in, with the rules "this codebase actually trips, with counts measured
from a real scan". The harness gives a builder no way to receive that list,
and nothing produces it.

For whom: anyone running the harness in a repository that has a static
analyser. The owner's three repositories are the first users, and the sibling
repository's session has said it will adopt this in place of building its own.

## Proposed shape (for the lenses to challenge)

Two parts, deliberately separable:

1. **A rules table the builder reads.** One optional plain-text file per
   repository at a fixed path under `.claude/`. When it exists, the
   `implementer` agent reads it before writing a test or production code, in
   both `tdd-task` phases and when dispatched directly by `conduct-plan`. When
   it does not exist nothing changes. The table is analyser-neutral: rule
   identifier, what to write instead in one line, how many open, how many new
   recently, and the date and revision it was derived from. A repository with
   no SonarQube can write the file by hand or fill it from another analyser.
2. **A generator that fills the table from SonarQube.** A small dependency-free
   Node program shipped in `bin/`, run by a person or by the conductor after a
   post-merge scan, never by CI and never as a gate. It asks the server for the
   rules new code tripped in a recent window and the largest open rules, looks
   up each rule's own name for the one-line guidance, and writes the table with
   its derivation stamp. Server address and token come from the environment
   only.

Linter equivalents (finding 5) are a per-repository follow-up and are not built
here.

## Not in scope

- Making any analyser result a gate. The owner's standards forbid wiring a scan
  in as a blocking check, and this change must not become one by another route.
- Running the scan itself. Each repository already has its own way to scan.
- Resolving, dismissing or accepting issues, or changing an analyser's rule
  configuration.
- Switching on linter rules in any repository.
- The lens agents. Lenses stay read-only and are not handed the table; whether
  review should check new code against it is a later question, once there is
  evidence the table helps builders.
- Analysers other than SonarQube for the generator. The table format is
  neutral so another generator can be added without changing the consumer.

## What this replaces

Nothing in this repository. In the sibling repository it replaces a paragraph
pasted by hand into each builder brief; removing that is that repository's
change, not this one.

| What goes | Owning lens | Removal criterion |
|---|---|---|
| nothing | | |

---

## Acceptance criteria

*To be written by the planning cycle.*

---

## Open questions for the planning cycle

1. Is the table tracked in git (shared, reviewed, but churning with every
   scan) or untracked and ignored (private, regenerated per machine)? The
   generator's counts change on every scan.
2. The table's text reaches a builder's instructions. It is derived from an
   analyser's rule names and from a file anyone with commit access to the
   repository can write. What stops it carrying instructions instead of
   coding guidance, and how large may it grow before it crowds the brief?
3. How does a builder, and a person, tell that the table is stale: by age, by
   the analysed revision falling behind, or both? What happens then: a warning
   or nothing?
4. Where does the token come from so that it cannot land in a tracked file, a
   log line or the table itself, and so the program refuses a server address
   it should not send a token to?
5. What is the measure that this helped, recorded where the delivery optimiser
   can read it: new analyser issues per merged PR before and after?
6. Does `tdd-task` need to mention the table in its prompts, or is the
   instruction in the `implementer` agent definition enough? A workflow script
   cannot read files itself.

## Vetoes and trade-offs

| Item | Raised by | Decision | Rationale |
|---|---|---|---|
| Rules table plus generator, not table only, linters only or documentation only | owner, 2026-11-21 | accepted | A hand-kept list was the measured weakness |
| One shared version for the owner's three repositories | owner, 2026-11-21 | accepted | The sibling repository's session asked to consume it |
| Own small spec now, outside the stopped HARN-AUDIT-1 plan | owner, 2026-11-21 | accepted | Touches builder instructions, not the runner or the guard |

## Risks

To be ranked by the planning cycle.

## Affected files

| Path | Change |
|---|---|
| `agents/implementer.md` | read the rules table when present |
| `workflows/tdd-task.js` | possibly name the table in both phase prompts |
| `bin/` (new program) | the SonarQube generator |
| `workflows/lib/install-consistency.mjs` | ship the new program |
| `README.md`, `AGENT-HARNESS.md` | document the table and the generator |
| `test/` | tests for the generator and for the consumer instruction |
