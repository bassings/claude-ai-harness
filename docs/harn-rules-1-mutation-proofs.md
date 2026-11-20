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
