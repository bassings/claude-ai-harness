# HARN-OPT-2 PR1 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour
was actually broken (edited in the working file, not "mentally mutated"),
the suite was run, the exact failing test and message recorded, then the
file was restored and the suite re-run green. Restoration used `cp` from a
snapshot taken before any mutation began (`git checkout --` reverts to the
last commit, destroying uncommitted work sitting on top of it), and every
restore was confirmed with `diff <working-file> <snapshot>` returning
nothing before the next mutation. Full suite: `node --test test/*.test.js`,
355/355 as of round 2 below, re-run three consecutive times clean after the
final restore. AC-SIMP-10 caps this file at 200 lines (Section 11 evidence
otherwise belongs in the PR body); kept concise accordingly.

**Round 2** (coordinator finding against the real live ledger): `perRepo[].root`
was still the raw caller-supplied path verbatim -- 1 match each for
`/Volumes/` and `whoami`, unchanged by round 1, whose own AC-SEC-3 fixture
used each test's own temp-repo path as root (never reliably home-like).
Also rendered downstream: `optimise-cycle.js:717`'s `entry.root` fallback in
the persisted report/synthesis prompt. Fixed by deriving a non-identifying
label (the root's own recorded repo identity, else a bare basename).

Eleven proofs executed, one per load-bearing guard. All eleven caught the
mutation on the first fixture — no vacuous or incidentally-passing guard.
Proof 9 records a real near-miss: the first implementation of AC-ARCH-3's
worktree-root resolution used a `git rev-parse --show-toplevel` subprocess,
which regressed AC-QA-20 (no additional git subprocess per write) by one
call on every write, not just worktree writes. Caught by writing AC-QA-20's
own guard before trusting the implementation, not by a review round.

## 1. `canonicalPlanKey`'s `..`-escape detection (AC-SEC-1 case d) — `ledger-append.mjs`

**Guards**: a relative spec whose `..` segments lexically resolve outside
the repo root (e.g. `../../../home/<user>/.ssh/config`) canonicalises to the
fixed marker — the leak ABSOLUTE_PATH_RE cannot catch (no leading slash).
**Mutation**: `if (segments.length === 0) return REDACTED_PATH_MARKER`
(inside the `..` branch) → `if (false) return REDACTED_PATH_MARKER`.
**Result**: `ledger-append: a relative spec containing ".." that resolves
OUTSIDE the repo root is redacted...` failed — `the traversal path must
never reach the ledger verbatim` (the hostile string appeared in the line).
96/97 other tests stayed green. **Reverted**, confirmed byte-identical,
97/97 green.

## 2. Worktree-root pre-pass gate (AC-DATA-1, AC-ARCH-3) — `ledger-append.mjs`

**Guards**: an absolute spec authored inside a linked worktree is
relativised against the WORKTREE's own root before the main-checkout-only
redaction pass runs, landing as a real repo-relative value, not the marker.
**Mutation**: `if (cwdRoot && cwdRoot !== root) {` → `if (false && cwdRoot
&& cwdRoot !== root) {`. **Result**: `an absolute spec path authored INSIDE
a worktree is recorded repo-relative...` failed — `spec` was
`<redacted-path>` instead of `specs/a.md`. **Reverted**, confirmed
byte-identical, 97/97 green.

## 3. Repo-identity fallback uses the main-checkout basename (AC-DATA-2) — `ledger-append.mjs`

**Guards**: a remoteless repo's identity fallback uses the basename of the
already-resolved MAIN checkout root, so a worktree write agrees with the
main checkout — closing the split where a fresh `git rev-parse
--show-toplevel` from a worktree returned its own throwaway directory name.
**Mutation**: `if (mainRoot) return path.basename(mainRoot)` → `if (false)
return path.basename(mainRoot)`. **Result**: `writing from inside a REAL
worktree with no origin remote records the SAME repo identity...` failed —
the main checkout recorded `repo-<hash>`, the worktree recorded
`ledger-append-identity-wt-<random>`, two identities for one repo.
**Reverted**, confirmed byte-identical, 97/97 green.

## 4. Raw `spec` field override for a relative escape (AC-SEC-1 case d, field half) — `ledger-append.mjs`

**Guards**: independent of proof 1 (which guards the *canonical key*), the
raw retained `spec` field is ALSO overwritten with the marker on a relative
escape — otherwise the hostile string still reaches the ledger verbatim in
`spec` even with a correct `plan_key`, since `plan_key` is additive, not a
replacement. **Mutation**: the override block (`if (typeof payload.spec ===
'string' && planKey === REDACTED_PATH_MARKER && payload.spec !==
REDACTED_PATH_MARKER) { payload.spec = REDACTED_PATH_MARKER }`) deleted,
leaving only `payload.plan_key = planKey`. **Result**: the same case-d test
as proof 1 failed again, this time because `entry.spec` (not `plan_key`)
retained the raw traversal string — confirming the two guards are
independently load-bearing; deleting either alone breaks the test.
**Reverted**, confirmed byte-identical, 97/97 green.

## 5. Unattributable-run exclusion in `aggregateWallClock` (AC-DATA-7, AC-OPS-5) — `optimise-read.mjs`

**Guards**: a run whose canonical plan key is the out-of-repo marker is
excluded from `byPlan` and counted under `unattributableRuns` instead — two
DIFFERENT out-of-repo specs must never merge into one fake shared bucket.
**Mutation**: `if (plan === REDACTED_PATH_MARKER) { unattributableRuns +=
1; continue }` → `if (false) { ... }`. **Result**: `aggregateWallClock
never presents two DIFFERENT out-of-repo specs as one merged plan...`
failed — `byPlan.size` was 1 (merged under the marker) instead of 0, and
`unattributableRuns` was 0 instead of 2. 58/59 other tests stayed green.
**Reverted**, confirmed byte-identical, 59/59 green.

## 6. Degraded-record exclusion in `planKeyForRecord` (AC-QA-7) — `optimise-read.mjs`

**Guards**: a `degraded: true` record (collapsed to the minimal envelope,
per `ledger-append.mjs`'s MAX_LINE_BYTES last resort) carries no
spec/plan_key and must never be silently folded into the no-spec bucket —
counted separately under `degradedUnattributedRuns`. **Mutation**: `if
(!record || record.degraded) return null` → `if (!record) return null`.
**Result**: `aggregateWallClock excludes a fully-degraded pair...` failed —
`byPlan.size` was 1 (landed in the no-spec bucket) instead of 0.
**Reverted**, confirmed byte-identical, 59/59 green.

## 7. `ci_wait`/`human_wait` bucket key also routes through `canonicalPlanKey` (AC-ARCH-4) — `optimise-read.mjs`

Added after noticing AC-ARCH-4's claim ("its `ci_wait`/`human_wait` bucket
key... route through it") had no test proving the `ci_wait` half — only
`agent_compute`'s collapsing was tested. A guard nobody has watched fail is
not done: a fixture was written first (absolute-form and relative-form
`event_key` for the same plan, asserted to collapse into one bucket),
confirmed green against the already-implemented code, then proven
load-bearing. **Guards**: `planKeyFromEventKey`'s raw plan-file segment is
canonicalised before use, so absolute and relative `event_key` forms for the
same plan collapse into one bucket, matching `agent_compute`'s treatment of
`spec`. **Mutation**: `const plan = canonicalPlanKey(rawPlan, root)` →
`const plan = rawPlan`. **Result**: `aggregateWallClock canonicalises the
ci_wait event_key plan segment too...` failed — `byPlan.size` was 2 (forms
stayed separate) instead of 1. **Reverted**, confirmed byte-identical, 60/60
green (this proof's own test raised the file's count from 59 to 60).

## 8. Single-definition-site static guard for `canonicalPlanKey` (AC-ARCH-1) — `test/static-checks.test.js`

Mirrors the pre-existing `LEDGER_ENTRY_SCHEMA` single-definition-site test.
**Guards**: no second `canonicalPlanKey` implementation is ever added
alongside the shared one in `ledger-append.mjs`. **Mutation**: appended a
second, throwaway `function canonicalPlanKey(x) { return x }` to the end of
`optimise-read.mjs` (a plausible way a future drift could re-introduce the
split PR1 exists to close). **Result**: the new static test failed —
`definitionSites` listed both files instead of one. **Reverted**: `cp` from
snapshot, confirmed byte-identical, suite back to 350/350 (this proof's own
static test is what raised the count from 349 to 350).

## 9. Worktree-root resolution costs zero additional git subprocesses (AC-QA-20) — `ledger-append.mjs`

**Guards**: resolving the current working tree's own root (needed for
AC-ARCH-3's worktree relativisation) never adds a git subprocess call beyond
the pre-PR1 baseline (measured directly: 4 calls for an ordinary write with
an origin remote configured -- show-superproject-working-tree,
git-common-dir, remote get-url origin, check-ignore). **Mutation**:
`resolveWorkingTreeRoot`'s fs-only stat walk replaced with the original
implementation attempt, `git(['rev-parse', '--show-toplevel'], cwd)`.
**Result**: both new PATH-shim-counting tests failed — 5 invocations instead
of 4 for an ordinary write, confirming a real regression this proof exists
to prevent, not a hypothetical one. **Reverted**: `cp` from a snapshot taken
immediately before this specific mutation, confirmed byte-identical, suite
back to 353/353 (this proof's own two new tests raised the count from 351
to 353).

## 10. `perRepo[].root` derives a non-identifying label, never the raw path (AC-SEC-3 round 2) — `optimise-read.mjs`

**Guards**: `perRepo[].root` carries the analysed root's own repo identity
(from its own ledger records) or a bare basename, never the raw absolute
path -- proven against a fixture root deliberately nested under a path
containing both a literal `home` segment and the real `whoami` output (a
bare temp-repo path cannot exercise this: on most machines it contains
neither). **Mutation**: `const label = derivePerRepoLabel(records, root)`
left in place but unused (`void label`); `perRepo.push({ root, ... })`
reverted to pushing the raw `root` verbatim. **Result**: 3 tests failed for
the right reason — the recursive whole-JSON walk (`$.perRepo[0].root` named
explicitly, all three of `/Volumes/`, `/home/` and `whoami` matched), the
broadened AC-SEC-3 CLI test, and round-3 F5's basename-lookup assertion.
**Reverted**, confirmed byte-identical, 354/354 green.

## 11. AC-DATA-6: a pre-PR1-shaped line (no `plan_key`) still attributes via `spec` — `optimise-read.mjs`

**Guards**: a ledger mixing hand-seeded pre-PR1-shaped lines (no `plan_key`,
`schema_version: 1`) with genuine post-PR1 writer output for the IDENTICAL
plan collapses to ONE bucket, with every record counted. **Mutation**:
`planKeyForRecord`'s fallback, `return canonicalPlanKey(record.spec, root)`,
replaced with `return NO_SPEC_PLAN_KEY` (pretending a plan_key-less record
can never be attributed via its retained `spec`). **Result**: 7 tests
failed, including the new AC-DATA-6 test (`byPlan` held 2 buckets, not 1)
and five pre-existing AC-ARCH-4/AC-DATA-7/AC-QA-7 tests — confirming the
fallback path is broadly load-bearing, not just for this one fixture.
**Reverted**, confirmed byte-identical, 355/355 green.

This proof also caught a genuine fixture bug of my own first: the initial
draft hand-seeded pre-PR1 lines with `repo: 'demo'` while the real writer
resolved a DIFFERENT repo identity (the temp repo's own basename) for the
post-PR1 lines in the same file -- two `repo` values meant two bucket keys
regardless of `plan_key`, failing for the wrong reason. Fixed by deriving
`repoIdentity` from `path.basename(repo)`, matching the real writer.

## Not separately mutation-proven

- **AC-SEC-3's whole-output zero-leak CLI test** (real 9-record ledger
  reproduction): an end-to-end assertion over the combined effect of proofs
  1–6, not a single guard with one clean on/off edit — any one of those six
  mutations breaks it too. Not re-proven separately to avoid duplicating the
  same six results under an eighth heading.
- **`aggregateRework`'s unattributable-exclusion** (proof 5's counterpart
  for `acVerdicts`): structurally identical to proof 5 (same
  `planKey === REDACTED_PATH_MARKER` branch, same `unattributableCount`
  pattern, sibling function) and covered by its own dedicated test
  (`aggregateRework excludes an out-of-repo spec from acVerdicts...`), but
  not independently mutated given the structural identity to proof 5 and
  this round's time budget. Flagged here, not silently omitted.
