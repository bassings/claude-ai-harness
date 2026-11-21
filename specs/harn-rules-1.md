# HARN-RULES-1: builders are handed the analyser rules this repository actually trips

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** agreed
**Lenses run:** security, QA, simplicity, product, architecture, operability (planning cycle `wf_7f82673d-a07`, 2026-11-21) · **Skipped:** design and accessibility (no interface), data (no stored records beyond one tracked text file)

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

## Shape as agreed at planning

Two parts, deliberately separable:

1. **A rules table the builder reads.** One optional plain-text file per
   repository at a fixed path under `.claude/`, **tracked in git** so that the
   worktrees builds run in receive it. When it exists, the `implementer` agent
   reads it before writing a test or production code, in both `tdd-task`
   phases and when dispatched directly by `conduct-plan`. The instruction
   lives in `agents/implementer.md` only; `tdd-task`'s prompts are not
   changed, so a repository that has replaced its implementer gets no benefit
   and the README says so. When the file does not exist, outcomes are
   unchanged. The table is analyser-neutral: rule identifier, what to write
   instead in one line, how many open, how many new recently, and one
   derivation stamp. A repository with no SonarQube can write the file by hand
   or fill it from another analyser.
2. **A generator that fills the table from SonarQube.** A small dependency-free
   Node program shipped in `bin/`. **A person runs it**, after the analyser has
   finished analysing a merge; the conductor does not run it, CI does not run
   it, and it is never a gate. It asks the server for the rules new code
   tripped in a fixed recent window and the largest open rules, looks up each
   rule's own name for the one-line guidance, and writes the table with its
   stamp. Server address and token come from the environment only.

**Hand-written guidance survives a refresh (owner decision, 2026-11-21).** For
a rule already in the table, the generator updates the counts and leaves the
guidance text as it found it; a rule new to the table arrives with the
analyser's own rule name until someone improves it. See AC-PROD-11.

**The four limits, measured 2026-11-21** against the three projects on the
owner's SonarQube, and fixed as named constants (AC-SIMP-7):

| Limit | Value | Basis |
|---|---|---|
| Row cap | 20 | This repository: 150 open across 26 rules, the top 20 cover 96%. The sibling repository: 589 open across 55 rules, the top 20 cover 90% |
| Recent window | 30 days | Issues created in the last 30 days: 46 across 15 rules here, 5 across 2 rules there; both fit inside the row cap |
| Guidance length cap | 160 characters | The longest of a sample of analyser rule names was 99 characters; 160 leaves room for a hand-written line and still fits one table row |
| Byte cap for the whole table | 8,192 bytes | 20 rows at about 250 bytes plus the header and stamp is about 5.5 KB |

Rows are chosen recent-new first, then by open count, so a rule that new code
has just tripped is never pushed out by a large old backlog.

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

Nothing is removed in this repository. This repository does adopt the table:
`.claude/analyser-rules.md` is committed with this change as its first real
use, and AC-PROD-7's comparison of the next 10 feature merges starts here. In
the sibling repository the table replaces a paragraph pasted by hand into each
builder brief; removing that is that repository's change, not this one.

| What goes | Owning lens | Removal criterion |
|---|---|---|
| nothing | | |

---

## Acceptance criteria

Written by the planning cycle on 2026-11-21 from six lens reports (security,
QA, simplicity, product, architecture, operability). Where two lenses asked
for the same thing, the more testable wording is kept and the other id is
named in the trailing note. "The table" means the rules table at its one fixed
path under `.claude/`; "the generator" means the new program under `bin/`.

### Security and privacy (lens-security)

- **AC-SEC-1:** The generator reads the server address and token only from `SONAR_HOST_URL` and `SONAR_TOKEN` in its own process environment; it accepts no command-line flag carrying a token and reads no server address or token from any file in the repository, including the table and `sonar-project.properties`. Test: with either variable unset and a `sonar-project.properties` naming a reachable fixture server, the program exits non-zero with one stderr line naming the missing variable by name, the fixture server records zero requests, and any existing table is byte-identical afterwards. *(merges AC-QA-5 and the missing-variable half of AC-OPS-4)*
- **AC-SEC-2:** Transport fails closed. An https `SONAR_HOST_URL` is accepted. An http URL is refused with a non-zero exit and no request sent, unless the operator sets `SONAR_ALLOW_HTTP=1`, in which case the program writes one stderr warning naming the cleartext token risk and proceeds. A URL containing userinfo, the `user:pass@host` form, is refused outright. Each of the three branches is a test.
- **AC-SEC-3:** The token is sent only in an Authorization header, never in a query string, and the generator follows no redirects: any 3xx response is a non-zero exit. Test: a fixture server answers 302 to a second fixture server on another port; the second server records zero requests and the generator exits non-zero.
- **AC-SEC-4:** The token never escapes. Test: with `SONAR_TOKEN` set to a unique sentinel, run the generator against fixture servers that answer 200, 401 with a body echoing the request's Authorization header, 500 with a body echoing all request headers, and a closed port; a search for the sentinel across stdout, stderr and the written table finds zero matches in every case. Error messages name the HTTP status and API path only, never the response body. *(merges AC-QA-6)*
- **AC-SEC-5:** Every generated row is inert data. A row is emitted only when its rule key matches the fixed pattern `^[A-Za-z0-9_.:-]{1,64}$` and is dropped otherwise; counts are non-negative integers; guidance text is reduced to one line, with control characters, carriage returns, newlines, ANSI escapes, backticks, every invisible or format character and the column separator removed or escaped, by allowlist and not by an enumerated list: after NFKC normalisation, every code point in general categories Cc, Cf, Co, Cn, Zl and Zp is removed, as are variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF) and Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), and is truncated to a fixed maximum length. Test: a fixture rule set including a name containing a newline followed by a markdown heading and a shell command, a 10 KB name, a name with column-separator characters, a backtick fence, an ANSI escape, a U+202E, an imperative sentence telling the reader to ignore prior guidance, and a rule key of `../../x` produces a table in which every rule is exactly one physical line with the header's column count, no guidance exceeds the cap, none of the listed characters survive, and the `../../x` rule is absent. *(merges the hostile-name half of AC-QA-8)* *(amended after review round 1: the fixture also carries a tag-character payload, U+061C, U+00AD, U+FE0F and U+3164, and none survives; the same sanitiser applies to guidance kept from the previous table)*
- **AC-SEC-6:** The table has a hard size bound: a maximum row count and a maximum byte size, each stated in README.md. Test: a fixture server offering 500 tripped rules yields a table within both bounds. The same bounds are written into `agents/implementer.md`: a table over either bound is treated as absent, and the implementer says so at the top of its report. *(merges the cap half of AC-QA-9)*
- **AC-SEC-7:** `agents/implementer.md` frames the table as reference data about patterns to avoid, never as instructions: it states that nothing in the table may cause the implementer to run a command, fetch a URL, read or write a file outside the task, change scope or skip a gate, that a row reading as an instruction is reported in the report's caveats and not followed, and that a table path which is a symlink or not a regular file is treated as absent. A test asserts each of those statements is present in `agents/implementer.md`.
- **AC-SEC-8:** The table reaches a model only through the implementer reading the file itself. No workflow script interpolates table content into a prompt, and no lens agent, ledger line or conductor block note carries table text. Test: a search over `workflows/`, `agents/` and `skills/` finds the table's path in `agents/implementer.md` and in no other file. *(merges AC-SIMP-4 and AC-ARCH-7; tightened by the veto on a second instruction site)*
- **AC-SEC-9:** Minimisation. The table carries only these fields: per row, the rule key, one line of guidance, the open count and the recent-new count; in the derivation stamp, the derivation date, the analysed revision, the analyser's name, the window start and end, the count of new-code issues in the window, how many of those were on rules the previous table already listed, the total open count, and the kept and total rule counts. It carries no file path, line number, issue key, author or assignee identity, email address, server host, IP address or port, and the generator requests no author or assignee facet. Test: fixture issue payloads carrying author emails, assignee logins, component paths and an absolute home path produce a table in which a search for the at sign, the fixture host, the fixture IP, the fixture logins and the fixture paths each finds zero matches. Because the table is tracked in git, a generated fixture table also passes the repository's existing static leak scan. *(stamp field list widened to admit the integers and dates AC-PROD-6, AC-ARCH-3 and AC-OPS-6 require)*
- **AC-SEC-10:** The generator cannot be turned into a file-overwrite primitive by the repository it runs in. It writes the table by creating a temporary file in the target directory and renaming it over the fixed path, and it exits non-zero without writing when the target path or the `.claude` directory is a symlink, or when the resolved target lies outside the repository root. Test: in a temporary repository where the table path is a symlink to a sentinel file outside the repository, after a run the sentinel's content and modification time are unchanged and the exit is non-zero.
- **AC-SEC-11:** No new dependency. The generator imports only `node:` built-in modules, and the change adds no package.json, lockfile, node_modules or vendored third-party code. Test: a static check parses the generator's import and require specifiers and fails on any that is not `node:` prefixed. *(merges AC-SIMP-1, AC-QA-19 and AC-ARCH-5; security's stricter wording wins, so the generator may not import from workflows/lib/ either)*
- **AC-SEC-12:** No agent session ever holds the token. No file under `skills/` or `workflows/` names `SONAR_TOKEN` or runs the generator, shown by a search that finds zero matches. README.md tells the person running the generator to supply `SONAR_TOKEN` on the same command line that runs node, read from their token file at that moment, and never to export it into a shell session, write it to another file or echo it; a test asserts that instruction text is present. *(narrowed: the conductor no longer runs the generator, so the per-command token rule now binds the person's command)*
- **AC-SEC-13:** README.md's generator section states the minimum SonarQube permission the token needs, which is Browse on the one project, says not to use a global admin token, and states that http requires `SONAR_ALLOW_HTTP=1` and sends the token in cleartext. A test asserts those statements are present.

### QA (lens-qa)

- **AC-QA-1:** Happy path. Run exactly as README.md's one documented command, with no hand edits, against a local HTTP fake of the analyser serving fixed fixtures for new-code issues, open issues by rule and rule names, the generator writes a table whose full content byte-matches a checked-in expected file: one row per rule with rule key, one-line guidance, open count and recent-new count, and a stamp carrying the derivation date and analysed revision. The test compares the whole file, not substrings. *(merges AC-PROD-3)*
- **AC-QA-2:** The open-count query, which fills the open column and the open total, asks for unresolved issues only. The two creation-date queries (the recent window, and issues created since the previous table) count issues by when they were created whether or not they have since been fixed, and leave out only issues closed as false positive or accepted; they send an explicit status list and never rely on the server's default. The fake server records each request's query string and holds, in every period, an open issue, a fixed issue, a false-positive issue and an accepted issue: the open column counts only the first, and the recent and since-previous counts include the first two and neither of the last two. Deleting the unresolved filter from the open query, dropping the status list from a creation-date query, and adding the false-positive status to it are three recorded mutations, each of which fails a named test. *(amended after review round 2, owner decision 2026-11-21: as first agreed every query was unresolved-only, so a rule left the table, and the success measure read zero, the moment its clean-up landed. Verified on SonarQube 26.11: `issueStatuses=OPEN,CONFIRMED,FIXED` is accepted and leaves out the false-positive and accepted issues the unfiltered query returns.)*
- **AC-QA-4:** Unhappy server paths: 401, 403, 404 for an unknown project, 500, connection refused, a non-JSON body, and a server that accepts the connection but never replies. Each exits non-zero within a bounded time, with the hang case finishing in under 15 seconds of test time, and writes one stderr line naming the condition, with the HTTP status and API path where there is one. The existing table's sha256 is identical before and after, and no partial or temporary file is left in `.claude/`. *(merges AC-OPS-4)*
- **AC-QA-7:** One and many. A project with one tripped rule produces exactly one row. A fixture with more issues than one page of the server's page size, where the fake enforces paging, gives counts equal to the full total and not to the first page. *(the zero case is AC-OPS-5)*
- **AC-QA-8:** A rule whose name the server does not return, or whose lookup answers 404, keeps its row with its rule key and one fixed placeholder as guidance; it is never omitted, so a rule new code tripped cannot vanish from the table. A test pins the placeholder text. *(narrowed: the hostile-name fixtures are in AC-SEC-5)*
- **AC-QA-9:** The output is deterministic. Rows are sorted by recent-new count descending, then open count descending, then rule key ascending, and two runs against the same fixture with the same injected clock produce byte-identical files. *(the size bounds are AC-SEC-6)*
- **AC-QA-10:** Concurrency and interruption. Two generator runs started together against a fake server that delays its responses, repeated 20 times, always leave a table that parses as one complete table from one run and never an interleaving. A run killed with SIGKILL partway through the write leaves the previous table byte-identical.
- **AC-QA-11:** The recent window is a fixed number of days held in one named constant, counted back from an injectable clock to a UTC midnight boundary that is inclusive. With TZ set to Australia/Sydney and the clock fixed either side of a daylight-saving change, the since-date sent to the server is that same UTC calendar boundary, and a fixture issue dated exactly on the boundary is counted.
- **AC-QA-14:** The table is tracked in git, so a linked worktree receives it. Test: in a temporary repository with the table committed, a checkout made with `git worktree add` holds a file at the table's fixed path, resolved from the worktree's own working directory, whose content equals the main checkout's. *(merges AC-OPS-2; settles open question 1 as tracked)*
- **AC-QA-15:** An absent table changes no outcome. With no table file present, a fake-runtime `tdd-task` run ends with the same verdict, the same number of dispatches and the same ledger payload fields as before the change, every existing `tdd-task` test passes with its assertions unchanged, and the builder's report carries no warning, error or prompt to create a table beyond the neutral status line of AC-OPS-1. *(merges AC-PROD-2 and the run half of AC-OPS-9)*
- **AC-QA-16:** The derivation stamp sits on a fixed, machine-readable line carrying an ISO-8601 UTC date and the full analysed revision, and a test parses that line from generated output. *(narrowed: the age and revision checks were vetoed)*
- **AC-QA-17:** The generator's path is in the optional consumer pattern list, and the deepEqual pin in `test/install-consistency.test.js` is updated to match. A test shows the staleness check reports drift when the installed copy differs from the published one and reports nothing when the generator is not installed. *(merges AC-OPS-11)*
- **AC-QA-18:** The generator is never a gate and nothing automated runs it. A static test fails if the generator's filename is referenced from `.github/workflows/`, `hooks/`, `bin/setup-hooks.sh`, the pre-push hook, the gate command, any `workflows/*.js` script, any `workflows/lib/` module other than the one install pattern literal of AC-SIMP-10, or anything under `skills/`. It is proven by adding such a reference, watching the test fail, and restoring. *(merges AC-ARCH-4 and the search half of AC-PROD-9)* *(after review round 2: the scanned set is not a hand-written list of directories. It is every tracked file from `git ls-files` except the generator, its tests and fixtures, README.md, this spec, the proofs record and the one install pattern literal, so `.githooks/` and anything added later are covered without editing the test. The AC-ARCH-2 and AC-SEC-8 static guards take their file sets the same way, and match any `/api/<name>/` path and not an enumerated list.)*
- **AC-QA-20:** Each new test this change adds has a recorded mutation proof under `docs/`: the edit made, the diff or hash showing it landed on the intended construct, the failing output and the restore.
- **AC-QA-21:** This change replaces nothing in this repository. No existing test is retired and no existing assertion is weakened or deleted, checked by diffing `test/` for removed assert lines. *(merges AC-PROD-10, AC-ARCH-11 and AC-OPS-R)*

### Simplicity (lens-simplicity)

- **AC-SIMP-2:** `workflows/tdd-task.js` is unchanged: `git diff main -- workflows/tdd-task.js` is empty. The builder instruction reaches both phases through `agents/implementer.md`, which both dispatches already load.
- **AC-SIMP-3:** Nothing under `skills/` is changed: `git diff main --stat -- skills/` is empty. The conductor gets no new step to run the generator.
- **AC-SIMP-5:** The generator is exactly one new file under `bin/`, and no new file is added under `workflows/lib/`.
- **AC-SIMP-6:** The generator takes its configuration, the project key included, only from environment variables: it reads no configuration file, parses no command-line options, and writes to a single fixed output path held in one constant.
- **AC-SIMP-7:** Each limit in the generator, namely the row cap, the byte cap, the guidance length cap and the recent-window length, is one named constant, and no environment variable or option changes any of them. *(reworded from one cap to four: AC-SEC-5 and AC-SEC-6 require separate bounds)*
- **AC-SIMP-8:** No code judges whether the table is stale: nothing in the diff parses the table's stamp to compute an age, compare revisions or emit a warning. The generator writes the stamp as text, and only people and the builder read it. *(amended after review round 1, owner decision 2026-11-21: one exception. The generator reads the derivation instant from the previous table's stamp for the single purpose of AC-PROD-6's count; it still computes no age, compares no revisions and emits no staleness warning.)*
- **AC-SIMP-9:** The ledger and the optimiser are unchanged: `git diff main` over every ledger and optimise file under `workflows/` is empty, and no new ledger field is introduced.
- **AC-SIMP-10:** Shipping the generator is exactly one added string literal in `CONSUMER_OPTIONAL_PATTERNS` in `workflows/lib/install-consistency.mjs`, beside `bin/redact-transcript.mjs`, and `bin/install.sh` is unchanged. After `bin/install.sh`, `bin/install.sh --check` reports the generator as installed. *(merges AC-ARCH-6)*
- **AC-SIMP-11:** `AGENT-HARNESS.md` is unchanged: the table and the generator are documented in README.md only.
- **AC-SIMP-12:** Excluding this spec, the change touches exactly five non-test files: `agents/implementer.md`, the one new program under `bin/`, `workflows/lib/install-consistency.mjs`, README.md, and this repository's own table at `.claude/analyser-rules.md`. Everything else it adds or edits is a test file or fixture under `test/` or a mutation-proof record under `docs/`. *(amended after review round 1: this repository adopts the table as its first user, see "What this replaces")*

### Product (lens-product)

- **AC-PROD-4:** Every rule that new code tripped in the recent window appears in the table, ranked ahead of rules that are open only as legacy debt. Test: a fixture with a new-code rule whose open count is lower than many legacy rules shows that rule present and ranked first. *(after review round 2: "tripped in the recent window" means created in it, fixed or not, per AC-QA-2. A second fixture has a rule whose only issue in the window has since been fixed and which has no open issue: it is present, with open 0 and recent-new 1, and its hand-written guidance survives.)*
- **AC-PROD-5:** README.md documents the table format with a complete copyable example and says that a replacement implementer must honour the table to get the benefit. A table written by hand to that format, with a rule identifier that is not a SonarQube key, is read and reported by the builder exactly as a generated one is.
- **AC-PROD-6:** Measurement. On each run the generator records in the table's stamp, and prints to stdout, the window start and end, the analysed revision, the count of new-code issues in the window, the total open count, and, when a previous table with a readable derivation instant exists, the count of issues created after that instant and how many of those were on rules that previous table listed, together with the instant itself. When there is no previous table or its stamp has no readable instant, those two counts are written as `n/a`, never as zero. Test: a first run writes `n/a`; a second run against fixtures holding one issue created before the previous instant on a listed rule, one created after it on a listed rule and one created after it on an unlisted rule gives 2 since the previous table and 1 on-listed; no author field appears in the file or the output. Mutation: count on-listed across the whole window and watch the test fail. *(amended after review round 1, owner decision 2026-11-21: the original count included issues that predate the table, so a first table read as a failure)*
- **AC-PROD-7:** Before the build starts, this spec records the baseline the change is judged against: the sibling repository's 4 of 11 post-merge scans with new issues, 12 issues in all, from 2026-11-13 to 2026-11-21, and this repository's 3 new issues across 3 merges on 2026-11-13. It names the comparison point, which is the next 10 feature merges in a repository using the table, states the do-nothing cost, and names the result that means the generator is not earning its keep: a share of post-merge scans with new issues no lower than the baseline, or new issues that land mostly on rules the table already listed.
- **AC-PROD-8:** The conductor does not run the generator. Before the build starts, this spec's Proposed shape and Affected files are corrected to say a person runs it, and README.md tells that person when: after the analyser has finished analysing the merge. The built change matches.
- **AC-PROD-11:** Hand-written guidance survives a refresh (owner decision 2026-11-21). When the table already holds a row for a rule the new run also selects, the generator writes that row's existing guidance text unchanged, after applying the same sanitising and length bounds as to any guidance (AC-SEC-5 to AC-SEC-8), and updates only its counts; a rule not previously in the table gets the analyser's rule name. A row whose rule the new run does not select is dropped. Test: a table whose row for one rule carries hand-written guidance is regenerated from fixtures in which that rule is still selected with different counts, a second rule is new and a third has left; the first row keeps its text with the new counts, the second carries the analyser's name, the third is gone. Mutation: make the generator always use the analyser's name and watch the test fail.
- **AC-PROD-9:** The generator exits zero after writing a table, whatever the issue counts. Test: a fixture with many new issues still exits zero. *(the no-reference searches are AC-QA-18 and AC-SEC-8)*

### Architecture (lens-architecture)

- **AC-ARCH-1:** The table's path is written as a literal in exactly one code location, the generator's default output path. A test reads every other file that names the table, which is `agents/implementer.md` and README.md, and fails if either names a different path. It is mutation-proved by editing the path in one of them and watching the suite fail.
- **AC-ARCH-2:** SonarQube knowledge is confined to the generator. No file outside the generator, its test and its test fixtures contains a SonarQube Web API path such as `/api/issues`, `/api/rules` or `/api/components`, or a field name only SonarQube uses, and `agents/implementer.md` describes the table only by its neutral columns. A static test over the shipped tree pins this.
- **AC-ARCH-3:** The table format is written down once, in README.md, as the neutral column set of rule identifier, one-line guidance, open count and recent-new count, plus one derivation stamp. Every name in that set is analyser-neutral, and a test asserts that the generator's output header and stamp match the documented format exactly.
- **AC-ARCH-8:** The generator's request count does not grow with the number of open issues: it gets per-rule open counts from one query faceted by rule and never pages through all issues. Test: against a local fake server reporting 20,000 open issues across 300 rules, it completes in a fixed number of requests, written as a constant in the test, and never asks beyond the first 10,000 results of an issue search.
- **AC-ARCH-10:** No new telemetry sink. The generator writes no ledger line and creates no file other than the table, and a static test asserts it does not import or run `ledger-append.mjs`.

### Operability (lens-operability)

- **AC-OPS-1:** Every implementer report, in both `tdd-task` phases and in a direct dispatch, has one rules-table status line showing exactly one of four states: read, with the table's derivation date and revision; absent, with the path that was checked; unstamped, when the file exists but has no derivation stamp; or unreadable, with the reason. A report with no such line fails this criterion, and the proof is one run per state with the report text quoted. *(merges AC-PROD-1)* *(after review round 2: the four quoted runs are made with real headless sessions in scratch repositories that carry this branch's `agents/implementer.md` as a project agent, before merge, and are pasted into `docs/harn-rules-1-mutation-proofs.md`; the same runs serve the builder halves of AC-QA-15 and AC-PROD-5.)*
- **AC-OPS-5:** An unknown or mistyped project key makes the generator exit non-zero with a message naming the key, and it does not write an empty table. A real project with no unresolved issues in the window exits zero and writes a table, with its stamp, that says explicitly that zero rules were tripped, and stdout says the same. *(merges the zero case of AC-QA-7)*
- **AC-OPS-6:** Truncation is never silent. When the server holds more rules than the row cap keeps, the table's stamp and stdout both give the two counts, kept and total, and a test feeding more rules than the cap asserts the row count equals the cap and that both counts appear. *(merges AC-ARCH-9)*
- **AC-OPS-7:** The stamp records the revision and date of the analysis the server last completed, never the local HEAD. Test: with the fake server reporting revision X and the temporary repository's HEAD at a different Y, the table contains X and does not contain Y, and stdout gives both revisions and says the server has not yet analysed the current head, without refusing to run. A successful run prints one summary line with the path written, the rule count, the window and the analysed revision. *(merges AC-QA-3)* *(after review round 2: when the revision is recorded as `unknown`, stdout says which of the causes applied, one note per cause: the token may not read it, the server returned no analysis, or the analysis carries no revision. In this repository's own table the cause is the first: the scan token is refused the analyses lookup, measured 2026-11-21.)*
- **AC-OPS-9:** README.md states that deleting the table is the rollback, and that reinstalling and restarting the Claude Code session are what roll out, or undo, the `agents/implementer.md` change.
- **AC-OPS-12:** README.md has a troubleshooting entry, each naming the cause and the action, for four symptoms: the generator exits non-zero; the table says zero rules; the builder reports absent although the file exists; and the builder's report carries no rules-table line at all, which means the installed implementer is a replacement or older than this change. *(the stale-table entry went with the staleness veto)*

### Vetoed at planning

Dropped under `lens-simplicity`'s veto. None of these belongs to security,
irrecoverable data loss or the accessibility floor.

| Dropped | Raised by | Reason |
|---|---|---|
| AC-QA-12, naming the table in every `tdd-task` phase prompt | lens-qa | Both phases already dispatch the `implementer` agent, so `agents/implementer.md` reaches them; a second site is a second copy that drifts, on a gated and heavily tested file (AC-SIMP-2). Cost accepted: an operator who has replaced their implementer gets no benefit, and AC-OPS-12 and AC-PROD-5 say so in README.md |
| AC-QA-13, naming the table in the `conduct-plan` delegation brief | lens-qa | Same reason, under AC-SIMP-3. Its path-consistency half survives as AC-ARCH-1 |
| The one-pointer-line allowance inside AC-ARCH-7 | lens-architecture | Same reason. The rest of AC-ARCH-7 is merged into AC-SEC-8 |
| AC-OPS-8, the conductor running the generator and logging the outcome | lens-operability | The harness cannot observe that a scan has finished, and running the scan is out of scope, so the step would poll or guess. A person runs the generator (AC-PROD-8, AC-SIMP-3) |
| AC-OPS-3, a stale status with an age threshold | lens-operability | The stamp already shows the date and revision to the builder and to a person; a threshold needs parsing code and an invented number for a file that is advisory (AC-SIMP-8) |
| The age and revision boundary tests inside AC-QA-16 | lens-qa | Went with AC-OPS-3. The stamp parse test is kept |
| AC-OPS-10, table status on each `tdd-task` ledger row | lens-operability | A ledger schema change for a measure one analyser query reproduces (AC-SIMP-9). AC-PROD-6 carries the measure in the stamp and stdout instead |
| The `AGENT-HARNESS.md` documentation row in Affected files | spec draft | Lenses are not handed the table; README.md is the product documentation (AC-SIMP-11) |

Not vetoed, but no longer applicable:

| Lapsed or narrowed | Why |
|---|---|
| AC-SEC-14, ledger records for the success measure carry no guidance text | It was conditional on the measure being written to the ledger. AC-SIMP-9 guarantees no ledger record exists, so there is nothing for it to constrain. If a later change adds one, this criterion returns with it |
| AC-SEC-12, token handling when the conductor runs the generator | Kept and narrowed, not dropped. With no conductor step the exposure it guarded is removed outright, and the same rule now binds the person's command |

### Arbitrated at planning

| Question | Decision | Why |
|---|---|---|
| Open question 1, tracked or untracked | Tracked in git (AC-QA-14) | Three lenses found that an ignored file is absent from the worktrees conducted builds run in, so the feature would switch itself off with no error. Tracking also puts each change to the table through review. The security cost is that every committer can write it, which AC-SEC-5 to AC-SEC-9 bound |
| Open question 2, instructions and size | Sanitised and capped at generation, framed as data at consumption, one channel into a model (AC-SEC-5 to AC-SEC-8) | The framing lowers the risk and cannot be proven by a test; this is recorded, not solved |
| Open question 3, staleness | The stamp is shown and nothing acts on it (AC-SIMP-8). The generator does say when the server has not analysed the current head (AC-OPS-7) | AC-OPS-7 compares the server's answer with the local head at generation time and parses no table, so it sits outside the veto |
| Open question 4, token and server address | AC-SEC-1 to AC-SEC-4 and AC-SEC-12 | https by default, http only behind a named opt-in, no redirects |
| Open question 5, the measure | Stamp and stdout, no ledger (AC-PROD-6, AC-PROD-7) | Avoids a telemetry schema change while still telling an ignored table from a stale one |
| Open question 6, `tdd-task` prompts | The agent definition is the only site (AC-SIMP-2, AC-SEC-8) | See the veto table |
| The recent window | A fixed number of days in one constant, recorded in the stamp (AC-QA-11, AC-SIMP-7) | Architecture wanted the window set by the program so runs are comparable across repositories; simplicity wanted no setting. A constant gives both |
| Import rule | `node:` built-ins only (AC-SEC-11) | Security's wording is stricter than simplicity's and wins on precedence |

Settled by the owner on 2026-11-21: regenerating the table keeps guidance a
person has edited by hand (AC-PROD-11).

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
| A refresh keeps hand-written guidance | owner, 2026-11-21 | accepted (AC-PROD-11) | The evidence credits hand-written guidance, and a refresh that discards it gives people a reason not to refresh |
| The four limits | conductor, measured 2026-11-21 | set from the analyser, table above | No lens had a measured basis; one defensible course, so taken without a question |
| The on-listed measure counts only issues created after the previous table | owner, 2026-11-21, review round 1 | accepted (AC-PROD-6, AC-SIMP-8 amended) | As first built it read 46 of 46 on a table no builder had used |
| This repository adopts the table in this change | lens-product and the AC-SIMP check, review round 1 | accepted (AC-SIMP-12 amended) | One defensible course: a generator with no real use behind it is the weaker thing to ship |
| Recent and since-previous counts include issues since fixed | owner, 2026-11-21, review round 2 | accepted (AC-QA-2 amended) | Open-only counting dropped a rule, and zeroed the measure, the moment its clean-up landed |
| AC-OPS-1's live proof | conductor, review round 2 | run now, before merge | Four short real runs; one defensible course |
| A second instruction site in `tdd-task` prompts | lens-simplicity veto | veto stands | Not a security, data-loss or accessibility item, so the veto holds; revisit if the measure shows the table earns its keep |

## Risks

Ranked by recoverability.

1. **Expensive: text in the table steers a builder.** The table is tracked,
   reviewed and read in every phase. Bounded by AC-SEC-5 to AC-SEC-9 and by
   the instruction that nothing in it is an instruction; a model obeying that
   cannot be proven by test.
2. **Cheap: the token is sent to the wrong place or in the clear.** Bounded by
   https by default, an explicit opt-in with a warning before the first
   request, no redirects and no token in any output (AC-SEC-1 to AC-SEC-4).
3. **Cheap: the table goes stale or is ignored.** Nothing judges staleness by
   design; the stamp and AC-PROD-6's counts are the signal, and AC-PROD-7 names
   the result that means it is not earning its keep.

## Affected files

| Path | Change |
|---|---|
| `agents/implementer.md` | read the rules table when present |
| `bin/` (one new program) | the SonarQube generator |
| `workflows/lib/install-consistency.mjs` | ship the new program |
| `README.md` | document the table, the generator, when a person runs it, and that a replaced implementer gets no benefit |
| `.claude/analyser-rules.md` | this repository's own table, generated and then given hand-written guidance |
| `test/`, `docs/` | tests, fixtures and mutation-proof records |

`workflows/tdd-task.js` and `AGENT-HARNESS.md` are not changed (vetoed at
planning, see above).
