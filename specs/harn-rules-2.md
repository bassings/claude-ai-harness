# HARN-RULES-2: a rule one project trips reaches the tables of its sibling projects

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft
**Lenses run:** none yet · **Skipped:** none yet

## Problem

HARN-RULES-1 gave builders a table of the analyser rules their own repository
trips. That table is built only from that repository's history, so it can stop
a mistake being repeated and cannot stop it being made the first time.

Measured, 2026-11-21:

- In a sibling repository, after the worst rule was named in the builder's
  brief it fell from 21 new issues to 2. The eight feature PRs that followed
  scored 1, 4, 4, 5, 1, 0, 0, 1 new issues, and each non-zero count was a rule
  nobody had listed yet. Clean-up PRs raised only to fix scan findings went
  from 2 to 6 over the period.
- In this repository the first entry in the per-merge record was 9 new issues,
  6 of them on listed rules, from builders that had not read the table; the
  second, from a builder that had, was 0 and 0. One PR, so an indication only.
- On the owner's analyser server, issues created in the last 30 days: this
  repository 57 across 15 rules (JavaScript 55, Python 2); the sibling
  repository 51 across 12 rules (Python 37, JavaScript 6, TypeScript 4, web
  4); a third repository none. Ten of the sibling's twelve recently tripped
  rules are in languages this repository also has, and none of the ten is in
  this repository's table. One of them, awaiting inside a loop, is a rule this
  repository's own generator then tripped.

So a rule tripped in one project is evidence about what a builder working in
the same language in a sibling project will trip next, and nothing carries it
across.

For whom: an operator with more than one project on the same analyser server,
written by the same builders. The owner's three repositories are the first
users.

## Proposed shape (for the lenses to challenge)

The generator from HARN-RULES-1 accepts an optional list of sibling project
keys on the same server. For each sibling it asks, with one faceted query, for
the rules new code tripped in the same recent window, and adds to this
repository's table those whose language this repository also has and which the
table does not already hold. Such a row is marked as coming from a sibling,
shows no counts for this repository, and takes the analyser's rule name as
guidance until someone improves it; hand-written guidance survives a refresh
exactly as for any row. Rows from this repository's own recent history always
rank ahead of rows that come only from a sibling, and the row cap still holds.

With no sibling list given, the output is byte-for-byte what it is today.

Two older faults in the same program, found by the last check of
HARN-RULES-1 and present before it, are fixed in passing: an unexpected
error's name is printed without being checked against a safe pattern, and a
server that sends headers and then stalls is reported as "not valid JSON"
where "timed out" is the truth.

## Not in scope

- Sharing across analyser servers, or with projects the token cannot read.
- Copying hand-written guidance from a sibling's tracked table. That would
  need this program to read another repository's files.
- Any automatic run, gate or schedule. A person still runs the generator.
- Linter rules. Each repository's own follow-up.
- Changing what a builder is told. `agents/implementer.md` and `tdd-task`
  already describe the table by its columns; whether a sibling row needs any
  different handling by a builder is a question for the lenses, and the
  preferred answer is no.

## What this replaces

Nothing.

| What goes | Owning lens | Removal criterion |
|---|---|---|
| nothing | | |

---

## Acceptance criteria

*To be written by the planning cycle.*

---

## Open questions for the planning cycle

1. How is a sibling row shown without breaking the four-column format that
   HARN-RULES-1 fixed, documented once and pinned in tests: a marker in an
   existing column, or a fifth column? What does a table written by hand, or
   by HARN-RULES-1's generator, look like to a reader expecting the new form?
2. How does the program know which languages this repository has: from the
   rule keys in its own facets (which misses a language with no issues yet),
   or from a measure the token may read?
3. The row cap is 20. This repository's own recent rules already fill 15 and
   the sibling would add 10. What is dropped first: this repository's old
   backlog rows, or sibling rows? Is the cap still right?
4. A sibling's project key is operator input sent to the server and the
   sibling's rule keys and names are server data written into a tracked file.
   What bounds and checks apply, and what happens when the token cannot read
   a sibling, or a sibling key does not exist: fail the run, or skip it and
   say so?
5. Does the success measure change? Today it counts new issues on listed
   rules. A sibling row that a builder then trips here is the measure working;
   a sibling row never tripped here is noise in the table. How is that told
   apart after ten merges?
6. Where does the sibling list live so that it is not a secret and does not
   drift between a person's shell and the repository: the environment only,
   as for every other setting, or a tracked line somewhere?

## Vetoes and trade-offs

| Item | Raised by | Decision | Rationale |
|---|---|---|---|
| Share tripped rules across the owner's repositories, after HARN-RULES-1 and before the weekly-runner redesign | owner, 2026-11-21 | accepted | The only cheap change aimed at first-time trips |

## Risks

To be ranked by the planning cycle.

## Affected files

| Path | Change |
|---|---|
| `bin/sonar-rules-table.mjs` | optional sibling project keys; the two older faults |
| `README.md` | the sibling option, and how a sibling row reads |
| `test/`, `docs/` | tests, fixtures and mutation-proof records |
| `.claude/analyser-rules.md` | regenerated with the sibling option |
