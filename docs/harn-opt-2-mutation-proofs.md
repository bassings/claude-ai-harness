# HARN-OPT-2 PR1 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour
was actually broken (edited in the working file, not "mentally mutated"),
the suite was run, the exact failing test and message recorded, then the
file was `cp`-restored from a pre-mutation snapshot (never `git checkout
--`, which reverts to the last commit and can destroy uncommitted work) and
confirmed via `diff <working-file> <snapshot>` returning nothing before the
next mutation. Full suite: `node --test test/*.test.js`. AC-SIMP-10 caps
this file at 200 lines; later rounds compress earlier ones, never drop them.

**Round 2**: `perRepo[].root` was still the raw caller-supplied path
verbatim. Fixed by deriving a non-identifying label (proof 10).

**Round 3**: BLOCKED on CRITICAL C1 (four distinct conductor events
collapsed to one line). Root cause: write-time regex redaction applied to a
STRUCTURED path value (`spec`/`event_key`), not free text. Decision: strip
write-time redaction of `spec` entirely (the ledger is gitignored,
local-only -- AC-SEC-1 -- no privacy requirement to redact data INSIDE it;
AC-SEC-3 governs the report/prompt OUTPUT boundary only), replaced with
pure lexical root-matching. **Supersedes proofs 2 and 4**, corrected in
place rather than deleted.

**Round 4** (current tip): H3 was only half-fixed by round 3 -- an
absolute spec through a symlinked ANCESTOR, submitted from a subdirectory
(not repo root) of that repo, still fell through to the marker; round 3's
own H3 test used cwd === repo root, letting its PWD candidate cover a
narrower case by accident. Fixed and mutation-proven below; round-3's
`realpathOrNull` finding is now resolved (deleted, genuinely dead), not
merely flagged. Suite: 400/400 (ledger-append.test.js 123,
optimise-read.test.js 76, optimise-cycle.test.js 63, optimise-static.test.js
15, static-checks.test.js 18, 105 elsewhere untouched).

## Round 1/2 proofs (1-11), condensed

1. **`..`-escape detection** (AC-SEC-1 case d): `if (segments.length === 0)
   return REDACTED_PATH_MARKER` -> `if (false) ...`, ledger-append.mjs:539.
   Failed the traversal-redaction test. Re-verified round 3 as an M1 direct
   unit test. **Reverted, current.**

2. **CORRECTED (was stale)**: originally described `spec` being relativised
   via a worktree pre-pass gate before general redaction -- that pipeline no
   longer applies to `spec` (round 3 struck it). The mutated line,
   `if (cwdRoot && cwdRoot !== root) {` (ledger-append.mjs:764), now guards
   only `task`/`round_key`/`event`/`event_key`; `spec` goes through
   `specRootCandidates` inside `canonicalPlanKey` instead (round-3 probe 9;
   round 4 for the symlink half). Not re-mutated separately here.

3. **Repo-identity fallback uses the main-checkout basename** (AC-DATA-2):
   `if (mainRoot) return path.basename(mainRoot)` -> `if (false) ...`,
   ledger-append.mjs:619. Failed the worktree/main identity-agreement test.
   **Reverted, current.**

4. **CORRECTED (was stale)**: original mutation targeted a standalone
   `payload.spec = REDACTED_PATH_MARKER` override that no longer exists.
   Current mechanism: `specWasOverwritten` (ledger-append.mjs:832-833)
   overwrites `payload.spec` with `planKey` whenever `planKey !==
   NO_SPEC_PLAN_KEY`. Not independently re-mutated; flagged for a future
   round if revisited, not marked passing.

5. **Unattributable-run exclusion, `aggregateWallClock`** (AC-DATA-7):
   `if (plan === REDACTED_PATH_MARKER) { unattributableRuns += 1; continue }`,
   optimise-read.mjs:475. **Reverted, current.**

6. **Degraded-record exclusion, `planKeyForRecord`** (AC-QA-7):
   `if (!record || record.degraded) return null`, optimise-read.mjs:155.
   **Reverted, current.**

7. **`ci_wait`/`human_wait` bucket key routes through `canonicalPlanKey`**
   (AC-ARCH-4): optimise-read.mjs:357. **Reverted, current.**

8. **Single-definition-site static guard** (AC-ARCH-1): a second throwaway
   `canonicalPlanKey` appended to optimise-read.mjs was caught by the static
   check. **Reverted, current.**

9. **Worktree-root resolution costs zero extra git subprocesses** (AC-QA-20):
   reverting the fs-only walk to `git rev-parse --show-toplevel` failed the
   PATH-shim call-count tests. **Reverted, current.**

10. **`perRepo[].root` derives a non-identifying label** (AC-SEC-3 round 2):
    `derivePerRepoLabel` left unused, raw `root` pushed, optimise-read.mjs:823.
    **Reverted, current.**

11. **AC-DATA-6: a pre-PR1-shaped line still attributes via `spec`**:
    `planKeyForRecord`'s fallback forced to `NO_SPEC_PLAN_KEY`,
    optimise-read.mjs:164. **Reverted, current.**

## Round 3 probes (this round's rebuild, nine total)

Each probe: mutate -> run the named suite -> record exact pass/fail counts
and which named test(s) failed -> `diff` against the pre-mutation `/tmp`
snapshot after `cp`-restoring, confirming zero lines -> full suite green
again before the next probe. Two probes (6, 9) are differential: run twice,
once per candidate mechanism, to isolate which one actually carries the fix.

1. **C1** (`ledger-append.mjs`): reintroduced the destructive event_key
   regex (`payload.event_key.replace(/\.\.[\\/].*$/, '<redacted-path>')`,
   C1's exact shape -- a "../" match swallowing the whole remainder).
   121 -> 119 pass, 2 fail: the C1 four-distinct-events reproduction, and
   the L2-reversion test (a literal "../" inside `event_scope` must survive
   verbatim in the minted `event_key`). No collateral failures. **Reverted,
   zero-line diff, 121/121.**

2/3. **Realpath vs. PWD root candidates** (`ledger-append.mjs`), a
   differential pair: (a) reduced `specRootCandidates` from `[cwdRoot, root,
   realpathOrNull(cwdRoot), realpathOrNull(root)]` to `[cwdRoot, root]` --
   0 failures; (b) short-circuited the PWD-push (`if (fs.statSync(...).ino
   === ...)`) to `if (false)` instead -- 121 -> 120 pass, 1 fail: exactly
   the round-3 H3 PWD symlink test. **Conclusion: PWD, inode-matched
   against `cwd`, was the load-bearing mechanism for round-3's own (narrower)
   H3 test; the two `realpathOrNull` entries were unexercised by anything.**
   Superseded by round 4: both findings resolved there (realpathOrNull
   deleted as genuinely dead; the real gap PWD was accidentally covering
   fixed properly). **Reverted, zero-line diff, 121/121.**

4. **Bucket-key escaping** (`optimise-read.mjs`): `escapeKeyComponent` ->
   `return String(s)` (pre-M4 bare join). 76 -> 74 pass, 2 fail: the
   `aggregateWallClock`/`aggregateRework` colliding-pair tests
   (`('demo','a|weird.md')` vs `('demo|a','weird.md')`), nothing else.
   **Reverted, zero-line diff, 76/76.**

5. **Exclusion-counter report line** (`optimise-cycle.js`):
   `` `observations=${wallTotalsForExclusions.unattributableWaits ?? 0}` ``
   -> literal `observations=0`. 63 -> 62 pass, 1 fail: the repaired M3 test
   (exact-substring, line-scoped). The PRE-repair version, a bare `/\b4\b/`
   whole-report scan, would have passed here since "AC-ARCH-4" appears
   elsewhere -- confirms the repair is a real detection-power gain.
   **Reverted, zero-line diff, 63/63.**

6. **Raw stdin parse-error leaks, all three CLI commands**
   (`optimise-read.mjs`): reverted to `'stdin was not valid JSON: ' +
   e.message` (V8's SyntaxError embeds the failing input). 76 -> 73 pass,
   3 fail: exactly the three parameterised L2 leak tests. **Reverted,
   zero-line diff, 76/76.**

7. **L4 static O(1)-per-record guard**: inserted an inert `void
   fs.existsSync` inside `parseLedgerContent`. 15 -> 14 pass, 1 fail: the
   L4 check (extracts each function body, greps for `fs.`), confirming it
   scopes correctly and does not false-positive on the file's CLI-layer
   usage. **Reverted, zero-line diff, 15/15.**

8. **L6 rootIndex label fallback** (`optimise-cycle.js`):
   `(d.repoLabels && typeof entry.rootIndex === 'number' &&
   d.repoLabels[entry.rootIndex]) || entry.root` -> bare
   `d.repoLabels[entry.rootIndex]`. 63 -> 62 pass, 1 fail: the repaired
   fallback test (fixture now omits `rootIndex`; the pre-repair fixture
   always supplied `rootIndex:0` and never exercised the `||` branch --
   vacuous-to-real conversion, verified). **Reverted, zero-line diff,
   63/63.**

9. **`spec` re-exposed to free-text redaction** (`ledger-append.mjs`,
   central structural fix): `FREE_TEXT_FIELDS = TRUNCATABLE_FIELDS.filter((f)
   => f !== 'spec')` -> `TRUNCATABLE_FIELDS`, reinstating C1/H1/H2's root
   mistake. 121 -> 120 pass, 1 fail: **only** the H3 PWD symlink test; both
   H1 tests and both H2 tests stayed GREEN. **Explanation, confirmed by
   re-tracing:** `ABSOLUTE_PATH_RE` was independently narrowed back to
   main's prefix form this round, so it is now harmless over a relative
   spec with a paren/space/non-ASCII segment -- H1/H2 are satisfied by that
   narrowing alone, defence in depth. Only an absolute spec (H3) still
   distinguishes the two fixes: **the FREE_TEXT_FIELDS split has thinner
   coverage than its design prominence suggests, one H3 test stands behind
   it.** Flagged, not silently trusted. **Reverted, zero-line diff,
   121/121. Full suite re-confirmed 398/398.**

## Round 4 probes (H3, second half)

Fix: `root`/`cwdRoot` are already real (git rev-parse and `process.cwd()`
resolve symlinks), so their own realpath forms (round 3's `realpathOrNull`)
never mattered -- deleted, confirmed dead by round-3 probes 2/3. The real
gap was the SPEC side: for an absolute spec, `main()` resolves the real
form of the spec's own DIRECTORY only (basename untouched) and matches
THAT, falling back to the lexical spec if the directory does not resolve.
`canonicalPlanKey` stays pure.

RED confirmed first: reverting to round 3's candidate list (one-line diff)
failed the new subdirectory test with `plan_key: '<redacted-path>'`, the
coordinator's exact reproduction.

1. **Neutralise the fix** (`specForMatching = payload.spec` unconditionally):
   123 -> 122 pass, 1 fail -- exactly the ancestor-symlink-from-subdirectory
   test; the case-e test stayed green. **Reverted, zero-line diff, 123/123.**

2. **Realpath the WHOLE spec, not just its directory**: 123 -> 121 pass,
   2 fail -- the new case-e test AND the pre-existing AC-DATA-3 case-e test
   (ledger-append.test.js:1766), nothing else; confirms the dirname-only
   distinction is genuinely load-bearing. **Reverted, zero-line diff,
   123/123. Full suite re-confirmed 400/400.**

No regression: the space/paren probe (`../specs/a.md` -> `specs/a.md`,
`../specs/b.md` -> `specs/b.md`, distinct, no leak) and the C1 four-events
probe (4 lines, 4 distinct `event_key`s, none `duplicate`) both re-run
matching round-3 exactly.

## Not separately mutation-proven

- **AC-SEC-3's whole-output zero-leak CLI test** and **`aggregateRework`'s
  unattributable-exclusion**: unchanged from round 1/2 (see proofs 5/10).
- **AC-DATA-17 (durability doc)**: a static-checks test, not a behavioural
  mutation guard -- proven RED (missing prose) before GREEN (README
  updated), per §1.
