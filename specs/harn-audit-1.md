# HARN-AUDIT-1: resolve every finding of the 11 November 2026 repository audit

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft 2026-11-11 (written from the audit; not yet through `/plan-cycle`)
**Lenses run:** none yet · **Skipped:** none yet. Expected at planning: security, qa, simplicity, data (history rewrite, ledger writer), architecture (restructure), operability (weekly job, installer, CI), product (onboarding, release). Design and accessibility do not apply: no UI.

## Problem

A whole-repository audit at commit `d805b7c` graded the harness B minus. The
engineering discipline is high (2,089 Node and 104 Python tests passing, no
dependencies, no shell-string subprocess calls, secret scanning, CodeQL and
branch protection all on), but several protections do less than they appear to,
which is the failure this project exists to prevent. Five themes explain the
findings:

1. **The safety net has holes in the common path.** The destructive-git guard
   allows a destructive command that follows a commented line, one continued
   with a backslash, and one whose pathspec is a substitution, variable, loop
   or brace expansion (all measured: exit 0 against exit 2 for the bare form).
   The README's manual-install snippet registers the guard with a 10 second
   timeout, below the 30 second worst case the same README says is unsafe.
2. **Decisions an agent makes that the script could make.** `plan-cycle`
   reports done when an always-on lens crashes. `tdd-task` takes the test
   freeze verdict as a boolean from an agent and reports DONE without checking
   a commit exists.
3. **Green means less than it says.** 20 of 189 CI runs on `main` or the weekly
   schedule failed on four timing-sensitive tests. No test runs a workflow
   script in the real runtime, and the stand-in runtime rejects forbidden
   features by denylist.
4. **History is stored inside the product.** Core files are 31% to 60% review
   commentary; four functions of 400 to 930 lines carry most of the logic; the
   README is 1,611 lines of which about 330 are onboarding; 187 of 248 commits
   are plan ticks pushed to `main`, each running full CI.
5. **Published, but not released.** A first install into an ordinary Claude
   home is refused with no documented override; there are no tags, changelog
   or security contact; a tracked binary coverage database publishes the
   maintainer's absolute home path.

Owner decisions taken 2026-11-11, which shape this plan:

- **This is a product for other people.** Onboarding, release and
  documentation tasks are priorities, not polish.
- **Public history is rewritten** to remove the maintainer's home path.
- **The largest files are restructured**, not put through further review
  rounds in their current shape.

The full audit, with evidence per finding, is the source for the finding ids
used below (S = security, G = gates, T = testing, A = architecture,
O = operations, D = documentation).

## Not in scope

- **More guard spellings** (`eval`, here-documents, `nice`, `timeout -k`,
  `git --no-optional-locks`, `bash -ec`). This is the arms race the README
  already names; the snapshot hook is the recovery path. Would change if a
  real incident traces to one of them.
- **Force-push in the guard.** Branch protection already blocks it on `main`.
- **Replacing the guard with a real shell parser.** Not proportionate while
  the snapshot exists.
- **De-duplicating the blocks shared by the workflow scripts.** The runtime
  forbids imports, and tests pin the copies byte for byte.
- **Ledger rotation, whole-ledger reads and the quadratic `truncateBytes`.**
  The ledger is 377 KB; years from mattering.
- **Making coverage or SonarQube a blocking gate.**
- **Concurrent same-scope plan events (G6).** Reachable only with two
  conductors on one plan. Resolved by recording it: T15 corrects the comment
  that claims the race cannot lose an event.
- **Any change to what the ledger records or what the optimiser reports.**
  The restructuring tasks are behaviour-preserving.

## What this replaces

| What goes | Owning lens | Removal criterion |
|---|---|---|
| Tracked `.coverage` file, at `HEAD` and in every commit reachable from `main` | security | written at planning |
| The denylist in `test/helpers/fake-runtime.js` as the only barrier against forbidden runtime features | qa | written at planning |
| The agent-returned `hashes_match` boolean as the freeze verdict in `tdd-task.js` | qa | written at planning |
| `--settings '{"disableAllHooks": true}'` in the weekly runner | security | written at planning |
| The test pinning the count of `return` statements per workflow script | simplicity | written at planning |
| Tests asserting on README prose | qa | written at planning |
| Tests that read a historical commit by hash, or the developer's live ledger | qa | written at planning |
| README sections for the guard, recovery, ledger, install-consistency and optimiser (moved to `docs/`, not deleted) | product | written at planning |
| `docs/claude-md-section-2-replacement.md` and the test asserting it exists | simplicity | written at planning |
| Review-round commentary inside the six largest source files (moved to `docs/history/`) | architecture | written at planning |

---

## Acceptance criteria

Not yet written. `/plan-cycle {"spec": "specs/harn-audit-1.md"}` writes the
numbered `AC-<LENS>-<n>` criteria here. Until then the "Done when" column in
the task detail below is the working contract, and every entry in it is
phrased so it can be shown true or false.

---

## Task detail

Effort: S under 2 hours, M half a day, L one to two days. "Codex" records
whether the same change probably applies to `codex-ai-harness`; every entry
in that column is an inference until T28 checks it.

### Phase 0: make green trustworthy

| Task | Resolves | What | Files | Done when | Effort | Risk | Codex |
|---|---|---|---|---|---|---|---|
| T1 | T1 | Stabilise the four flaky tests by fixing each cause: remove wall-clock thresholds, bound the concurrency, stop running test files from inside a test. No retries. | `test/ledger-append.test.js` (the 50-writer and linear-time tests), `test/install-consistency.test.js` (check-staleness), `test/harn-opt-6-r2-env.test.js` | Each passes 50 consecutive local runs under parallel load and 20 in CI; each still fails when the code it guards is broken; 30 consecutive `main` and scheduled runs with no failure from these four | M | Low | likely |
| T2 | T2 | Stand-in runtime fails closed: run scripts in an isolated context exposing only the bindings the real runtime provides. | `test/helpers/fake-runtime.js`, `test/fake-runtime.test.js` | A script using `setTimeout`, `fetch`, `Buffer` or `structuredClone` fails with no list entry naming it; a forbidden call inside a string or block comment does not fail; existing suite green | M | Medium: may surface existing violations | likely |
| T3 | T2 | Real-runtime smoke checklist, run once and recorded: each workflow by `scriptPath` against a scratch repo. Also records what `agent()` returns on a schema failure and on an unknown `agentType`, which T8 and T10 depend on. | `docs/release-checklist.md` (new) | Checklist exists; first run's results recorded in it, including the two runtime behaviours | S | Low | likely |
| T4 | T4 | Remove the suite's dependence on repository history and on the developer's live ledger: vendor the historical writer as a fixture file; replace the live-ledger read with a fixture ledger. | `test/harn-opt-6-gap.test.js`, `test/harn-opt-6-r2.test.js`, `test/review-cycle-finding-ids.test.js`, `test/static-checks.test.js:70-98`, `test/fixtures/` | Suite passes in a `--depth 1` clone and with `.claude/` absent; CI checkout no longer needs `fetch-depth: 0`; no test file runs `git show <hash>:` | M | Low | n/a |

### Phase 1: safety and correctness

| Task | Resolves | What | Files | Done when | Effort | Risk | Codex |
|---|---|---|---|---|---|---|---|
| T5 | S1, S2, S4, A3 | Close the three guard parsing classes and add `zsh` to the shells looked through. Join backslash-newline before tokenising; stop a `#` comment swallowing the following newline; treat any pathspec containing `$`, a backtick, `{` or a substitution placeholder as whole-tree scope (the rule `xargs` already uses). | `hooks/destructive-git-guard.py`, `hooks/destructive-git-cases.json`, `README.md` open-bypass table | New cases block: trailing comment then destructive line; backslash continuation; `$(...)` bare and quoted; variable; `for` and `while` loops; brace expansion; `zsh -c`. A `#` inside quotes or mid-word starts no comment. All existing cases unchanged; hostile suite and timeout-budget test green | M | Medium: over-blocking safe commands | likely |
| T6 | S3, D2 | Correct the documented hook timeout and the `~` in hook `args`; add a test comparing every hook snippet in the docs with the guard's worst case. | `README.md:392`, `:625`, `hooks/test_hook_timeout_budget.py` | Test fails when the README snippet is set to 10; no documented snippet uses `~` in `args`. Owner action outside the repo: set the guard's timeout to 60 in `~/.claude/settings.json` | S | Low | likely |
| T7 | S6, hooks payload crash | `git worktree remove --force` on a worktree with uncommitted changes is refused or snapshotted first; `git-snapshot.py` and `plan-guard-stop.py` tolerate a non-object payload as the guard does. | `hooks/destructive-git-guard.py`, `hooks/git-snapshot.py:189`, `hooks/plan-guard-stop.py:767`, case table | Forced removal of a dirty worktree blocks or leaves a recoverable snapshot; a clean worktree removal is allowed; `[1]` on stdin exits 0 without a traceback in both hooks | M | Medium | likely |
| T8 | G1, plan-cycle SHA compare | `plan-cycle` aborts with a named reason when an always-on lens returns no report; `lenses_run` records only lenses that reported; the checkout-moved check uses the same SHA comparison as `review-cycle`. | `workflows/plan-cycle.js:540`, `:630-632`, `:711`, `:807`, `:846`, `test/plan-cycle.test.js` | Null report from `lens-security`, `lens-qa` or `lens-simplicity` gives a non-done outcome naming the lens and writes no criteria to the spec; a triggered optional lens failing is reported and recorded as not run; a short or upper-case SHA raises no false alarm | S | Low | likely |
| T9 | G2, G3 | `tdd-task` decides the freeze in script code and verifies the commit. RED must return a hash for every listed test file and at least one; GREEN returns current hashes, not a boolean; the script compares. The commit step has a schema requiring a hex id. | `workflows/tdd-task.js:298`, `:310`, `:411`, `:436`, `:474-491`, `test/tdd-task.test.js` | Empty or partial RED hashes refuse; any hash difference gives `tests_modified`, still ahead of the attempt-cap exit; a failed or malformed commit result gives a non-done outcome and ledger row. Freeze width stays "listed test files" (see Vetoes and trade-offs) | M | Medium: core loop | likely |
| T10 | G4, S9, S10, locate wording | `review-cycle`: a failed simplicity check is reported as not verified; `opts.lenses` is checked against the roster and `opts.spec` and `opts.base` are validated identically in all three scripts; diff-derived and lens-authored text is fenced in nonce-delimited data blocks as `optimise-cycle` does; one helper-locate wording, which excludes the checkout under review, pinned by test. | `workflows/review-cycle.js`, `workflows/plan-cycle.js`, `workflows/tdd-task.js`, `test/review-cycle.test.js`, `test/shell-injection.test.js`, `test/static-checks.test.js` | Unknown lens name rejected before any agent is dispatched; `lens-simplicity` cannot be run at review; a failed simplicity agent yields an explicit "not verified" line and outcome; a file name carrying an instruction appears only inside a fenced block; the four locate wordings are byte-identical | M | Low | likely |
| T11 | S5, O2, weekly robustness | Weekly runner keeps the guard and snapshot active (disable only the Stop hook, or run in a disposable worktree); permission model moves from denylist to allowlist; a FAIL notifies; exit trap cleans the transcript temp file and the staged workflow copy; a lock prevents overlap; `SCRIPT_VERSION` bumped; log rotation. | `bin/optimise-cycle-weekly.sh`, `bin/com.local.optimise-cycle-weekly.plist`, `test/weekly-runner.test.js` | Runner invocation contains no `disableAllHooks`; a stubbed FAIL produces the notification; a killed run leaves no temp transcript or staged script; a second concurrent start exits without running | M | Medium: could break the unattended run | check |
| T12 | S7 | Untrack `.coverage`; ignore it; the leak scan reads binary files for the path patterns instead of skipping them, or fails on any tracked binary not on a named list. Replace the three literal account-name mentions in tracked text with a placeholder. | `.coverage`, `.gitignore`, `test/static-checks.test.js:280-281`, `specs/harn-opt-2.md:428`, `:439`, `test/optimise-read.test.js:2069` | `git ls-files .coverage` is empty; re-adding a binary containing a home path fails the suite | S | Low | check |
| T13 | S7 | Rewrite public history to remove the home path. See "History rewrite runbook" below. | whole repository | Runbook's verification steps all pass | M | **High: irreversible on the remote** | n/a |
| T14 | O1, O5 | Installer: a genuine first install succeeds or prints the exact override; a differing destination file is backed up before overwrite; installing from a dirty tree or a non-default branch warns and names it; tracked file names containing spaces install. README install step updated. | `bin/install.sh:187-215`, `README.md:55-58`, `test/install-sync.test.js` | Install into a home holding only `settings.json` and `projects/` exits 0 with files installed, or exits non-zero printing the one command that proceeds; an overwritten file has a timestamped backup; `--check` remains write-free | M | Low | check |

### Phase 2: restructure and release

| Task | Resolves | What | Files | Done when | Effort | Risk | Codex |
|---|---|---|---|---|---|---|---|
| T15 | G5, G7, A4, G6 (recorded), writer git timeouts, dead code, optimiser id pairing | Helper edges: symlink-safe entry check in the two CLIs that lack it; top-level catch in the writer so it always prints one line; the reader skips a malformed row and counts it; report-ignore reuses the hardened ignore routine; timeouts on the writer's three bare git calls; unused parameter and unreachable fallback removed; `optimise-cycle` pairs proposal ids by `target`, not position; the comment claiming plan-event minting cannot lose an event is corrected. | `workflows/lib/optimise-read.mjs:2184`, `:588-654`, `workflows/lib/optimise-report-ignore.mjs`, `workflows/lib/ledger-append.mjs:839`, `:1468-1526`, `:1867`, `:2524`, `workflows/optimise-cycle.js:887-895` | Each reproduced failure has a test that failed before and passes after: symlinked invocation prints output; unreadable ledger gives `write_ok: false` and exit 0; `findings:[null]` is skipped with a count; a reordered proposal response keeps the right id | M | Low | check |
| T16 | A1, A2 | Restructure the ledger writer: `main()` becomes a short sequence of named stage functions (parse, resolve roots, mint key, redact, canonicalise, reconcile, degrade, shrink, ignore-check, append) with counters owned by one structure. Behaviour-preserving. Review-round commentary moves to `docs/history/ledger-append.md`; comments left in code say what and why-now only. | `workflows/lib/ledger-append.mjs`, `docs/history/` | `main()` under 80 lines; no function over 120; comment-only share under 30%; no test file changed except imports; full suite green three times; installed copy byte-identical in output on a recorded corpus of payloads before and after | L | Medium | check |
| T17 | A2 | Restructure the ledger reader's `aggregateRework`: one counter definition per metric, applied to both the whole window and the schema-v4 subset by the same code. Commentary moved as in T16. | `workflows/lib/optimise-read.mjs:391-787` | Adding a metric is one definition; output identical to the pre-change output on this repo's ledger fixture and on the test corpus; no function over 120 lines | L | Medium | check |
| T18 | A2, T3 | Restructure `run()` in `review-cycle.js` and `optimise-cycle.js` into named phase functions; delete the test that pins the count of `return` statements and replace it with whatever property it was protecting, stated as behaviour. Commentary moved as in T16. Shared blocks stay byte-identical with `plan-cycle.js`. | `workflows/review-cycle.js:717-1643`, `workflows/optimise-cycle.js:207-1594`, `test/static-checks.test.js:917-945` | No function over 150 lines in either script; byte-identity tests green; fake-runtime suite green; T3 smoke checklist re-run by `scriptPath` and recorded | L | **High: the review gate itself** | likely |
| T19 | A1 | Move review-round commentary out of the remaining heavy files into `docs/history/`, leaving current-design comments. No code change. | `hooks/destructive-git-guard.py`, `workflows/lib/install-consistency.mjs`, `workflows/plan-cycle.js`, `workflows/tdd-task.js` | Comment-only share under 30% in each; a diff with comments stripped is empty | M | Low | n/a |
| T20 | O3 | Plan ticks stop running full CI and stop dominating history: push events touching only `specs/**` skip the test jobs (pull requests unaffected, so required checks still report); the conductor batches log lines and commits them only with a task state change. | `.github/workflows/ci.yml`, `skills/conduct-plan/SKILL.md`, tests pinning that skill's wording | A specs-only push to `main` starts no test job; a pull request touching only `specs/**` still reports all four required checks; a conducted task produces at most one log commit per state change | M | Medium: changes how plans resume | check |
| T21 | D1, D2, T3 | Split the README: purpose, requirements (Node, Python and git versions), install, first use, map of the docs. Guard, recovery, ledger, install-consistency and optimiser reference move to `docs/`. Stale statements corrected. Tests that assert on README prose are repointed to the moved reference or deleted where they only prove a sentence exists. | `README.md`, `docs/`, about 12 test files | README under 400 lines; `redact-transcript.mjs` located correctly; inventory lists every shipped directory; no test reads `README.md` except link and snippet checks | L | Low | check |
| T22 | S8, D3 | Make the contract true. Lenses may modify files only inside their own disposable worktree and never the main checkout; the optimiser's description names every file it writes; the contract names which agents commit. Wording aligned across the contract, both skills and the agent definitions. | `AGENT-HARNESS.md:21-23`, `:44-45`, `:75`, `:304`, `agents/lens-qa.md`, `agents/reviewer-verification.md:32`, `:57`, `skills/optimise-cycle/SKILL.md:55-56`, `workflows/optimise-cycle.js:3` | No document says "never modify files" of an agent another document tells to mutate; a test fails if a lens definition gains a write tool outside the stated licence | S | Low | likely |
| T23 | O4 | First release: `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`; plugin version bumped; tag `v0.5.0-beta`; a test that the plugin version and the latest changelog entry agree. Verify, in the real product, that a plugin install discovers `workflows/` and that `/claude-ai-harness:plan-cycle` resolves; correct the README if not. | `.claude-plugin/plugin.json`, new files, `README.md` | Tag exists on the rewritten history; plugin install verified and recorded in the release checklist | S | Low | check |
| T24 | O1 | Clean-machine install job in CI: run `bin/install.sh` into an empty home, then `--check`, on both Node versions. | `.github/workflows/ci.yml` | Job fails when the installer refuses a first install or leaves drift | S | Low | check |

### Phase 3: polish

| Task | Resolves | What | Files | Done when | Effort | Risk | Codex |
|---|---|---|---|---|---|---|---|
| T25 | T5 | Rename ticket-named test files by the module they test; move copied fixture builders into `test/helpers/`. No assertion changes. | 18 `test/harn-opt-*.test.js` files, `test/helpers/` | No test file is named for a ticket; each duplicated builder has one definition; test count unchanged | M | Low | n/a |
| T26 | S11 | CI hygiene: pin all actions to commit ids; add `.github/dependabot.yml` for actions; add shellcheck and pyflakes steps; pin the Python version; align the pre-push and CI Python thresholds; fix the contradictory CodeQL comment. | `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.githooks/pre-push:64` | No `uses:` line references a mutable tag; a shell or Python lint error fails CI | S | Low | check |
| T27 | D4, T6 | Housekeeping: spec status headers match reality; applied patch document and its test removed; Sonar config describes the current tree; a tracked script regenerates the coverage numbers. | `specs/*.md` headers, `docs/claude-md-section-2-replacement.md`, `test/conduct-plan-escalation.test.js:223-225`, `sonar-project.properties` | Every merged spec says shipped; one command regenerates `coverage/` | S | Low | n/a |
| T28 | cross-harness | Review each merged task against `codex-ai-harness` and raise the Codex-side change or record why it does not apply. | (other repository) | Every task above has a recorded Codex disposition | M | Low | n/a |

## History rewrite runbook (T13)

Measured on 2026-11-11 against `origin/main` (248 commits): the full home path
appears only in the `.coverage` blob (two commits touch it; every later tree
carries it). No tracked text file at `HEAD` contains the full path. Zero forks,
zero stars, zero open pull requests, 24 `refs/pull/*` refs on the remote.

What the rewrite can and cannot do:

- It removes the blob from `main` and from any fresh clone.
- It does **not** remove it from GitHub's `refs/pull/*` refs or from cached
  commit views addressable by the old ids. Only GitHub Support can purge
  those; the request is a step below, and until it is answered the claim
  "removed" is false and must not be made.
- Every commit id changes. Commit ids quoted in spec conductor logs, docs and
  ledger rows stop resolving. They are historical records and are left as
  written, with one note added (step 9).

Steps. Steps 6 and 8 are destructive and outward-facing: the conductor stops
and the owner confirms at each, in the session, at the time.

1. Preconditions: T4 and T12 merged; no open pull requests; no live agent
   worktrees; local gate green.
2. Take a mirror backup (`git clone --mirror`) to a location outside the
   repository and record its path and the pre-rewrite `main` id in the
   untracked conductor note.
3. In a **fresh clone** (the working checkout carries about 770 local
   snapshot refs that must not be rewritten or pushed), re-scan every commit
   on `main` for the path patterns, including commit messages and binary
   blobs, and record the hit list. If anything beyond `.coverage` appears,
   stop and widen the plan before rewriting.
4. Run `git filter-repo --invert-paths --path .coverage` in the fresh clone
   (plus a message or blob replacement only for hits recorded in step 3).
5. Verify locally: the step 3 scan returns nothing; the tree at the new
   `main` tip is byte-identical to the old tip apart from `.coverage`; the
   full suite passes in the rewritten clone.
6. **Owner confirms.** Temporarily allow force pushes on `main` in branch
   protection; force-push the rewritten `main`; restore the protection in the
   same step and verify by reading it back.
7. Verify remotely: a new fresh clone passes the step 3 scan; CI is green on
   the new tip.
8. **Owner confirms.** Request a purge of unreachable objects and cached
   views from GitHub Support, citing the old commit ids from step 2. Record
   the request and its outcome.
9. Add one line to `CHANGELOG.md` (created in T23) stating the date of the
   rewrite and that commit ids quoted in documents before it refer to the
   pre-rewrite history.
10. Re-clone the working checkout or hard-reset it to the new `main` only
    after confirming it holds no unpushed work; run `bin/install.sh` and
    `--check`.
11. Keep the mirror backup until step 8 is answered, then delete it: it
    contains the path.

## Vetoes and trade-offs

| Item | Raised by | Decision | Rationale |
|---|---|---|---|
| Product for other people | owner, 2026-11-11 | accepted | Makes T14, T21, T23 and T24 priorities |
| Rewrite public history | owner, 2026-11-11 | accepted | T13; cost is every commit id changing and a dependency on GitHub Support for full removal |
| Restructure the largest files, no further review rounds in their current shape | owner, 2026-11-11 | accepted | T16 to T19 |
| TDD freeze width | audit | **default taken, owner may overrule:** listed test files only, but coverage of that list is now mandatory (T9) | Freezing helpers and config needs a way to tell a legitimate helper change from tampering; that is a separate design |
| May lenses modify files | audit | **default taken, owner may overrule:** yes, inside their own disposable worktree only (T22) | Removing mutation from the QA lens removes its ability to prove a test can fail |
| Conductor log location | audit | **default taken, owner may overrule:** stays in the tracked spec; ticks are batched and specs-only pushes skip CI (T20) | Keeps plans resumable and visible; removes the CI cost. Moving the log out of the repository is the stronger option if history noise still matters afterwards |
| Weekly unattended run | audit | **default taken, owner may overrule:** keep it, with the guard on and failures notified (T11) | It caught its own stale reports, which is the verdict logic working |

## Risks

Ranked by recoverability.

1. **Irreplaceable: T13.** A force-push to a public default branch cannot be
   undone for anyone who has fetched in between, and a botched rewrite loses
   history. Mitigated by the mirror backup, the fresh-clone rule, the
   tree-identity check and two owner confirmations.
2. **Expensive: T18.** It restructures the script that reviews every other
   task in this plan. A defect there weakens the gate for everything after
   it. Mitigated by ordering it after T2 and T3, re-running the real-runtime
   smoke check, and dispatching every review during this plan by
   `scriptPath` from the installed copy, not from the branch under change.
3. **Expensive: T16 and T17.** Behaviour-preserving restructures of files
   with a history of regressions introduced by fixes. Mitigated by a recorded
   before-and-after output corpus and by changing no tests.
4. **Cheap: T5 over-blocking.** A refused safe command costs seconds and is
   reversible by the documented override.
5. **Cheap: T11.** A broken weekly run is noticed, after this task, by its
   own notification.
6. **Process: plan size.** 28 tasks is larger than any previous plan here,
   and HARN-OPT-5 needed 88 spec commits. Mitigated by the four phases being
   independently shippable: stopping after any phase leaves the repository
   better and consistent.

## Affected files

| Path | Change |
|---|---|
| `hooks/destructive-git-guard.py`, `hooks/destructive-git-cases.json` | T5, T7, T19 |
| `hooks/git-snapshot.py`, `hooks/plan-guard-stop.py` | T7 |
| `workflows/plan-cycle.js` | T8, T10, T19 |
| `workflows/tdd-task.js` | T9, T10, T19 |
| `workflows/review-cycle.js` | T10, T18 |
| `workflows/optimise-cycle.js` | T15, T18 |
| `workflows/lib/ledger-append.mjs` | T15, T16 |
| `workflows/lib/optimise-read.mjs` | T15, T17 |
| `workflows/lib/optimise-report-ignore.mjs`, `workflows/lib/install-consistency.mjs` | T15, T19 |
| `bin/install.sh` | T14 |
| `bin/optimise-cycle-weekly.sh`, `bin/com.local.optimise-cycle-weekly.plist` | T11 |
| `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.githooks/pre-push` | T4, T20, T24, T26 |
| `test/helpers/fake-runtime.js`, `test/fixtures/` | T2, T4 |
| `test/*.test.js` | T1, T4, T21, T25 and each task's own tests |
| `README.md`, `docs/`, `docs/history/`, `docs/release-checklist.md` | T3, T6, T16 to T19, T21 |
| `AGENT-HARNESS.md`, `agents/*.md`, `skills/*/SKILL.md` | T20, T22 |
| `.coverage`, `.gitignore` | T12, T13 |
| `.claude-plugin/plugin.json`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md` | T23 |
| `specs/*.md`, `sonar-project.properties` | T12, T27 |

## Follow-ups (not tasks in this plan)

- HARN-OPT-6 T3 takes its live tally from this plan's first ten review-cycle
  runs, after a session restart.
- Whether to freeze test helpers and configuration in `tdd-task`.
- Whether the conductor log should leave the repository entirely.

## Tasks
- [ ] T1: stabilise the four flaky tests, no retries (audit T1) — state: queued
- [ ] T2: stand-in runtime fails closed on unknown features (audit T2) — state: queued
- [ ] T3: real-runtime smoke checklist, first run recorded (audit T2) — state: queued
- [ ] T4: tests no longer depend on repository history or the live ledger (audit T4) — state: queued
- [ ] T5: guard parsing holes closed, zsh looked through (audit S1, S2, S4, A3) — state: queued (needs: T1)
- [ ] T6: documented hook timeout and args corrected, tested against the guard's worst case (audit S3, D2) — state: queued
- [ ] T7: forced worktree removal covered; sibling hooks tolerate a non-object payload (audit S6) — state: queued (needs: T5)
- [ ] T8: plan-cycle refuses on a missing always-on lens; lenses_run truthful (audit G1) — state: queued (needs: T3)
- [ ] T9: tdd-task decides the freeze in script and verifies the commit (audit G2, G3) — state: queued (needs: T2)
- [ ] T10: review-cycle argument validation, fenced untrusted text, simplicity check reported when unverified (audit G4, S9, S10) — state: queued (needs: T2, T3)
- [ ] T11: weekly runner keeps the guard on, allowlist, failure notification, cleanup (audit S5, O2) — state: queued
- [ ] T12: .coverage untracked and ignored; leak scan covers binaries (audit S7) — state: queued
- [ ] T13: public history rewritten per the runbook; owner confirms at steps 6 and 8 (audit S7) — state: queued (needs: T4, T12)
- [ ] T14: installer first install, backup on overwrite, branch warning (audit O1, O5) — state: queued
- [ ] T15: helper program edges and optimiser id pairing (audit G5, G7, A4) — state: queued (needs: T1)
- [ ] T16: ledger writer restructured into named stages, history moved to docs (audit A1, A2) — state: queued (needs: T1, T15)
- [ ] T17: ledger reader aggregateRework restructured (audit A2) — state: queued (needs: T15)
- [ ] T18: review-cycle and optimise-cycle run() restructured; return-count pin removed (audit A2, T3) — state: queued (needs: T2, T3, T10)
- [ ] T19: review commentary moved out of the guard, install-consistency, plan-cycle and tdd-task (audit A1) — state: queued (needs: T5, T7, T8, T9)
- [ ] T20: specs-only pushes skip CI; conductor batches log commits (audit O3) — state: queued
- [ ] T21: README split, stale statements corrected, README-prose tests repointed (audit D1, D2, T3) — state: queued (needs: T6, T14)
- [ ] T22: contract, skills and agent definitions agree on who may write (audit S8, D3) — state: queued
- [ ] T23: first release: changelog, security contact, version, tag, plugin install verified (audit O4) — state: queued (needs: T13, T21)
- [ ] T24: clean-machine install job in CI (audit O1) — state: queued (needs: T14)
- [ ] T25: test files named by module, fixture builders consolidated (audit T5) — state: queued (needs: T16, T17, T18)
- [ ] T26: CI hygiene: pinned actions, dependabot for actions, shell and Python lint (audit S11) — state: queued
- [ ] T27: spec headers, applied patch removed, Sonar config and coverage script (audit D4, T6) — state: queued
- [ ] T28: Codex harness disposition recorded for every task — state: queued (needs: T27)
## Conductor log
