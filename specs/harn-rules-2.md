# HARN-RULES-2: a rule one project trips reaches the tables of its sibling projects

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** parked by the owner on 2026-11-21, before any build. See "Backtest and decision". Only the two older faults named below are fixed now.
**Lenses run:** security, QA, simplicity, product, operability (planning cycle `wf_a5e3fdb6-c85`, 2026-11-21) · **Skipped:** design and accessibility (no interface), data and architecture (one program, no stored data, no new module)

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

## Backtest and decision

AC-PROD-7 required a backtest before any build. Taken by the conductor from
the analyser on 2026-11-21, over every issue the server still holds for the
three projects (open, confirmed and fixed; 182, 725 and 88 issues):

| Project | Rules first seen there in the last 30 days | Issues on those rules | A sibling had tripped the rule at any earlier time | A sibling had tripped it within the 30 days before |
|---|---|---|---|---|
| the sibling repository | 6 | 8 | 4 rules, 4 issues | 0 rules, 0 issues |
| this repository | 6 | 10 | 3 rules, 5 issues | 1 rule, 1 issue |

By rule-set prefix, issues on first-seen rules and how many of those a sibling
had earlier: the sibling repository, JavaScript 4 and 3, Python 4 and 1; this
repository, JavaScript 10 and 5.

What it says. Siblings' history predicted about half of the first-time trips
(9 of 18 issues), so the problem claim holds. The shape proposed below does
not: it shares only what a sibling tripped in the recent window, which would
have caught 1 of 18. Sharing everything a sibling has ever tripped would have
caught 9 of 18, at the cost of a longer table whose noise is unmeasured.

Limits of the backtest: 18 issues over one month in two projects; the server
purges closed issues after its retention period and dates an issue by when its
line was written, so "first seen" means first among what is still held.

**Owner decision, 2026-11-21:** park the sharing work. The sample is small,
HARN-RULES-1 took three review rounds, and the weekly runner has been switched
off for a week and comes first. Revisit after HARN-RULES-1's ten-merge reading;
if it is taken up again, the shape to plan is all-time sibling rules in
matching languages with the row cap reconsidered, not the recent window. The
acceptance criteria below were written for the recent-window shape and are
kept as the planning record; they are not a contract for a build until the
spec is re-planned.

## Proposed shape (as drafted, superseded by the backtest)

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

Written by the planning cycle on 2026-11-21 from five lens reports (security,
qa, simplicity, product, operability). Ids are the lenses' own; a gap in a
lens's numbering is a criterion merged into another (named in that
criterion's trailing note) or dropped under "Vetoed at planning" below.
"Sibling variable" means the one new environment variable that carries the
sibling project keys. "The HARN-RULES-1 generator" means
`bin/sonar-rules-table.mjs` as it stands on main before this change.

The answers these criteria give to the open questions: four columns with one
constant marker in the count cells (question 1); languages taken from the
rule-key prefixes of this repository's own facets (question 2); own recent
rows, then sibling-only rows, then own backlog rows, under the one existing
cap (question 3); any sibling failure fails the run with nothing written
(question 4); no new stamp field, the ten-merge verdict is a manual read of
the table's git history (question 5); the environment only (question 6).

### Security and privacy

- **AC-SEC-1:** The sibling list is read only from the sibling variable in the generator's own process environment, never from a command-line flag, the table, `sonar-project.properties` or any other tracked file; the generator reads no configuration file and parses no command-line option, and no tracked file outside `README.md`, `specs/`, `test/` and `docs/` contains that variable's name or a value for it. Threat model, for the record: the adversaries are anyone who can read this public repository, anyone who can influence analyser data such as rule names, and a committer who could point the operator's token at another project; the prize is the names and code-quality profile of the owner's other projects, and a channel into the implementer model. Test: with the variable unset and a tracked file in the repository naming a sibling key, a run sends zero requests carrying that key (fixture server request log) and the output is byte-identical to a run with no sibling configured. *(merges AC-SIMP-2)*
- **AC-SEC-2:** No sibling project key reaches any tracked artefact. A sibling row is marked only by one fixed constant that does not vary with which sibling contributed it. Test: with the sibling variable set to two unique sentinel keys whose fixture facets contribute rows, a search of the written `.claude/analyser-rules.md`, rows and derivation stamp included, finds zero matches for either sentinel, and a search across every tracked file after the run (`git ls-files`) also finds zero. *(merges AC-SIMP-4)*
- **AC-SEC-3:** Sibling data in the tracked table is minimised. A sibling-only row carries the rule key, the guidance and the fixed marker, and no count, issue key, file path, author, assignee or project name originating from the sibling. Each sibling's issues query requests only the rules facet, with no author, assignee, file or directory facet, and `ps=1`. Test: sibling fixture payloads carrying author emails, assignee logins, component paths and the sibling's project name produce a table in which a search for the at sign, each login, each path and the project name finds zero matches, and the fixture server log shows every sibling request's `facets` parameter is exactly `rules`.
- **AC-SEC-4:** Every project key, the own `SONAR_PROJECT_KEY` and each sibling key, is validated before any request is sent. A key must match one fixed pattern of letters, digits and the characters `_ . : -` with a fixed maximum length, so no comma, whitespace, slash, percent sign, ampersand, NUL or control character passes. The sibling list holds at most a fixed number of keys, held as a named constant beside `ROW_CAP`. Empty entries and surrounding whitespace are ignored, and duplicates and a sibling equal to the own key are dropped. An invalid key, or a list over the maximum, aborts the run with a non-zero exit, zero requests sent, the existing table byte-identical, and one stderr line that does not quote the rejected text; the over-maximum line names the limit. Test, table-driven: the keys `a,b`, `a b`, `../x`, `a&b`, a 500-character key, a key holding a NUL, a key holding a newline and an ANSI escape, and a list one over the maximum each give that outcome, checked on the fixture server's recorded raw URLs, on stdout and stderr, and by a byte comparison of the table; `a,,b` with padded whitespace, a duplicated key and the own key each give a normal run with one request set per distinct sibling. *(merges AC-QA-8 and the list-maximum half of AC-OPS-11)*
- **AC-SEC-5:** Sibling-derived data is held to the same inert-data rules as own data under HARN-RULES-1 AC-SEC-5. A sibling facet rule key that fails the rule-key pattern, or carries a non-integer or negative count, is dropped and counted in the existing rejected-count note, never quoted; rule names looked up for sibling rows pass through the same sanitiser and length cap. Test: the HARN-RULES-1 hostile-name fixture set (a newline followed by a heading, a 10 KB name, column separators, a backtick fence, an ANSI escape, U+202E, tag characters, an imperative sentence telling the reader to ignore prior guidance, and the rule key `../../x`) served as a sibling's facet and rule names yields a table in which every row is one physical line with the header's column count, none of the listed characters survives, `../../x` is absent, and no stray line appears. *(merges AC-QA-9)*
- **AC-SEC-6:** The sibling feature adds no new host, redirect or credential path. Every sibling request goes to `SONAR_HOST_URL` with the same Authorization header and `redirect: manual`, and the token sentinel test of HARN-RULES-1 AC-SEC-4 is extended to siblings. Test: with `SONAR_TOKEN` set to a sentinel and a sibling whose fixture answers 200, 401 echoing the Authorization header, 403, 500 echoing all headers, and 302 to a second fixture port, a search of stdout, stderr and the table for the sentinel finds zero matches, and the second port records zero requests.
- **AC-SEC-7:** A sibling that does not exist, or that the token cannot read, is never silent and never contributes rows. Each sibling's existence is proved before its facet query by the same lookup `confirmProject` uses for the own key, which can answer not-found, because an issue search alone answers 200 with total 0 for an unknown project. Either cause fails the run: non-zero exit, the table byte-identical, and one stderr line naming the validated sibling key and saying which cause applied, not found or not permitted. Test: the fixture server models the live one, answering 200 with total 0 to the issue search for an unknown sibling; one run with a sibling answering 404 on the lookup and one with a sibling answering 403 each give that outcome with the matching cause, and the test fails if the generator relies on the issue search alone. *(merges AC-OPS-1 and AC-QA-6; the fail policy is AC-SIMP-10, see AC-QA-7)*
- **AC-SEC-8:** The request count is bounded and independent of issue volume. Each sibling costs at most one existence lookup and one rules-facet query, name lookups are made for kept rows only, and the total for a run is a documented fixed function of the sibling maximum and the row cap. Test: with 1 sibling and with 3 siblings the fixture server's request log length equals the documented formula; a sibling fixture offering 500 tripped rules and a total of 100000 issues gives the same count as one offering 10 issues, and a table within the existing row and byte caps. *(merges AC-QA-14 and the per-sibling request half of AC-OPS-11)*
- **AC-SEC-9:** An unexpected error's name is printed only when it matches a fixed safe pattern, an identifier of bounded length made of letters, digits and underscores; otherwise the fixed line `sonar-rules-table: unexpected error` is printed. Test, through a new `test/helpers/write-hook.cjs` mode that throws an error with no code and a chosen name: names holding a newline, an ANSI escape, a column separator, the token sentinel and 200 characters each give stderr of exactly that one fixed line, with zero matches for the sentinel or the escape; the name `TypeError` still gives one line naming `TypeError`. Mutation, run and recorded in both directions: deleting the pattern check fails the hostile cases, and removing the name entirely fails the safe-name case. *(merges AC-QA-16 and AC-OPS-10)*
- **AC-SEC-10:** A server that sends status and headers, then some or none of the body, and then stalls past the request timeout is reported as `request timed out on <api path>` and never as `not valid JSON`, and the message carries no body text. Test: a fixture mode that writes status 200, headers and a partial body and holds the socket open gives exactly that one stderr line, a non-zero exit inside 15 seconds, the previous table byte-identical and zero token-sentinel matches; the existing case of a complete body that does not parse still says `not valid JSON`; reverting the fix makes the stall case fail on its timed-out match. *(merges AC-QA-15 and AC-OPS-9)*
- **AC-SEC-11:** `README.md`'s minimum-permission statement is replaced, not supplemented. It states that the token needs Browse on this project and on each sibling named, still forbids a global admin token, and states that sibling project keys belong only in the sibling variable and must not be written into a tracked file, a commit message or a pull request body, because this table and repository may be public. The old wording, Browse permission on the one project it reads, is gone from `README.md`, and the HARN-RULES-1 AC-SEC-13 docs assertion in `test/sonar-rules-docs.test.js` is updated to assert the new statement. Test: the docs test passes on the new `README.md` and fails when the old sentence is restored. *(merges the token-scope half of AC-OPS-8)*
- **AC-SEC-12:** No new dependency and no new consumer of the table. The generator still imports only `node:` built-ins; the diff adds no `package.json`, lockfile, `node_modules` or vendored code; the table's path is still named only in `agents/implementer.md` within `workflows/`, `agents/` and `skills/`; and no workflow or skill names the sibling variable or runs the generator. The HARN-RULES-1 AC-SEC-8 and AC-SEC-11 static checks stay green and unmodified. *(merges AC-SIMP-1)*
- **AC-SEC-13:** Removal list for this lens: one item, the `README.md` sentence limiting the token to Browse on the one project, covered by AC-SEC-11. No other security control is replaced or made redundant: HARN-RULES-1 AC-SEC-1 to AC-SEC-12 remain in force, and their tests are unmodified in the diff except the docs assertion AC-SEC-11 names.

### QA

- **AC-QA-1:** With no sibling list set, the table file and stdout are byte-for-byte what the HARN-RULES-1 generator produces, the derivation stamp included, and the same holds when the sibling variable is the empty string or holds only separators and whitespace. Test: the existing happy-path test against `test/fixtures/sonar-rules/expected-table.md` is run three times, with the variable unset, set to the empty string and set to a comma between two spaces; the fixture server records zero requests naming any project key other than the own one; and every existing expected-output assertion and fixture under `test/` is unchanged in the diff, additions only. *(merges AC-PROD-4, AC-OPS-7 and AC-SIMP-5)*
- **AC-QA-2:** Happy path. This repository trips `js:S1` and `python:S2`; one sibling trips `js:S9`, `python:S8` and `js:S1` in the window. The table gains rows `js:S9` and `python:S8` carrying the sibling marker; `js:S1` appears exactly once, as this repository's own row with its own counts and no marker; neither sibling row shows any count; and the sibling rows' guidance is the analyser's rule name, looked up on the same server. The expected table is pinned byte for byte in a new fixture. *(merges the first half of AC-PROD-1)*
- **AC-QA-3:** Language filter. A sibling rule is added only when its rule-key prefix, the text before the first colon, exactly equals the prefix of at least one rule in this repository's own open or recent facets. Test fixtures use the real prefixes: this repository holds `javascript` and `python` rules only, and the sibling offers a `javascript` rule and a `python` rule, which are added, and a `typescript` rule, a `Web` rule and a `secrets` rule, which are absent. A prefix this repository holds only as open backlog with zero recent issues still counts as present, and a prefix with no issues here at all is excluded, each asserted explicitly so the documented limitation cannot change silently. *(merges the language half of AC-PROD-1; the source of languages is fixed by AC-SIMP-6)*
- **AC-QA-4:** Ranking at the cap. Rows rank in three classes: this repository's rows with recent-new above zero first, then rows only a sibling tripped, then this repository's backlog rows with recent-new zero. A rule this repository holds in its own facets is always an own row in its own class, whether or not a sibling also tripped it, and a sibling row never displaces a row this repository tripped in the window. The value of `ROW_CAP`, 20 or 30, is the owner's decision, recorded in this spec's Vetoes and trade-offs table before the build starts. Test: a fixture holding more candidates than `ROW_CAP`, with at least `ROW_CAP` minus 2 own recent rules, 4 own backlog rules and 5 sibling-only rules, keeps exactly the top-ranked prefix in that order, so 2 sibling rows and no backlog row; the row cap and the byte cap both hold; and the existing `rules` field of the stamp and stdout reports kept out of available, where available now counts eligible sibling rules, a meaning `README.md` states in the same change. Mutation: ranking sibling rows first fails the test, and restoring passes it. *(merges AC-PROD-3 and the never-silent half of AC-OPS-4)*
- **AC-QA-5:** Ordering is deterministic. Two runs with the same clock give byte-identical output, and so does permuting the sibling list. A rule tripped by two siblings appears once. Sibling-only rows are ordered by rule key, whatever order the server lists them in.
- **AC-QA-7:** Every failure on a sibling fails the whole run: there is no partial-success path and the diff contains no skip-and-continue branch for a sibling. For a sibling's requests answering 401, 403, 404, 500 and a body that is not valid JSON, the run exits non-zero with one stderr line in the existing failure-message shape, the table byte-identical and no temporary file left. A hang and a stall after headers on a sibling request are covered by the own-project timeout cases wherever the code path is the same, per AC-QA-19. Test: each case runs once, and a run with two siblings, one failing and one healthy, leaves the table untouched. *(merges AC-SIMP-10; the skip alternative is vetoed)*
- **AC-QA-10:** Guidance on sibling rows. Hand-written guidance on a sibling row in the previous table survives a refresh; a sibling row whose guidance is the placeholder or the bare key is looked up again; a sibling row no sibling trips any longer is dropped. A rule that was a sibling row last time and that this repository now trips becomes an own row with its own counts, no marker, and its hand-written guidance kept. Test: one fixture run per sentence. *(merges the fixture half of AC-PROD-8)*
- **AC-QA-11:** Compatibility in both directions, as tests. Upgrade: a four-column table written by the HARN-RULES-1 generator, or by hand, read by the new generator keeps every row's guidance and reports zero unreadable rows. Downgrade and rollback: a table written by the new generator, with sibling rows and hand-written guidance in them, read by the HARN-RULES-1 generator, taken from git and run as a child process against the fixture server, keeps every hand-written guidance cell, and that generator's note that rows of the previous table could not be read is absent. *(merges AC-OPS-6)*
- **AC-QA-12:** The stamp still round-trips. After a run with siblings, a second run reads the first run's derived instant as its previous instant and computes since-previous and on-listed, with no `n/a`.
- **AC-QA-17:** The full gate is green on the branch at every commit that reaches review, including the static test that nothing tracked references the generator. `specs/harn-rules-2.md` and `docs/harn-rules-2-mutation-proofs.md` are added to the `RECORDS` exclusion in `test/helpers/tracked-files.js`, or covered there by a pattern, and that test is not weakened in any other way.
- **AC-QA-18:** Each new guard is load-bearing, and `docs/harn-rules-2-mutation-proofs.md` records it. For each of AC-QA-3, AC-QA-4, AC-SEC-4, AC-SEC-7, AC-SEC-9 and AC-SEC-10 the record gives the mutation applied, the diff or hash confirming the edit landed where intended, the failing test's name and message, and the restored green run.
- **AC-QA-19:** Suite time is measured, not guessed. The baseline is 43.74 seconds of wall time for `test/sonar-rules-table.test.js`, one run on 2026-11-21. The pull request records the new wall time; the change adds at most one timeout-bound case per distinct code path, with no environment override of the request timeout; and the file stays under 70 seconds.
- **AC-QA-20:** Removal list for this lens: one item, a body that stalls after headers is no longer reported as `not valid JSON`, pinned by AC-SEC-10. Nothing else this lens owns is replaced: the existing four-column pins, the hang case and the byte-for-byte fixture all stay and still pass.

### Product

- **AC-PROD-2:** A reader can tell from the row alone, without the stamp or `README.md`, that a row came from a sibling and has no history in this repository. Both count cells of a sibling-only row hold the marker and neither holds the literal 0, because 0 open and 0 recent-new reads as a rule this repository knows and is clean on. `README.md` has a copyable example table containing at least one sibling row, with one sentence saying what the marker means and that a builder treats the row like any other. Test: in the AC-QA-2 output every sibling-only row carries the marker in both count cells, and a docs test asserts the `README.md` example and sentence.
- **AC-PROD-6:** Before the build starts, this spec names the reader, the read point and the failure result of the success measure. Reader: the conductor of this repository. Read point: after the tenth feature merge following this change, by hand from `git log -p .claude/analyser-rules.md`. Signal: a row that carried the sibling marker in one refresh and is an own row with counts in a later one is a sibling rule a builder then tripped here. Failure result: across those refreshes no sibling row became an own row, or sibling rows made up most of the table while first-time trips continued on rules no sibling had listed; either result means the sibling option comes out or is held. The spec also records that this change starts inside HARN-RULES-1's unread ten-merge window, and that from this change on-listed includes issues on sibling-listed rows, so the HARN-RULES-1 verdict is read with those rows subtracted by the same manual read. The verdict, when read, is written into this spec's review section.
- **AC-PROD-7:** Before the build starts, this spec records a backtest taken from the analyser that tests the problem claim directly. Of the issues the sibling's eight feature pull requests introduced on rules not yet listed, counted 1, 4, 4, 5, 1, 0, 0 and 1, how many were on rules this repository or the third repository had already tripped before that pull request, and the reverse for this repository's recent first-time trips, each reported per language and with the date measured. If the share is near zero, the spec records that the problem is unconfirmed and the decision to proceed is put to the owner as labelled options.
- **AC-PROD-10:** Removal list for this lens: none. No HARN-RULES-1 AC-PROD criterion is retired or weakened, and the stamp's on-listed keeps its definition, issues on rules the previous table listed. *(renumbered from AC-PROD-R, whose id the spec scanner cannot read)*

### Operability

- **AC-OPS-8:** `README.md`'s troubleshooting list gains four entries, each naming the cause and the action: a sibling reported not found; a sibling reported not permitted; sibling rows that disappeared after a refresh, because the sibling variable was not set in that shell; and a sibling that contributed no rows because none of its rules is in a language this repository has. Test: a docs test asserts each of the four entries is present. *(the token-scope sentence is AC-SEC-11)*
- **AC-OPS-12:** Removal list for this lens: the single-project token scope sentence in `README.md`, covered by AC-SEC-11, is the only thing replaced, and this spec's "What this replaces" table is corrected to list it before the build starts. Nothing else in observability, rollback or deploy shape is made redundant; the tests for the `not valid JSON` message stay, and now apply only to a body that arrived complete and does not parse. *(renumbered from AC-OPS-R)*

### Simplicity

Checked by the orchestrator directly against the diff at review.

- **AC-SIMP-3:** The table keeps four columns. `HEADER_ROW` and the separator line are byte-identical to main, the diff adds no fifth column, and a sibling row is marked with one constant string in existing cells. Proof: a diff of the two literals, plus a test that a sibling row splits into exactly four cells.
- **AC-SIMP-6:** No new API path. The set of `/api/` string literals in `bin/sonar-rules-table.mjs` is identical to main's, namely `/api/issues/search`, `/api/rules/show`, `/api/measures/component` and `/api/project_analyses/search`, and this repository's languages come from the rule-key prefixes in its own facet responses, not from a measure or language lookup. Accepted limitation, to be written into `README.md`: a language this repository has but has never had an issue in receives no sibling rows.
- **AC-SIMP-7:** One code path builds an issues query. `ISSUES_PATH` is passed to `get()` at exactly one call site, and sibling queries go through it with a project parameter, not through a parallel copy.
- **AC-SIMP-8:** `ROW_CAP` is still the only limit on row count. The diff adds no separate cap, quota or reserved-slot constant for sibling rows, and if the cap value changes, that change is an edit to the one existing constant.
- **AC-SIMP-9:** The stamp's set of field names, which is derived, revision, analyser, window, new-issues, previous, since-previous, on-listed, open-total, rules and note, is unchanged, and the diff adds no new stamp field and no new stdout line or count for sibling rows. A sibling rule later tripped here is counted by the existing on-listed figure.
- **AC-SIMP-11:** Touched non-test files are exactly `bin/sonar-rules-table.mjs`, `README.md`, `.claude/analyser-rules.md` and `specs/harn-rules-2.md`; everything else in the diff is under `test/` or `docs/`. `agents/implementer.md`, `AGENT-HARNESS.md`, everything under `workflows/` and `skills/`, and the ledger are unchanged, so `git diff main --stat` over those paths is empty. *(merges the no-new-instruction half of AC-PROD-8)*
- **AC-SIMP-12:** Removal list for this lens: none. This change replaces nothing in the simplicity lens's area, and no criterion requires anything to be deleted.

### Vetoed at planning

Dropped under `lens-simplicity`'s veto. None of these belongs to security,
irrecoverable data loss or the accessibility floor. Each is a requirement
from a lens ranked at operability or below, and the owning lens supplied no
criterion that the cheaper form cannot meet.

| Dropped | Raised by | Reason |
|---|---|---|
| A fifth column for the sibling marker (open question 1) | the spec, as an option | The previous-table reader accepts only four-cell rows, so a fifth column makes every earlier table unreadable and turns a ranking change into a format migration. A constant marker in the count cells needs none of that (AC-SIMP-3, AC-PROD-2). The one-way-format branches of AC-QA-11 and AC-OPS-6 went with it |
| AC-PROD-5, an on-sibling stamp field, a sibling-rows-kept count, and on-listed narrowed to own-origin rows | lens-product | A stamp format change, a marker-aware previous-table reader and their tests, for a question the owner asks once after ten merges. The marked rows in the table's git history answer it by hand (AC-PROD-6, AC-SIMP-9). Cost accepted: on-listed now mixes the two mechanisms and the HARN-RULES-1 verdict needs the manual subtraction AC-PROD-6 describes |
| AC-QA-13, a test and mutation for the separate sibling count | lens-qa | Went with AC-PROD-5 |
| Reading this repository's languages from a measure (open question 2) | the spec, as an option | One more request, one more API path to allowlist and one more refusal branch, to cover a language this repository has never had an issue in (AC-SIMP-6) |
| Skip a failing sibling and carry on: the skip halves of AC-QA-7, AC-OPS-1, AC-OPS-2 and AC-PROD-9 | lens-qa, lens-operability, lens-product | The generator's contract is all or nothing. A partial table that looks complete is harder to reason about than a run that fails and names the key, and recovery is one edit to one environment variable (AC-QA-7, AC-SEC-7) |
| AC-OPS-2's stamp counts of siblings read and skipped | lens-operability | With no skip path there is nothing to count, and it would be a new stamp field (AC-SIMP-9) |
| AC-OPS-3 and AC-PROD-9, one stdout accounting line per sibling | lens-operability, lens-product | New stdout counts for sibling rows (AC-SIMP-9). A failed sibling stops the run and names itself; a sibling that contributed is visible as marked rows in the table. Cost accepted: a sibling whose rules were all filtered out by language looks the same as a clean one, and AC-OPS-8's troubleshooting entry says so |
| AC-OPS-4's separate kept-of-offered count for sibling rows, and the separate dropped-sibling count inside AC-PROD-3 | lens-operability, lens-product | The existing `rules` field already reports kept out of available and now counts sibling candidates (AC-QA-4), so truncation is not silent |
| AC-OPS-5, a stdout note counting sibling rows not carried forward when the variable is unset | lens-operability | A new stdout count that needs a marker-aware previous-table reader (AC-SIMP-9). Cost accepted: a refresh from a shell without the variable drops sibling rows with no note; the table's diff shows it and AC-OPS-8 documents the cause |
| A tracked line holding the sibling list (open question 6) | the spec, as an option | A new file format, a parser and a precedence rule for a list of two keys, and it would publish private project keys in a public repository, which AC-SEC-1 forbids in any case |
| A separate cap, quota or reserved slots for sibling rows | anticipated by lens-simplicity | One constant bounds the table (AC-SIMP-8) |

Not vetoed, and recorded so it is not re-argued: the two older faults stay in
this change (AC-SEC-9, AC-SEC-10) as minimal edits in place with no new
error-classification helper. `lens-product` asked for them to be split into
their own pull request; `lens-simplicity` accepted them in scope, and the
task plan may still sequence them first so that they ship whatever
AC-PROD-7's backtest decides.

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
| Share tripped rules across the owner's repositories, after HARN-RULES-1 and before the weekly-runner redesign | owner, 2026-11-21 | accepted, then **parked the same day** after the backtest | The recent-window shape would have caught 1 of 18 first-time issues; the weekly runner comes first |
| The two older faults in the generator | conductor | fixed now, in their own small change | A few lines each; no reason to wait for the parked work |

## Risks

To be ranked by the planning cycle.

## Affected files

| Path | Change |
|---|---|
| `bin/sonar-rules-table.mjs` | optional sibling project keys; the two older faults |
| `README.md` | the sibling option, and how a sibling row reads |
| `test/`, `docs/` | tests, fixtures and mutation-proof records |
| `.claude/analyser-rules.md` | regenerated with the sibling option |
