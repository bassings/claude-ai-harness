# Analyser rules table
derived: 2026-11-21T06:14:47Z revision: unknown analyser: SonarQube window: 2026-10-22..2026-11-21 new-issues: 57 previous: 2026-11-21T03:27:05Z since-previous: 9 on-listed: 6 open-total: 141 rules: 20 of 26

| rule | guidance | open | recent-new |
|---|---|---|---|
| javascript:S3776 | Keep a function's cognitive complexity at or under 15: extract named helpers, return early, avoid nesting loops inside conditionals | 14 | 10 |
| javascript:S3358 | No nested ternaries: use if/else or name the inner result in a const first | 31 | 9 |
| javascript:S8786 | No regex that can backtrack non-linearly: avoid nested or adjacent overlapping quantifiers; anchor and bound repeats | 9 | 6 |
| javascript:S6582 | Use optional chaining (a?.b) instead of a && a.b | 28 | 5 |
| javascript:S7776 | A collection used only for membership tests is a Set with .has(), not an array with .includes() | 5 | 4 |
| javascript:S4036 | OS commands should not rely on PATH resolution | 5 | 3 |
| javascript:S6353 | Write \d, \w, \s and ? + * instead of [0-9], [A-Za-z0-9_] and {0,1} {1,} {0,} | 2 | 3 |
| javascript:S2871 | Always pass a compare function to sort() and toSorted() | 0 | 3 |
| python:S3776 | Keep a function's cognitive complexity at or under 15: extract named helpers, return early, flatten nesting | 8 | 2 |
| javascript:S6535 | Do not escape characters that need no escape in a regex or string, such as / inside a character class | 4 | 2 |
| javascript:S8784 | Put every assertion inside a test() or a hook, never at module top level | 2 | 2 |
| javascript:S7718 | Name a caught error error or error_, never a role name such as first or second | 0 | 2 |
| javascript:S4624 | No template literal inside another: build the inner string in a const first | 8 | 1 |
| javascript:S9382 | Promises should not be awaited sequentially in a loop | 2 | 1 |
| javascript:S1940 | Boolean checks should not be inverted | 1 | 1 |
| javascript:S3800 | A function returns one type on every path: do not mix null, boolean and object returns | 1 | 1 |
| javascript:S7781 | Strings should use "replaceAll()" instead of "replace()" with global regex | 1 | 1 |
| javascript:S7785 | Top-level await should be preferred over promise chains and async wrappers | 1 | 1 |
| javascript:S7778 | Multiple consecutive calls to methods that accept multiple arguments should be combined | 6 | 0 |
| python:S8997 | Tests should use the "monkeypatch" fixture for temporary modifications | 4 | 0 |
