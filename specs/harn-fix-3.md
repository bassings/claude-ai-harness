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
- **AC-OPS-4:** The comparison covers exactly the consumer subset
  (`AGENT-HARNESS.md`, `agents/lens-*.md`, `agents/reviewer-*.md`,
  `workflows/*.js`, `workflows/lib/`, `hooks/`, `skills/optimise-cycle/`) and
  reports a published file **absent** from the install as drift. Test: delete
  one subset file from the fixture install; it is named. A user-owned file that
  the repo does not ship (`CLAUDE.md`, `agents/implementer.md`) is never
  reported. Test: both present in the fixture, neither named.
- **AC-OPS-5:** The subset list has exactly one definition in the codebase. Test:
  a static check fails if a second literal copy of it appears.

### Consistency check

- **AC-QA-1:** `plan-cycle.js` and `review-cycle.js` verify, before dispatching
  any lens, that every findings-block field the installed `AGENT-HARNESS.md` and
  `agents/lens-*.md` instruct a lens to fill has a matching property in the
  findings schema they are about to use, and vice versa. Test: an install where
  `recurrence` is instructed but absent from the schema is detected.
- **AC-QA-2:** On mismatch the cycle **refuses**: it does not dispatch lenses,
  exits non-zero, and names the field and both sides. Test: assert no lens agent
  was invoked, by counting dispatches, not by reading a message.
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

## Risks

| Risk | Recoverability |
|---|---|
| The consistency check refuses on a false positive and blocks all review cycles | Cheap to fix, expensive while live; AC-QA-3 exists to bound it |
| The drift report is noisy and gets ignored, becoming decoration | Cheap, and the likeliest way this ships useless |
| A cache clone accumulates on a volume twice at 99% | Cheap if bounded at design time |

## Affected files

| Path | Change |
|---|---|
| `bin/optimise-cycle-weekly.sh` | staleness report |
| `workflows/plan-cycle.js`, `workflows/review-cycle.js` | consistency preflight |
| `workflows/lib/` | the shared subset definition and both checks |
| `test/`, `docs/` | tests and mutation proofs |
