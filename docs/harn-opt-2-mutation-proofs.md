# HARN-OPT-2 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour
was actually broken (edited in the working file, not "mentally mutated"),
the suite was run, the exact failing test and message recorded, then the
file was restored (`cp` from a pre-mutation snapshot, never `git checkout
--`, which reverts to the last commit and can destroy uncommitted work),
confirmed via `diff <working-file> <snapshot>` returning nothing before the
next mutation. Full suite: `node --test test/*.test.js`. AC-SIMP-10 caps
this file at 200 lines; later rounds compress earlier ones, never drop them.

## PR1 (plan-identity canonicalisation), condensed to fit the cap

Merged as PR #3 (squash d6ada19) after 5 fix rounds / 4 review rounds. Full
history lived here across those rounds; condensed now that PR1 is closed,
per this file's own stated policy.

Root cause chased across rounds 3-5: write-time REDACTION (as opposed to
canonicalisation) is inherently lossy and must never be what gets written to
an append-only, unbacked-up file. Round 3 stripped write-time redaction of
`spec` entirely (replaced with pure lexical root-matching); round 4 shipped
`fs.realpathSync` inside `main()` to recover a symlinked-ancestor case, which
the coordinator's own review caught as making plan identity
FILESYSTEM-STATE-DEPENDENT (a live regression) -- reverted whole in round 5,
which added spec_raw (verbatim, redaction-exempted only when the canonical
form IS the marker) and closed a conductor-event occurrence-canonicalisation
gap (AC-ARCH-6). All proofs below: mutation applied, suite run, exact
failure recorded, revert confirmed byte-identical via `diff`.

Load-bearing, confirmed by mutation (11 write-side + 7 round-5 + 2 more,
21 total): `..`-escape detection; repo-identity main-checkout-basename
fallback; unattributable-run exclusion in `aggregateWallClock`;
degraded-record exclusion in `planKeyForRecord`; ci_wait/human_wait bucket
key routing through `canonicalPlanKey`; the single-definition-site static
guard; zero-extra-git-subprocess guard; `perRepo[].root` non-identifying
label; AC-DATA-6 pre-PR1-line attribution; the H-A behavioural
ancestor-symlink-existence purity test (the ONLY one of two purity tests
that actually caught round 4's regression -- proven by a differential:
target-existence purity stayed green under the same mutation); H-B(a)
`.toLowerCase()` corruption of the plan key; H-B(b) unconditional
`spec_raw` (would have reopened the AC-SEC-1 leak); H-C occurrence
canonicalisation and its cwd-resolution sub-case; `planKeyForRecord`'s
stored-plan_key re-canonicalisation branch (optimise-read.mjs:163).

Verified non-vacuous, no fix needed: AC-QA-13 order-independence
(`keys.find` mutated to `keys[0]`, both tests failed cleanly); the
spec-exclusion FREE_TEXT_FIELDS guard (5 tests failed, not reliant on the
regex alone). Final suite: 405/405.

## PR2 (start/terminal pairing), this round

Scope: (1) an exception escaping `run()` in tdd-task.js/review-cycle.js/
plan-cycle.js must still produce a terminal ledger write (AC-QA-8, AC-OPS-1);
(2) the terminal-only orphan class (a failed START write) handled as its own
case; (3) the aggregator counts and names the two orphan classes SEPARATELY
(AC-OPS-2); (4) AC-DATA-10 pairing purity (exactly one started + one
terminal, never fewer/more/wrong-shaped). Full suite: 422/422 (RED counts
below are each mutation's own run, not the baseline).

1. **AC-ARCH-9 byte-identity, exception-guard block** (static-checks.test.js):
   mutated plan-cycle.js's log-line text inside the guard block only.
   21 -> 20 pass, 1 fail (the new PR2 byte-identity test, exact diff shown in
   the failure). **Reverted, `diff` against snapshot empty.**
2. **AC-ARCH-9/AC-QA-8/AC-OPS-1, the re-throw itself**: deleted
   `if (runError) throw runError` from review-cycle.js only. 3 tests failed
   simultaneously -- the static re-throw-pair guard AND both new AC-QA-8/
   AC-OPS-1 behavioural tests in review-cycle.test.js (proving the static
   guard and the behavioural tests are independent, not the same check
   twice). **Reverted, `diff` empty.**
3. **AC-QA-9 return-count pin**: added an unreachable `if (false) return {...}`
   inside tdd-task.js's `run()`. 21 -> 20 pass, 1 fail (the count guard,
   8 expected vs 9 actual). **Reverted, `diff` empty.**
4. **AC-DATA-10 pairing-purity gate**: reverted the new
   `pair.length === 2 && starts.length === 1 && terminals.length === 1`
   condition back to the original `pair.length < 2` (i.e. any 2-record pair
   is measured regardless of outcome shape). 85 -> 81 pass, 4 fail: both
   fabricated-duration reproductions (two started 1h apart; two terminal),
   the three-or-more-records case, and the malformed-pairing/AC-OPS-2
   boundary test. The genuine-pair test stayed green (confirms the mutation
   only widens what counts as measured, doesn't break the real case).
   **Reverted, `diff` empty.**
5. **AC-OPS-2 start-only counter**: gated the start-only branch with
   `if (false && ...)`. 85 -> 83 pass, 2 fail: the direct start-only unit
   test AND the live-9-record-ledger CLI test (startOnly=4 no longer
   reported). The terminal-only counter test and the malformed-pairing test
   both stayed green -- confirms the two counters are independently wired,
   not one flag driving both. **Reverted, `diff` empty.**
6. **AC-QA-10 seam, terminal run_id reuse**: in tdd-task.js, changed
   `if (startRunId) terminalEntry.run_id = startRunId` to `if (false) ...`.
   The new real-writer-to-real-writer seam test in ledger-seam.test.js
   failed (two lines written with two DIFFERENT run_ids instead of one
   shared one) -- the pre-existing fake-agent-response seam tests stayed
   green (they hand-script the run_id reuse rather than exercising the
   real writer for both halves, which is exactly why AC-QA-10 asked for a
   real end-to-end proof beyond them). **Reverted, `diff` empty.**
7. **AC-DATA-9, SIGKILL test non-vacuity**: not a code mutation (there is no
   guard to mutate -- the invariant is the OS's, not this codebase's).
   Proven non-vacuous instead by a standalone script performing the same
   real start+terminal writes WITHOUT sending SIGKILL: confirmed 2 real
   lines land (vs. the test's own assertion of exactly 1 when the process
   IS killed mid-flight), so the test's `lines.length === 1` assertion is
   not trivially true regardless of the kill.

8. **AC-QA-9, run_id reuse on EVERY return path (a strengthening of a
   pre-existing gap)**: the pre-existing per-case tests only counted ledger
   calls, never checked the terminal write actually requested the start's
   run_id (both used the same static `LEDGER_OK` object for both calls, so
   equal run_ids proved nothing). Strengthened to distinct start/terminal
   run_ids per case, then in tdd-task.js changed
   `if (startRunId) terminalEntry.run_id = startRunId` to `if (false) ...`.
   23 -> 20 pass, 3 fail: the strengthened parametrized test failed on its
   FIRST case (test-writer-agent-fails, an ABORTED path), proving the single
   shared line covers every return path, not just the DONE path the old
   dedicated pairing test exercised. **Reverted, `diff` empty.**

## Runtime unwind fact-check (AC-ARCH-9/AC-QA-8 dependency, flagged unproven
at planning by lens-architecture)

- **Agent-step throw**: CONFIRMED to unwind through `try/catch` -- this is
  ordinary JS async/await semantics (an `await`ed rejected promise throws at
  the call site) and is directly exercised by every new AC-QA-8/AC-OPS-1
  test above, which all pass.
- **Budget exhaustion**: UNVERIFIED. Whether the production runtime enforces
  a budget cutoff by throwing inside an `agent()` call (same class as an
  agent throw, and therefore caught) or by externally terminating the
  script (same class as a kill, and therefore NOT caught by any JS-level
  construct) is not observable from this repo or its tests. Not assumed
  either way.
- **Process kill (SIGKILL/forced termination)**: CONFIRMED to NOT unwind --
  no JS-level `try`/`catch`/`finally` runs once the OS terminates the
  process. This is exactly why AC-DATA-9's guarantee rests on
  ledger-append.mjs's append-only, single-syscall-per-write durability
  (proven by the real-process SIGKILL test above), never on the try/catch
  added for AC-QA-8.
