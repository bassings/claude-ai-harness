# HARN-OPT-2 PR1 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour
was actually broken (edited in the working file, not "mentally mutated"),
the suite was run, the exact failing test and message recorded, then the
file was restored and the suite re-run green. Restoration used `cp` from a
snapshot taken before any mutation began (`git checkout --` reverts to the
last commit, destroying uncommitted work sitting on top of it), and every
restore was confirmed with `diff <working-file> <snapshot>` returning
nothing before the next mutation. Full suite: `node --test test/*.test.js`.
AC-SIMP-10 caps this file at 200 lines; kept concise accordingly, so round 3
below compresses round 1/2's proofs rather than dropping them.

**Round 2**: `perRepo[].root` was still the raw caller-supplied path
verbatim. Fixed by deriving a non-identifying label (proof 10 below).

**Round 3** (current tip; BLOCKED verdict on CRITICAL C1: four distinct
conductor events collapsed to one ledger line). Root cause: write-time
regex redaction applied to a STRUCTURED path value (`spec`/`event_key`),
not free text. Decision: strip write-time redaction of `spec` entirely (the
ledger is gitignored, local-only -- AC-SEC-1 -- so there is no privacy
requirement to redact data INSIDE it; AC-SEC-3 governs the report/prompt
OUTPUT boundary only), replaced with pure lexical root-matching in
`canonicalPlanKey`. **Supersedes proofs 2 and 4 below**, corrected in place
rather than deleted. Suite at this tip: 398/398 (ledger-append.test.js 121,
optimise-read.test.js 76, optimise-cycle.test.js 63, optimise-static.test.js
15, static-checks.test.js 18, 105 elsewhere untouched by this PR).

## Round 1/2 proofs (1-11), condensed

1. **`canonicalPlanKey`'s `..`-escape detection** (AC-SEC-1 case d):
   `if (segments.length === 0) return REDACTED_PATH_MARKER` -> `if (false)
   ...`. Still the live mechanism at ledger-append.mjs:539. Failed the
   traversal-redaction test (hostile string reached the line verbatim).
   Re-verified round 3 as an M1 direct unit test
   (`canonicalPlanKey('../../../home/some-user/.ssh/config', '/repo')`,
   see round-3 probe list). **Reverted, current.**

2. **CORRECTED (was stale)**. Originally described `spec` being relativised
   against a worktree's root via a pre-pass gate before general redaction --
   that pipeline no longer applies to `spec` (round 3 struck all regex-based
   redaction of it). The mutated line, `if (cwdRoot && cwdRoot !== root) {`
   at ledger-append.mjs:764, still exists but now guards only
   `task`/`round_key`/`event`/`event_key` via `relativiseAgainstRoot` --
   `spec` is handled by `specRootCandidates` inside `canonicalPlanKey`
   instead (round-3 probes 2-3). Not re-mutated separately: structurally
   identical to round-3 probe 9, same gate, same fields.

3. **Repo-identity fallback uses the main-checkout basename** (AC-DATA-2):
   `if (mainRoot) return path.basename(mainRoot)` -> `if (false) ...` at
   ledger-append.mjs:619. Unchanged this round. Failed the worktree/main
   identity-agreement test. **Reverted, current.**

4. **CORRECTED (was stale)**. Original mutation targeted a standalone
   `payload.spec = REDACTED_PATH_MARKER` override block that no longer
   exists. Current mechanism: `specWasOverwritten`
   (ledger-append.mjs:832-833) overwrites `payload.spec` with `planKey`
   (real key or marker) whenever `planKey !== NO_SPEC_PLAN_KEY`. Not
   independently re-mutated this round (a `specWasOverwritten` mutation is a
   different, less interesting failure mode than proof 4's original); flagged
   as needing its own round-4 proof if revisited, not marked passing.

5. **Unattributable-run exclusion in `aggregateWallClock`** (AC-DATA-7):
   `if (plan === REDACTED_PATH_MARKER) { unattributableRuns += 1; continue }`
   at optimise-read.mjs:475-478. Unchanged. **Reverted, current.**

6. **Degraded-record exclusion in `planKeyForRecord`** (AC-QA-7):
   `if (!record || record.degraded) return null` at optimise-read.mjs:155.
   Unchanged. **Reverted, current.**

7. **`ci_wait`/`human_wait` bucket key routes through `canonicalPlanKey`**
   (AC-ARCH-4): `const plan = canonicalPlanKey(rawPlan, root)` at
   optimise-read.mjs:357. Unchanged. **Reverted, current.**

8. **Single-definition-site static guard for `canonicalPlanKey`** (AC-ARCH-1):
   a second throwaway definition appended to optimise-read.mjs was caught
   by the static single-definition test. Unchanged. **Reverted, current.**

9. **Worktree-root resolution costs zero additional git subprocesses**
   (AC-QA-20): reverting `resolveWorkingTreeRoot`'s fs-only walk to a
   `git rev-parse --show-toplevel` call failed the PATH-shim call-count
   tests. Unchanged. **Reverted, current.**

10. **`perRepo[].root` derives a non-identifying label** (AC-SEC-3 round 2):
    `derivePerRepoLabel` left unused, raw `root` pushed instead, at
    optimise-read.mjs:789-823. Unchanged. **Reverted, current.**

11. **AC-DATA-6: a pre-PR1-shaped line still attributes via `spec`**:
    `planKeyForRecord`'s fallback replaced with `return NO_SPEC_PLAN_KEY` at
    optimise-read.mjs:164. Unchanged. **Reverted, current.**

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

2. **Realpath root candidates** (`ledger-append.mjs`): reduced
   `specRootCandidates` from `[cwdRoot, root, realpathOrNull(cwdRoot),
   realpathOrNull(root)]` to `[cwdRoot, root]`. **0 failures** -- the H3
   symlinked-worktree test passed regardless. Genuine coverage gap, not a
   false pass: see probe 3.

3. **PWD root candidate** (`ledger-append.mjs`), differential counterpart
   to probe 2: `if (fs.statSync(process.env.PWD).ino === fs.statSync(cwd).ino)
   specRootCandidates.push(process.env.PWD)` short-circuited to
   `if (false) ...`. 121 -> 120 pass, 1 fail: exactly the H3 PWD symlink
   test. **Conclusion: `process.env.PWD`, inode-matched against `cwd`, is
   the load-bearing mechanism for the symlinked-absolute-spec case; the two
   `realpathOrNull` entries in `specRootCandidates` are currently
   unexercised by any test in this suite** -- kept per the coordinator's
   explicit instruction to try them as candidates, but their coverage claim
   is honestly downgraded here rather than implied by proof 2 above.
   **Reverted, zero-line diff, 121/121.**

4. **Bucket-key escaping** (`optimise-read.mjs`): `escapeKeyComponent`
   reduced to `return String(s)` (the pre-M4 bare join). 76 -> 74 pass,
   2 fail: the `aggregateWallClock` and `aggregateRework` colliding-pair
   tests (`('demo','a|weird.md')` vs `('demo|a','weird.md')`). Two other
   tests sharing the "M4" label in their names (unmeasured-run and
   orphan-start counters) stayed green, confirming the mutation is scoped
   to escaping only. **Reverted, zero-line diff, 76/76.**

5. **Exclusion-counter report line** (`optimise-cycle.js`): the
   `unattributableWaits` render hardcoded from
   `` `observations=${wallTotalsForExclusions.unattributableWaits ?? 0}` ``
   to a literal `observations=0`. 63 -> 62 pass, 1 fail: the repaired M3
   test asserting the "Excluded from attribution" line's exact substring.
   The PRE-repair version of this test (a bare `/\b4\b/` scan over the
   whole report) would have passed under this exact mutation, since
   "AC-ARCH-4" appears elsewhere in the output -- confirming the repair is a
   real detection-power improvement, not cosmetic. **Reverted, zero-line
   diff, 63/63.**

6. **Raw stdin parse-error leaks, all three CLI commands**
   (`optimise-read.mjs`): `ci`/`escaped-defects`/`ids` reverted to
   `'stdin was not valid JSON: ' + e.message` (V8's raw SyntaxError, which
   embeds a snippet of the failing input). 76 -> 73 pass, 3 fail: exactly
   the three parameterised L2 leak tests, one per command, no collateral.
   **Reverted, zero-line diff, 76/76.**

7. **L4 static O(1)-per-record guard** (`optimise-static.test.js` against
   `optimise-read.mjs`): inserted an inert `void fs.existsSync` inside
   `parseLedgerContent`. 15 -> 14 pass, 1 fail: the L4 check, which extracts
   each named function's body between column-0 boundaries and greps for
   `fs.`. Confirms the extraction correctly scopes to the three target
   functions without false-positiving on the file's legitimate CLI-layer
   `fs` usage. **Reverted, zero-line diff, 15/15.**

8. **L6 rootIndex label fallback** (`optimise-cycle.js`): the label
   expression `(d.repoLabels && typeof entry.rootIndex === 'number' &&
   d.repoLabels[entry.rootIndex]) || entry.root` reduced to a bare
   `d.repoLabels[entry.rootIndex]`. 63 -> 62 pass, 1 fail: the repaired
   defensive-fallback test (fixture now omits `rootIndex`, where the
   pre-repair fixture always supplied `rootIndex:0` and so never exercised
   the `||` branch at all -- a vacuous test converted into a real one,
   verified by the mutation that originally exposed it). **Reverted,
   zero-line diff, 63/63.**

9. **`spec` re-exposed to free-text redaction** (`ledger-append.mjs`,
   central round-3 structural fix): `FREE_TEXT_FIELDS =
   TRUNCATABLE_FIELDS.filter((f) => f !== 'spec')` mutated to
   `TRUNCATABLE_FIELDS` (spec no longer excluded), reinstating C1/H1/H2's
   root architectural mistake. 121 -> 120 pass, 1 fail: **only** the H3 PWD
   symlink test. Both H1 tests (paren segment, non-ASCII segment) and both
   H2 tests (space in checkout path) stayed GREEN under this mutation.
   **Explanation, confirmed by re-tracing, not assumed:** `ABSOLUTE_PATH_RE`
   was independently narrowed back to main's whitespace/quote/paren-prefix
   form in this same round, so running it over a relative spec containing a
   paren, space or non-ASCII segment is now harmless -- H1/H2 are satisfied
   by that narrowing alone, defence in depth rather than redundant coverage.
   Only an absolute spec (H3's case, which the narrow regex still matches
   and would mis-relativise against `root` alone, bypassing the
   multi-candidate/PWD logic) distinguishes the two fixes. **The
   FREE_TEXT_FIELDS split has thinner coverage than its design prominence
   suggests: one H3 test stands behind it.** Flagged, not silently trusted.
   **Reverted, zero-line diff, 121/121. Full suite re-confirmed 398/398
   after all nine probes.**

## Not separately mutation-proven

- **AC-SEC-3's whole-output zero-leak CLI test** and **`aggregateRework`'s
  unattributable-exclusion**: unchanged from round 1/2 (see original
  reasoning, condensed above under proofs 5/10 and their neighbours).
- **AC-DATA-17 (durability doc)**: a static-checks test, not a mutation
  guard in the behavioural sense -- proven RED (missing prose) before
  GREEN (README updated), per §1, not independently mutated.
- **`realpathOrNull(cwdRoot)`/`realpathOrNull(root)`** (round-3 probe 2):
  explicitly left as an open, honestly-reported gap, not a false pass --
  see probe 3's conclusion.
