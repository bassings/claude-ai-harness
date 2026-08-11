# PR2 mutation proofs

Per AC-QA-3 and standard §11: for the guards below, the guarded behaviour was
actually broken (edited in the working file, not "mentally mutated"), the
suite was run, the exact failing test and message recorded, and the file was
then restored and the suite re-run green. Every mutation's application was
confirmed with `git diff` (or `git diff --stat`) before running tests, and
every revert was confirmed with `git status --porcelain` returning nothing
before moving to the next mutation, following PR1's own recorded near-miss:
`git checkout --` reverts to the last COMMIT, not "a moment ago", so the
working tree was kept clean (mutation, test, revert, confirm clean) between
each proof rather than stacking uncommitted mutations.

Eighteen proofs were executed in the initial build. Sixteen caught the
mutation on the first fixture; one (proof 7, `citationPool`'s dedup check)
**survived** its original fixture -- a genuine vacuous-mutant find,
investigated and fixed before being trusted, recorded in full below rather
than quietly patched. A further thirteen proofs were executed after review
round-1 (see "Review round-1 fixes" below), covering each of the eight
findings. A further fifteen proofs were executed after review round-2 (see
"Review round-2 fixes" below); two of them (the L2 totals-line/Filtering-
line proofs) surfaced a SECOND genuine vacuous-mutant pair, also
investigated and fixed before being trusted. The full suite was
`node --test test/*.test.js`, 307/307 as of
the last commit in this worktree, re-run clean after every proof.

## 1. `parseLedgerContent` skips a line missing a required envelope field — `workflows/lib/optimise-read.mjs`

**Guarded behaviour**: AC-QA-16 — a ledger line missing `schema_version`,
`run_id`, `ts`, `repo` or `kind` is skipped, counted, and reported with a
reason naming the missing field(s); a line with all envelope fields present
(regardless of extra unknown ones) is kept.

**Mutation**: `const missing = ENVELOPE_REQUIRED.filter(...)` replaced with
`const missing = []`, so no line could ever be judged to be missing a
required field.

**Result**: 2 tests failed for the right reason —

- `optimise-read: parseLedgerContent tolerates a truncated final line, blank lines, unknown extra fields, a missing required field, an unknown kind, older/newer schema_version, and a 30KB unicode field...`
  — `AssertionError: expected 6 usable records, got 7` (the line missing
  `kind` was wrongly kept)
- `optimise-read: parseLedgerContent counts a line missing run_id, ts or repo as skipped...`
  — `AssertionError: Expected values to be strictly equal: 3 !== 0` (zero
  skips instead of three)

**Reverted**: restored from a `cp` backup taken before the edit (this
mutation predated the decision to rely on `git checkout --` exclusively, so
a `cp`-restore was used, then confirmed byte-identical to the committed
version); `optimise-read.test.js` back to 27/27 green.

## 2. `windowRecords` keeps the most recent records, not the first — `workflows/lib/optimise-read.mjs`

**Guarded behaviour**: AC-ARCH-14 — when a ledger exceeds the window, the
**most recent** records are kept (a run's own append order is chronological,
so this is "kept" = "recent"), not the oldest.

**Mutation**: `records.slice(droppedCount)` (tail slice) changed to
`records.slice(0, maxLines)` (head slice).

**Result**: 1 test failed for the right reason —

- `optimise-read: windowRecords keeps only the most recent maxLines records...`
  — `AssertionError: Expected values to be strictly equal: 0 !== 500` (the
  windowed set's first element's `__seq` was 0, the oldest record, instead
  of 500, the correct start of the most-recent 2000)

**Reverted**: `git checkout -- workflows/lib/optimise-read.mjs`; confirmed
clean via `git status --porcelain`; 27/27 green.

## 3. AC verdicts keyed by (repo, spec, ac_id), not by ac_id alone — `workflows/lib/optimise-read.mjs` `aggregateRework`

**Guarded behaviour**: AC-DATA-7 — the same `ac_id` in two different specs
(or under two different repos) is tracked as two distinct criteria, never
merged into one by AC id text alone.

**Mutation**: the composite key
`` `${r.repo}|${r.spec}|${v.ac_id}` `` replaced with the bare `v.ac_id`.

**Result**: 1 test failed for the right reason —

- `optimise-read: aggregateRework produces byte-identical, hand-computable counts from a known fixture, keyed by (repo, spec, ac_id) not by AC id alone (AC-DATA-7)`
  — `AssertionError: Expected values to be strictly deep-equal: + undefined
  - { ac_id: 'AC-QA-1', ... }` (the test's lookup at the correct composite
  key found nothing, because every AC-QA-1 verdict across both specs had
  collapsed onto the single bare-`ac_id` key)

**Reverted**: `git checkout --`; confirmed clean; 27/27 green.

## 4. `neverFailingAcs` respects the minimum-runs floor — `workflows/lib/optimise-read.mjs`

**Guarded behaviour**: AC-DATA-8 — a (repo, spec, ac_id) pair with fewer
than `minRuns` recorded verdicts is `insufficient_data: true`, never
proposed as a removal candidate regardless of whether every recorded
verdict happens to be PASS.

**Mutation**: `const insufficient_data = entry.n < minRuns` replaced with
`const insufficient_data = false`.

**Result**: 1 test failed for the right reason —

- `optimise-read: neverFailingAcs labels a below-minimum (spec,ac) pair insufficient_data...`
  — `AssertionError: Expected values to be strictly equal: false !== true`
  (the n=2 fixture, below the minRuns=5 floor, was no longer flagged)

**Reverted**: `git checkout --`; confirmed clean; 27/27 green.

## 5. Negative/out-of-order wait intervals are never counted as valid — `workflows/lib/optimise-read.mjs` `aggregateWallClock`

**Guarded behaviour**: AC-QA-10 — an `ended` timestamp before its `started`
timestamp is reported as an unusable interval with a reason, never averaged
into `ciWaitSeconds`/`humanWaitSeconds`, never defaulted to zero silently.

**Mutation**: `if (!(durationS >= 0)) { ... }` (the guard that diverts a
negative duration into `unusableIntervals`) changed to `if (false) { ... }`.

**Result**: 1 test failed for the right reason —

- `optimise-read: aggregateWallClock reports a negative/out-of-order interval as unusable with a reason, never averaged, defaulted to zero, or silently dropped (AC-QA-10)`
  — `AssertionError: a negative interval must not be counted toward the
  valid-duration total: 1 !== 0` (the negative interval was counted as one
  valid `ci_wait`)

**Reverted**: `git checkout --`; confirmed clean; 27/27 green.

## 6. CI job `truncated` flag reflects whether the fetch hit its own limit — `workflows/lib/optimise-read.mjs` `aggregateCi`

**Guarded behaviour**: AC-DATA-8 — when the number of runs returned equals
the requested `gh` fetch limit, the true history may extend further back
than what was read; `truncated: true` records that honestly.

**Mutation**: `truncated: requestedLimit !== null && n >= requestedLimit`
replaced with `truncated: false`.

**Result**: 1 test failed for the right reason —

- `optimise-read: aggregateCi sets truncated:true when the returned run count equals the requested limit...`
  — `AssertionError: Expected values to be strictly equal: false !== true`

**Reverted**: `git checkout --`; confirmed clean; 27/27 green.

## 7. `citationPool` deduplication — a self-caught vacuous mutant

**Guarded behaviour**: AC-QA-20 / AC-DATA-10 — the citation pool contains
no duplicate id, so a proposal's citation always resolves unambiguously.

**First mutation attempt**: the dedup condition
`if (typeof id === 'string' && id && !seen.has(id))` had its `!seen.has(id)`
clause removed.

**First result: the mutation SURVIVED.** All 27 `optimise-read.test.js`
tests stayed green. Investigation (per §11 — check the mutation actually
applied and exercises what it claims to, don't trust one green run): the
mutation itself was confirmed applied via `git diff`, so the code change was
real; the fixture was the problem. The original fixture appended exactly
**one** trailing duplicate (`run_id: 'run-0'` re-appended once, after 60
distinct ids), and `citationPool`'s size-50 cap meant the backward scan
never revisited the earlier occurrence of `run-0` within that window — so a
broken dedup check produced an output byte-identical to the correct one for
this specific fixture. This is exactly the class of failure §11 names: a
fixture "shaped to sit away from the real threshold" and passing green
while the guard is vacuous, the same shape as PR1's own M2 byte-truncation
near-miss.

**Fix**: strengthened the fixture (`test/optimise-read.test.js`) to append
20 duplicate occurrences of the same id, landing well inside the scan
window, so a broken dedup check is forced to fill a large fraction of the
50-slot pool with repeats — a difference the `new Set(pool).size === 50`
assertion can actually observe.

**Re-run against the SAME mutation, with the strengthened fixture**: caught
—

- `optimise-read: citationPool is deduplicated, most-recent-first, capped at the stated size, and contains only real run_ids present in the window`
  — `AssertionError: no duplicates: 30 !== 50` (only 30 distinct ids
  survived the 50-slot pool once duplicates were allowed to fill it)

**Reverted**: `git checkout --`; confirmed clean; 27/27 green with the
strengthened fixture kept in the suite (committed separately, see
`35ef3f8`).

## 8. `countEscapedDefectCandidates` matches only at the START of a commit subject — `workflows/lib/optimise-read.mjs`

**Guarded behaviour**: AC-PROD-7 — a commit subject merely *mentioning*
"fix:" in prose (e.g. a docs commit describing the convention) must not be
counted; only a subject that actually **uses** the conventional-commit
`fix:` type, at the start, counts.

**Mutation**: `const FIX_COMMIT_RE = /^fix(\([^)]*\))?:/i` had its `^`
anchor removed: `/fix(\([^)]*\))?:/i`.

**Result**: 1 test failed for the right reason —

- `optimise-read: countEscapedDefectCandidates counts commit subjects matching the conventional "fix:" type deterministically...`
  — `AssertionError: Expected values to be strictly equal: 3 !== 2` (the
  fixture's `"docs: mention fix: in prose, must not match mid-string"` line
  was wrongly counted as a third match)

**Reverted**: `git checkout --`; confirmed clean; 27/27 green.

## 9. The workflow's mechanical citation filter (AC-QA-20) — `workflows/optimise-cycle.js`

**Guarded behaviour**: a proposal without a citation resolving to a real id
in either citation pool is dropped, in script code, regardless of what the
drafting agent wrote.

**Mutation**: the filter line
`proposals = proposals.filter((p) => Array.isArray(p.citations) && p.citations.some((c) => allCitations.has(c)))`
replaced with `proposals = proposals // MUTATION: citation filter disabled`.

**Result**: exactly 2 tests failed, both and only the ones that exercise
this gate —

- `optimise-cycle: a proposal citing an id not present in either citation pool is dropped mechanically; one citing a real id survives`
- `optimise-cycle: a proposal with an empty citations array is dropped`

Every other test in the file (18 of 20) stayed green, confirming the filter
is exactly what those two tests detect and nothing else depends on it
incidentally.

**Reverted**: `git checkout --`; confirmed clean; 20/20 green.

## 10. The insufficient-ledger mechanical backstop (AC-QA-17) — `workflows/optimise-cycle.js`

**Guarded behaviour**: below the minimum ledger sample size, any proposal
whose only valid citations are ledger ids (no `gh` citation) is dropped,
regardless of what the drafting agent wrote — "zero harness-side proposals"
holds even against a synthesis step that ignored the insufficiency notice.

**Mutation**: `if (!ledgerSufficient) { ... }` changed to `if (false) { ... }`.

**Result**: 3 of the 4 fixtures targeting this path failed for the right
reason —

- `optimise-cycle: ledger n=1 (below the minimum of 5) suppresses harness-side...` — the ledger-cited proposal survived when it should not have
- `optimise-cycle: ledger n=4 (below the minimum of 5) suppresses harness-side...` — same
- `optimise-cycle: insufficient-ledger backstop holds even if the drafting agent ignores the notice...` — same

The n=0 fixture did **not** fail under this mutation: at n=0 its
`citationPool` is deliberately empty, so proof 9's generic citation filter
(a separate, independently-proven gate) already excludes the same proposal
on its own. This is legitimate defence in depth, not a gap in this proof —
confirmed by the fact that the two OTHER n>0 fixtures, whose citation pools
are non-empty, could only be caught by this specific backstop and were.

**Reverted**: `git checkout --`; confirmed clean; 20/20 green.

## 11. The always-on security-lens removal gate (AC-SEC-10 first clause) — `workflows/optimise-cycle.js`

**Guarded behaviour**: a proposal to remove `lens-security` or `lens-qa`
from the always-on roster is dropped unconditionally, in script code, no
matter how well-cited or well-evidenced it is.

**Mutation**: `isAlwaysOnSecurityRemoval`'s body replaced with `return false`.

**Result**: exactly 3 tests failed —

- `optimise-cycle: a proposal to remove lens-security from the always-on roster is dropped unconditionally...`
- `optimise-cycle: a proposal to remove lens-qa is likewise dropped unconditionally`
- `optimise-cycle: an injection payload inside a gh job name reaches the synthesis prompt strictly inside an UNTRUSTED-DATA block, and even a "fooled" drafting agent that obeys it produces no lens-security-removal proposal in the final result (AC-SEC-8 canary)`

The third result is the important one: it confirms the AC-SEC-8 canary
test's real protection comes from THIS mechanical gate, not merely from the
prompt's delimiter framing (which a real, successfully-injected model could
in principle ignore) — with the gate disabled, the canary's "fooled agent"
fixture's forbidden proposal now ships.

**Reverted**: `git checkout --`; confirmed clean; 20/20 green.

## 12. Reinstatement-evidence requirement on every removal proposal (AC-PROD-7 / AC-SEC-10 second clause) — `workflows/optimise-cycle.js`

**Guarded behaviour**: any proposal that deletes, demotes or skips
something (security-purposed or not) must carry non-empty
`reinstatement_evidence`, or it is dropped.

**Mutation**: `hasReinstatementEvidence`'s body replaced with `return true`.

**Result**: exactly 2 tests failed —

- `optimise-cycle: a security-purposed check removal with NO reinstatement evidence is dropped (AC-PROD-7)`
- `optimise-cycle: a NON-security removal proposal with no reinstatement evidence is also dropped (AC-PROD-7 applies to every delete/demote/skip, not only security ones)`

confirming the requirement is enforced for removal proposals generally, not
only security-flagged ones.

**Reverted**: `git checkout --`; confirmed clean; 20/20 green.

## 13. Sample-size labelling excludes below-minimum proposals from the ranked list (AC-SIMP-10) — `workflows/optimise-cycle.js`

**Guarded behaviour**: a surviving proposal with `n` below
`MIN_RECORDS_FOR_PROPOSALS` is excluded from `ranked` and reported
separately as `insufficient_data`, never silently hidden or ranked
alongside well-evidenced ones.

**Mutation**: `if (typeof p.n === 'number' && p.n >= MIN_RECORDS_FOR_PROPOSALS) ranked.push(p)`
changed to `if (true) ranked.push(p)`.

**Result**: exactly 1 test failed —

- `optimise-cycle: a proposal with n below the minimum is excluded from the ranked list and reported separately as insufficient_data, not silently dropped`

**Reverted**: `git checkout --`; confirmed clean; 20/20 green.

## 14. No repo resolved -> no lane calls (early-exit guard) — `workflows/optimise-cycle.js`

**Guarded behaviour**: when scope resolves zero repos, the workflow returns
immediately with the unresolved reasons and never fans out to the three
lanes (no wasted `gh`/git/ledger reads against nothing).

**Mutation**: `if (!scope || !scope.resolved.length) { ... }` changed to
`if (false) { ... }`.

**Result**: 1 test failed for the right reason —

- `optimise-cycle: no repo resolves -> returns early with the unresolved reasons and makes no lane calls`
  — `AssertionError: The expression evaluated to a falsy value: assert.ok(!calls.some((c) => c.opts.phase === 'Lanes'))`
  (the Lanes phase ran anyway, against zero resolved repos)

**Reverted**: `git checkout --`; confirmed clean; 20/20 green.

## 15. AC-SEC-9's mechanical no-write grep, proven against a real write call — `test/optimise-static.test.js`

**Guarded behaviour**: `workflows/lib/optimise-read.mjs` contains no
filesystem write call of any kind (AC-SEC-9) — enforced by a grep for named
write functions, not left to code review alone.

**Mutation (on the GUARDED file, to prove the TEST detects a real
violation)**: appended a genuine `fs.writeFileSync('/tmp/should-never-happen', 'x')`
call to the end of `optimise-read.mjs`.

**Result**: 1 test failed for the right reason —

- `static: workflows/lib/optimise-read.mjs contains no filesystem WRITE call anywhere...`
  — `AssertionError: optimise-read.mjs must not call fs.writeFileSync -- it is a read-only aggregator`

**Reverted**: `git checkout --`; confirmed clean; suite green.

## 16. AC-SEC-9's mutating-verb-near-negation check, proven against a real un-prohibited instruction — `test/optimise-static.test.js`

**Guarded behaviour**: any mention of a mutating git/gh verb inside
`workflows/optimise-cycle.js`'s prompt text sits within a clear prohibition
("do not"/"never"), never as a bare instruction to actually run it.

**Mutation (on the GUARDED file)**: inserted
`` `After writing, also run git commit -am 'auto' for good measure. `` `` as
a prefix onto the `report:write` prompt — a real, un-negated instruction to
mutate.

**Result**: 1 test failed for the right reason —

- `static: workflows/optimise-cycle.js instructs no mutating git or gh command outside an explicit prohibition...`
  — `AssertionError: mention of "git commit" at offset 22964 is not clearly
  wrapped in a prohibition: ...` (quoting the injected sentence back)

**Reverted**: `git checkout --`; confirmed clean; suite green.

## 17. `wrapAsData`'s UNTRUSTED-DATA delimiter is what the canary test actually checks — `workflows/optimise-cycle.js`

**Guarded behaviour**: AC-SEC-8 — every untrusted-text block reaching an
agent prompt is wrapped in an explicit `<UNTRUSTED-DATA>` tag pair, which is
the structural containment the canary test's "delimited" assertion checks
for.

**Mutation**: `wrapAsData`'s
`` `<UNTRUSTED-DATA label="${label}">\n${text}\n</UNTRUSTED-DATA>\n` ``
replaced with a bare `` `${text}\n` ``, removing the delimiter entirely
(this function is shared by every call site in the file, not just the
canary's).

**Result**: 2 tests failed —

- `optimise-cycle: an injection payload inside a gh job name reaches the synthesis prompt strictly inside an UNTRUSTED-DATA block...`
  — `AssertionError: the canary text must sit strictly inside an UNTRUSTED-DATA block, not as free prose in the prompt` (the structural check itself, the direct target of this mutation)
- `optimise-cycle: happy path returns ranked proposals, writes the report, and reports ledger sufficiency`
  — `AssertionError: Expected values to be strictly equal: null !== 'id-0'`
  (collateral: the test's own `idsResponder` helper parses proposal targets
  out of the `<UNTRUSTED-DATA label="proposal-targets">` block that
  `wrapAsData` also builds, so removing the delimiter broke id assignment
  too — an honest, expected side effect of mutating a function used at
  every untrusted-data call site in the file, not a second independent
  finding)

**Reverted**: `git checkout --`; confirmed clean; 20/20 green.

## 18. `stableProposalId` is derived from the target, not a constant — `workflows/lib/optimise-read.mjs`

**Guarded behaviour**: AC-DATA-10 — two calls with different targets yield
different ids; two calls with the same target yield the same id.

**Mutation**: `JSON.stringify(target, Object.keys(target).sort())` replaced
with `JSON.stringify({})` (the target argument ignored entirely).

**Result**: 2 tests failed —

- `optimise-read: stableProposalId is derived from the target descriptor, not wording...`
  — `AssertionError: Expected "actual" to be strictly unequal to: '44136fa355b3678a'` (two DIFFERENT targets now hashed to the same id)
- `optimise-read CLI: node optimise-read.mjs ids reads a batch of proposal targets from stdin and returns a stable id per target, in order`
  — collateral failure from the same root cause (two different targets
  batched through the CLI both got the same id)

**Reverted**: `git checkout --`; confirmed clean; 27/27 green.

## Review round-1 fixes (proofs 19-31)

A full multi-lens review (1 High, 6 Medium, 1 Low; 7 failing ACs, 8
findings) found that five of the eight failures traced to the wall-clock
decomposition -- the spec's headline deliverable. Every finding below was
fixed, not rejected; every mutation was applied to the working file,
confirmed with `git diff`/`git diff --stat`, and reverted with
`git checkout --`, confirmed clean via `git status --porcelain` before the
next mutation. Full detail and reasoning is in the fix commit's own
message (`f246420`); this section is the proof ledger's continuation.

**19-20. H1 -- `buildReport` renders nothing, and the return omits the
aggregates, two separate mutations.** (a) `wall_clock:
ledgerAgg ? ledgerAgg.wallClock : null` in the return statement replaced
with a comment (field dropped entirely). The H1 fixture test failed with
`AssertionError: return must include wall_clock` (`actual: undefined`).
(b) The wall-clock section's `if (d.wallClock)` guard changed to
`if (false && d.wallClock)`, so the section header printed but its body
never did. The same test failed with `AssertionError: report must include
"unterminated"`. Both reverted; `optimise-cycle.test.js` back to 34/34
(H1's own test exercises seven separate needles across four rendered
sections plus two return-shape assertions in one fixture, so either
mutation alone was sufficient to fail it -- confirming the test is not
narrowly coupled to one specific line).

**21. M1 -- the check-ignore verification in `optimise-report-ignore.mjs`.**
The `execFileSync('git', ['check-ignore', ...])` call and its `catch`
branch deleted outright, so `ensureIgnored` always reported `ignored:true`
regardless of whether the path was actually ignored. Caught by exactly the
negation-pattern test (`optimise-report-ignore.test.js`): `AssertionError:
a negation pattern in a tracked .gitignore must be detected, not silently
reported as success: true !== false`. The other four tests in the file
stayed green (they never construct a negation-pattern fixture), confirming
this is the one guard that specific mutation removes. Reverted; 5/5 green.

**22-23. M2 -- the widened verb regex and the structured-target keying,
proven as two INDEPENDENT layers.** (a) `REMOVAL_VERBS_RE` reverted to the
pre-fix narrow list (no move/retire/etc). Caught 2 of 5 M2 tests --
specifically the two whose target carries no `lens` field (the
"Move the gitleaks scan..." and "Retire the never-failing gitleaks
job..." CI-job cases) -- while the three lens-targeted tests stayed green,
because `isAlwaysOnSecurityRemoval`'s structured `target.lens` check
(unaffected by this mutation) caught those independently. This is the
intended defence-in-depth shape, not a partial proof: it demonstrates the
two layers are genuinely independent, not that one is redundant. (b) The
structured `target.lens` check itself (`if (target && SECURITY_LENS_NAMES
.includes(target.lens)) return true`) disabled via `if (false && ...)`.
Caught exactly 1 test -- the one deliberately written with NO removal verb
anywhere in the statement (`"lens-security should not run on every
review"`) -- while the two "Move"/"Retire" tests stayed green, because
their STATEMENT text also happens to satisfy the widened verb-regex
fallback path. Both reverted; `optimise-cycle.test.js` back to 34/34.

**24. M3 -- the null-timestamp guard in `aggregateWallClock`'s wait-pairing
loop.** `if (startMs === null || endMs === null) { ... }` disabled via
`if (false && (...))`. Caught the STARTED-side test only (`ciWaitN`
became 1 instead of 0, reproducing the review's exact "~56-year garbage
duration" scenario: `null` coerces to `0` in `endMs - startMs`, i.e. epoch
1970, so the resulting duration is enormous and positive, evading the
pre-existing negative-duration check entirely). The ENDED-side test
stayed green, because a null `endMs` makes the subtraction NEGATIVE
(`0 - startMs`), which the pre-existing negative-duration guard already
catches -- confirming the null-guard is uniquely load-bearing specifically
for the STARTED-null case, the exact asymmetry the review's evidence
described. Reverted; `optimise-read.test.js` back to 43/43.

**25. M4 -- the unmeasured-segment mechanical gate in `optimise-cycle.js`.**
`isUnmeasuredSegmentMotivated`'s body replaced with `return false`. Caught
exactly the dedicated M4 test (`AssertionError: 1 !== 0` -- the
agent-compute-motivated proposal, whose segment has 4 unmeasured runs,
shipped anyway); the "does not over-block" sibling test stayed green.
Reverted; 34/34.

**26. M5 -- `planBucketKey` dropping the repo component.** ``return
`${repo}|${plan}` `` replaced with `return plan`. Caught the dedicated M5
test (`AssertionError: 1 !== 2` -- two repos' distinct 60s/600s ci_waits
merged into one bucket) AND five other wall-clock tests that assert
against the `demo|specs/a.md` composite key specifically -- expected,
pervasive collateral (this function computes the map key for literally
every wall-clock bucket in every test), not a vacuous result: it confirms
the composite key is exercised everywhere, not just in the one fixture
built to probe it. Reverted; `optimise-read.test.js` back to 43/43.

**27-28. M6 -- the truncated-nulls-the-claim rule and the renameSuspect
flag, separately.** (a) `neverFailed: truncated ? null : rawNeverFailed`
reverted to `neverFailed: rawNeverFailed` (dropping the truncated check).
Caught exactly the PROBE2 fixture test (100/100 successful runs at the
fetch limit wrongly claimed `neverFailed:true`). (b) `if
(entry.renameSuspect) entry.neverFailed = null` replaced with a comment.
Caught exactly the PROBE3 fixture test (the renamed job's clean-looking
own history wrongly claimed `neverFailed:true`). Both reverted;
`optimise-read.test.js` back to 43/43 after each.

**29. M6 -- the workflow-level weak-CI-evidence gate.**
`isWeakCiEvidenceRemoval`'s body replaced with `return false`. Caught
exactly the dedicated M6 workflow test (a removal proposal citing a
`truncated:true` CI job shipped instead of being dropped); the
"does not over-block" sibling test (a solid, non-truncated never-failed
claim) stayed green. Reverted; `optimise-cycle.test.js` back to 34/34.

**30. M7 -- `revertedTwiceOrMore`'s threshold in `aggregateProposalOutcomes`.**
`bucket.reverted.length >= 2` replaced with the constant `false`. Caught
exactly the dedicated aggregator test (`AssertionError`: the two-revert
fixture's flag came back `false` instead of `true`); the adjacent
last-rejection-timestamp assertion in the same test file was unaffected,
confirming the mutation is scoped to the one field it changed. Reverted;
`optimise-read.test.js` back to 43/43.

**31. M7 -- the workflow-level annotation step, `annotateProposalOutcome`.**
Body replaced with `return p` (a no-op pass-through). Caught exactly the
two dedicated M7 workflow tests (the prior-rejection annotation and the
reverted-twice flag both silently disappeared); the "no recorded outcome
events -> stays clean" sibling test was unaffected (it asserts absence,
which a no-op trivially still satisfies -- confirming that test alone
would NOT have caught this mutation, which is why the other two exist).
Reverted; `optimise-cycle.test.js` back to 34/34.

Every mutation above was confirmed applied via `git diff`/`git diff --stat`
before running tests, confirmed reverted via `git status --porcelain`
returning nothing before the next mutation, and the full suite re-run
clean after the batch -- 292/292 as of the last commit in this round.

## Review round-2 fixes (proofs 32-46)

A follow-up multi-lens review found no AC failures, but 3 Mediums and 6
Lows, all real. The coordinator's framing for M1 mattered: it was the
THIRD wall-clock pairing symptom across two rounds (round 1: null-
timestamp fabrication, cross-repo merge; round 2: sorted-index mispairing
of an orphan ended event) -- a §12 signal to reframe rather than patch
again, so that proof documents the REWRITE, not one more instance-fix.

**32. M1 -- `occurrenceKeyFromEventKey` disabled entirely (returns null
unconditionally).** Every event falls back to the "malformed/unpaired"
branch. Caught 7 tests -- every wall-clock pairing test in the suite,
including all three round-1 regression tests (null-ts, negative-interval,
cross-repo) and the two new round-2 fixtures -- confirming the function is
the SINGLE point every pairing path now depends on, exactly the "make the
whole class unrepresentable" goal. Reverted; `optimise-read.test.js` back
to 48/48.

**33. M1 -- the orphan-ended branch (`else if (!s && e)`) silently
dropped, uncounted -- the OLD bug's exact shape, reproduced as a
mutation.** Caught exactly the two dedicated round-2 M1 tests (the
reviewer's PROBE1 reproduction, and the "orphan never mispairs with an
unrelated event" test); every other wall-clock test, including the
established round-1 regressions, stayed green -- confirming this specific
branch is what the two new tests exist to guard, independent of the rest
of the pairing rewrite. Reverted; `optimise-read.test.js` back to 48/48.

**34. M2 -- `canonicalJson` reverted to the original top-level-only
replacer array (the reviewer's exact reproduced bug).** Caught exactly the
dedicated nested-collision test (`AssertionError`: two distinct targets
collided again); the key-order-stability and same-target-twice tests
stayed green (they don't exercise nesting). Reverted;
`optimise-read.test.js` back to 48/48.

**35. M3 -- `wrapAsData`'s tag reverted to the bare, un-nonced
`UNTRUSTED-DATA` form.** Caught 7 tests -- every test that parses a
nonce-tagged block, including the round-1 canary, the new round-2 breakout
canary, both L5 wrap tests, and (as expected collateral) the two M7
annotation tests whose `synthesis:ids` responder locates its payload via
the same nonce-tagged pattern. This breadth confirms the nonce is now the
single mechanism every containment boundary in the file depends on, not
just the two tests specifically named for M3. Reverted;
`optimise-cycle.test.js` back to 38/38.

**36. M3 -- the missing-nonce abort guard (`if (!scope.nonce ...)`)
disabled.** Caught exactly the dedicated defensive-path test (a
schema-bypassed scope response with no nonce field); every other test
supplies a real nonce via `scopeFixture()` and was unaffected. Reverted;
`optimise-cycle.test.js` back to 38/38.

**37-38. L5 -- the ledger-lane and ci-lane wrapping, each reverted to a
bare `JSON.stringify` interpolation separately.** Each mutation caught
exactly its own dedicated wrap-test (the ledger-lane roots test for the
first, the ci-lane {root,label} test for the second) and nothing else,
confirming the two wraps are independent, not one incidentally covering
the other. Both reverted; `optimise-cycle.test.js` back to 38/38 after each.

**39-40. L2 -- the wall-clock totals line and the Filtering line's
segment-detail rendering, a self-caught vacuous-mutant PAIR.** First
attempt: removing the totals line's per-segment counts left the existing
M4 test (`/agent_compute[^\n]*\b4\b/i`) green, because the Filtering
line's own detail incidentally satisfied the same loose regex --
investigated per §11, not trusted on a single green run. Fixed in both
directions: (a) a NEW dedicated test, using a fixture where no proposal
drop occurs at all (so the Filtering line carries no detail to
incidentally satisfy anything), proves the totals line's own
`unmeasured n=N` phrasing; (b) the original M4 test's assertion was
tightened to the Filtering line's OWN distinct phrasing
(`agent_compute (4 unmeasured runs)`), textually impossible to satisfy
from the totals line's different wording. Re-mutated both independently
afterward: disabling the totals-line rendering now fails ONLY the new
dedicated test; disabling the Filtering-line detail now fails ONLY the
original M4 test -- confirmed genuinely separate, independently
load-bearing guards. Both reverted; `optimise-cycle.test.js` back to
44/44 after each.

**41-42. L3 -- the `reportWriteError` derivation, and the case where the
report:write agent call itself returns nothing.** (a) The three-line
derivation (`let reportWriteError = null; if (!reportWrite) ...`) removed
entirely, replaced with the bare declaration. Caught exactly the two
dedicated L3 tests (the named-error-reason test and the undefined-response
test); the "succeeds" test (asserting `null`) stayed green, since the
mutated code ALSO always yields `null` -- confirming the two failing tests
are what actually prove the derivation exists, not the trivially-true
success case. Reverted; `optimise-cycle.test.js` back to 43/43.

**43. L4 -- `ledgerLaneFailed` hardcoded to `false`.** Caught exactly the
dedicated lane-failure test; the "genuinely empty ledger does NOT trigger
the wording" test (asserting the ABSENCE of the phrase) stayed green,
since a hardcoded `false` trivially satisfies "must not say lane failed"
too -- confirming, symmetrically to proof 41-42, that only the
failure-case test actually proves this field is computed from `ledgerAgg`
rather than a constant. Reverted; `optimise-cycle.test.js` back to 44/44.

**L1, L6**: not separately mutation-proved as new guards. L1's fix was
entirely test-side (the underlying citation filter it now also exercises
was already proven load-bearing in round-1 proof 9); the strengthened
assertion in the "all four gh failure modes" test was confirmed to
exercise a real proposal (added a CI-cited proposal to the fixture) rather
than an empty one, which is itself the proof that it is no longer vacuous
-- there is no separate PRODUCTION guard to mutate. L6 is a regex
tightening on the TEST side of the M3 canary, not a change to any guarded
production behaviour; its own non-vacuity is demonstrated structurally
(anchored, non-greedy, backreferenced to the actual nonce) rather than by
a further mutation.

Every mutation above was confirmed applied via `git diff`/`git diff --stat`
before running tests, confirmed reverted via `git status --porcelain`
returning nothing before the next mutation, and the full suite re-run
clean after the batch -- 307/307 as of the last commit in this round.

### Spec bugs found at review round-2 (no AC behind them)

Per the harness's own convention (a review finding with no AC behind it is
a spec bug, logged because that list is how the harness improves): three
of round-2's findings traced to no acceptance criterion in
`specs/optimise-cycle.md` at all, meaning the planning lenses never
required these behaviours in the first place.

- **M1 (wall-clock pairing correctness under a lost event)** -- no AC
  required started/ended events to be paired by anything other than "the
  matching ones", which happened to hold for every planning-time fixture
  (always exactly one occurrence per plan). A future AC should require:
  "an orphan event on either side of a wait pair is never mispaired with
  an unrelated event, proven against a fixture with more ends than
  starts (or vice versa) within the SAME plan/repo bucket."
- **L3 (report-persistence failure surfacing)** -- AC-PROD-5 requires the
  report to be persisted, but no AC required a WRITE FAILURE's reason to
  reach the operator, the same gap AC-QA-7 already closed for the ledger
  write. A future AC should require: "a report:write failure surfaces its
  reason in the workflow return and is logged visibly in the same turn,
  mirroring AC-QA-7's ledger-write discipline."
- **L4 (lane-crash vs. empty-ledger distinction)** -- AC-OPS-11 requires
  distinguishing an uninstrumented REPO from no activity, but no AC
  required distinguishing a lane CRASH (the agent step itself failing)
  from a successfully-read, genuinely empty ledger -- a third state
  AC-OPS-11's own text does not name. A future AC should require: "a
  ledger-lane agent failure is reported distinctly from n=0, both in the
  report and in a machine-readable field."

## Guards NOT proven by an executed mutation, stated plainly rather than implied

- **AC-SEC-9's overall "never mutates" claim** was proven by REAL EXECUTION
  (sha256 and mtime identity of a real ledger file before and after a real
  `optimise-read.mjs ledger` CLI invocation against a real repo — see
  `optimise-read.test.js`'s two CLI tests, and the additional real
  multi-record invocation captured in this PR's final report), not by a
  code-mutation-and-revert cycle. Proofs 15-16 above mutation-test the two
  STATIC mechanical checks that back this claim structurally; the dynamic
  hash-identity proof is a different, complementary kind of evidence (an
  observed real-world invariant, not a broken-guard/watch-fail pair) and is
  not listed as a numbered mutation proof for that reason.
- **AC-ARCH-14's overall prompt-bound claim** is proven by composition of
  two already-proven bounds (proof 2's `windowRecords` truncation and proof
  7's `citationPool` cap) plus an integration-level test
  (`optimise-cycle.test.js`'s "stays bounded even when the ledger citation
  pool is at its max size" test measuring actual prompt string length). No
  separate mutation was executed at the workflow level for "the workflow
  embeds the full raw window into a prompt", because no code path in
  `optimise-cycle.js` ever holds a raw per-line ledger record at all (only
  the pre-aggregated JSON an agent step returns) — there is no existing
  behaviour to invert into that shape without inventing a new code path
  first, which would not be a mutation of anything real.
- **`neverFailingAcs`'s "does not mark never_failed with at least one FAIL"
  branch**, `aggregateCi`'s "insufficient_data below the minimum" branch,
  and `aggregateWallClock`'s "unterminated_waits" counting are exercised by
  dedicated tests in `optimise-read.test.js` but were not separately
  mutation-broken in this pass — proof 4 and proof 6 cover the SAME
  functions' adjacent branches, and the marginal risk of the untested
  branches is judged low (simple boolean/arithmetic logic directly adjacent
  to already-proven code in the same function). Listed here rather than
  silently omitted, per the standard's own instruction to say plainly what
  was not verified.
- **The report markdown's rendering** was mutation-tested for its wall-clock
  section (proofs 19-20, since round-1's H1 finding was precisely that this
  section existed but never rendered) and is exercised indirectly elsewhere
  by tests asserting specific substrings appear (gh failure modes, the
  flagged-category marker, cadence wording in the skill), but the Rework /
  Never-failing-AC / Trigger-accuracy sections' own rendering was not
  separately mutation-broken — they are pure string formatting with no
  guard-shaped behaviour to invert beyond "is this section present at all",
  which H1's own fix already had to prove for the wall-clock case.
- **`workflows/lib/optimise-report-ignore.mjs`'s existence as a narrowly-
  scoped, deliberate exception to `optimise-read.mjs`'s absolute read-only
  guarantee** is a design decision stated in that file's own header comment
  and in this PR's final report, not itself a "guard" with a proof of its
  own beyond proofs 21 (its check-ignore verification, mutation-tested) and
  its five real-git integration tests (`optimise-report-ignore.test.js`,
  the same real-repo style AC-SEC-1 uses for the ledger).
- **The real, end-to-end `/optimise-cycle` invocation through an actual
  Claude Code agent runtime** was not performed in this session: this
  worktree has no access to the live dynamic-workflow runtime, only
  `test/helpers/fake-runtime.js`'s approximation of it (the same limitation
  PR1's own L1 finding recorded about its own fake-runtime coverage). Every
  proof above exercises real Node code (`optimise-read.mjs`) or the
  workflow's orchestration logic through the fake runtime; none of them
  proves a REAL agent will follow the `optimise-read.mjs`-location search
  order, the base64-free JSON piping instructions, or resist a prompt
  injection in practice. The mechanical gates (proofs 9-14) are the
  intended backstop for exactly this gap: even a real agent that mis-follows
  an instruction cannot ship a forbidden proposal, because the script code
  re-checks it afterward regardless.
