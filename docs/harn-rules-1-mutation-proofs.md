# HARN-RULES-1 part 2: mutation proofs

Each row: the edit was applied by line number, with the script asserting exactly
one match on that line and printing the changed line (so it landed on the
intended construct, not a comment); the named test failed; the file was then
restored and compared byte for byte with its pre-mutation copy (identical in
every case). Suites run: `test/sonar-rules-docs.test.js` for docs, agent and
helper mutations, `test/sonar-rules-table.test.js` for generator mutations.

| # | Criterion | Edit | Failing test (name abridged) |
|---|---|---|---|
| a | AC-ARCH-1 | `agents/implementer.md` line 55: `analyser-rules.md` to `analyser-rule.md` | the table path is one literal in the generator and any other file that names it names the same path |
| b | AC-ARCH-2 | `agents/implementer.md` line 55: prefix `Use /api/issues/search.` | agents/implementer.md describes the table by its neutral columns only and names no SonarQube API |
| c | AC-ARCH-3 | README table-format header: `recent-new` to `recent_new` | README documents the table format once, with a complete copyable example whose stamp and header match the generator's output |
| d | live defect 1 | generator line 213: drop `\|\| e.status === 403` so a 403 on the analyses lookup is fatal | a 401 or 403 on the analyses lookup is not fatal, the revision is unknown and one stdout line... |
| e | live defect 2 | generator line 205: the project-existence request disabled (`0 && get(...)`) | the project is proved to exist before any issue query, and an unknown key fails naming it |
| f | live defect 3 | generator: `console.error(cfg.warning)` moved from before the first request to after the run | the cleartext warning is on stderr before the first request is answered, not after a successful run (also the unhappy-path test, AC-QA-4) |
| g | AC-PROD-11 | generator line 240: `if (kept)` to `if (false)`, so existing guidance is ignored and the analyser name always used | hand-written guidance survives a refresh, a new rule gets the analyser name, a departed rule... |
| h | AC-QA-20 | docs test helper line 48: `masked.search` to `rest.search` (fence-blind search restored) | section helper: a fenced block starting with a hash line stays inside the section, a real heading ends it (plus five README section tests) |

## Fix round 1: proofs for the generator's tests and for each change in the round

Method, for every row below. A script applied the edit, asserting that exactly
one line contained the anchor text and exactly one occurrence of the old text sat
on that line (so an edit cannot land on a comment or a second match); it printed
the file and line number that changed (the "Landed on" column, line numbers as at
the time of the run); it ran only the named test; it recorded the failing test
by name; and it wrote the original text back and compared its hash, which matched
in every case. Rows P5 (userinfo), N3 (fillers) and N19 (boundary) were first run
against weaker tests: P5 survived because `fetch` itself refuses an address with
credentials, so the test could not tell the generator's refusal from a connection
error, and N19 and a one-sided variant survived because the two facet checks
covered for each other. The tests were strengthened (the refusal message is now
asserted, and the cap check now reads one facet, with a case where only the open
facet is at its cap) and the rows below are the second run.

All rows run `test/sonar-rules-table.test.js` except N21, N22 and N23, which run
`test/sonar-rules-docs.test.js`.

| # | Criterion | Edit | Landed on | Failing test (name abridged) |
|---|---|---|---|---|
| P1 | AC-QA-2 (superseded in round 2 by rows Q1 to Q4, once the query was split) | Drop `resolved: 'false'` from the one issue-query helper | generator:92 | generator: every issue request asks for unresolved issues only and the resolved fixtures are not counted |
| P5 | AC-SEC-2, userinfo refusal | Replace the userinfo condition with `false` | generator:49 | generator: http is refused without SONAR_ALLOW_HTTP=1, allowed with a cleartext warning, and userinfo in the address is refused outright |
| P6 | AC-SEC-2, http refusal | Replace the missing-opt-in condition with `false` | generator:52 | generator: http is refused without SONAR_ALLOW_HTTP=1, allowed with a cleartext warning, and userinfo in the address is refused outright |
| P2 | AC-SEC-3, redirect refusal | `redirect: 'manual'` to `'follow'` | generator:70 | generator: a redirect is a failure and the redirect target receives no request |
| P3 | AC-SEC-3, token only in a header | Append the token to every request URL | generator:68 | generator: the token travels only in an Authorization header, never in a URL |
| P4 | AC-SEC-10, symlink refusal | Replace the symlink and not-a-regular-file condition with `false` | generator:181 | generator: a symlinked table path or a symlinked .claude directory is refused and nothing outside the repository is written |
| P7 | AC-SEC-4, token and body never echoed | Append the response body to the HTTP error message | generator:79 | generator: the token never escapes through stdout, stderr or the table in success, 401 and 500 echoes, or a refused connection |
| P8 | Lookup-mismatch fail-safe | Replace the returned-key check with `false`, so any returned rule is trusted | generator:107 | generator: a lookup that returns rules it was not asked for is never trusted; the rule key becomes the guidance and the output says so |
| P9 | AC-SEC-1, no variable, no request | Replace the missing-variable condition with `false` | generator:35 | generator: a missing variable exits non-zero naming it, sends no request and leaves the table untouched, even with sonar-project.properties present |
| P10 | AC-QA-4, not-JSON failure | Return `{}` instead of failing on an unparseable body | generator:86 | generator: every unhappy server path exits non-zero in bounded time with one stderr line, leaves the table byte identical and leaves no temporary file |
| P11 | AC-QA-4, bounded time | Remove the request timeout signal | generator:71 | generator: every unhappy server path exits non-zero in bounded time with one stderr line, leaves the table byte identical and leaves no temporary file |
| P12 | AC-QA-8, placeholder | Empty guidance instead of the fixed placeholder | generator:295 | generator: a rule whose name is missing keeps its row with the fixed placeholder |
| P13 | AC-PROD-4, recent-new first | Drop the recent-new term from the sort | generator:283 | generator: a rule only new code tripped outranks a large legacy backlog |
| P14 | AC-SEC-6, row cap | `ROW_CAP` 20 to 21 | generator:19 | generator: more rules than the row cap keeps exactly the cap, within the byte cap, and says kept and a lower bound on the total in the stamp and stdout |
| P16 | AC-ARCH-8, request count | Look up the name of every rule instead of only the kept rows | generator:287 | generator: request count does not grow with open issues and never reaches past the first 10,000 results |
| P17 | AC-QA-11, window length | `WINDOW_DAYS` 30 to 31 | generator:20 | generator: the window is 30 days back to a UTC midnight, inclusive, either side of a Sydney daylight-saving change |
| P18 | AC-SEC-9, minimisation | Ask for an authors facet as well | generator:92 | generator: minimisation, no author, assignee, path, email, host or address reaches the table or stdout and no author facet is requested |
| P19 | AC-OPS-7, server revision in the stamp | Always record the revision as unknown | generator:255 | generator: the stamp holds the server's analysed revision, not local HEAD, and stdout says the server has not analysed the head |
| P20 | AC-QA-7 / AC-OPS-5, zero-rules note | Remove the zero-rules note | generator:301 | generator: a project with one tripped rule gives one row, and a project with nothing says so explicitly and still writes a table |
| P21 | AC-SEC-11, node: imports only | `node:path` to `path` | generator:15 | static: the generator imports only node: built-ins and never the ledger |
| P22 | AC-SIMP-6 / AC-SIMP-7, constants only | Read `ROW_CAP` from `process.argv` | generator:19 | static: the generator reads its limits as named constants and takes no option or file configuration |
| P23 | Lookup comment records its verification | Write UNVERIFIED into the comment | generator:95 | static: the rule lookup comment records that it was verified against 26.11 on 2026-11-21 and no longer says UNVERIFIED |
| P24 | AC-QA-18, no automation | Name the generator in `workflows/plan-cycle.js` | workflows/plan-cycle.js:1 | static: nothing automated or agent-facing references the generator or its token variable |
| N1 | AC-SEC-5, format characters (tag characters, U+061C, U+00AD) | Remove `\p{Cf}` from the removal class | generator:132 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| N2 | AC-SEC-5, private-use and unassigned code points | Remove `\p{Co}\p{Cn}` from the removal class | generator:132 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| N3 | AC-SEC-5, variation selectors and Hangul fillers (U+FE0F, U+3164) | Remove the variation-selector and filler ranges from the removal class | generator:132 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| N3b | AC-SEC-5, NFKC first (fullwidth backtick and bar) | Remove `.normalize('NFKC')` | generator:129 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| N3c | AC-SEC-5 / AC-PROD-11, kept guidance sanitised | Keep the previous table's guidance as read, unsanitised | generator:160 | generator: hidden characters in guidance kept from the previous table are removed too, and the visible text is kept |
| N4 | AC-PROD-6, on-listed since the previous instant only | Count on-listed over the whole window | generator:276 | generator: on-listed counts only issues created after the previous table's instant, sent as an explicit UTC instant, and the instant is shown in the stamp and stdout |
| N5 | AC-PROD-6, n/a and never zero | Write 0 instead of n/a with no previous table | generator:270, generator:271 | generator: a first run writes n/a for the since-previous counts, never zero, and no author field appears |
| N6 | L3, explicit UTC instants | Send a bare date as the created-after parameter | generator:259 | generator: on-listed counts only issues created after the previous table's instant, sent as an explicit UTC instant, and the instant is shown in the stamp and stdout |
| N7 | AC-PROD-6, instant in the stamp and stdout | Write n/a for the previous instant always | generator:301 | generator: on-listed counts only issues created after the previous table's instant, sent as an explicit UTC instant, and the instant is shown in the stamp and stdout |
| N9 | Unknown revision draws no head note | Remove the `revision !== 'unknown'` condition | generator:315 | generator: an unknown revision never prints the not-yet-analysed note, only a real revision that differs from the local head does |
| N10 | AC-PROD-6, an impossible instant is n/a | Remove the invalid-date guard | generator:156 | generator: a table with no readable derivation instant, or an unreadable one, gives n/a and no extra query |
| N11 | AC-QA-10, kill mid-write | Write the table directly instead of through a temporary file and rename | generator:209, generator:211 | generator: a run killed partway through the write leaves the previous table byte identical, and the next run removes the dead run's temporary file |
| N12 | AC-QA-10, concurrent runs | Give every run the same temporary file name | generator:209 | generator: two runs started together against a slow server always leave one complete table from one run, never an interleaving, and no temporary file |
| N13 | AC-QA-10, dead run's temporary file swept | Remove the sweep call | generator:208 | generator: a run killed partway through the write leaves the previous table byte identical, and the next run removes the dead run's temporary file |
| N14 | AC-QA-10, a live run's file is left alone | Sweep files whose process is still alive | generator:202 | generator: a temporary file belonging to a live process is not removed by another run |
| N16 | AC-QA-9 / L1, key tiebreak | Reverse the key comparison | generator:283 | generator: rules tied on recent-new are ordered by open count, then rules tied on both by key, whatever order the server lists them in |
| N17 | AC-QA-9 / L1, open-count tiebreak | Reverse the open-count comparison | generator:283 | generator: rules tied on recent-new are ordered by open count, then rules tied on both by key, whatever order the server lists them in |
| N18 | L4, cap noticed | Never treat the facet as capped | generator:300 | generator: a rules facet below its cap gives an exact total, one at the cap says "at least" because it cannot know |
| N19 | L4, boundary at exactly the cap | `>=` to `>` on the cap | generator:300 | generator: a rules facet below its cap gives an exact total, one at the cap says "at least" because it cannot know |
| N19b | L4, the right facet is checked | Check the new-issue facet instead of the open facet | generator:300 | generator: a rules facet below its cap gives an exact total, one at the cap says "at least" because it cannot know |
| N20 | L2, one mention in install-consistency.mjs | Name the generator a second time in that file | workflows/lib/install-consistency.mjs:401 | static: nothing automated or agent-facing references the generator or its token variable |
| N21 | AC-QA-14, worktree receives the table | Add the table path to this repository's `.gitignore` | .gitignore:52 | a linked worktree made with git worktree add holds the committed table at its fixed path, with the main checkout's content, under this repository's own ignore rules |
| N22 | AC-PROD-6 / AC-OPS-6, README describes the cap | Reword `at least` in the README | README.md:1744 | README describes the since-previous measure: the previous instant, n/a when there is none, and "at least" at the facet cap |
| N23 | AC-ARCH-3, README example matches the stamp format | Rename a stamp field in the README example | README.md:1748 | README documents the table format once, with a complete copyable example whose stamp and header match the generator's output exactly |

### Mutants that survive, and why

- **Temporary-file naming pattern (AC-QA-10).** The test leaves a file named
  `.analyser-rules.md.bak` beside a dead run's file and asserts it survives. It
  was not mutated: broadening the pattern still leaves the file alone, because a
  non-numeric process id is treated as alive. Two guards cover one case.

### Correction: the byte cap is reachable

Round 1 said the 8,192-byte loop was unreachable, counting one byte per
character. That was wrong: guidance is capped at 160 code points, and a CJK
character is three bytes and an emoji four, so a row can reach about 650 bytes
and 20 such rows come to about 13 KB. With 160-character multibyte names the
loop trims to 15 rows. Rows B1 and B2 below prove the new test
(`20 rules with 160-character multibyte names stay within the byte cap...`)
fails when the loop is disabled and when it trims from the wrong end.

## Fix round 2: proofs for the repaired and new guards

Same method as round 1 (one anchor line, one occurrence of the old text, the
file and line printed, only the named test run, original text written back and
its hash compared; identical in every row). Rows T1 to T6 plant a reference in
`.githooks/pre-push`, which the old directory lists did not scan, and in a
second place they missed (`bin/install.sh`, or `workflows/lib/` for the API
path), so each of the three guards is shown failing on a file the old list did
not cover. Rows D11 and G1 repaired guards that did not hold: the first matched
a sentence elsewhere in the file, and the second could not see an ignore rule
once the table was tracked (`git check-ignore` skips tracked files unless given
`--no-index`); both survived on first run, and the rows are the second run.
The rows from D1 on give each of the previously unrecorded tests a mutation of
its own subject (the README or implementer text, or the generator), not of a
shared helper. Rows run `test/sonar-rules-table.test.js` for Q to L4 and K,
and `test/sonar-rules-docs.test.js` for T5, T6, R, D and G.

| # | Criterion | Edit | Landed on | Failing test (name abridged) |
|---|---|---|---|---|
| Q1 | AC-QA-2 | Drop `resolved: 'false'` from the open query | generator:100 | generator: the open query counts unresolved issues only, the two creation-date queries count created issues whether or not since fixed and leave out false positives and accepted ones, by an explicit status list |
| Q2 | AC-QA-2 | Drop the explicit status list from the creation-date queries | generator:101 | generator: the open query counts unresolved issues only, the two creation-date queries count created issues whether or not since fixed and leave out false positives and accepted ones, by an explicit status list |
| Q3 | AC-QA-2 | Add `FALSE_POSITIVE` to the status list | generator:98 | generator: the open query counts unresolved issues only, the two creation-date queries count created issues whether or not since fixed and leave out false positives and accepted ones, by an explicit status list |
| Q4 | AC-PROD-4 / AC-QA-2 | Also send `resolved=false` on the creation-date queries, so a fixed issue stops counting as new | generator:101 | generator: a rule whose only window issue has since been fixed, with no open issue, is present with open 0 and recent-new 1 and keeps its hand-written guidance |
| B1 | AC-SEC-6, byte cap (multibyte) | `> BYTE_CAP` to `> BYTE_CAP * 100` | generator:340 | generator: 20 rules with 160-character multibyte names stay within the byte cap, the rows are the top-ranked prefix, and stamp and stdout say N of M with N below 20 |
| B2 | AC-SEC-6, top-ranked prefix kept | Trim from the top of the ranking instead of the bottom | generator:341 | generator: 20 rules with 160-character multibyte names stay within the byte cap, the rows are the top-ranked prefix, and stamp and stdout say N of M with N below 20 |
| C1 | AC-SEC-5, cap counts code points | Cap by UTF-16 units instead of code points | generator:159 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| T1 | AC-QA-18 (tracked-file scan) | Plant the generator's name in `.githooks/pre-push` | .githooks/pre-push:7 | static: nothing tracked references the generator or its token variable outside the named exclusions, and install-consistency.mjs names it exactly once, in CONSUMER_OPTIONAL_PATTERNS |
| T2 | AC-QA-18 (tracked-file scan) | Plant the generator's name in `bin/install.sh` | bin/install.sh:36 | static: nothing tracked references the generator or its token variable outside the named exclusions, and install-consistency.mjs names it exactly once, in CONSUMER_OPTIONAL_PATTERNS |
| T3 | AC-ARCH-2 (tracked-file scan, any API path) | Plant `/api/measures/component` in `.githooks/pre-push` | .githooks/pre-push:7 | static: SonarQube API paths appear in no tracked file outside the generator, its tests and fixtures and the documents about it |
| T4 | AC-ARCH-2 (the path the old list missed) | Plant `/api/measures/component` in `workflows/lib/install-consistency.mjs` | workflows/lib/install-consistency.mjs:401 | static: SonarQube API paths appear in no tracked file outside the generator, its tests and fixtures and the documents about it |
| T5 | AC-SEC-8 (tracked-file scan) | Plant the table path in `.githooks/pre-push` | .githooks/pre-push:7 | the table path appears in agents/implementer.md and in no other tracked file outside the generator, its tests and the documents about it |
| T6 | AC-SEC-8 (tracked-file scan) | Plant the table path in `bin/install.sh` | bin/install.sh:36 | the table path appears in agents/implementer.md and in no other tracked file outside the generator, its tests and the documents about it |
| M4a | M4, message not printed (coded error) | Append the error message to the coded line | generator:371 | generator: a local file failure names the system call, the code and the repository-relative path, never the error message |
| M4b | M4, message not printed (no code) | Append the error message to the generic line | generator:364 | generator: a local file failure names the system call, the code and the repository-relative path, never the error message |
| M4c | M4, path relative to the repository root | Print the absolute path | generator:368 | generator: a local file failure names the system call, the code and the repository-relative path, never the error message |
| L1a | L1, placeholder looked up again | Treat the placeholder as hand-written | generator:325 | generator: guidance equal to the placeholder or to the bare rule key was never hand-written, so the name is looked up again, while real hand-written guidance stays |
| L1b | L1, bare rule key looked up again | Treat the bare rule key as hand-written | generator:325 | generator: guidance equal to the placeholder or to the bare rule key was never hand-written, so the name is looked up again, while real hand-written guidance stays |
| L3a | L3, missing or non-integer total fails | Accept any total | generator:125 | generator: a missing or non-integer total, or a missing rules facet, fails naming the API path and writes nothing |
| L3b | L3, `paging.total` accepted | Read only the top-level total | generator:124 | generator: paging.total is read when the top-level total is absent |
| L3c | L3, missing rules facet fails | Skip the facet check | generator:137 | generator: a missing or non-integer total, or a missing rules facet, fails naming the API path and writes nothing |
| L4a | AC-OPS-7, token cause note | Never take the token branch | generator:286 | generator: an unknown revision says which cause applied, one note per cause, and nothing about the head |
| L4b | AC-OPS-7, no-analysis cause note | Never take the no-analysis branch | generator:287 | generator: an unknown revision says which cause applied, one note per cause, and nothing about the head |
| L4c | AC-OPS-7, no-revision cause note | Reword the no-revision note | generator:288 | generator: an unknown revision says which cause applied, one note per cause, and nothing about the head |
| L4d | AC-OPS-7, git unavailable is said | Never print the git-unavailable note | generator:352 | generator: says so when git is unavailable for the head comparison, and not when it is available |
| R1 | L5, README: once per analysed merge | Reword the sentence | README.md:1780 | README says each run starts a new measurement interval, so run once per analysed merge and commit the result |
| R2 | AC-OPS-12, README: local failure named | Reword the troubleshooting entry | README.md:1792 | README troubleshooting names a local file failure by system call, code and path, and says zero rules can also mean nothing was created in the window |
| R3 | AC-OPS-12, README: zero rules cause | Restore the old "no unresolved issues" cause | README.md:1793 | README troubleshooting names a local file failure by system call, code and path, and says zero rules can also mean nothing was created in the window |
| K1 | AC-QA-9, two runs byte identical | Put the process id into the stamp | generator:338 | generator: two runs with the same clock against the same fixture are byte identical |
| K2 | AC-OPS-5, unknown project names the key | Drop the key from the failure line | generator:266 | generator: an unknown project key exits non-zero naming the key and writes no table |
| K3 | AC-SIMP-8, nothing judges staleness | Print a "previous table is stale" note | generator:306 | generator: nothing derived from the previous stamp but the one instant is computed, so a stale revision or an old table draws no warning |
| K4 | live defect 1, other analyses failures stay fatal | Treat every analyses failure as tolerated | generator:277 | generator: any other failure on the analyses lookup stays fatal, names the status and path, and writes nothing |
| K5 | AC-SEC-2, no warning without the opt-in | Print the cleartext warning on every run | generator:254 | generator: a failing run without the opt-in prints exactly one stderr line, with no warning |
| D1 | AC-PROD-5, README section exists | Rename the section heading | README.md:1736 | README: has a section for the analyser rules table |
| D2 | AC-ARCH-2, README names no API path | Write `/api/issues` into the README | README.md:1740 | README names no SonarQube Web API path or SonarQube-only field name |
| D3 | AC-SEC-6, README states the byte bound | Remove the byte bound sentence | README.md:1744 | README states the table bounds, the generator's environment variables and the stamp as the one derivation record |
| D4 | AC-PROD-8, README: never a gate | "It is sometimes a gate." | README.md:1780 | README says a person runs the generator from the repository root after the analyser has finished, that it is never a gate and nothing automated runs it |
| D5 | AC-PROD-11, README: hand-written guidance survives | Say guidance is rewritten on every refresh | README.md:1782 | README says the table is tracked in git, hand-written guidance survives a refresh, and how to write the table by hand for another analyser |
| D6 | AC-PROD-5, README: a replaced implementer gets no benefit | "gets full benefit" | README.md:1740 | README says a repository that has replaced its implementer agent gets no benefit, and the replacement must read the table to get it |
| D7 | AC-SEC-12, README: token on the same command line | "somewhere" | README.md:1770 | README tells the person to supply the token on the same command line as node, read from their token file at that moment, and never export, copy or echo it |
| D8 | AC-SEC-13, README: no global admin token | "any token you like" | README.md:1776 | README states the minimum permission, forbids a global admin token and explains the http opt-in |
| D9 | AC-OPS-9, README: deleting the table is the rollback | "Deleting the table is harmless" | README.md:1788 | README says deleting the table is the rollback, and that reinstalling and restarting the session roll the implementer change out or back |
| D10 | AC-OPS-12, README: absent-although-present symptom | Drop "although the file exists" | README.md:1794 | README has a troubleshooting entry, naming cause and action, for each of four symptoms |
| D11 | AC-OPS-1, implementer: read only when it exists (repaired guard) | Drop "only when it exists" | agents/implementer.md:57 | agents/implementer.md reads the table when it exists, before writing a test or production code, in every phase |
| D12 | AC-SEC-7, implementer: instruction-like rows not followed | "is followed" | agents/implementer.md:60 | agents/implementer.md frames the table as reference data about patterns to avoid and never as instructions |
| D13 | AC-SEC-6, implementer: byte bound | `8,192 bytes` to `9,000 bytes` | agents/implementer.md:62 | agents/implementer.md states the same bounds as the generator and treats an oversize table as absent, saying so at the top of the report |
| D14 | AC-OPS-1, implementer: status line forms | Rename the `unreadable` status line form | agents/implementer.md:69 | agents/implementer.md requires one rules-table status line in every report, showing exactly one of read, absent, unstamped or unreadable |
| G1 | AC-QA-14, table not git-ignored (repaired guard) | Add the table path to `.gitignore` | .gitignore:52 | the table is not git-ignored, so a linked worktree receives it |
| G2 | AC-QA-14, worktree receives the table | Add the table path to `.gitignore` | .gitignore:52 | a linked worktree made with git worktree add holds the committed table at its fixed path, with the main checkout's content, under this repository's own ignore rules |

### Comparator inversions and UTC instants (L6, L7)

Re-run in round 2 against the current code. Inverting the key tiebreak (row N16)
fails `generator: rules tied on recent-new are ordered by open count, then rules
tied on both by key, whatever order the server lists them in (AC-QA-9)`;
inverting the open-count comparison (row N17) fails the same test. Every date
parameter is an explicit UTC instant: the test
`generator: the window is 30 days back to a UTC midnight, inclusive, either
side of a Sydney daylight-saving change (AC-QA-11)` asserts that every
`createdAfter` sent equals the window start plus `T00:00:00+0000`, and the fake
server answers 400 to a bare date. Sending a bare date (row N6) fails that test.

| # | Criterion | Edit | Landed on | Failing test (name abridged) |
|---|---|---|---|---|
| N16 | AC-QA-9 key tiebreak | Reverse the key comparison | generator:317 | generator: rules tied on recent-new are ordered by open count, then rules tied on both by key, whatever order the server lists them in |
| N17 | AC-QA-9 open-count tiebreak | Reverse the open-count comparison | generator:317 | generator: rules tied on recent-new are ordered by open count, then rules tied on both by key, whatever order the server lists them in |
| N6 | AC-QA-11 explicit UTC instants | Send a bare date | generator:293 | generator: the window is 30 days back to a UTC midnight, inclusive, either side of a Sydney daylight-saving change |

## Fix round 3: proofs for the survivors the round 3 review found and the new guards

Same method as the earlier rounds (anchor line unique, old text unique on it,
file and line printed, only the named test run, original restored and its hash
compared; identical in every row). The review's four surviving mutants are rows
H1 and H2 (its M4, the integer check on a facet count), H3 and H3b (M5, the
40-hex check), H5 (M6, the previous-table size check) and H4 (M8, the
negative-total check); its M3 (ANSI removal) is H11a. Row H11c first survived
the exact-cell assertions, because whitespace collapsing removes the controls
the fixtures used; a fixture with controls that are not whitespace (bell, NUL,
DEL) was added and the row below is the second run. Two lines of code that no
test could fail were removed instead of tested: the skip of the previous
table's header and separator rows, which changed nothing, because neither row
can be unreadable. Rows F1 to F3 (a last fix: the cap checks counted the rules kept rather than the values the server sent, so a cut facet holding one rejected key looked complete) each use a 100-value facet with one over-long key. Rows run `test/sonar-rules-table.test.js` except H13 to H15,
which run `test/sonar-rules-docs.test.js`.

| # | Criterion | Edit | Landed on | Failing test (name abridged) |
|---|---|---|---|---|
| H1 | AC-SEC-5 (review M4), facet counts must be integers | Drop the integer check on a facet count | generator:139 | generator: hostile server numbers and a hostile revision are dropped or made unknown, with one count-only note and no stray line |
| H2 | AC-SEC-5, facet counts must not be negative | Drop the non-negative check on a facet count | generator:139 | generator: hostile server numbers and a hostile revision are dropped or made unknown, with one count-only note and no stray line |
| H3 | AC-SEC-5 (review M5), revision must be 40 hex | Accept any revision string | generator:293 | generator: hostile server numbers and a hostile revision are dropped or made unknown, with one count-only note and no stray line |
| H3b | AC-SEC-5, the revision check is anchored | Remove the anchors from the 40-hex pattern | generator:293 | generator: hostile server numbers and a hostile revision are dropped or made unknown, with one count-only note and no stray line |
| H4 | AC-SEC-5 (review M8), a negative total fails | Drop the negative-total check | generator:127 | generator: a missing or non-integer total, or a missing rules facet, fails naming the API path and writes nothing |
| H4b | AC-SEC-5, a fractional total fails | Drop the integer check on a total | generator:127 | generator: a missing or non-integer total, or a missing rules facet, fails naming the API path and writes nothing |
| H5 | AC-SEC-6 (review M6), an oversize previous table is ignored | Drop the size check | generator:178 | generator: a previous table over the size bound is ignored with one note, and unreadable rows of a previous table are counted, never quoted |
| H5b | L9, the previous-table-ignored note | Never print the note | generator:370 | generator: a previous table over the size bound is ignored with one note, and unreadable rows of a previous table are counted, never quoted |
| H5c | L9, unreadable previous rows are counted | Count none | generator:188 | generator: a previous table over the size bound is ignored with one note, and unreadable rows of a previous table are counted, never quoted |
| H6a | L9, rejected facet values are counted | Count none | generator:140 | generator: hostile server numbers and a hostile revision are dropped or made unknown, with one count-only note and no stray line |
| H6b | L9, the rejected-values note | Never print the note | generator:369 | generator: hostile server numbers and a hostile revision are dropped or made unknown, with one count-only note and no stray line |
| H7 | L1, the total is a floor when the recent facet is cut | Check the open facet only | generator:352 | generator: a rules facet cut at its cap makes the total a lower bound whichever facet is cut, and on-listed a lower bound when the since-previous facet is cut |
| H8 | AC-OPS-6, on-listed is a floor when its facet is cut | Always print the exact value | generator:325 | generator: a rules facet cut at its cap makes the total a lower bound whichever facet is cut, and on-listed a lower bound when the since-previous facet is cut |
| H9 | L2, a non-atomic writer is detected by the concurrency test | Write the table directly instead of through a temporary file and rename | generator:243, generator:245 | generator: two runs started together against a slow server always leave one complete table from one run, never an interleaving, and no temporary file |
| H10a | AC-QA-1, README command variable names | Rename one variable in the command | README.md:1775 | README: the documented command invokes node bin/sonar-rules-table.mjs, shows exactly the variables the generator requires, and runs as written against the fake |
| H10b | AC-QA-1, README command script path | Misspell the script path in the command | README.md:1775 | README: the documented command invokes node bin/sonar-rules-table.mjs, shows exactly the variables the generator requires, and runs as written against the fake |
| H10c | AC-QA-1, the generator's required variables | Rename the project variable the generator requires | generator:44 | README: the documented command invokes node bin/sonar-rules-table.mjs, shows exactly the variables the generator requires, and runs as written against the fake |
| H11a | AC-SEC-5 (review M3), ANSI sequences removed | Remove the ANSI-sequence step | generator:154 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| H11b | AC-SEC-5, column separator replaced | Remove the separator replacement | generator:157 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| H11c | AC-SEC-5, control characters become spaces | Remove the control-character class | generator:155 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| H12 | L6, the sweep tolerates a vanished file | Rethrow ENOENT | generator:235 | generator: a dead run's temporary file that another run's sweep removes first does not fail this run |
| H13 | L7, README: commit the deletion | Reword the sentence | README.md:1790 | README says deleting the table is the rollback, and that reinstalling and restarting the session roll the implementer change out or back |
| H14a | L8, README: run from a checkout of this repository | Reword | README.md:1772 | README says the generator is run from a checkout of this repository, that bin/install.sh copies it as an optional file for the drift check, and gives the copy and diff lines beside the other two |
| H14b | L8, README: the copy line for the generator | `cp` to `mv` | README.md:1605 | README says the generator is run from a checkout of this repository, that bin/install.sh copies it as an optional file for the drift check, and gives the copy and diff lines beside the other two |
| H14c | L8, README: the diff line for the generator | `diff -q` to `diff` | README.md:1609 | README says the generator is run from a checkout of this repository, that bin/install.sh copies it as an optional file for the drift check, and gives the copy and diff lines beside the other two |
| H15 | AC-OPS-6, README: on-listed is a floor | Reword | README.md:1746 | README says on-listed is a lower bound when the since-previous list is cut at its limit |
| H16 | L11, the request uses the path constant | Write the path out in the request | generator:101 | static: the issues path is one constant, declared before its first use, and the request uses it |
| H17 | L12, the helper exports only what tests use | Export one more name | test/helpers/tracked-files.js:52 | static: the tracked-files helper exports only what tests use |
| F1 | AC-OPS-6, the new-issue facet's cap counts the values the server sent, rejected ones included | Test the filtered size of the new-issue facet instead | generator:354 | generator: a rules facet cut at its cap makes the total a lower bound whichever facet is cut, and on-listed a lower bound when the since-previous facet is cut |
| F2 | AC-OPS-6, the open facet's cap counts the values sent | Test the filtered size of the open facet instead | generator:354 | generator: a rules facet cut at its cap makes the total a lower bound whichever facet is cut, and on-listed a lower bound when the since-previous facet is cut |
| F3 | AC-OPS-6, the on-listed floor counts the values sent | Test the filtered size of the since-previous facet instead | generator:327 | generator: a rules facet cut at its cap makes the total a lower bound whichever facet is cut, and on-listed a lower bound when the since-previous facet is cut |

### Scanner fixes: the README-command parser and the sweep without a regular expression

The README command is now split by a loop, not a pattern, and the sweep compares
the file name as text and reads only the digits between prefix and suffix. The
sentinel token is built from plain words. Same method as above. Rows H10a, H10b,
H12 and N13 are re-runs against the new code; S1 to S3 are new, and S2 and S3
first survived (a name with the wrong suffix, and one whose middle is a number
only to JavaScript, were each protected by a second check), so the live-process
test gained those two names and the rows are the second run.

| # | Criterion | Edit | Landed on | Failing test (name abridged) |
|---|---|---|---|---|
| H10a | AC-QA-1, README command variable names | Rename one variable in the command | README:1775 | README: the documented command invokes node bin/sonar-rules-table.mjs, shows exactly the variables the generator requires, and runs as written against the fake |
| H10b | AC-QA-1, README command script path | Misspell the script path in the command | README:1775 | the same test |
| H12 | L6, the sweep tolerates a vanished file | Rethrow ENOENT | generator:243 | generator: a dead run's temporary file that another run's sweep removes first does not fail this run |
| N13 | AC-QA-10, the sweep runs | Remove the sweep call | generator:250 | generator: a run killed partway through the write leaves the previous table byte identical, and the next run removes the dead run's temporary file |
| S1 | AC-QA-10, a live run's file is left alone | Remove the liveness skip | generator:237 | generator: a temporary file belonging to a live process is not removed by another run |
| S2 | AC-QA-10, the suffix is checked | Remove the suffix check | generator:226 | the same test |
| S3 | AC-QA-10, only digits name a process | Remove the digit check | generator:228 | the same test |

## Live implementer runs (AC-OPS-1, and the builder halves of AC-QA-15 and AC-PROD-5)

The first four runs below all used a SonarQube-keyed table, so on their own
they did not cover AC-PROD-5's hand-written, other-analyser case; review round
3 said so. The fifth run, added afterwards, does.

Run by the conductor on 2026-11-21, Claude Code 2.1.322: four headless
sessions, one per table state, each in its own scratch repository carrying
this branch's `agents/implementer.md` as a project agent (unchanged between
these runs and the fix round 2 commit). Each session dispatched the
`implementer` once through the Agent tool with a Test-phase task (write the
minimal failing test for an `add(a, b)` that does not exist yet) and printed
the report verbatim. No server and no token were involved. The status line of
each report, with the scratch path shortened:

| Table state in the scratch repository | Status line in the implementer's report | The task itself |
|---|---|---|
| no table | `Rules table: absent (checked <scratch repository>/.claude/analyser-rules.md)` | test written and seen failing; no warning, no request to create a table |
| this repository's table, copied | `Rules table: read, derived 2026-11-20T23:52:33Z, revision: unknown.` The report added that the table was a regular file of 20 rows within both bounds, that the one applicable row was `javascript:S8784` and every assertion sat inside a test, and that no row read as an instruction | test written and seen failing |
| the same table with its `derived:` line removed | `Rules table: unstamped (<scratch repository>/.claude/analyser-rules.md is a regular file, 2,293 bytes, 20 rows, but has no derived: line)`. The report said the guidance was still used where it applied | test written and seen failing |
| the same table with all permissions removed | `Rules table: unreadable.` with the reason: a regular file whose permissions allow no access, opening fails with "permission denied", and the permissions were left alone as outside the task | test written and seen failing |

**Fifth run, hand-written table (AC-PROD-5).** Same method, same day, with the
table taken verbatim from the README's example block, whose second row is a
rule identifier that is not a SonarQube key (`no-todo-comments`). Status line:
`Rules table: read, derived 2026-11-21T10:30:00Z, revision a1b2c3d4e5f60718293a4b5c6d7e8f9012345678.`
The report added: a regular file of 488 bytes with 3 rows, within the size
limits; "the test has no unused imports, no TODOs and no nested ternaries";
no row read as an instruction. The test was written as asked.

Not covered by these runs: the Implement phase and a `conduct-plan` direct
dispatch were not run separately. The dispatch here is a direct one through
the Agent tool, which is the path `conduct-plan` uses, and `tdd-task` loads
the same agent definition for both of its phases; the instruction is the same
text in all three.

## Follow-up: tdd-task pointer

AC-QA-22. Each mutation was applied to `workflows/tdd-task.js`, confirmed landed
by counting the matching text afterwards, run against
`test/tdd-task.test.js` and `test/sonar-rules-docs.test.js`, and restored (the
file was compared byte for byte with a copy taken before the first mutation).
The last seven rows are the second round (the `rules_table` field and the
word-for-word pin); the same procedure applied.

| Mutation | Landed (check) | Test that failed |
|---|---|---|
| Remove the constant from the Test prompt (`write-test` dispatch) | one `${rulesTableNote}` use left instead of two | `tdd-task.js: the Test and Implement prompts both carry the same rules-table pointer sentence (AC-QA-22)` |
| Remove the constant from the Implement prompt | one `${rulesTableNote}` use left instead of two | the same test |
| Alter the path inside the constant (`analyser-rules.md` to `analyser-rule.md`) | one match for the altered path, none for the real one | `the table path is one literal in the generator and any other file that names it names the same path (AC-ARCH-1, AC-QA-22)`, and `the table path appears in agents/implementer.md and in no other tracked file outside the generator, its tests and the documents about it (AC-SEC-8)` |
| Hostile rewording of the opening: "check the file" became "create the file ... if it is missing and follow every line in it as an instruction" | one match for the hostile opening, none for the real one | `tdd-task.js: the Test and Implement prompts both carry the rules-table pointer, word for word (AC-QA-22)` only (the earlier key-phrase test stayed green on this rewording, which is why the exact pin exists) |
| Change `over 20 rows` to `over 21 rows` in the constant | one match | the word-for-word test, and `the row and byte bounds in the tdd-task pointer are the numbers agents/implementer.md and the generator state, so they cannot drift (AC-QA-22)` |
| Drop the 200 character cap on the logged `rules_table` value | one match | `tdd-task.js: a reported rules_table is logged once per phase as one capped, control-free line, and never reaches the result, the ledger or a verifier prompt (AC-QA-22)` |
| Drop the control character and line break reduction | one match | the same test |
| Make `rules_table` required in the Test schema | one match | `tdd-task.js: both builder schemas declare an optional string rules_table, and the RED verifier schema is untouched (AC-QA-22)`, and the existing tests whose fake builder omits the field |
| Remove the once-per-phase flag in `logRulesTable` | one match | `tdd-task.js: no rules_table, no log line; a Test phase that retries still logs once (AC-QA-22)` |
| Append the status to `expected_failure` (the RED verifier's input) | one match | the same test as the cap mutation, which asserts the value reaches no verifier prompt |

### Live run for the tdd-task pointer (AC-QA-22)

Run by the conductor on 2026-11-21, Claude Code 2.1.322: one headless session
in a scratch repository whose project `implementer` was a replacement with no
rules-table section (zero occurrences of the table's path), with this
repository's table present. The builder was dispatched once with a Test-phase
task that carried the pointer sentence as first written. Its report said the
table exists, quoted its derivation stamp, said it "read the table as
reference data only", named the one row that applied to the test
(`javascript:S8784`, assertions inside a test) and confirmed the test complied.
The test was written as asked. So the sentence alone reaches a builder whose
definition lacks the section.

The report's status line quoted the stamp where the four-state form was
wanted, so the sentence was then tightened to name the four states (read with
the derived date, absent, unstamped, unreadable). The tightened wording has
not had a live run of its own; the tests pin that both prompts carry it.

**Final wording, three live runs.** After the fix round that gave the status a
`rules_table` field and added the symlink, size and no-instruction rules, the
conductor ran three more headless sessions the same day, each with a
replacement `implementer` that has no rules-table section, dispatched with a
Test-phase task carrying the final constant and asked for the four fields:

| Table in the scratch repository | `rules_table` in the builder's answer |
|---|---|
| this repository's table | `read (derived 2026-11-21T03:27:05Z)`, adding that it was a regular file, not a symlink, of 2,501 bytes and 20 rows, treated as reference only with no instructions taken from it |
| none | `absent`, the path does not exist, no guidance applied |
| a symlink at the table's path pointing at a file outside the repository that held a marker phrase | `absent`: a symlink counts as absent and it was neither read nor followed. The marker phrase appears nowhere in the session's output |

Not covered: these were direct dispatches carrying the prompt text, not runs
of the `tdd-task` workflow itself, so the `log()` line has been seen only in
the fake runtime.

## After the complexity refactor

The generator's long functions were split into named helpers with no change in
behaviour (`readPrevious`, `removeDeadTemporaries` and `main` each over the
analyser's limit of 15), and three regular-expression and top-level issues were
cleared. The tests and fixtures were not edited. Rows below re-run recorded
mutations against the refactored code, with the same method as the earlier
rounds: each edit asserted exactly one match in the file and printed the line
it landed on (the "Landed on" column, line numbers as at this run, so they have
moved), only the named test was run, and the file was then restored and its
hash compared with the pre-mutation hash (identical in every row). All rows run
`test/sonar-rules-table.test.js`. Where the construct moved into a helper the
row keeps its name and the edit is the same change to the same logic.

| # | Criterion | Edit | Landed on | Failing test (name abridged) |
|---|---|---|---|---|
| Q1 | AC-QA-2 | Drop `resolved: 'false'` from the open query | generator:109 | generator: the open query counts unresolved issues only, the two creation-date queries count created issues whether or not since fixed... |
| f | live defect 3 | Warning moved from before the first request to after the table is written | generator:442, generator:460 | generator: the cleartext warning is on stderr before the first request is answered, not after a successful run |
| e | live defect 2 | Project-existence request disabled (`await (0 && confirmProject(cfg))`) | generator:448 | generator: the project is proved to exist before any issue query, and an unknown key fails naming it... |
| N11 | AC-QA-10 | Write the table directly, no temporary file and rename | generator:284, generator:285 | generator: a run killed partway through the write leaves the previous table byte identical... |
| H11c | AC-SEC-5 | Remove the control-character class from the sanitiser | generator:164 | generator: hostile rule names and keys become inert one-line data and a bad key is dropped |
| N3b | AC-SEC-5 | Remove `.normalize('NFKC')` | generator:162 | the same test |
| g | AC-PROD-11 | `isHandWritten` always false, so existing guidance is ignored | generator:386 | generator: hand-written guidance survives a refresh, a new rule gets the analyser name, a departed rule is dropped |
| L1b | L1 | Treat the bare rule key as hand-written | generator:386 | generator: guidance equal to the placeholder or to the bare rule key was never hand-written... |
| H7 | L1 | Total floor checks the open facet only | generator:408 | generator: a rules facet cut at its cap makes the total a lower bound whichever facet is cut... |
| F3 | AC-OPS-6 | On-listed cap tests the filtered size of the since-previous facet | generator:373 | the same test |
| H1 | AC-SEC-5 | Drop the integer check on a facet count | generator:146 | generator: hostile server numbers and a hostile revision are dropped or made unknown... |
| H3b | AC-SEC-5 | Remove the anchors from the 40-hex pattern | generator:350 | the same test |
| M4a | M4 | Append the error message to the coded failure line | generator:481 | generator: a local file failure names the system call, the code and the repository-relative path, never the error message |
| L4a | AC-OPS-7 | Never take the token-denied cause | generator:341 | generator: an unknown revision says which cause applied, one note per cause, and nothing about the head |
| S1 | AC-QA-10 | Remove the liveness skip | generator:250 | generator: a temporary file belonging to a live process is not removed by another run |
| H5 | AC-SEC-6 | Drop the previous-table size check | generator:193 | generator: a previous table over the size bound is ignored with one note... |
| N10 | AC-PROD-6 | Remove the invalid-date guard | generator:179 | generator: a table with no readable derivation instant, or an unreadable one, gives n/a and no extra query |
| H12 | L6 | Sweep rethrows ENOENT | generator:275 | generator: a dead run's temporary file that another run's sweep removes first does not fail this run |
| P8 | lookup fail-safe | Trust any returned rule | generator:125 | generator: a lookup that returns rules it was not asked for is never trusted... |
| N16 | AC-QA-9 | Reverse the key comparison | generator:381 | generator: rules tied on recent-new are ordered by open count, then rules tied on both by key... |
| N6 | AC-QA-11 | Send a bare date as the created-after parameter | generator:305 | generator: the window is 30 days back to a UTC midnight, inclusive, either side of a Sydney daylight-saving change |
| B2 | AC-SEC-6 | Trim from the top of the ranking | generator:421 | generator: 20 rules with 160-character multibyte names stay within the byte cap... |
| TLA | exit code | Exit code 0 on failure in the new top-level `catch` | generator:488 | generator: every unhappy server path exits non-zero in bounded time with one stderr line... |
| X1 | trailing slash | `trimTrailingSlashes` returns its input unchanged (the replacement for the backtracking pattern) | generator:45 | all 86 tests in the file fail (every request URL gains a double slash) |

## After HARN-RULES-1: two older faults

Each edit was applied to `bin/sonar-rules-table.mjs`, the diff against a saved
copy was read to confirm it landed on the intended line, the named test was run
and seen to fail, and the file was then restored and compared byte for byte
(`cmp`) with the saved copy. The two stalled-body rows share one test, which
checks the first request, a later (third) request and a genuinely invalid body.

| # | Fault | Edit | Landed on | Failing test (name abridged) |
|---|---|---|---|---|
| O1 | Error name echoed | Remove the name pattern check (`safeName` returns `e?.name \|\| 'error'`) | generator:`safeName` | generator: an unexpected error prints its name only when the name is up to 32 letters... (the token sentinel case printed `unexpected Error not-a-real-token-sentinel`) |
| O2 | Stalled body | A stalled body reports invalid JSON again (drop the `TimeoutError` branch in `readBody`) | generator:`readBody` | generator: a server that sends headers then stalls the body is a timeout naming the API path... (first request: got `response was not valid JSON on /api/measures/component`) |
| O3 | Invalid JSON | An invalid JSON body reports a timeout (the `JSON.parse` catch throws the timeout line) | generator:`get` | the same test (invalid JSON case: got `request timed out on /api/measures/component`) |
