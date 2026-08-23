# HARN-FIX-3: make a stale or half-updated consumer install detectable

**Status:** agreed
**Lenses run:** none. **Skipped:** all, deliberately, see "Proportionality".

## Problem

Found 2026-08-23 by the `couchpotatoserver-a6` session, by hand, because nothing
in the harness emits a signal for it. Verified here against the filesystem
rather than relayed.

Twelve files in the consumer install at `~/.claude` were behind the published
repo: `AGENT-HARNESS.md`, all nine `agents/lens-*.md`, `workflows/plan-cycle.js`
and `workflows/review-cycle.js`. Detection required cloning the published repo
to a scratch directory and running `cmp` file by file. There is no cheaper
method: `~/.claude` is a git repo with **no remote**, so `git fetch` is not
available there, and no file carries a version or source-commit stamp.

**A partial update is worse than a fully stale one, and partial is the likely
failure mode**, because updating is a manual multi-file copy. The `Recurrence`
rollout spans three layers that must move together:

1. the FINDINGS template in `AGENT-HARNESS.md`
2. the instruction in each of the nine `agents/lens-*.md`
3. the `recurrence` property on the findings schema in **both**
   `workflows/plan-cycle.js` and `workflows/review-cycle.js`

Copy layers 1 and 2 without layer 3 and every lens is instructed to emit
`recurrence` while the schema silently drops it. That is the H3 defect already
recorded in comments in both workflow files, and `test/static-checks.test.js`
guards it, **in the repo**. The guard cannot see a consumer install, so H3 is
reproducible in the field with nothing to catch it.

This is the repo's own recurring shape: a check that lives where the problem is
not. Compare 2026-08-21, where deleting the entire `PreToolUse` registration
left all 743 tests green.

## Proportionality

No planning cycle was run. §13 says a change of this size does not get nine
lenses, and the criteria below are mechanical enough to write directly. This is
recorded rather than silent, per the rule that an empty lens section reads as
"considered and found nothing", which is a different claim from "not run".

## Not in scope

- **An install or update command.** The two trees legitimately differ: the
  install holds `CLAUDE.md`, `agents/implementer.md` and unrelated skills that
  the repo does not ship, and the repo ships `test/`, `specs/`, `docs/`,
  `.claude-plugin/` and `bin/` that the install does not have. A careless
  installer overwrites user-owned files. Deferred to its own spec.
- **Changing `~/.claude`'s git configuration.** Adding the published repo as a
  remote there is a footgun: a later `git pull` would merge a public repo into
  personal config. The drift check uses its own cache instead and never writes
  to `~/.claude`.
- **Auto-updating anything.** Both mechanisms report. Neither copies files.

## The two mechanisms, and why the split

| | Catches | Needs network | On failure |
|---|---|---|---|
| **Staleness check** | install behind published | yes | warn |
| **Consistency check** | install internally incoherent | no | refuse |

The failure behaviours differ deliberately. Being behind published main is not
necessarily broken, so refusing work over it would be noise, and a guard that
blocks harmless work gets switched off. An instructed-but-unsupported field
**is** broken and silently corrupts output, so it fails fast.

## Acceptance criteria

### Staleness check

- **AC-OPS-1:** The weekly runner (`bin/optimise-cycle-weekly.sh`) reports, once
  per invocation rather than once per repo, whether the consumer subset in
  `$CLAUDE_HOME` (default `~/.claude`) differs from published `main`. Test:
  a fixture install with one modified file produces exactly one drift report
  naming that file; an identical install reports no drift.
- **AC-OPS-2:** The check never writes to the install. Test: `shasum` every
  file under the fixture install before and after a run, including a run that
  reports drift; all unchanged, and no new file appears.
- **AC-OPS-3:** No network, an unreachable remote, or a `git` failure produces
  `could not check` naming the reason, exit 0, and does not fail the weekly run.
  Test: run with a remote URL pointing at a non-existent path.
- **AC-OPS-4:** The comparison covers exactly the consumer subset. **Amended
  2026-08-23 (round-one review HIGH-2)**: the original enumeration omitted
  `bin/` and `skills/conduct-plan/` entirely -- both are genuinely published
  and consumer-installed (`README.md`'s manual install copies the whole
  `skills/` tree; its separate "Weekly scheduled run" section documents
  copying `bin/optimise-cycle-weekly.sh` and `bin/redact-transcript.mjs`,
  with their own `diff -q` verification commands), so the check that this
  spec ships could itself be arbitrarily stale in an install, and
  `skills/conduct-plan/` -- which drives every multi-PR plan -- was
  unwatched entirely. Both are the exact partial-update failure this spec
  exists to catch, sitting inside its own fix. Corrected subset:
  - **Required** (absence from the install is reported as drift):
    `AGENT-HARNESS.md`, `agents/lens-*.md`, `agents/reviewer-*.md`,
    `workflows/*.js`, `workflows/lib/`, `hooks/`, `skills/` (broadened from
    `skills/optimise-cycle/` to the whole directory).
  - **Optional** (present-if-opted-in: absence from the install is a
    legitimate configuration, never drift; presence with different content
    IS drift): `bin/optimise-cycle-weekly.sh`, `bin/redact-transcript.mjs`.
    The weekly job is opt-in -- a plugin install, or a manual install that
    never set up the launchd job, legitimately has no `bin/` directory at
    all.
  - **Deliberately excluded**: `bin/com.local.optimise-cycle-weekly.plist`.
    Both `README.md` and the plist's own header comment document it as a
    per-operator TEMPLATE the operator edits before installing (substituting
    their real `$HOME` for the placeholder path it ships with), so a byte
    comparison against the published template would report every genuinely
    working install as permanently drifted -- the same false-drift shape
    round-one review's MED-4 found in the (withdrawn) version stamp, and
    exactly the outcome this spec's own risk table warns against ("the drift
    report is noisy and gets ignored, becoming decoration").

  Reports a published file **absent** from the install as drift, for every
  REQUIRED pattern. Test: delete one required subset file from the fixture
  install; it is named. An OPTIONAL file absent from the install is never
  reported. Test: an install with no `bin/` directory at all reports no
  drift over it. A user-owned file that the repo does not ship (`CLAUDE.md`,
  `agents/implementer.md`) is never reported. Test: both present in the
  fixture, neither named.
- **AC-OPS-5:** The subset list has exactly one definition in the codebase. Test:
  a static check fails if a second literal copy of it appears.

### Consistency check

- **AC-QA-1:** `plan-cycle.js` and `review-cycle.js` verify, before dispatching
  any lens, that every findings-block field the installed `AGENT-HARNESS.md` and
  `agents/lens-*.md` instruct a lens to fill has a matching property in the
  findings schema they are about to use, and vice versa. Test: an install where
  `recurrence` is instructed but absent from the schema is detected.
- **AC-QA-2:** (Amended 2026-08-23, round-two review.) The cycle refuses ONLY
  on a PROVEN mismatch. Round one's unconditional refuse gave the mechanism
  its teeth and also its worst failure: an ordinary documentation edit to
  `AGENT-HARNESS.md` (H1) reproducibly flipped `consistent:false` for every
  install carrying the file, with no override (H2), bricking every
  plan-cycle and review-cycle everywhere. Two sources of truth, not one --
  the prose parse of `AGENT-HARNESS.md`/`agents/lens-*.md` is a heuristic
  (already wrong once, H1); the in-process cross-check
  (`crossCheckAgainstOwnSchema`, comparing the model-reported instructed
  fields against the schema object the running workflow script itself
  holds) is reliable, because it needs no parsing of anything at all.
  **Certainty refuses; uncertainty warns, never halts.** Refuses (no lens
  dispatched, exits non-zero, names the field and both sides) only when the
  in-process cross-check proves a reported field is absent from the running
  schema, or when the report is self-contradictory (`consistent:true`
  alongside a reported mismatch or `blind:true` -- provable from the
  report's own structure, no parsing needed, M3). Every other condition --
  the consistency field missing, `blind`, `ok:false`, or the script's own
  prose-derived verdict alone with no in-process proof -- **warns** (one
  loud log line) **and proceeds**: lenses still dispatch.

  **The override (amended 2026-08-23, round three; supersedes M9).** A
  proven refusal may be downgraded to a loud warning for a SINGLE
  invocation by an explicit flag on that invocation's own args,
  `allow_inconsistent_install: true`, read by the workflow script
  directly. Never from the environment, never persisted, and never relayed
  through the model. Round two specified
  `HARNESS_ALLOW_INCONSISTENT_INSTALL=1` "matching
  `hooks/destructive-git-guard.py`'s `HARNESS_ALLOW_DESTRUCTIVE_GIT` in
  naming and shape"; that was wrong on two counts. The analogy fails,
  because the git guard's variable sits inline in the very command being
  guarded and is therefore visible at the point of use, whereas an
  exported variable here silently disables the gate for every subsequent
  run in the session with nothing in the invocation showing it. More
  seriously, a dynamic-workflow script has no environment access, so the
  variable had to be read by `install-consistency.mjs` and relayed as
  `escape_hatch_active` **through the scope agent -- the model whose
  report this gate is checking**. A gate whose override is asserted by the
  thing being policed is circular: the same bypass class as MED-2,
  reintroduced by the fix for M9. `escape_hatch_active` is removed from
  the reported schema and is ignored wherever it appears.

  It may override a PROVEN mismatch, deliberately. "Proven" here means the
  model's reported field list disagrees with the schema object held in
  process; if the model OVER-reports a field that is not really
  instructed, the cross-check proves a mismatch that does not exist, and
  with no override that is H1's total lockout returning through a
  different door. Using it must be impossible to miss: every suppression
  is named in the log AND prefixed to the run's own report, saying what
  was suppressed.

  Test: a proven mismatch, or a self-contradictory report, still refuses
  -- asserted by counting dispatches, never by reading a message. A blind,
  could-not-check, missing-field, or unproven-mismatch report dispatches
  normally with a warning logged. The flag turns a would-be refusal into a
  warning, is inactive by default, must be exactly boolean `true` (a
  mistyped `"true"` fails CLOSED), and a scope agent that reports
  `escape_hatch_active: true` on a proven mismatch is still refused --
  asserted by counting dispatches.
- **AC-QA-6:** (Added 2026-08-23, round three; closes M1, which was
  previously parked.) The check detects a findings schema that has **lost**
  a structural property, not only one that has gained a property or is
  missing an instructed field. `severity`, `claim`, `location` and `ac_id`
  are exempt from the doc-side comparison because nothing in
  `AGENT-HARNESS.md`'s FINDINGS template names them; that exemption was
  one-directional, so deleting `location` from an installed
  `REVIEW_SCHEMA` reported `consistent: true` with
  `missing_in_review_schema: []` -- measured, the H3 defect sitting inside
  the mechanism that exists to catch it. A per-schema required floor
  closes it: `REVIEW_SCHEMA` must declare all four, `PLAN_SCHEMA` the
  first three (`ac_id` is review-mode AC attribution and plan-cycle
  legitimately has no such property). The floor must be per-schema, or
  every honest install reports a lost field -- H1's lockout through a
  third door. Direction 2's behaviour must be unchanged: the exemption set
  is DERIVED from the floors, not a third literal that can drift from
  them. Test: a fixture whose `REVIEW_SCHEMA` lost `location` is reported
  and flips the verdict; a `PLAN_SCHEMA` without `ac_id` is not; a blind
  parse reports blindness rather than four fabricated losses; a report
  claiming `consistent: true` alongside a reported structural loss is
  self-contradictory and refuses, by dispatch count.
- **AC-QA-3:** On a consistent install it is silent and adds no measurable
  delay to startup. Test: a consistent fixture dispatches normally.
- **AC-QA-4:** The check reads the **installed** files it will actually use, not
  paths hardcoded to `~/.claude`. Test: point it at a fixture directory and it
  reads that one.
- **AC-QA-5:** Both guards are proven load-bearing by mutation: removing the
  consistency check leaves a mismatched fixture passing; removing the staleness
  report leaves a drifted fixture unreported. Both watched failing, restored,
  documented in `docs/`.

### Version stamp -- DROPPED 2026-08-23, after the round-one review

`AC-ARCH-1`, `AC-ARCH-2` and `AC-ARCH-3` are **withdrawn**. They are not
deferred and must not be re-raised at review as unmet criteria. Scott chose
this from options describing the evidence below; he did not read the review
report itself.

The stamp was built, reviewed, and turned out to be net negative:

- **It generated permanent false drift, defeating the mechanism it was meant to
  support.** Measured here, not inferred: an install taken one commit back,
  where the only real change since was to `.githooks/pre-commit` (a file the
  subset does not even cover), reported drift on all three stamped files. Since
  the hook rewrites the stamp on *every* commit, every commit to `main` makes
  every install report drift on those three files, for ever. The spec's own
  risk table names that outcome: "The drift report is noisy and gets ignored,
  becoming decoration."
- **It leaked unstaged work.** `stamp_md`/`stamp_js` rewrote the working-tree
  copy and `git add`-ed the whole file, so unfinished edits in the three
  most-edited files in the repo were committed silently and pushed to a public
  remote, invisible in `git diff --cached`. Reproduced with a planted token
  before it was patched (`065abe4`, a stopgap now superseded by removal).
- **It was misleading in two ways that cannot both be fixed cheaply.** A commit
  cannot embed its own hash, so the stamp necessarily names the *parent*; and
  under this repo's squash-merge flow the stamp on published `main` names a
  commit that does not exist in the published repository at all.

Deleting it resolves six of the round-one review's eighteen findings outright
(HIGH-1, MED-4, MED-5, MED-9, MED-10, MED-11), because the machinery goes away
rather than being made safer.

Nothing of value is lost. The staleness check's primary and only necessary
signal is full-file comparison against published `main`, which answers "is this
install current" directly and more reliably than a self-reported label.

- **AC-ARCH-4:** Replacing the three withdrawn above. No mechanism writes a commit
identifier into a shipped file, and no git hook rewrites tracked content during
a commit. Test: a static check fails if `SOURCE_COMMIT` reappears in any shipped
file, and `.githooks/` contains no `pre-commit`.

### Simplicity constraints

- **AC-SIMP-1:** No new dependency, no new scheduled job, no new daemon. The
  staleness check extends the weekly runner that already exists and already
  runs (verified: scheduled Mondays 07:41, last genuine run 2026-08-17).
- **AC-SIMP-2:** At most two new files outside `test/` and `docs/`.
- **AC-SIMP-3:** Neither mechanism ever copies, moves or deletes a file in the
  install.

## Parked at review (2026-08-23, round-two review, 22 findings)

Six findings were built this round (H1, H2, M2, M3, M9, M11, above). The
remaining sixteen are recorded here as the coordinator's explicit ruling, per
the harness's own exit condition (converge on substance, not on silencing
every comment) -- not deferred silently, and not to be re-raised at a future
review as unmet unless new evidence changes the ruling.

**Round three (2026-08-23) changed two of these rulings and closed the
list.** `M1` was un-parked and built (`AC-QA-6` above): it was measured, not
argued, and it turned out to be the H3 defect sitting inside the mechanism
that exists to catch H3. `M9`'s own fix was replaced rather than extended
(`AC-QA-2`'s override paragraph above): the escape hatch it shipped was
relayed through the model whose report the gate checks, which reopened
MED-2's bypass class. `M5`'s ruling is unchanged, but its evidence is now a
measurement rather than an impression -- see below. Everything else on this
list is **parked permanently**: it is not deferred work, and it is not to be
re-raised at a future review as unmet.

- **H3:** Every `could-not-check` outcome of the weekly staleness check is
  stderr-silent. Parked under the standing ruling that no-network stays
  stderr-silent: warning weekly about a routine condition trains the
  operator to ignore the channel the real drift signal uses.
- **L1:** `mktemp -d` failing during the staleness check can write a clone to
  `/src` at the filesystem root with no cleanup.
- **L2:** The refusal error interpolates `checked_dir`/`error` raw, leaking an
  absolute path (account name) into the propagated message.
- **L3:** The in-process cross-check closes fabrication, not omission -- a
  scope agent that under-reports `doc_fields`/`agent_fields` passes the gate
  trivially. Already documented as structurally unclosable for a
  dynamic-workflow script with no filesystem access of its own.
- **L4:** `hooks/hooks.json` sits in the REQUIRED subset but is plugin-only,
  so a manual install reports permanent drift on it and a plugin install
  reports the whole required set missing.
- **L5:** The directory-prefix patterns match any file at any depth,
  including untracked build artefacts (e.g. `__pycache__`), if a caller ever
  passes a working checkout instead of a fresh clone.
- **L6:** `AC-QA-3`'s "adds no measurable delay to startup" clause has no
  measurement and no test; what is actually proven is "no extra `agent()`
  call".
- **L7:** `install-consistency.mjs` holds two mechanisms (findings-schema
  consistency, consumer-subset staleness) that share no code, drawn together
  by the `AC-SIMP-2` file-count budget rather than by cohesion.
- **L8:** The weekly runner's one `EXIT` trap is scoped to a single resource;
  a later second `trap ... EXIT` registration would silently replace it and
  leak the shallow clone.
- **M1: BUILT round three, no longer parked.** Parking this was wrong. The
  finding as filed named the widening risk; measuring it found the worse
  half, which is that the exemption was one-directional and the check was
  blind to a schema that LOSES a real field (removing `location` from the
  installed `REVIEW_SCHEMA` left `consistent: true` and
  `missing_in_review_schema: []`). Closed by `AC-QA-6`. The original
  widening concern is closed as a side effect and needs no separate fix:
  adding a word to a floor now makes the repo's own schemas fail the H3
  static guard by name, so the set can no longer grow quietly. Narrowing a
  floor stays a deliberate two-place edit, pinned by a `deepEqual` in
  `test/static-checks.test.js`.
- **M4:** `AC-QA-2`'s "names both sides" test assertions match hardcoded
  boilerplate text rather than the field/value association, so the two
  sides can be transposed with the suite green.
- **M5: still PARKED, now with a measurement instead of an impression.**
  The `AC-OPS-5` single-definition guard is a proximity heuristic. Five
  duplicate shapes were planted against it by the coordinator on
  2026-08-23 and the results recorded here, replacing the round-two note
  that said only "found weak twice":

  | Duplicate shape | Caught? |
  |---|---|
  | Contiguous, bash idiom | yes |
  | Contiguous, JS idiom | yes |
  | One-per-line with trailing comments | yes |
  | Same list split ~90 lines apart | **no** |
  | Partial copy, 3 of 7 patterns | **no** |

  So it catches realistic contiguous copies and is blind to split and
  partial ones. It stays parked because it is a guard on a guard, not a
  correctness mechanism. Do not change the guard on the strength of the
  two "no" rows alone; the next reader now inherits a measurement rather
  than an impression, and can decide against acting on it.
- **M6:** An unreadable published file during staleness comparison is
  silently skipped and the run still reports `status:"ok"`.
- **M7:** The could-not-check reason names the failing step, not the cause
  (git's and node's stderr are both discarded).
- **M8:** The consistency preflight leaves no ledger trace on either the
  pass or the refuse path, so its false-positive/refusal rate cannot be
  measured externally.
- **M10:** The never-execute-a-repo-local-script rule now lives in four
  prose sites across two prompt families (the consistency preflight and the
  ledger writer), pinned pairwise but not to each other.

## Risks

| Risk | Recoverability |
|---|---|
| The consistency check refuses on a false positive and blocks all review cycles | Bounded by AC-QA-2's amendment (refuse only on proof, warn on doubt) and by the per-invocation `allow_inconsistent_install: true` override (round three; it replaces the `HARNESS_ALLOW_INCONSISTENT_INSTALL` environment variable, which was relayed through the model the gate checks). Never by AC-QA-3 -- that is a startup-latency bound and never bounded this risk, a round-two spec bug corrected here |
| The drift report is noisy and gets ignored, becoming decoration | Cheap, and the likeliest way this ships useless |
| A cache clone accumulates on a volume twice at 99% | Cheap if bounded at design time |

## Affected files

| Path | Change |
|---|---|
| `bin/optimise-cycle-weekly.sh` | staleness report |
| `workflows/plan-cycle.js`, `workflows/review-cycle.js` | consistency preflight |
| `workflows/lib/` | the shared subset definition and both checks |
| `test/`, `docs/` | tests and mutation proofs |
