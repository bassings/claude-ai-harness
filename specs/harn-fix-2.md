# HARN-FIX-2: make destroyed uncommitted work recoverable, instead of trying to recognise the command that destroys it

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** agreed
**Lenses run:** `lens-security`, `lens-qa`, `lens-simplicity`, `lens-product`,
`lens-data`, `lens-architecture`, `lens-operability` ·
**Skipped:** `lens-design`, `lens-accessibility` (no UI surface)

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

Synthesised by `/plan-cycle` from seven lenses (`lens-security`, `lens-qa`,
`lens-simplicity`, `lens-product`, `lens-data`, `lens-architecture`,
`lens-operability`). Each line below is one criterion the review cycle verifies
by ID. Where two lenses wrote the same criterion, the more testable wording was
kept and the merged IDs are named in brackets: those IDs are retired and must
not be re-raised at review as separate findings.

Every criterion is proven by an executed test unless its line says otherwise.
The `AC-SIMP-<n>` lines are mechanical and are checked by the orchestrator
directly against the diff, per `AGENT-HARNESS.md`.

### Settled at planning

The "Approach sketch" above is preserved as it was written, and three of its
premises were measured false by more than one lens. These decisions override it,
and the criteria below encode them.

1. **The snapshot runs against a private index copy.** `git stash create` leaves
   the working tree alone, but the bare form takes `.git/index.lock` and can
   rewrite `.git/index`. Measured contention failures: 5 of 6 concurrent calls
   (`lens-operability`), 25 of 50 paired calls (`lens-qa`), 7 of 8 at 8-way
   concurrency (`lens-qa`). The form that survives is copying `.git/index` to a
   path outside the working tree and pointing `GIT_INDEX_FILE` at the copy, which
   `lens-data` measured to succeed even while `.git/index.lock` is held. Note a
   genuine measurement conflict, recorded rather than resolved away:
   `lens-simplicity` measured `.git/index` byte-identical across a bare
   `git stash create` while `lens-data` measured it change (262 to 281 bytes) and
   `lens-operability` measured its mtime change. Both are reproducible; the index
   is rewritten only when its stat cache is stale. The lock is taken either way,
   which is the half that matters.
2. **A snapshot is not a snapshot until its ref exists.** Three lenses measured
   an unreferenced `git stash create` object destroyed by `git gc --prune=now`.
   Ref creation completes before the hook returns.
3. **Snapshot refs are keyed per checkout, one ref per snapshot.** Linked
   worktrees share a ref store: `lens-data` measured a single mutable ref written
   from a worktree resolving, from the main checkout, to the worktree's content.
   This repo runs agents in worktrees by standing policy.
4. **Untracked and ignored files stay out of scope** (closes known-hard question
   1). Measured: `git stash create` already excludes both, no guarded git shape
   destroys an untracked file, and including them would sweep an agent-written
   `.env` into a ref on every Bash call.
5. **The hook fails open and always exits 0** (closes question 5), with a
   durable, bounded failure trace so the silent-miss failure mode is
   discoverable. Exit code 2 is unreachable from the snapshot hook.
6. **The hook never reads the command text.** It snapshots the repository at the
   payload `cwd` and nothing else. Parsing `cd` or `git -C` out of the command is
   how round three produced both its false refusal and six new holes, and
   re-importing that parser reinstates the frame this spec abandons. The gap
   (a Bash call that changes directory into another repository) is documented as
   a limitation rather than covered.
7. **Recovery is non-destructive by default** (closes question 4).
   `git stash apply --index` into a live tree was measured writing conflict
   markers into a tracked file while reporting `Index was not unstashed`, so it
   is not the documented default. Recovery is documented git commands, not a new
   executable.
8. **The detector is frozen.** `hooks/destructive-git-guard.py` gains no new
   guarded shape, spelling or normalisation stage in this change. A newly found
   bypass is evidence that recovery is load-bearing, not a defect to patch.
9. **Snapshot creation is unconditional on the detector's verdict**, because
   matching PreToolUse hooks run in parallel with no ordering guarantee.
10. **Consent is one new environment variable, default on**, registered
    separately from the detector so silencing the detector does not silence
    recovery (closes the consent half of question 6).

### lens-security

- **AC-SEC-1** -- The snapshot never captures an ignored or untracked path: in a repo with a modified tracked file, an untracked file and a gitignored `.env` each holding a distinct high-entropy gitleaks-detectable token, `git ls-tree -r <snapshot>` lists no ignored or untracked path and `git grep -q <ignored-token> <snapshot>` exits non-zero. [merges AC-QA-15]
- **AC-SEC-2** -- Snapshot refs live outside `refs/heads/*`, `refs/tags/*` and `refs/remotes/*`: after `git push`, `git push --all` and `git push --tags` to a local bare remote, `git --git-dir=<remote> for-each-ref` shows no snapshot ref; and README states the two measured residuals in plain words, that `git push --mirror` and an explicit `refs/*:refs/*` refspec DO transmit them and that `git log/rev-list --all` DOES walk them. [merges AC-DATA-15]
- **AC-SEC-3** -- One documented command makes snapshot content unrecoverable, not merely unreferenced: after running it verbatim as README gives it, `git cat-file -e <snapshot>` exits non-zero, `git rev-list --all` does not list it, and a grep across all remaining refs finds no occurrence of the planted token. README documents this as the required step after removing a secret from a working tree or rewriting history, because a snapshot ref pins the pre-rewrite commit. Measured: deleting the ref alone leaves `git show <sha>:.env` printing the secret. [merges AC-DATA-14]
- **AC-SEC-4** -- Retention is bounded by the mechanism and the bound is named in README: a test creates more snapshots than the bound, runs whatever triggers pruning, and asserts the excess refs are gone AND their commits are unreachable from any ref. "Kept forever" is acceptable only if README says so in those words and the test asserts no pruning occurs; silence is not.
- **AC-SEC-5** -- Every git invocation the snapshot hook makes is hardened three ways: (a) the subprocess environment is filtered through the same `GIT_ENV_ALLOWLIST` as `hooks/destructive-git-guard.py`, tested by running the hook with `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` pointed at a decoy repo and asserting no ref and no new object appears there; (b) no `shell=True` and no payload-supplied `command` or `cwd` interpolated into a shell string, asserted by a static test over `hooks/`; (c) each invocation passes `-c core.fsmonitor=`, tested by setting `core.fsmonitor` in a repo's own `.git/config` to a script that touches a sentinel and asserting the sentinel is absent. Measured on git 2.50.1: without (c) a cloned hostile repository executes attacker code on every Bash call. [merges AC-QA-11]
- **AC-SEC-6** -- No working-tree content reaches the model or any log: with a file whose name and whose contents both carry a distinctive injection payload, the payload appears in neither stdout, stderr, nor any file the hook wrote. On the success path the hook emits at most a fixed template naming a ref and a short sha.
- **AC-SEC-7** -- README's guard section states in plain words that the detector is a best-effort early catch and not a boundary, contains no completeness claim, and names the measured-open bypass classes: an `env` or `command` prefix, a command-substitution binary path such as `$(which git)`, `eval`, a backtick or subshell, `bash -c`, `xargs`, a here-doc, and any input the tokenizer cannot parse. Pinned by a static README assertion in `test/static-checks.test.js` so the doc cannot drift back into a claim.
- **AC-SEC-8** -- The user can decline: a documented environment variable disables snapshotting, and with it set the hook creates no ref, no object and no file anywhere, while with it unset a snapshot is created. Separately, the hook creates nothing when the effective directory is not inside a git work tree. Protection is on by default for anyone who installs the documented way, and no README instruction tells a user to enable snapshotting: the control is opt-OUT, never opt-in. [merges AC-PROD-5]

### lens-qa

- **AC-QA-1** -- End-to-end recovery of the incident itself: in a real temp repo with an uncommitted tracked edit, invoke the snapshot hook as a subprocess with a PreToolUse Bash payload, actually run the destroying command, then run the documented recovery, and assert the file is byte-identical to its pre-command content. The test executes the destroying command, it does not simulate it.
- **AC-QA-2** -- Spelling independence: AC-QA-1 holds unchanged for every spelling measured to walk past `hooks/destructive-git-guard.py` today (`env git`, `command git`, `$(which git)`, `eval "..."`, `bash -c "..."`, `xargs`) and for `git reset --hard`. Each case asserts both that the edit was destroyed and that it was recovered, so a case that silently stops destroying anything cannot pass vacuously.
- **AC-QA-5** -- Each of these is a separate named assertion that the hook exits 0, prints nothing, creates no file or ref anywhere, and completes inside `hooks.json`'s timeout: clean tree; unborn HEAD; bare repo; cwd that is not a git repo; cwd that does not exist; cwd that is a regular file; `tool_name` not `Bash`; malformed JSON on stdin; empty stdin; empty command; a 1 MB command string. [merges AC-DATA-5]
- **AC-QA-6** -- Conflicted state is pinned by a test that builds a genuine `UU` merge conflict, the state in which an agent is most likely to reach for a destructive command, and asserts the decided behaviour (allow without snapshot, plus the AC-OPS-3 named warning) and that the hook emits no Python traceback. Measured: `git stash create` fails there with `Cannot save the current index state` and prints `f.txt: needs merge` on stdout.
- **AC-QA-8** -- Concurrency: 20 iterations of two hook processes launched simultaneously against the same repo leave zero `.git/index.lock` files behind, and every invocation either records a recoverable snapshot or emits the AC-OPS-3 contention warning, with none exiting non-zero and none silently skipping. [merges AC-OPS-4]
- **AC-QA-17** -- Repository growth is bounded and the bound is asserted: 50 snapshots on a repo holding a 250 KB file that changes between each keeps `.git` under the documented size bound. Measured baseline for the naive form: 100 snapshots of a changing 270 KB file grew `.git` from 312 KB to 21.5 MB across 306 loose objects. A repeat snapshot of unchanged content is measured to produce an identical commit sha, so the skip path must be shown to cost no additional objects.
- **AC-QA-19** -- A table-driven test drives every spelling README lists as GUARDED and asserts exit 2, and every spelling it lists as OUT OF SCOPE and asserts exit 0, against a genuinely dirty file. It fails in both directions, so neither a closed hole nor a stopped guard can leave the documentation stale. This is the executable half of AC-SEC-7.
- **AC-QA-21** -- Each new guard has a row in a `docs/` mutation-proofs table recording the mutation applied, confirmation the diff landed on the intended line, and the exact test names that failed, matching `docs/destructive-git-guard-mutation-proofs.md`. Every criterion above must be shown to fail when the behaviour it pins is deliberately broken, and to pass again after restoration by `cp` from a pre-mutation copy.

### lens-simplicity

- **AC-SIMP-1** -- No new dependency: the diff adds no `package.json`, no lockfile and no vendored module, and the new hook imports only Python standard-library modules.
- **AC-SIMP-2** -- The change touches at most three files outside `test/`, `docs/` and `specs/`: the one new hook under `hooks/`, `hooks/hooks.json`, and `hooks/destructive-git-guard.py`.
- **AC-SIMP-3** -- The new snapshot hook is at most 200 lines including its docstring. If the surviving criteria cannot be met inside that ceiling, that is recorded as a spec bug at review rather than silently dropped.
- **AC-SIMP-4** -- The snapshot hook can never refuse a tool call: no `sys.exit` with a code other than 0 appears anywhere in it, and no retry loop or blocking error path exists.
- **AC-SIMP-5** -- *(amended, see "Vetoed at planning")* The hook holds no state across invocations: no dirtiness cache, no last-snapshot memo, no file under `$HOME` or `.claude/`, and no `git status` call used to decide whether to snapshot. Measured: such a skip saves about 10 ms of a roughly 49 ms hook and buys state that can go stale and silently stop snapshotting.
- **AC-SIMP-6** -- *(amended)* Snapshots capture tracked changes only: the hook contains no `git add`, no `--include-untracked`, no `-u` and no `-a`, and a test with an untracked file and a gitignored `.env` in a dirty tree asserts `git ls-tree -r --name-only <snapshot>` contains neither.
- **AC-SIMP-7** -- *(amended)* Snapshot refs live under one constant namespace prefix that begins with neither `refs/heads/` nor `refs/tags/`, and no snapshot index file, manifest, separate pruning script or scheduled job is added by this change.
- **AC-SIMP-8** -- No new configuration surface beyond one environment variable: the diff adds no configuration file, no key to `.claude/harness-triggers.json`, and no settings or args-contract key.
- **AC-SIMP-9** -- *(amended)* `hooks/destructive-git-guard.py` gains no new guarded shape, spelling or subcommand: no member is added to `SHELL_KEYWORDS`, `GIT_GLOBAL_OPTS_*`, `REDIRECT_OPERATORS`, `CONTROL_OPERATORS` or `PUNCTUATION_CHARS`, and `destructive_scope()` gains no new branch. Its permitted diff is deletions, message and docstring wording, and the AC-PROD-6 narrowing.
- **AC-SIMP-10** -- The unresolved-`cd` hard refusal is deleted, not extended: `CD_UNRESOLVED_REFUSAL` and `UNRESOLVED_CWD` appear nowhere in `hooks/`, `test/`, `README.md` or `docs/` after the change, and the tests covering that refusal are removed rather than skipped. Its stated justification, that irrecoverable loss outranks a false positive, is the premise this spec removes.
- **AC-SIMP-11** -- Recovery is documented commands, not new software: the diff adds no file under `bin/`, `skills/`, `workflows/` or `agents/`, at most one new file under `test/`, at most one new file under `docs/`, no new file under `test/helpers/`, and at most one new `##` section in `README.md`.
- **AC-SIMP-12** -- *(amended)* The change adds at most one new test file, and the total test count before and after is recorded in the mutation-proofs document.

### lens-product

- **AC-PROD-1** -- Recovery is demonstrated on at least one command the existing detector does NOT refuse today, so the increment over the detector is observable rather than notional. Measured at HEAD: `rm <tracked-file>` and a truncating redirect over a tracked file both exit 0 through the hook. This is a demonstration of a command-agnostic mechanism, not a claim of coverage for non-git destruction.
- **AC-PROD-3** -- The route to recovery is stated at the moment of loss: `hooks/destructive-git-guard.py`'s refusal message names the recovery command, asserted by running the hook against a dirty fixture and matching stderr against the command string AC-OPS-11 documents. At HEAD it offers only advice about avoiding the loss, not about undoing one.
- **AC-PROD-4** -- A user can tell what is and is not protected before relying on either mechanism: README names in one place the loss paths the snapshot does NOT cover (untracked files, ignored files, work never written to disk, a repository the command `cd`s into, and destruction by non-Bash tool calls such as Write and Edit), and the install snippet is preceded by a statement of what the hook writes into the reader's own repository and how to remove it. Asserted statically in `test/static-checks.test.js`.
- **AC-PROD-6** -- Writing or quoting a guarded command as text is not refused: a Bash call whose only occurrence of a guarded command is inside a here-document body, a quoted string, or a `grep` or `echo` argument exits 0. RED at HEAD, where a here-doc body mentioning a guarded command is refused although nothing executes, and this repo's own README and `docs/` carry 59 occurrences of that text.

### lens-data

- **AC-DATA-1** -- Taking a snapshot does not modify the repository it snapshots: `shasum .git/index`, the full `git status --porcelain` output, `git diff` output and the mtimes of every worktree file are byte-identical immediately before and after the hook runs, and no new file appears inside the working tree, so the temporary index copy lives outside the repository. [merges AC-QA-4]
- **AC-DATA-2** -- Snapshotting succeeds while another process holds `.git/index.lock`, and the hook never creates or leaves `.git/index.lock` itself: with the lock file present, a snapshot ref exists afterwards and the lock file is still the exact file the test created. [merges AC-QA-7]
- **AC-DATA-3** -- The snapshot commit is anchored by a ref before the hook exits and survives `git reflog expire --expire-unreachable=now --all && git gc --prune=now`, after which `git cat-file -t <snapshot>` still returns `commit` and the documented recovery still restores the content. [merges AC-QA-10, AC-OPS-2]
- **AC-DATA-4** -- `git stash create` output is used only when its exit status is 0 AND stdout matches the repository's object-id format exactly: driving a real merge conflict produces no ref, no ref anywhere in the namespace holding a non-commit value, and no blocked Bash call. Measured: in that state stdout carries `f.txt: needs merge`, which a naive command substitution captures as if it were a sha.
- **AC-DATA-6** -- Snapshot refs are keyed per checkout: with a repository plus a linked worktree holding different content at the same path, resolving "the latest snapshot" from the main checkout yields the main checkout's content and from the worktree yields the worktree's. Measured today with one shared ref name, the main checkout resolved to the worktree's content.
- **AC-DATA-7** -- A later snapshot never destroys an earlier one: after snapshot A then snapshot B in the same checkout, A's content is still recoverable byte-identical. Measured: `git update-ref` on a custom namespace writes no reflog by default, so a single mutable ref silently discards A.
- **AC-DATA-8** -- Pruning is bounded, in both directions, and runs last: after N+5 snapshots at most N remain, the most recent is always among them, pruning never removes a snapshot belonging to a different checkout, and with the new snapshot's ref creation forced to fail no previously existing snapshot has been removed. [merges AC-QA-13, AC-OPS-7]
- **AC-DATA-9** -- SIGKILL at each of at least two points (during snapshot creation, and between object creation and ref update) on a repo of at least 5000 tracked files leaves the repository indistinguishable from "no snapshot taken": `.git/index` byte-identical, `git status --porcelain` byte-identical, no `.git/index.lock` the test did not create, no non-commit value in the namespace, and no temporary file inside the working tree. [merges AC-QA-9]
- **AC-DATA-10** -- The recovery command written in README, extracted from the README text by the test rather than retyped, restores byte-identical content after a real destructive command, across five payload cases in one repository: a modified tracked file; a tracked file whose staged content differs from its worktree content (which must restore as `MM`, since the obvious command without `--index` was measured to collapse it to ` M` and silently lose the index state); a newly set executable bit; non-ASCII and CRLF content; and a tracked file deleted from the worktree. [merges AC-QA-3, AC-QA-20]
- **AC-DATA-11** -- Recovery is non-destructive by default: when the working tree at recovery time has an uncommitted change to a path the snapshot also carries, the documented default either refuses with a message naming the conflicting path or writes the recovered content somewhere that is not that path. It never leaves conflict markers in a tracked file and never reports success when it did not fully apply. Measured: `git stash apply --index` there produced `CONFLICT (add/add)`, wrote `<<<<<<< Updated upstream` into the file, and printed `Index was not unstashed`.
- **AC-DATA-12** -- Recovery is re-runnable: running the documented recovery command twice in succession leaves the same `git status --porcelain` output and the same file shas as running it once.
- **AC-DATA-13** -- A snapshot contains exactly the tracked changes and nothing else, and README states plainly that untracked and ignored files are NOT recoverable from a snapshot. [merges AC-QA-14]
- **AC-DATA-16** -- *(amended)* The hook snapshots the repository at the payload `cwd` and does not attempt to resolve the command's real target: with payload cwd in dirty repo A and a command targeting dirty repo B, exactly one snapshot of A exists afterwards and none of B, and README documents that gap as a limitation rather than claiming coverage.
- **AC-DATA-17** -- The snapshot hook is its own entry in `hooks/hooks.json` with its own opt-out variable: `hooks.json` contains two distinct PreToolUse Bash entries naming two different scripts, and with the detector's opt-out active (`HARNESS_ALLOW_DESTRUCTIVE_GIT=1`) a snapshot ref is still created. The detector's false refusals are its documented failure mode, so a user silencing it must not silently lose recovery with it.

### lens-architecture

- **AC-ARCH-1** -- The snapshot hook decides what to snapshot without reading the Bash command text and has no dependency on `hooks/destructive-git-guard.py`: its source contains no import of, subprocess call to, or copied shape list from that module, and three payloads sharing an identically dirty fixture but differing in `command` (a guarded destructive command, an unrelated `ls`, and text the tokenizer cannot parse) produce the same snapshot. Proved load-bearing by making the hook branch on the command string and watching the test fail.
- **AC-ARCH-2** -- The two PreToolUse Bash hooks are independent in both directions, because matching hooks run in parallel with no ordering guarantee: the snapshot hook is an ordinary `hooks.json` entry with no wrapper or dispatcher, `test/static-checks.test.js`'s set-equality check passes unmodified and still fails when any single registration is deleted, the snapshot hook still records a snapshot for a payload the detector refuses with exit 2, and the detector's refusal text and exit code are unchanged when the snapshot hook is absent or exits non-zero. [merges AC-QA-12]
- **AC-ARCH-3** -- Every `hooks/*.py` that shells out to git strips the `GIT_*` namespace to the same allowlist, enforced by a test that ENUMERATES `hooks/*.py` rather than naming files, so a git-invoking hook added later fails the suite when it omits the scrub. The current parity guard names one file by path and is structurally blind to a second copy. Proved by removing the scrub from the new hook, watching the enumerating test fail by name, and restoring it.
- **AC-ARCH-4** -- The repository is resolved from the payload's `cwd` field, never from the hook process's own working directory and never by parsing the command, and the consequence is stated as a limitation in README. This criterion exists to stop the recovery layer re-importing the command parser whose unbounded input language is the reason this spec exists.
- **AC-ARCH-5** -- The hook declares its wall-clock deadline as one named constant strictly less than the timeout registered for it in `hooks/hooks.json`, asserted by a test that reads both artefacts rather than hard-coding either number, and declares the maximum git subprocess invocations per call, counted via a stub `git` earlier on PATH in both the clean and dirty cases. On PreToolUse a timed-out hook does not block the call, so a hook that overruns silently lets the command run unprotected; the existing detector sets its per-subprocess timeout equal to the registered timeout, which is the defect this prevents being copied.
- **AC-ARCH-6** -- The ref namespace is a single named constant in the hook module, a test imports that constant as data and asserts the same literal appears in README's recovery section, and no literal ref name is duplicated in the hook source. Proved by renaming the constant, watching the test fail, and restoring it.
- **AC-ARCH-7** -- Pruning happens inside the same hook invocation path that creates snapshots, requiring no scheduled job, no separate command and no operator action: N+1 snapshots driven through the entrypoint alone leave at or below N with the oldest dropped, and no new file appears under `bin/` or `.github/workflows/` to do the cleanup.

### lens-operability

- **AC-OPS-1** -- The snapshot hook never blocks a Bash call: it exits 0 for every input, including a malformed or empty payload, a `cwd` that is not a git repository or does not exist, an unborn HEAD, an unresolved merge conflict, a `.git` directory that is not writable, and a `PATH` with no `git` on it. Exit code 2 is never reachable from this hook. [merges AC-SIMP-4's runtime half]
- **AC-OPS-3** -- Each state in which no snapshot can be taken produces a distinct warning naming the repository path, the state and git's own stderr, with no generic fallback: unborn HEAD, an unresolved merge or rebase, and index-lock contention. README lists all three as limitations by name.
- **AC-OPS-5** -- A snapshot failure leaves a durable, bounded trace an operator can find later: the hook appends a record naming the timestamp, repository path, failing state and git's stderr to a file inside the repo, README names that exact path and the command to read it, twenty successful snapshots leave the file's size unchanged, the file stays within a stated byte or line ceiling with the OLDEST entries evicted first, and repeated identical failures are deduplicated or rate-limited. [merges AC-OPS-6]
- **AC-OPS-8** -- Snapshot refs do not disturb routine tooling, and where they ARE visible is documented honestly: with at least fifty snapshot refs present, `git status --porcelain`, `git log --oneline -1`, `git branch -a` and the refs selected by the default push refspec are byte-identical to the same repo without them, and README states plainly that any all-refs walk (`git log --all`, `git fsck`, `git push --mirror`, an IDE history view) WILL show snapshot commits. Measured: `git log --all --oneline` went from 1 commit to 209.
- **AC-OPS-9** -- The kill switch works mid-incident and its scope is measured rather than asserted: the documented way to disable snapshotting takes effect on the next Bash call without restarting the session, and README states, with the measurement behind it, whether an environment variable exported inside a Bash tool call reaches the hook process at all. If it does not, the same correction is applied to the existing `HARNESS_ALLOW_DESTRUCTIVE_GIT` "exported for the session" wording.
- **AC-OPS-10** -- Uninstall is complete and executed, not asserted: README gives the exact commands to remove the hook registration AND to delete every snapshot ref and reclaim the disk, states plainly that removing the hook alone leaves the refs and their disk behind, and a test seeds a repo with snapshot refs, runs the documented deletion command verbatim and asserts zero remain with the repository otherwise unchanged.
- **AC-OPS-11** -- Recovery works from a cold start with no prior knowledge: one documented command lists the snapshots for the current repository with timestamp, branch, originating worktree and changed-file count, and one documented command restores a chosen one. A test destroys an uncommitted edit, runs those two commands verbatim and asserts the content is restored. README also states that snapshot refs live in the shared ref store and therefore survive `git worktree remove`. [merges AC-PROD-2, AC-OPS-12]
- **AC-OPS-13** -- The per-call cost is measured and capped: `docs/` records the overhead the hook adds to a Bash call, naming the fixture (repository file count, dirty file count) and the method, and a test asserts the median of at least five invocations against that fixture stays under a stated ceiling with at least a 5x margin so it cannot become flaky. Measured baselines: existing detector 22.6 ms benign and 33.0 ms destructive; `git stash create` 16.4 ms at 200 files and 25 to 30 ms at 4000 to 5000 files; `git status --porcelain` 10.5 ms. [merges AC-QA-16]
- **AC-OPS-14** -- Both PreToolUse hooks are registered as independent entries and the install documentation cannot drift from the registration: `hooks/hooks.json` registers the snapshot hook separately, README's manual-install `settings.json` snippet includes it, README's install and re-sync section names the new hook file, and a static test asserts the set of hooks in `hooks.json` equals the set in the README snippet so adding one and not the other fails the suite. [merges AC-QA-18]

### Vetoed at planning

`lens-simplicity` holds a veto at planning over any requirement not traceable to
a stated acceptance criterion. It cannot override irrecoverable data loss,
security, or the accessibility floor. Every drop and every amendment is recorded
here with its reason.

**Dropped outright**

| Dropped | Raised by | Reason |
|---|---|---|
| The "cheap skip when nothing changed since the last snapshot" in known-hard question 2 | the spec itself | Measured: the skip saves about 10 ms of a roughly 49 ms hook and needs either a `git status` costing 15 ms of the 25 ms it saves, or cross-invocation state that can go stale and silently stop snapshotting. Encoded as AC-SIMP-5. |
| Capturing untracked files (known-hard question 1) | left open by the spec | Closed as out of scope. Measured: no guarded git shape destroys an untracked file, `git stash create` already excludes them, and including them would write an agent-authored `.env` into a ref on every Bash call, turning the top-ranked risk from theoretical to certain. `lens-data` owned this call and made it. Reopening it requires naming an observed loss of untracked work caused by a command this hook runs before. |
| A recovery CLI under `bin/` | `lens-operability` finding 5 | Measured: listing and restoring are existing git commands. A wrapper is a new executable, a new install step and one more surface between the operator and a command that already works. The substance survives as AC-OPS-11 and AC-PROD-3. Encoded as AC-SIMP-11. |
| Any further spelling added to `hooks/destructive-git-guard.py` | implicit in "the detector stays" | Three rounds of adding spellings produced 3, then 11, then 6+ new holes. Freezing the guarded-shape set is the whole point of the frame change. Encoded as AC-SIMP-9. |
| A separate pruning script or scheduled job | `lens-security` AC-SEC-4, `lens-data` AC-DATA-8 read as needing one | This repo has twice measured accumulation as the failure mode when cleanup lives in a separate step. Pruning moves inside the hook: AC-ARCH-7. The retention requirement itself is untouched. |
| Parsing `cd` or `git -C` out of the command to find the real target repository | `lens-data` AC-DATA-16, first clause | **Orchestrator arbitration, not a simplicity veto.** Round three's `cd` chasing produced both the false refusal and six new holes, and re-importing that parser reinstates the frame this spec exists to abandon. AC-DATA-16's own fallback clause is adopted instead: snapshot the payload `cwd`, document the gap. This is the one call a human may want to overturn, because it is a real uncovered loss path traded against a measured failed approach. |
| AC-QA-7 (index-lock miss discoverable through the recovery surface) | `lens-qa` | Subsumed, not rejected: with the private-index form measured to succeed while the lock is held, a lock-contention miss is no longer the expected path. AC-DATA-2 asserts the stronger property directly. |

**Amended, with the overriding lens named**

| Criterion | Amendment | Reason |
|---|---|---|
| AC-SIMP-5 | The bans on `open(`, `tempfile`, `mkstemp` and on more than two subprocess calls are removed; the ban on cross-invocation cached state is kept | Overridden by irrecoverable data loss (`lens-data` AC-DATA-1, AC-DATA-2, AC-DATA-9). The private index copy the contention fix requires cannot be written without a temp file, and in-hook pruning cannot run in two subprocess calls. The measured rationale behind the criterion was the cache, and that part stands. |
| AC-SIMP-6 | The ban on `GIT_INDEX_FILE` is removed; the bans on `git add`, `--include-untracked`, `-u` and `-a` are kept | `GIT_INDEX_FILE` is the mechanism that makes the snapshot lock-free and non-mutating. The criterion's purpose, keeping untracked files out, is unaffected. |
| AC-SIMP-7 | "Exactly one constant ref name, history carried by its reflog" becomes "one constant namespace prefix, one ref per snapshot, keyed per checkout" | Overridden by irrecoverable data loss (`lens-data` AC-DATA-6, AC-DATA-7). Measured: linked worktrees share a ref store, so a single mutable ref returned another checkout's content on restore, and silently discarded the overwritten snapshot. The rest of the criterion (no manifest, no separate pruning script) stands. |
| AC-SIMP-9 | "Net lines <= 0" is removed; "no new guarded shape, spelling or normalisation stage" is kept, and the AC-PROD-6 narrowing is permitted | `lens-product` supplied the criterion the veto asks for: the here-doc false refusal is RED at HEAD, is named in this spec's own Problem section, and its escape hatch disarms every genuine refusal for the session. Suppressing text-only occurrences reduces coverage rather than extending the blocklist, so it does not reopen the arms race the criterion exists to close. |
| AC-SIMP-12 | The cap of 25 new tests is removed; "at most one new test file, counts recorded" is kept | Arithmetically incompatible with the surviving set: 22 of the criteria belong to security or irrecoverable data loss and cannot be vetoed, and each is proven by an executed test. A cap that would force dropping one of those is a cap on the wrong axis. |
| AC-OPS-6 | Folded into AC-OPS-5 as one criterion | Deduplication, not a veto: bounding the failure record and creating it are one mechanism and one test. |
| AC-DATA-16 | First clause dropped, fallback clause kept | See the parsing row above. |

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
