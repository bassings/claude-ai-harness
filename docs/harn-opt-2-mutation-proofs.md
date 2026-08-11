# HARN-OPT-2 PR1 mutation proofs

Per AC-QA-22 and standard §11: for each guard below, the guarded behaviour
was actually broken (edited in the working file, not "mentally mutated"),
the suite was run, the exact failing test and message recorded, then the
file was restored and the suite re-run green. Restoration used `cp` from a
snapshot taken before any mutation began (`git checkout --` reverts to the
last commit, destroying uncommitted work sitting on top of it), and every
restore was confirmed with `diff <working-file> <snapshot>` returning
nothing before the next mutation. Full suite: `node --test test/*.test.js`,
350/350 (this count already includes proofs 7 and 8's own new tests),
re-run three consecutive times clean after the final restore. AC-SIMP-10
caps this file at 200 lines (Section 11 evidence otherwise belongs in the
PR body); kept concise accordingly.

Eight proofs executed, one per load-bearing guard. All eight caught the
mutation on the first fixture — no vacuous or incidentally-passing guard.

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
