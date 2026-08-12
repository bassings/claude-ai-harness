# HARN-OPT-2 PR1 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour
was actually broken (edited in the working file, not "mentally mutated"),
the suite was run, the exact failing test and message recorded, then the
file was `cp`-restored from a pre-mutation snapshot (never `git checkout
--`, which reverts to the last commit and can destroy uncommitted work),
confirmed via `diff <working-file> <snapshot>` returning nothing before the
next mutation. Full suite: `node --test test/*.test.js`. AC-SIMP-10 caps
this file at 200 lines; later rounds compress earlier ones, never drop them.

**Round 2**: `perRepo[].root` was still the raw caller-supplied path
verbatim. Fixed by deriving a non-identifying label (proof 10).

**Round 3**: BLOCKED on CRITICAL C1 (four distinct conductor events
collapsed to one line). Root cause: write-time regex redaction applied to a
STRUCTURED path value. Decision: strip write-time redaction of `spec`
entirely (the ledger is gitignored, local-only -- AC-SEC-1; AC-SEC-3
governs the OUTPUT boundary only), replaced with pure lexical root-matching.
**Supersedes proofs 2 and 4**, corrected in place.

**Round 4 (SHIPPED, then REVERTED by round 5)**: added `fs.realpathSync
.native(path.dirname(spec))` in `main()` to recover a spec reached through
a symlinked ancestor. Coordinator's own review found this made plan
identity FILESYSTEM-STATE-dependent (the identical spec string recorded the
marker before a symlink existed and the real key after one was created at
the same path) -- a fresh violation of AC-ARCH-3/AC-DATA-3/AC-SEC-2, despite
satisfying the letter of "canonicalPlanKey stays pure" (the call sat in
`main()`, not inside it). **Entirely reverted in round 5**; see round 5
below. This is why round 5 adds BEHAVIOURAL (not function-body-grep) purity
guards -- a static check scoped to `canonicalPlanKey` could never have
caught a violation living in a different function.

**Round 5 (current tip)**: three High findings. **H-A**: reverts round 4 (above).
**H-B**: AC-DATA-4's recoverability test was vacuous (re-derived from a
field that already WAS the canonical key; proven by an invisible
`.toLowerCase()` mutation). Fixed with a new `spec_raw` field -- the
caller's original string, retained verbatim, EXCLUDED when the canonical
form is the redaction marker (retaining a hostile out-of-repo/escaping
value there would defeat AC-SEC-1's own protection through a side door).
**H-C** (AC-ARCH-6): an event_scope's plan segment is now canonicalised
(resolved against cwd when relative, exactly like `spec`) before minting
the occurrence suffix, closing a C1 remnant where an absolute event_scope
lost every occurrence after the first via the free-text pass further down.
Suite: 405/405 (ledger-append.test.js 127, optimise-read.test.js 77,
optimise-cycle.test.js 63, optimise-static.test.js 15, static-checks.test.js
18, 105 elsewhere).

## Round 1/2 proofs (1-11), condensed

1. **`..`-escape detection** (AC-SEC-1 case d): `if (segments.length === 0)
   return REDACTED_PATH_MARKER` -> `if (false) ...`. **Reverted, current.**

2. **CORRECTED (was stale)**: `spec` no longer goes through the worktree
   pre-pass gate at all; it uses `specRootCandidates` inside
   `canonicalPlanKey` (round-3 probe 9). Not re-mutated separately.

3. **Repo-identity fallback uses the main-checkout basename** (AC-DATA-2):
   `if (mainRoot) return path.basename(mainRoot)` -> `if (false) ...`.
   **Reverted, current.**

4. **CORRECTED AGAIN (round 5)**: `specWasOverwritten` now ALSO gates
   `spec_raw` (`if (planKey !== REDACTED_PATH_MARKER) payload.spec_raw =
   specRawInput`) -- see round 5 probe H-B(b) below for its own proof.

5. **Unattributable-run exclusion, `aggregateWallClock`** (AC-DATA-7):
   optimise-read.mjs:475. **Reverted, current.**

6. **Degraded-record exclusion, `planKeyForRecord`** (AC-QA-7):
   optimise-read.mjs:155. **Reverted, current.**

7. **`ci_wait`/`human_wait` bucket key routes through `canonicalPlanKey`**
   (AC-ARCH-4): optimise-read.mjs:357. **Reverted, current.**

8. **Single-definition-site static guard** (AC-ARCH-1). **Reverted, current.**

9. **Worktree-root resolution costs zero extra git subprocesses** (AC-QA-20).
   **Reverted, current.**

10. **`perRepo[].root` derives a non-identifying label** (AC-SEC-3 round 2).
    **Reverted, current.**

11. **AC-DATA-6: a pre-PR1-shaped line still attributes via `spec`**.
    **Reverted, current.**

## Round 3 probes (nine total; unchanged this round, condensed)

1. **C1**: reintroduced the destructive event_key regex. 2 targeted fails
   (C1 repro, L2-reversion). **Reverted.**
2/3. **Realpath vs. PWD root candidates**: differential pair proving PWD
   (not realpathOrNull) carried round 3's narrower H3 fix. **Superseded by
   round 4/5** (realpathOrNull deleted for good in round 4; the real gap is
   now closed properly by round 5, see below). **Reverted.**
4. **Bucket-key escaping** (`escapeKeyComponent` -> `String(s)`): 2 targeted
   fails. **Reverted.**
5. **Exclusion-counter report line** hardcoded to 0: 1 targeted fail
   (repaired M3 test; the PRE-repair version would have passed). **Reverted.**
6. **Raw stdin parse-error leaks**, all 3 CLI commands: 3 targeted fails.
   **Reverted.**
7. **L4 static O(1)-per-record guard**: inert `fs.existsSync` reference
   trips it. **Reverted.**
8. **L6 rootIndex label fallback**: 1 targeted fail (vacuous-to-real
   conversion, verified). **Reverted.**
9. **`spec` re-exposed to free-text redaction**: only the H3 PWD test
   failed (H1/H2 satisfied independently by the narrowed regex --
   defence in depth, thinner coverage than design prominence suggests).
   **Reverted.**

## Round 5 probes (H-A, H-B, H-C -- seven total)

RED confirmed first for H-A: reverting to round 4's candidate-matching
(one-line diff) reproduced the coordinator's exact repro,
`plan_key: '<redacted-path>'`, on a new ancestor-symlink-from-subdirectory
fixture, before H-A's revert was applied.

1. **H-A, round 4 fully reinstated**: round 4's exact removed dirname-realpath
   block re-inserted verbatim (a genuine 8-line re-add, confirmed via `diff`).
   127 -> 125 pass, 2 fail: the "H-A pinned" marker test (recorded the real
   key again, not the marker) AND the ancestor-symlink-existence purity test
   (probe 3 below). The target-existence purity test (probe 2) stayed
   GREEN -- neither run in that fixture ever involves a symlink, so
   round 4's mutation cannot diverge it; confirms probe 2 and probe 3 guard
   genuinely different axes, not the same one twice. **Reverted, zero-line
   diff, 127/127.**
2. **H-A behavioural purity, target existence**: `runAppend` twice with the
   IDENTICAL absolute spec, target file absent then present. Passes
   unconditionally under CURRENT code (lexical matching never touches the
   fs) and, per probe 1, is NOT what catches round 4's mutation -- kept as a
   documented, correct invariant, not claimed as this round's load-bearing
   guard.
3. **H-A behavioural purity, ancestor-symlink existence**: `runAppend` twice
   with the IDENTICAL spec string reached through a symlink path, symlink
   absent then created between runs. **This is the test that actually
   caught probe 1's mutation** (before=`<redacted-path>`,
   after=`specs/a.md` under round 4's code -- diverging, exactly the
   defect this round exists to keep dead).
4. **H-B(a), `.toLowerCase()` corruption**: `segments.join('/')` ->
   `segments.join('/').toLowerCase()`. 127 -> 125 pass, 2 fail: the M1
   verbatim-preservation test AND the rewritten AC-DATA-4 test (which the
   ORIGINAL version of this test did NOT catch -- confirmed separately
   before the rewrite). **Reverted, zero-line diff, 127/127.**
5. **H-B(b), spec_raw redaction-exemption**: `if (planKey !==
   REDACTED_PATH_MARKER) payload.spec_raw = ...` -> unconditional. 127 -> 125
   pass, 2 fail: the AC-SEC-1 case-c and case-d tests (a hostile path would
   have reached the ledger via spec_raw). **Reverted, zero-line diff,
   127/127.**
6. **H-C, occurrence canonicalisation**: `canonicalScope = canonicalPlanKey
   (...) + restOfScope` -> raw `payload.event_scope`. 127 -> 124 pass, 3
   fail: the escaping-marker test, the legitimate-subdirectory test, and the
   NEW two-absolute-scope AC-ARCH-6 test (`duplicate: true` on the second
   write -- the coordinator's exact measured symptom). C1's own test stayed
   green (independent coverage). **Reverted, zero-line diff, 127/127.**
7. **H-C, cwd-resolution for relative plan segments** (a gap found and
   fixed DURING this round, not present in the brief): the relative-segment
   `path.resolve(cwd, ...)` step disabled. 127 -> 126 pass, 1 fail: only the
   legitimate-subdirectory test -- C1's own test stayed green even here,
   confirming it alone would NOT have caught this gap. **Reverted,
   zero-line diff, 127/127.**

Also mutation-proven (optimise-read.mjs line 163, AC-SEC-3 medium):
`planKeyForRecord`'s stored-plan_key branch trusted verbatim instead of
re-canonicalising -- 3 fails (2 pre-existing M1 tests + the new hostile
-plan_key test). **Reverted, zero-line diff, 77/77.**

Verified non-vacuous, no fix needed (AC-QA-13 medium): the order-independence
`keys.find(...)` logic mutated to `keys[0]` -- both AC-QA-13 tests fail
cleanly. Already solid.

Verified non-vacuous, no fix needed (spec-exclusion coverage note): `spec`
re-added to `FREE_TEXT_FIELDS` (leaving only `spec_raw` excluded) -- 5 tests
fail, including the AC-DATA-1/AC-ARCH-3 worktree test. Genuine, multi-test
coverage, not reliant on the narrowed regex alone.

## Not separately mutation-proven

- **AC-SEC-3's whole-output zero-leak CLI test**, **`aggregateRework`'s
  unattributable-exclusion**: unchanged, see proofs 5/10.
- **AC-DATA-17 (durability doc)**: static-checks test, proven RED before
  GREEN, per §1.
- **AC-DATA-3 (ledger-append.mjs, cwd-resolution comment)**: closed by
  documentation clarification at the call site (why using `cwd` there is
  consistent with "lexical, never realpath-based") -- no code change, no
  behavioural mutation applicable.
