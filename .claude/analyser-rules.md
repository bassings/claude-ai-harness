# Analyser rules table
derived: 2026-11-20T23:13:34Z revision: unknown analyser: SonarQube window: 2026-10-21..2026-11-20 new-issues: 46 on-listed: 46 open-total: 150 rules: 20 of 26

| rule | guidance | open | recent-new |
|---|---|---|---|
| javascript:S3358 | No nested ternaries: use if/else or name the inner result in a const first | 29 | 7 |
| javascript:S3776 | Keep a function's cognitive complexity at or under 15: extract named helpers, return early, avoid nesting loops inside conditionals | 11 | 7 |
| javascript:S6582 | Use optional chaining (a?.b) instead of a && a.b | 28 | 5 |
| javascript:S8786 | No regex that can backtrack non-linearly: avoid nested or adjacent overlapping quantifiers; anchor and bound repeats | 8 | 5 |
| javascript:S7776 | A collection used only for membership tests is a Set with .has(), not an array with .includes() | 7 | 4 |
| javascript:S6353 | Write \d, \w, \s and ? + * instead of [0-9], [A-Za-z0-9_] and {0,1} {1,} {0,} | 7 | 3 |
| javascript:S2871 | Always pass a compare function to sort() and toSorted() | 3 | 3 |
| python:S3776 | Keep a function's cognitive complexity at or under 15: extract named helpers, return early, flatten nesting | 8 | 2 |
| javascript:S4036 | OS commands should not rely on PATH resolution | 4 | 2 |
| javascript:S7718 | Name a caught error error or error_, never a role name such as first or second | 2 | 2 |
| javascript:S8784 | Put every assertion inside a test() or a hook, never at module top level | 2 | 2 |
| javascript:S4624 | No template literal inside another: build the inner string in a const first | 9 | 1 |
| javascript:S6535 | Do not escape characters that need no escape in a regex or string, such as / inside a character class | 8 | 1 |
| javascript:S1940 | Boolean checks should not be inverted | 1 | 1 |
| javascript:S3800 | A function returns one type on every path: do not mix null, boolean and object returns | 1 | 1 |
| javascript:S7778 | Multiple consecutive calls to methods that accept multiple arguments should be combined | 6 | 0 |
| python:S8997 | Tests should use the "monkeypatch" fixture for temporary modifications | 4 | 0 |
| javascript:S1481 | Unused local variables and functions should be removed | 3 | 0 |
| javascript:S7780 | String literals with escaped backslashes should use String.raw template literals | 2 | 0 |
| javascript:S1871 | Two branches in a conditional structure should not have exactly the same implementation | 1 | 0 |
