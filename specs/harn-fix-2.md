# HARN-FIX-2: make destroyed uncommitted work recoverable, instead of trying to recognise the command that destroys it

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft
**Lenses run:** _(to be filled by `/plan-cycle`)_ · **Skipped:** _(record why)_

## Problem

An agent destroyed its own uncommitted work three times in one session, using
`git checkout --` on files it had just edited. `docs/harn-opt-2-mutation-proofs.md`
had already forbidden that command by name. Prose did not prevent it.

The first attempt at a mechanism, `hooks/destructive-git-guard.py` (this branch,
commits `4e4e1a2`, `af2bb82`, `6fac36a`), refuses a Bash call whose command text
parses as one of a set of guarded git shapes. **That approach has now failed to
converge across three rounds**, and the evidence is the point of this spec:

| Round | Holes closed | New holes found by the next review |
|---|---|---|
| 1 (`4e4e1a2`) | the 4 shapes originally scoped | 3 (`git checkout <path>`, `checkout <dir>`, `checkout -f`) |
| 2 (`af2bb82`) | those 3 | 11 (newline, `git -C`, `--no-pager`, absolute path, `-fq`, `-fb`, quoted escape-hatch mention, redirect, shell keyword, `--pathspec-from-file`, `cd`) |
| 3 (`6fac36a`) | those 11 | 6+ (`env git`, `command git`, `` `which git` ``, `$(which git)`, keyword-then-env-prefix, trailing `#` comment) |

Round 3 also introduced a **false refusal**: writing a here-document whose body
merely mentions a guarded command is refused, which is the noise failure that
gets a guard switched off.

The shape is wrong, not the patch. The hook is a blocklist over a
Turing-complete input language: the set of shell spellings that reach the same
destructive `git` call is unbounded, so each round closes the enumerated
spellings and the next reviewer enumerates more. Standard §12 ("after three
failed fixes, question the frame") names exactly this.

**This spec changes the frame from prevention to recovery.** If uncommitted work
is snapshotted before it can be destroyed, then destroying it is survivable
regardless of how the destroying command was spelled. Recovery does not need to
understand the command, so no spelling defeats it.

The existing detector is **kept** as a first line of defence and as the thing
that produces a useful refusal message for the obvious cases. It is demoted from
"the guard" to "the cheap early catch", and its documentation must stop claiming
completeness it cannot have.

## Not in scope

- **Retiring `hooks/destructive-git-guard.py`.** It stays. What changes is the
  claim made for it. Deleting it would remove real protection against the exact
  command that caused the incident.
- **Guarding non-git destruction** (`rm -rf`, a truncating redirect, an editor
  writing over a file). The snapshot mechanism may happen to cover some of it;
  no AC should assert that it does unless a lens writes one deliberately.
- **Protecting work that was never written to disk.**
- **Any change to `main`'s branch protection.** H-1 from the round-two review is
  already fixed on this branch (`11b4960`) and is not re-opened here.

## Approach sketch, for the lenses to attack rather than to accept

Before a Bash tool call runs, if the working directory is a git repository with
uncommitted tracked changes, record a snapshot that can restore them, then let
the command proceed. `git stash create` produces a commit object without
touching the index or the working tree, which is the property that matters: the
snapshot must be invisible to the command about to run, or it changes the
behaviour of the thing it is protecting.

Known-hard questions, deliberately unresolved here:

1. **Untracked files.** `git stash create` does not include them. The current
   detector also deliberately ignores them. If untracked work is in scope, the
   mechanism is different (a temporary index), and that is a materially larger
   change. `lens-data` owns this call.
2. **Cost on every Bash call.** The dirty case is the normal case during active
   work, so "snapshot only when dirty" is not much of a saving. Needs a measured
   budget and a cheap skip when nothing changed since the last snapshot.
   `lens-operability` owns the budget; a hook that makes every command slow will
   be switched off, which is the same failure mode as a noisy guard.
3. **Where snapshots live and when they are removed.** Unbounded refs are a leak;
   aggressive pruning defeats the purpose. Note that this repo's own standards
   record leftover branches and worktrees as a recurring, measured problem.
4. **Recovery ergonomics.** A snapshot nobody can find is not a recovery
   mechanism. What does the agent, or the user, actually run at 2am?
5. **Failure mode when snapshotting fails.** The detector fails open. Whether
   this should too is a genuine question, not an inherited default.
6. **Whether snapshots can leak secrets.** A snapshot of a dirty tree captures
   whatever is in it, including a `.env` an agent has just written. Refs are
   pushable and are walked by history-scanning secret scanners. `lens-security`
   owns this, and it may be the constraint that reshapes the whole design.

## Acceptance criteria

_To be written by `/plan-cycle`. Deliberately empty: every review round on the
previous approach recorded "no spec, so `ac_verdicts` is empty" as a finding,
and this file exists to end that. Do not implement against this spec until the
criteria are filled in._

## Risks

Ranked by recoverability.

| Risk | Recoverability |
|---|---|
| A snapshot of a dirty tree captures a secret and it is later pushed | Irreversible once pushed; a rewrite removes it from the branch, not from the repository (recorded in the standards on 2026-08-17) |
| The mechanism slows every command enough that it gets disabled | Cheap to fix, but the failure is silent: nobody reports a guard they turned off |
| Snapshot refs accumulate and consume a volume already twice at 99% | Cheap, if pruning is designed in rather than retrofitted |
| Recovery is theoretically possible but nobody knows the command | Cheap, and the most likely way this ships useless |

## Affected files

| Path | Change |
|---|---|
| `hooks/` | new snapshot hook |
| `hooks/hooks.json` | registration (note: registration wiring is now covered by a test, `test/static-checks.test.js`) |
| `README.md` | document recovery; **correct the existing detector's claims**, which currently overstate its coverage |
| `docs/` | mutation proofs |
| `test/` | tests, including proof the snapshot is actually restorable, not merely created |

## Spec gaps found at review

_Recurring finding from both rounds on the previous approach: the work shipped
with no spec and no acceptance criteria, which made every lens's `ac_verdicts`
empty and turned each review into an unanchored rubric pass. Recorded here as
the reason this file exists._
