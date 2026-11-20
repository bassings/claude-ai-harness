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
| P1 | AC-QA-2 | Drop `resolved: 'false'` from the one issue-query helper | generator:92 | generator: every issue request asks for unresolved issues only and the resolved fixtures are not counted |
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

- **Byte cap (AC-SEC-6).** Replacing `> BYTE_CAP` with `> BYTE_CAP * 100` leaves
  every test green, and no test can fail it: a row is at most about 260 bytes (a
  64-character key, 160 characters of guidance and two counts), so 20 rows and
  the stamp come to about 5.5 KB, under the 8,192-byte cap. The size loop is a
  guard the other two caps make unreachable. It is left in place and is not
  claimed as tested.
- **Temporary-file naming pattern (AC-QA-10).** The test leaves a file named
  `.analyser-rules.md.bak` beside a dead run's file and asserts it survives. It
  was not mutated: broadening the pattern still leaves the file alone, because a
  non-numeric process id is treated as alive. Two guards cover one case.

