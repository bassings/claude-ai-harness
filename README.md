# claude-ai-harness

A multi-lens planning and review harness for [Claude Code](https://code.claude.com),
orchestrated by [dynamic workflows](https://code.claude.com/docs/en/workflows)
rather than by an agent's chat context.

One agent carrying six concerns does the first two well. This harness splits
non-trivial planning and review across **single-focus specialist lenses**
(security and privacy, QA, data integrity, accessibility, design, architecture,
operability, product, simplicity) that run **in parallel as subagents**, each
with one job and no licence to drift into another's. A deterministic workflow
script does the orchestration, so lens reports never flood your conversation's
context window: only one synthesised report comes back.

The contract between planning and review is the **acceptance criterion**. At
planning, each lens writes numbered `AC-<LENS>-<n>` criteria into your spec. At
review, each lens verifies its own criteria against the built change. A review
finding with no AC behind it is recorded as a spec bug: that list is how the
harness improves rather than merely runs.

## Why workflows

Agent-orchestrated multi-agent review has a structural problem: every lens
report lands in the orchestrating conversation's context, and long sessions
lose the early reports to compaction. A dynamic workflow moves the plan into
code: the script holds the loop, the fan-out and the intermediate results in
an isolated background runtime, and the model's context holds only the final
answer. The orchestration is also rerunnable and diffable, because it is a
file, not a chat transcript.

## Requirements

- Claude Code **v2.1.154+** with dynamic workflows available (all paid plans;
  on Pro, enable Dynamic workflows in `/config`).
- No API key needed: workflows bill against your Claude Code subscription.

## Install

### As a plugin

```
/plugin marketplace add bassings/claude-ai-harness
/plugin install claude-ai-harness@claude-ai-harness
```

Then run the workflows namespaced:

```
/claude-ai-harness:plan-cycle {"spec": "specs/MY-FEATURE.md"}
/claude-ai-harness:review-cycle
```

### Manual copy (per-user, unnamespaced)

The installer accepts an empty directory, a directory holding `settings.json`
or `projects/` (a fresh `~/.claude`), and an existing install (`AGENT-HARNESS.md`,
`workflows/` or `skills/`). It refuses, writes nothing, and prints the one
command that proceeds anyway, for any other non-empty directory and for any
directory holding a typical home-directory entry (`.zshrc`, `.bashrc`,
`.bash_profile`, `.profile`, `.ssh`, `.config`, `Documents`, `Desktop`, `Library`
or `Downloads`),
whatever markers it also holds. Each file is written to a temporary name beside
its destination and renamed into place, so a stopped install never leaves a
half-written file at the destination. If an install is killed outright
(`SIGKILL`), one `<file>.harness-tmp.<pid>` stray can remain beside the
destination; it is never at the destination path, nothing loads it, and it is
safe to delete by hand. The installer never deletes one, because it may belong
to an install that is still running. A destination file that was a symlink is
replaced by a regular file (the install says so, naming the link target), and its
backup holds the target's bytes, not the link. A directory where a file should go
stops the install. If an install stops part-way it says so ("INCOMPLETE"), how
many files it had updated, and to re-run it or restore from the printed backup
directory. That restores files the install overwrote; files it added are in its
`updated:` lines and stay until you delete them by hand.
Run one install at a time: two installs into the same destination at once can
stop each other with INCOMPLETE, because each checks its backup against a file
the other has just replaced. Nothing is lost; re-run the installer.
Before it replaces a file that differs, it copies the old
version under `~/.claude/.harness-backups/<UTC timestamp>/` and prints that
path; the newest 10 backup directories are kept. It warns, naming which, when
the checkout is not on the default branch or has uncommitted changes to tracked
files, because that code goes live on your next session.

```bash
git clone https://github.com/bassings/claude-ai-harness
claude-ai-harness/bin/install.sh            # install, then verify
claude-ai-harness/bin/install.sh --check    # verify only, non-zero on drift

# What that does, if you would rather run it by hand. Prefer the script: it
# installs exactly what workflows/lib/install-consistency.mjs calls the
# consumer subset, skips anything the repo does not track (so build output
# never lands in your harness), and verifies the result. These commands do not.
cp claude-ai-harness/agents/*.md ~/.claude/agents/
cp -r claude-ai-harness/workflows/. ~/.claude/workflows/
cp -r claude-ai-harness/skills/. ~/.claude/skills/
cp -r claude-ai-harness/hooks/. ~/.claude/hooks/
cp claude-ai-harness/AGENT-HARNESS.md ~/.claude/
```

`agents/*.md` includes `implementer.md`: the agent `tdd-task` and
`conduct-plan` dispatch to for all build work (every other shipped agent is
read-only -- "lenses analyse, `implementer` builds"). It ships as a generic
default, not a fixed dependency: replace it with your own
`~/.claude/agents/implementer.md` to change how implementation is done
without touching any workflow script. Because of that, it is deliberately
excluded from the drift comparison below (`AC-OPS-4`) -- a replaced
implementer is never reported as a stale install.

Then **start a new Claude Code session** -- the workflow scripts are read
when a session starts, so an install performed inside an already-open session
is invisible to it (see the next section) -- and in any project:

```
/plan-cycle {"spec": "specs/MY-FEATURE.md"}
/review-cycle
```

### Making a change live: copying the files is not deploying them (AC-OPS-4)

The harness RUNS from `~/.claude`, not from your checkout, so a change can
merge, pass every test and change nothing on a real run. Measured 2026-09-14:
two merged PRs had not reached the install. Run `bin/install.sh`; `--check`
writes nothing and exits non-zero when the install is behind, so it suits a
hook. What it installs is decided by `workflows/lib/install-consistency.mjs`,
the same module the weekly drift check reads.

Copying **source** is not deploying. The two halves of
`workflows/` reach a running session by different routes, they go live at
different moments, and the gap between them is the failure mode this section
exists to prevent.

**The top-level workflow scripts** -- `plan-cycle.js`, `review-cycle.js`,
`tdd-task.js`, `optimise-cycle.js` -- are captured when a Claude Code session
starts. Both the list of names and each script's contents. Invoking
`/plan-cycle` or `Workflow({name: "plan-cycle"})` runs that capture, not the
file on disk. Measured in this repo on 2026-08-18, with zero agents spawned:

- A workflow file written into `~/.claude/workflows/` mid-session and
  invoked by name returns `Workflow "registry-probe" not found. Available:
  deep-research, optimise-cycle, plan-cycle, review-cycle, tdd-task` -- the
  name list is fixed at session start.
- `throw new Error('PROBE-FRESH-READ-MARKER')` inserted as the first
  statement of the installed `plan-cycle.js`, then invoked by name, **did not
  throw**. The run failed with `plan-cycle requires args.spec`, which is the
  pre-edit code path. The invocation reported its script as a session-local
  snapshot at `workflows/scripts/plan-cycle-wf_<runid>.js`, 21753 bytes
  against the edited file's 21797, and that snapshot did not contain the
  marker.

**`workflows/lib/*.mjs`** -- `ledger-append.mjs`, `optimise-read.mjs`,
`redact-transcript.mjs`, `install-consistency.mjs`, `stray-snapshot.mjs`, `spec-writeback.mjs` -- are not part of that capture. A workflow script has
no filesystem access, so it instructs an agent to shell out to
`node ~/.claude/workflows/lib/<file>.mjs` (see the resolution order in
`plan-cycle.js:100-106`, global mirror first). `node` reads the file when the
process starts, so a copied `.mjs` is live on the very next run, in the same
session.

`bin/install.sh --check` detects the file-level half of this: it compares every
file in the consumer subset and exits non-zero when the install is behind. What
it cannot see is a session that ALREADY loaded a stale script before you
re-installed; only a restart fixes that.

The `schema_version` staleness signal described further down does **not** detect
a stale top-level workflow script either: that fix class bumps no
`SCHEMA_VERSION` and adds no ledger field, so a session running last week's
`plan-cycle.js` produces a ledger indistinguishable from a current one. So the
two signals cover different things -- `--check` compares files on disk, the
schema version compares what a run wrote -- and neither covers an already-loaded
script. The restart is still the control there.

So there are two rules, and they are not the same rule:

| What you changed | What makes it live |
|---|---|
| `workflows/lib/*.mjs` | `cp -r`. Live on the next run of the current session. |
| A top-level workflow script | `cp -r`, **then restart the session**. Or invoke it as `Workflow({scriptPath: "~/.claude/workflows/<name>.js"})`, which reads the file at invocation time (measured: the same probe file that failed to resolve by name ran successfully via `scriptPath`). |

If you changed only `workflows/lib/` and want the narrower command, the pair
scoped to that directory is the one partial copy that is fully effective,
because nothing about `lib/` is snapshotted:

```bash
cp -r claude-ai-harness/workflows/lib/. ~/.claude/workflows/lib/
diff -rq claude-ai-harness/workflows/lib ~/.claude/workflows/lib
```

It is not a substitute for the whole-tree copy after any other change, and it
is deliberately the *only* subset documented here: an earlier revision of this
section named "the four files this PR touched", a list already stale by the
time that same review landed six further commits touching all six files under
`workflows/`. Any hand-maintained per-PR enumeration goes stale the moment a
later round adds one more file.

**The whole-tree copy, then, opens a skew window rather than closing one.**

```bash
cp -r claude-ai-harness/workflows/. ~/.claude/workflows/
diff -rq claude-ai-harness/workflows ~/.claude/workflows   # exits 0 when the SOURCE is current
```

After that pair passes, the libs are new and the top-level scripts running in
any already-open session are still old. `diff -rq` reports success, because it
compares files and the files do agree. It cannot see that the session is not
running them. **`diff -rq` proves the source is current; it does not prove the
code is live.** Treat it as necessary and not sufficient, and close the window
by restarting the session -- that is the only action that promotes a top-level
script, and it is one action rather than an ordering discipline.

This supersedes an earlier revision of this section, which prescribed syncing
`optimise-read.mjs` (the reader) before the top-level scripts (the writer) so
the reader would never lag. Under the mechanism measured above that ordering
cannot be honoured mid-session: the reader goes live immediately and the
writer cannot go live at all until restart, so every mid-session sync produces
newer-reader-with-older-writer regardless of the order the files were copied
in. That direction is the comparatively safe one -- an older writer simply
never emits the fields a newer reader looks for, and those render as the
explicit "unavailable (installed optimise-read.mjs predates this field)"
marker rather than a wrong number. The dangerous direction, a newer writer
against an older reader, is now reachable only by copying the top-level
scripts and restarting **without** copying `lib/`, which the whole-tree `cp -r`
above does not do.

### Detecting a stale install without running the commands (AC-OPS-11)

A stale `workflows/lib/` mirror is *sometimes* visible in the optimiser's own
report: `ledger-append.mjs`'s `SCHEMA_VERSION` has been bumped twice, 1 to 2
by the plan-identity canonicalisation change and 2 to 3 by the validator
changes described under "Run ledger" below, and `optimise-read.mjs ledger`'s
`perRepo[].schemaVersionsSeen` reports the schema-version mix actually seen
per repo, so a stale installed writer still emitting an older
`schema_version` surfaces there instead of failing silently.

**This signal does not cover every staleness class**, and it covers none of
the session-snapshot class above. Additive, optional fields
(the start/terminal exception guard, `invalid_ac_ids_dropped`, `ac_id_raw`,
`ac_verdicts_truncated`) bump no `SCHEMA_VERSION` by design, so a stale top-level script or a stale
`optimise-read.mjs` reading a newer ledger produces no `schemaVersionsSeen`
difference at all. What covers that gap is the report's own rendering: a
genuinely stale or absent reader field renders as an explicit "unavailable"
marker rather than a confident zero. The markers are a second line of defence
for when the checks above were skipped, never a replacement for them.

## Setup: activate the local gate

The pre-push gate lives in `.githooks/pre-push` and runs the full suite before
anything leaves your machine. **It is inert until you point git at it**, and it
fails silently: git ignores an unset `core.hooksPath` without a word, so a push
succeeds and looks gated. Measured -- with the hook present, executable and
unconditionally `exit 1`, `git push` returned 0 and the hook never printed.

```bash
sh bin/setup-hooks.sh
```

That sets `core.hooksPath` to the **relative** path `.githooks` and verifies it
took effect. Relative matters: an absolute path is resolved against each linked
worktree, so a worktree would run the main checkout's copy of the hook,
including a stale copy from a branch predating it.

Because this is per-clone local config that no repository can set for you, CI
is the backstop rather than the belt: `.github/workflows/ci.yml` runs the same
suite on every push and pull request, plus a weekly scheduled secret-scanning
sweep over all history. Treat the hook as the fast local signal and CI as the
one that actually gates.

## Usage

**Planning** (once per spec, before implementation):

```
/plan-cycle {"spec": "specs/MY-FEATURE.md"}
```

Triggered lenses read the spec and the relevant code in parallel, then a
synthesis step applies the simplicity veto, merges the surviving criteria and
writes an `## Acceptance criteria` section into the spec file.

**Review** (per push, before the PR):

```
/review-cycle
/review-cycle {"base": "develop", "spec": "specs/MY-FEATURE.md"}
/review-cycle {"lenses": ["lens-security", "lens-qa"]}
/review-cycle {"adversarial": true}
```

The scope step diffs your branch against the base (default branch if omitted)
and pins the tip SHA. Lenses trigger deterministically from the changed paths,
review in parallel in **isolated git worktrees** (so mutation experiments are
safe), and a synthesis step deduplicates findings, arbitrates conflicts by a
fixed precedence order (irrecoverable data loss, security, accessibility floor,
operability, product and design intent, performance) and returns one report.
Ties above the accessibility line are escalated to you, never resolved
silently.

`adversarial: true` adds `reviewer-verification`: an adversarial fresh-eyes
pass with no plan context, as a counterweight to lenses that verify only their
own criteria.

**Building** (one scoped change, TDD enforced by control flow):

```
/tdd-task {"task": "reject a settings save whose path escapes the soft chroot", "suite_command": "make verify-fast"}
```

Four phases: a test-writer writes only the failing test; an independent
verifier runs it and must confirm it fails **for the right reason** (the
missing behaviour, not a typo or import error) — the implementation phase is
literally unreachable in the script until then; the implementer writes the
minimum code with the test files frozen; a final verifier confirms the pass,
runs the broader suite, and compares test-file hashes against RED time, so a
test edited into passing voids the run instead of shipping. Three failed
attempts at either gate stops the workflow with "the frame is wrong" rather
than trying a fourth.

**Optimising the delivery cycle** (scheduled, weekly per repo by default —
see "Delivery optimiser" below; never per-PR):

```
/optimise-cycle
```

Read-only: your session collects the ledger, GitHub Actions and git data with
one collector program, the workflow analyses it, and a result check places a
ranked, cited report of proposed changes in the repository (see "Delivery
optimiser" below for the steps) — it never applies a change itself.

## Per-repo trigger customisation

The review cycle ships generic path globs for deciding which lenses a diff
triggers. To tune them for a repo, add `.claude/harness-triggers.json` at the
repo root; any key you supply replaces the default list for that key:

```json
{
  "ui": ["src/components/**", "**/*.vue", "e2e/**"],
  "data": ["migrations/**", "src/db/**"],
  "architecture": ["package.json", "src/core/**"],
  "operability": ["Dockerfile", "deploy/**", ".github/workflows/**"]
}
```

`lens-security` and `lens-qa` always run at review. `lens-simplicity` always
runs at planning (and only at planning: its veto is spent before anything is
built, the only point where cutting scope is free).

**The keys are not fully independent.** At review, the `ui` globs also trigger
`lens-architecture`, because that lens holds the only duty covering dead code a
change created and did not remove, and the `architecture` globs are dependency
manifests a components-and-styles diff never touches. Two consequences worth
knowing before you tune:

- Narrowing `ui` switches off **four** lenses together for the paths you drop:
  `lens-design`, `lens-accessibility`, `lens-product` and `lens-architecture`.
- Narrowing `architecture` does **not** switch `lens-architecture` off for UI
  changes. That path is deliberately not overridable, since a repo naming only
  wiring files there would otherwise disable the lens for exactly the change
  class that leaves orphaned code behind.

`AGENT-HARNESS.md` records the reasoning, and the condition under which the UI
trigger should be narrowed again if it proves not to earn its cost.

**This override fails closed, not silently.** `.claude/harness-triggers.json`
is read and transcribed by an LLM step, not by the workflow script itself
(dynamic-workflow scripts have no filesystem access), so a transcription
failure is a real risk: the file exists but its contents do not arrive. If
that happens, `review-cycle.js` **aborts the review** rather than silently
falling back to the harness defaults -- a review conducted with the wrong
lens roster and no visible sign of it is worse than one that stops and says
so. Two related failure modes, both intended:

- **A malformed override file blocks every review** until it is fixed: only
  the four known keys (`ui`, `data`, `architecture`, `operability`) are
  accepted, and each value must be an array of glob strings. An unknown key,
  a non-array value, or a non-string glob aborts the run, naming the
  offending key.
- **A transcription failure blocks the review too**, even when the file
  itself is well-formed: if the scope step reports the file exists but its
  parsed contents came back `null`, that contradiction is treated as the scope
  step having dropped the data, not as the file being empty.

Either way the abort message says what to do: re-run; if it keeps happening,
the override file is not being read. The run's log line and its ledger entry
both record which rule source actually governed the run (`repo-tuned`, with
the count of overridden keys, or `harness defaults`), so a silently-dropped
override is visible after the fact too, not only when it aborts.

## Loop conducting: long plans that cannot stall

Executing a multi-PR plan across CI waits has a failure mode the harness
alone does not fix: the orchestrating agent ends a turn "waiting for CI",
nothing ever re-invokes it, and hours are lost before anyone notices. The
conductor pieces make that state unrepresentable:

- **The invariant**: a conductor turn may end only (a) done, (b) blocked on a
  human decision with the plan marked so, or (c) holding an armed wake
  source: a background task (`gh pr checks <n> --watch`), a Monitor, or a
  ScheduledWakeup.
- **`skills/conduct-plan`** encodes each turn as one controller tick:
  reconcile the plan file against reality (`gh`, git, CI), act on every
  unblocked task (fanning out where independent), re-arm watches, log, stop.
  Run it under `/loop /conduct-plan <plan-file>` so a heartbeat guarantees
  liveness even if a watch dies.
- **`hooks/plan-guard-stop.py`** is a Stop hook that enforces the invariant
  mechanically: while `<repo>/.claude/active-plan` points at a plan with
  open tasks, a stop with no wake source armed that turn is blocked with
  instructions. Every allowed stop now states which of ten conditions
  applied (armed, a live `.claude/blocked-on-human` note, the `stop_hook_active` escape
  hatch, a bystander session, and others) via `systemMessage`, landing in
  the session record; only a stop with no `.claude/active-plan` marker at
  all stays silent, since that path fires on every ordinary stop, plan or
  not (see `docs/plan-guard-reasons-mutation-proofs.md`).

Installing as a plugin wires the hook automatically. For manual installs,
copy the hook and add to `~/.claude/settings.json`, substituting your own
home directory for the placeholder (`args` is not tilde-expanded, see the
destructive git guard section below):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "python3",
      "args": ["/ABSOLUTE/PATH/TO/HOME/.claude/hooks/plan-guard-stop.py"], "timeout": 10 }] }]
  }
}
```

## Destructive git guard

An agent ran `git checkout -- <file>` on its own uncommitted work three
times in one session and destroyed its edits each time, despite
`docs/harn-opt-2-mutation-proofs.md` forbidding it by name. Prose did not
prevent it, so the rule is now a mechanism.

**This is an accident guard, not a security boundary against an
adversary.** It exists to stop an agent destroying its own uncommitted work
by running a command whose danger it did not notice -- the same class of
mistake a careful human operator makes under time pressure. It is not a
sandbox: an adversarial payload with a reason to defeat detection has many
ways to (see "Measured-open bypass classes" below), and the escape hatch
below is deliberately easy to set inline, because it exists to let a
genuine, deliberate revert through, not to resist someone trying to get
past it.

- **`hooks/destructive-git-guard.py`** is a PreToolUse hook, matched to the
  `Bash` tool, that refuses `git checkout -- <path>`, a bare
  `git checkout <path>` with no `--` (resolved as a pathspec because it does
  not resolve as a ref -- git's own precedence for an unqualified argument,
  matched here rather than assumed; a leading ref followed by trailing paths,
  e.g. `git checkout HEAD <path>`, is handled the same way), `git checkout
  .`, `git checkout -f`/`--force` and `git switch
  -f`/`--force`/`--discard-changes` (tree-wide, like `git reset --hard`),
  `git checkout --pathspec-from-file=...`/`git restore --pathspec-from-file=...`
  (tree-wide: the paths never appear on the command line to scope against),
  `git restore <path>` (unless it is `--staged` alone, which only
  unstages), `git reset --hard`, a non-dry-run `git clean` when a REAL dry
  run of the same flags and pathspecs shows something would actually be
  removed, and `git stash drop`/`git stash clear` when the stash is
  non-empty (including a stash an earlier segment in the SAME command would
  create, e.g. `git stash && git stash drop`). `git status` (or, for
  `clean`/stash, the dedicated measurement below) decides whether there is
  something to lose on every call: a clean tree or clean named paths are
  let through untouched, including `git checkout -b`, a bare
  `git checkout <branch>` that resolves as a ref (git itself refuses the
  switch if it would actually overwrite uncommitted work), and
  `git restore --staged` -- a guard that blocks harmless commands gets
  disabled, which is worse than no guard. Refusal is exit code 2 with the
  reason on stderr (the one PreToolUse exit code Claude Code treats as
  blocking), naming its OWN reason (untracked/ignored files for `clean`,
  stash entries for `stash drop`/`clear`, a tracked uncommitted change for
  everything else) and a safe alternative.
- **Fail direction differs by rule.** `checkout`/`restore`/`reset` keep
  their original fail-OPEN posture: when the measuring `git status` call
  cannot run at all (cwd is not a repository, the call fails or times out),
  the command is ALLOWED, because the git-tracked snapshot below already
  covers tracked work regardless. `git clean` and `git stash drop`/`clear`
  fail CLOSED on the same three conditions -- an unresolvable directory, a
  failed measuring call, or a timeout -- and on two more of their own: the
  command selecting a DIFFERENT repository (`--git-dir`/`--work-tree`, or a
  `GIT_DIR=`/`GIT_WORK_TREE=` env prefix), which this guard's own measuring
  call cannot reach, and a `stash drop` naming a ref that cannot be reduced
  to a `stash@{N}` index. Neither untracked/ignored files nor a stash entry
  has any snapshot anywhere, so an unverifiable clean or stash-drop is
  refused, not guessed at. `git stash` in ANY push spelling (`-u`, `-m`,
  `-a`, bare) counts as creating the entry a later `drop` would destroy,
  read off git's grammar rather than a list of literal spellings.
- **A command over 65,536 characters (`MAX_COMMAND_LENGTH_CHARS`) is
  handled BEFORE any tokenising runs**, at every recursion level (the whole
  command, and each `bash -c` body or `$(...)`/backtick substitution
  independently) -- K1 review round 2, after CI measured a 1 MiB command
  making Python's `shlex` tokeniser (which reads one character at a time)
  take roughly 8 seconds on its own, comfortably over a 10-second test
  budget under ordinary machine contention. If the raw text contains the
  substring `git` anywhere (a single cheap linear scan, including inside a
  heredoc body or a quoted string), it is REFUSED unseen -- deliberately
  NOT the same "a shape the tokenizer cannot parse falls through allowed"
  rule this guard otherwise uses (see "Deliberately out of scope" below):
  an over-cap command could still, in principle, be parsed, just not
  within a safe wall-clock budget, and skipping the parse to answer
  "allowed" would let a real `git reset --hard` hidden inside enough
  padding straight through. If the raw text has NO `git` substring at all,
  it is ALLOWED without being parsed: every rule this guard can ever fire
  needs a real git invocation, and a git invocation always contains those
  three letters somewhere, so a command that never mentions `git` cannot
  possibly match any rule this guard has. **K1 review round 3** added this
  half: refusing every over-cap command, regardless of content, blocked
  ordinary work -- this hook runs on every Bash call, and an agent
  routinely writes a large file through one (a heredoc, generated test
  data); measured, `echo hi ` followed by 70,000 `x`s was refused purely
  for being long. **Accepted cost**: because the `git` check runs on the
  RAW text before heredoc-body stripping, an over-cap heredoc body that
  only MENTIONS `git` (and would ordinarily be inert once parsed) is still
  refused -- confirming it is really inert needs the same expensive parse
  this cap exists to avoid, so this is deliberate, not a bug, and a test
  pins it so the cost stays a choice.
- **Registered timeout.** `hooks/hooks.json` gives this hook 60 seconds
  (raised from 10 in K1 review round 1), strictly greater than
  `WORST_CASE_SEGMENT_SECONDS` (30s: `MAX_SUBPROCESS_CALLS_PER_SEGMENT` x
  `SUBPROCESS_TIMEOUT_SECONDS`, the most subprocess calls a SINGLE segment's
  measurement step can make) -- checked by `hooks/test_hook_timeout_budget.py`
  against those named constants, not a hard-coded number. This matters
  because a Claude Code PreToolUse hook that TIMES OUT does not block the
  tool call, it lets it PROCEED: a registered timeout at or below the
  guard's own worst case would turn a genuinely slow (not hung) git call
  into a silent allow of exactly the command this guard exists to refuse.
  **This is a documented limit, not a closed gap**: a single Bash command
  with many `&&`/`;`/newline-chained segments, or many sibling `$(...)`
  substitutions, sums EACH segment's own worst case -- there is no ceiling
  on how many segments one command can contain, so a sufficiently long
  chain can still exceed any fixed timeout regardless of this constant.
- **Normalisation layer**, between the raw shell string and the matcher
  above (added after a review found eight distinct spellings of the same
  guarded commands walking straight past it): a bare newline separates
  commands exactly like `&&`/`;`, so a destructive call on any line of a
  multi-line Bash tool call is still caught; a shell redirect (`>`,
  `2>`, ...) and its target are dropped before anything can be read as a
  pathspec; `git` is recognised by binary basename, so `/usr/bin/git` and a
  prefixed form like `git -C <dir> checkout -- <path>` still reach the
  matcher, and `-C`'s directory becomes the one the safety check actually
  runs against; a bundled short-flag cluster (`git checkout -fq`) is
  expanded so `-f` is still seen as force. `$(...)` and backtick command
  substitution are extracted (nesting depth-counted, and never one sitting
  inside single quotes, which bash never expands) and independently
  re-evaluated the same way, so `echo $(git reset --hard)` is caught while
  `echo '$(git reset --hard)'` stays inert text. Before any of that the text
  is read as the shell reads it: a backslash-newline outside single quotes
  joins the two lines, and a `#` comment (which starts only at the beginning
  of a word, never in the middle of one or inside quotes) ends at its own
  newline, so the line after a comment is still checked. A pathspec the
  shell builds at run time (`$X`, `${X}`, `$(...)`, backticks, `{a,b}`) on
  `git checkout`/`git restore` is whole-tree scope, so a dirty tracked file
  anywhere refuses it. The operand of `--detach`, `-t`/`--track` and
  `--source`/`-s` is a ref, so those are not refused, and `git checkout -`
  is not either. A bare run-time word with nothing to say whether it is a
  branch or a file IS refused on a dirty tree, and so is any `@{...}`: that
  is a documented over-block, because a file reverted by mistake is lost and
  a refusal costs one retry with the override
  (`HARNESS_ALLOW_DESTRUCTIVE_GIT=1`, put immediately before the git command
  that was refused, or before the wrapper if it runs through `env`, `xargs`,
  `command`, `nohup`, `exec` or `timeout`). For a branch switch, `git switch -` or a literal branch
  name is not refused.
  These commands, which a guard that read `@{...}` as git's ref syntax would
  have let through, are refused while a tracked file is dirty:
  `git checkout @{-1}`, `git checkout @{u}`, `git checkout HEAD@{1}`,
  `git checkout master@{1}`, `git checkout "$BRANCH"` and
  `git checkout ${BRANCH:-master}`. The reason is that `@{a,b}` is a brace
  expansion that names two files (bash and zsh both print `@a @b`), and a
  lone `@{1}` is a file name in a pathspec position, so the text alone does
  not say which one it is. An operator (`&&`, `||`, `;`, `|`, `&`) or parenthesis at the end of a line, or beside another one, no longer hides the next command: the tokeniser read such a run as one token, so the text is spaced around them first. A refusal does not print the refused command: a hint rebuilt from the
  guard's own tokens once turned an inert single-quoted `$(...)` into a live
  one. It says to put `HARNESS_ALLOW_DESTRUCTIVE_GIT=1` immediately before
  the git command that was refused, or immediately before the wrapper when
  the git call runs through `env`, `xargs`, `command`, `nohup`, `exec` or
  `timeout` (the shell cannot run it between the wrapper and git, and `env`
  refuses it there). The inline form applies to that one command, not the
  whole line: a line with more than one refused git command needs it on each,
  inside a `$(...)`, a loop or an `if` it goes on the git call there, and in
  front of `git status && git reset --hard` it would not cover the reset. In
  a loop or `if`, start the git call on its own line or after `;` or `&&`,
  not directly after `do` or `then` (see the known-gaps row). Exporting it
  for the session also works but switches the guard off for everything in
  that session. The
  refusal also says which parsing class applied. A
  `zsh -c` refusal names `zsh -c` as the class that fired, because its body is
  only checked at all as zsh is unwrapped. A `dynamic pathspec` refusal has
  its own text. For `comment continuation`, `backslash continuation` and
  `adjacent operators` the refusal lists them as constructs the command also
  uses, once at the end, and does not claim the refusal depended on them: the
  guard does not re-run the match without each one. If the guard itself
  raises, the command is still allowed (as for any shape it cannot parse),
  and a `systemMessage` and an `additionalContext` on stdout say it was NOT
  checked, naming only the exception class. `bash -c`/`sh -c`/`zsh -c`/
  `bash -lc SCRIPT`, and the `nohup`, `sudo` (including `sudo -u <user>`),
  `timeout <n>`, `xargs`, `env` (including `env -i`), `command` and `exec`
  prefix wrappers, are unwrapped and their inner command fed back through
  the same matching -- stacked wrappers unwrap recursively, bounded by a
  depth constant so adversarial nesting (a `bash -c` nested a thousand
  deep) cannot exhaust Python's own recursion limit; past that bound, the
  command fails open like any other shape this tokenizer cannot positively
  identify. A `cd <path>` earlier in the same command changes which
  directory later segments are scoped against, and it is PROCESS-LOCAL (a
  `cd` inside a `bash -c` body or a `$(...)` substitution does not move the
  outer segments that follow it, while a `git stash` push inside one DOES
  count against a later `drop`, because that is a fact about the repository
  rather than about a process), so
  `cd <dir> && git checkout -- <path>` is judged against `<dir>`, not the
  tool call's own working directory -- and when that target cannot be
  resolved without actually running a shell (a variable, `cd -`, a bare
  `cd`), checkout/restore/reset ALLOW the rest of the command through
  (fails open, like every other shape this tokenizer cannot positively
  identify: the snapshot mechanism below is what actually covers that gap),
  while `clean`/`stash drop`/`clear` REFUSE instead, per the fail-closed
  posture above.
- **Escape hatch**: for a revert that is genuinely deliberate, set
  `HARNESS_ALLOW_DESTRUCTIVE_GIT=1`, either as this hook process's own
  environment (exported for the session) or as a genuine env-prefix
  assignment on the SAME command segment as the destructive call
  (`HARNESS_ALLOW_DESTRUCTIVE_GIT=1 git checkout -- file`, ordinary shell
  env-prefix syntax). This is deliberately not a text search over the whole
  command: a quoted mention, a code comment, or an assignment that prefixes
  a different, unrelated segment on the same line must not disarm a refusal
  it was never meant to cover. **The hatch covers everything the segment it
  prefixes goes on to run**, its wrapped bodies included: measured,
  `HARNESS_ALLOW_DESTRUCTIVE_GIT=1 bash -c 'git checkout -- f.txt'` and
  `HARNESS_ALLOW_DESTRUCTIVE_GIT=1 sudo git checkout -- f.txt` both exit 0.
  That follows from where the check sits, before the wrapper is unwrapped,
  and it is the behaviour to rely on. What it does NOT do is cross into a
  different segment in either direction: an earlier segment's hatch leaves a
  later `bash -c` refused (exit 2, measured), and one set inside a wrapped
  body does not leak back out. Three places here and in the guard used to
  claim the opposite for the first case; the code is right and the sentences
  were wrong.
- **Deliberately out of scope**: `git worktree remove --force`,
  `git branch -D`, and any command reached through an unbalanced quote or
  wrapper nesting past the depth bound (fails open by design -- see the
  module docstring). Both can destroy content with no copy anywhere in git.
  A `(...)` subshell IS caught (it is stripped as a grouping token like
  `if`/`then`, not treated as an opaque shape, and since K1 it also gets its
  own working directory, so a `cd` inside it does not move the segments
  after it), and so are `$(...)` and backtick substitution, per the
  normalisation layer above.

  Untracked and stashed work IS in scope, and that is the whole point of the
  `git clean` and `git stash drop`/`clear` rules: they are the two shapes
  this guard covers that snapshots cannot. Earlier versions of this section
  said the opposite -- "none of the commands it DOES intercept can lose an
  untracked file" -- which stopped being true the day those rules landed.

### What this guard does not stop

**This guard stops accidents. It does not stop a determined attempt to hide
a command from it, and it is not trying to.** It is a blocklist over a
Turing-complete input language: the set of shell spellings that reach the
same destructive `git` call is unbounded, so no list of spellings can ever
be complete. Five review rounds each closed the bypasses they were shown and
each next round found more, which is the behaviour of the approach and not
of the effort. What actually covers the gap is recovery, not detection: the
snapshot mechanism below, for the work it can reach.

Read the list below as the boundary, not as a to-do list. Every entry is
measured, none is guarded, and none is planned to be.

| Bypass | Spelling | What it costs you |
|---|---|---|
| Repository retargeting through a wrapper | `env GIT_DIR=<other>/.git git clean -fd` | The clean/stash fail-closed rule reads the env prefix on the segment itself, and `env` hides it one level down. The other repository's untracked files or stash entries go, unmeasured. |
| Repository retargeting already in the environment | `export GIT_DIR=...` in the shell that launched the session, then `git clean -fd` | The guard scrubs `GIT_*` from its own measuring call, which is what stops a leaked variable making it read the wrong repo -- but the real command still obeys the variable, so the two look at different repositories. Measured with a clean cwd and untracked work in the target: ALLOWED, and the real run deleted it. |
| A run-time pathspec on a command other than `checkout`/`restore` | `git clean -fd "$X"`, `git clean -fd -- "$X"`, `git clean -fd ${X}` | `git checkout` and `git restore` read a pathspec containing `$`, a backtick, `$(...)`, `{...}` or a leading `~` as whole-tree scope (class `dynamic pathspec`), so a dirty tracked file anywhere refuses them. `git clean` does not for a variable or a brace: its dry run measures the pathspec as literal text, which matches nothing, so untracked files go unmeasured. A `$(...)` or backtick substitution IS handled: it is dropped from the dry run, which widens it to everything the other arguments select, so `git clean -fd -- $(cat list)` is refused. Not detected. |
| An apostrophe inside a double-quoted string | `git commit -m "don't" && echo $(git reset --hard)` | Substitution extraction flips into single-quote mode at the apostrophe, so every `$(...)` and backtick after it on the line is never looked at. |
| `-n` where it is not a flag | `git clean -f -e -n`, `git clean -f -- -n` | Any `-n` token anywhere reads as `--dry-run`, so the invocation is treated as harmless and never measured. Measured: `git clean -f -e -n` was ALLOWED and the real run deleted every untracked file in the tree. |
| Nesting past `MAX_UNWRAP_DEPTH` | six or more stacked `bash -c` / `$(...)` layers | Past the bound everything fails OPEN, with no notice, the clean and stash rules included, so these two lose their fail-closed posture exactly where an adversary would put them. |
| `git stash store` | `C=$(git stash create) && git stash store "$C" && git stash drop` | `store` is treated as a non-push, so the entry it adds is not counted and the following drop is allowed. The working tree survives, so this one costs a dangling commit rather than live work. |
| `eval` | `eval 'git reset --hard'` | Never unwrapped at all. |
| A substitution as the binary path | `$(which git) checkout -- file` | The guard cannot resolve what the substitution prints, so it never recognises the invocation as `git`. |
| Process substitution | `echo >(git reset --hard)`, `cat <(git reset --hard)` | The body of `<(...)` and `>(...)` is never extracted, so it is never matched. |
| ANSI-C quoting | `echo $'a\'b'; git reset --hard` | The `\'` inside `$'...'` is read as closing a single quote, so the rest of the line is treated as quoted. |
| A heredoc marker the shell does not read as one | `echo "a <<EOF"`, `echo a <<<EOF`, `echo $((1<<2))`, each followed by a newline, `git reset --hard`, a newline and `EOF` | The here-document stage matches `<<WORD` anywhere in the text, so the lines after such a marker are blanked as if they were a body. Found while checking the comment class; not fixed by it. Not detected. |
| A quoted parenthesis inside `$(...)` | `echo $(echo ')'); git checkout -- file` | The substitution extractor counts parentheses without reading quotes, so it ends the substitution at the quoted `)` and the rest of the line is treated as inside it. Measured: bash and zsh both revert the file, the guard does not refuse. Not detected. |
| A trailing lone backslash | `git reset --hard \`, `git checkout -- file \` | The tokeniser rejects the dangling escape, and an unparseable command fails open (with no notice, because nothing raised). bash drops the backslash and runs the command. Not detected. |
| Abbreviated long options | `git reset --har`, `git checkout --forc master` | Long flags are matched exactly. git accepts any unique prefix, and a prefix of `--hard` or `--force` reverts the tree. Not detected. |
| Many destructive lines in one command | 65,535 characters of `git reset --hard` lines in a clean tree | Each line starts its own `git status`: 3,855 runs, about 35 seconds measured on one machine, and nothing caps the total. A slower machine could pass the 60-second hook timeout, and a timed-out hook lets the command run. Not detected. |
| Shell and wrapper flags not modelled | `sh -ec`, `bash -xc`, `zsh -fc`, `zsh -ic`, `zsh -l -c`, `zsh --no-rcs -c`, `timeout -k 5 5`, `xargs -I {}` | The wrapper is not recognised, so the inner command is never reached. Only `-c` and `-lc` are read, for `bash`, `sh` and `zsh`. Not detected. |
| Shells other than `bash`, `sh` and `zsh` | `dash -c`, `ksh -c`, `fish -c`, `busybox sh -c`, `env -S '...'` | Not unwrapped, so the inner command is never reached. |
| A script fed to a shell on its standard input | `echo 'git reset --hard' \| zsh`, `zsh <<< 'git reset --hard'` | Nothing on the command line names the script, so it is never matched. |
| A command built at run time or defined elsewhere | `f() { git reset --hard; }; f`, `G=git; $G reset --hard`, `zsh -c "$(echo git reset --hard)"` | The destructive text is never a literal token in a position the guard reads. |
| A here-document fed to a shell | `bash <<'EOF'` ... `EOF` | Heredoc bodies are blanked uniformly before matching, which is right for the inert case (`cat <<EOF`) and wrong for this one. |
| Input the tokeniser cannot parse | an unbalanced quote, ANSI-C quoting such as `echo $'it\'s'; git reset --hard`, a trailing lone backslash | The command is allowed with no notice: nothing raised, so the "NOT checked" message that a guard exception produces is not sent either, and neither the user nor Claude is told the command was never read. The guard only ever refuses a shape it positively identifies. Not detected. |
| An assignment directly after a shell keyword | `for x in f; do FOO=1 git reset --hard; done`, and the same after `then`, `else`, `elif ...; then`, `{`, `!`, `time`, and `do` of a `while` or `until` loop | The keyword is stripped before the assignment, so the guard sees `FOO=1` as the command and never reads the git call after it. Any variable name does it, `HARNESS_ALLOW_DESTRUCTIVE_GIT` included, so there the override is neither needed nor checked. The same lines without the assignment are refused; `(`, `&&`, `;` and a newline before the assignment are refused too. Present on main. Not detected. |
| A `cd` on the left of a background operator | `cd <clean directory> & git reset --hard`, and the same with `&\|` or `&!` | The guard moves its dirty check into the clean directory, but the shell runs the next command in the original one, so the dirty tree is reset. `\|` and `\|&` are handled (the `cd` runs in its own subshell); `&`, `&\|` and `&!` are not. The `&` form is the same on main. Not detected. |
| Heredoc delimiters spelled `<<\EOF`, `<<"E-F"` or `<<E.F` | `cat <<\EOF`, a line with an apostrophe, `EOF`, then `git checkout -- file` | The delimiter pattern reads only plain words, so these markers are misread, the apostrophe in the body opens a quote, and the text is unparseable and fails open. bash and zsh both revert the file. Not detected. |
| The oversize shortcut's `git` test | 65,536+ characters containing `g''it` but not `git` | Over the parsing cap, a command with no literal `git` substring is allowed unparsed. Quote removal defeats the substring test. |

Writing or quoting a guarded command as inert TEXT -- inside a here-document
body, a quoted string, or a `grep`/`echo` argument -- is deliberately not
refused: nothing there executes, and refusing it is the noise failure that
gets a guard switched off.

Installing as a plugin wires the hook automatically. For manual installs,
copy the hooks and add to `~/.claude/settings.json` (this repo writes only
these two files into your own repository once running: a
`harness-snapshot-failures.log` inside `.git/`, and refs under
`refs/harness-snapshots/` -- see "Recovering destroyed work" below for what
each one is and how to remove it):

**Use an ABSOLUTE path, not `~`.** These `args` are passed to `exec`, which
does not expand a tilde: `python3` then exits **2** on the file it cannot
open, and exit 2 is precisely the code PreToolUse treats as *block*. A
mistyped or unexpanded path therefore does not disable the hooks, it refuses
**every Bash call in the session**. Measured: `python3 "~/.claude/hooks/git-snapshot.py"`
exits 2. Substitute your own home directory below.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [
      { "type": "command", "command": "python3",
        "args": ["/ABSOLUTE/PATH/TO/HOME/.claude/hooks/destructive-git-guard.py"], "timeout": 60 },
      { "type": "command", "command": "python3",
        "args": ["/ABSOLUTE/PATH/TO/HOME/.claude/hooks/git-snapshot.py"], "timeout": 10 }
    ] }]
  }
}
```

**Already installed by hand from an earlier README?** Raise the guard's
`timeout` in your `settings.json` to 60 (earlier copies of this snippet said
10) and replace any `~` in `args` with an absolute path. A PreToolUse hook that
times out does not block the command, it lets it run, so a 10 second timeout
turns a slow git call into a silent allow of the command the guard exists to
refuse; and `args` is not tilde-expanded, so a `~` path makes the hook exit 2
and refuse every Bash call.

**What is, and is not, protected before you rely on either mechanism:**
the snapshot mechanism below does NOT cover untracked files, ignored files
(a gitignored `.env` included), work that was never written to disk, a
repository a command `cd`s or `git -C`s into (only the Bash tool call's own
`cwd` is snapshotted), or destruction by a non-Bash tool call (`Write`,
`Edit`). Tracked, on-disk changes in the payload's own `cwd`, destroyed by
ANY spelling of ANY command, are what it actually covers.

## Recovering destroyed work

`hooks/git-snapshot.py` is a second, independent PreToolUse hook, matched to
`Bash`, that snapshots uncommitted TRACKED changes in the repository at the
Bash call's own `cwd` before the call runs -- so destroyed work is
recoverable regardless of how the destroying command was spelled, closing
the gap the detector above cannot close by enumeration. It never reads the
command text at all: it does not matter whether the command was
`git checkout -- file`, `env git checkout -- file`, `$(which git) checkout
-- file`, or `git reset --hard`; the snapshot happens identically either
way, and it also runs on a genuinely harmless command (there is no way to
tell in advance which command was about to be destructive).

**Mechanism.** `git stash create` against a PRIVATE COPY of `.git/index`
(via `GIT_INDEX_FILE`), never the real one -- measured to succeed while
`.git/index.lock` is held by another process, and to leave the real index
byte-identical. Untracked and ignored files are excluded (`git stash
create`'s own behaviour). The resulting commit is anchored by one immutable
ref per snapshot under `refs/harness-snapshots/`, keyed per checkout (a
linked worktree gets its own key, since worktrees share one ref store but
must not resolve to each other's content), before the hook returns. Refs
older than the 20 most recent per checkout are pruned inline on every call;
there is no separate pruning job or scheduled task. The hook fails open
always -- exit 0 in every case -- with a bounded, deduplicated failure trace
at `.git/harness-snapshot-failures.log` for the three states nothing could
be snapshotted in: an unresolved merge or rebase in progress, an unborn
HEAD (no commit yet), and index-lock contention. Twenty successful
snapshots leave that log's size unchanged; it only grows on failure, is
capped at 200 lines with the oldest evicted first, and repeated identical
failures are written once, not once per call.

**Recover a destroyed file, from a cold start with no prior knowledge.**
List the snapshots for the current repository (timestamp, branch and
originating worktree path are all in the ref's own creation date and
commit subject):

```
git for-each-ref --format='%(refname) %(creatordate:iso-strict) %(contents:subject)' refs/harness-snapshots/
```

Pick a `<ref>` from that list, then extract a file's pre-destruction content
into a sibling `.recovered` file -- this is the documented DEFAULT, and it
never overwrites the original path, even if the current working copy has
since been edited again and would otherwise conflict:

```
git show <ref>:<path> > <path>.recovered
```

Inspect `<path>.recovered`, then `mv` it over `<path>` yourself once you are
sure -- that move is a separate, conscious step, never automatic. Running
the extraction command twice is safe: it produces the same file both times.
For a file that was staged differently from the worktree at snapshot time
(`git status` showed `MM`), the worktree content is `git show <ref>:<path>`
as above and the staged content is `git show <ref>^2:<path>`.

**What is NOT recoverable from a snapshot:** untracked files, ignored files
(a gitignored `.env` included -- deliberately: including them would put an
agent-authored secret into a ref on every single Bash call), and anything
never written to disk in the first place.

**Retention.** At most 20 snapshot refs are kept per checkout; older ones
are deleted (and their commits become unreachable) as a normal side effect
of the next snapshot in that same checkout, no scheduled job involved.

**Where these refs are, and are not, visible.** `git status`, `git log
--oneline -1`, `git branch -a`, and a plain `git push`/`git push
--all`/`git push --tags` to a remote are all unaffected -- snapshot refs
live outside `refs/heads/*`, `refs/tags/*` and `refs/remotes/*`, and a
routine push only ever transmits those three. Two things DO show them: any
all-refs walk (`git log --all`, `git fsck`, an IDE's full history view), and
`git push --mirror` or an explicit `refs/*:refs/*` refspec, both of which
DO transmit snapshot refs to a remote.

**Purging content, not just unreferencing it -- required after removing a
secret from a working tree, or rewriting history to remove one.** Deleting
the ref alone is not enough: `git show <sha>:.env` still prints the secret
from the dangling commit until the object itself is gone. Run, in this
repository, verbatim:

```
git for-each-ref --format='delete %(refname)' refs/harness-snapshots/ | git update-ref --stdin
git reflog expire --expire-unreachable=now --all
git gc --prune=now
```

**Kill switch.** Set `HARNESS_DISABLE_SNAPSHOT=1` in the Claude Code
process's own environment (before starting `claude`, not something a Bash
tool call's own `export` can reach -- see the next paragraph) to stop
snapshotting entirely: no ref, no object, no file anywhere. It takes effect
on the very next Bash call, no restart needed, because the hook holds no
state across invocations. This is a separate variable from the detector's
own `HARNESS_ALLOW_DESTRUCTIVE_GIT`: silencing the detector's false
refusals must not silently silence recovery too, so the two are
independent by design.

**Scope of "exported for the session".** Every PreToolUse hook, this one and
the detector above, runs as its own fresh subprocess spawned by the Claude
Code CLI process for each tool call, inheriting THAT process's environment
-- never the environment of a Bash tool call's own shell. An `export
FOO=1` an agent runs as part of a Bash tool call's command does not reach
either hook, on that call or any later one: it lives and dies inside the
ephemeral shell Claude Code spawns to run that one command. "Exported for
the session" means set in the shell `claude` itself was started from (or
via your OS environment more generally), for both `HARNESS_DISABLE_SNAPSHOT`
and `HARNESS_ALLOW_DESTRUCTIVE_GIT` -- this corrects the detector's escape
hatch's own wording above, which previously left that ambiguous.

**Cost.** Measured directly (`test/git-snapshot.test.js`'s AC-OPS-13 case):
a small single-file fixture, dirtied fresh on every call so pruning never
triggers, costs a median of ~76ms per invocation (7-run sample, on this
development machine); the test's own ceiling is 400ms, a 5x margin over
that baseline, so it fails before this drifts into "slow enough to get
disabled" territory. Separately, the existing detector costs about 22.6ms
on a benign command and 33.0ms refusing a destructive one; `git stash
create` alone costs roughly 16.4ms at 200 tracked files and 25-30ms at
4000-5000 (both figures from `specs/harn-fix-2.md`'s planning measurements,
not re-verified here). The snapshot hook's own git subprocess calls
(`rev-parse`, `stash create`, `update-ref` and, only when pruning,
`for-each-ref`/`update-ref --stdin`/`gc --auto`) are bounded at
`MAX_GIT_INVOCATIONS` (6) per call in `hooks/git-snapshot.py`, each with its
own 6-second deadline, strictly under the 10-second timeout `hooks.json`
registers.

**Uninstall, completely.** Removing the hook registration (delete the
`git-snapshot.py` entry from `hooks.json` or your `settings.json`) stops
NEW snapshots but leaves every existing ref and its disk behind -- to
reclaim that too, run the purge sequence above in every repository you want
cleaned.

## Run ledger

Every `tdd-task`, `review-cycle` and `plan-cycle` run -- conducted or
invoked directly, there is no way to opt a single run out -- appends two
JSON lines to `.claude/harness-ledger.jsonl` **inside the repo the workflow
ran against** (the main checkout root, never a worktree): a `started` record
before any work begins and a terminal record after, sharing a `run_id`, so a
run killed mid-flight is recorded as incomplete rather than simply absent.
`conduct-plan`'s task-level wait/PR events add one line each. The file is
created and ignored automatically on first write, via `.git/info/exclude`
rather than your tracked `.gitignore` (so writing the ledger never shows up
as a diff on a file you own); it is never staged, committed or pushed by
any code in this repo, and if you want it committed as a deliberate
opt-in, remove that line from `.git/info/exclude` yourself.

Each line records: which workflow ran and its outcome, which lenses ran/were
skipped and their verdicts, findings as `{id, lens, severity, ac_id,
disposition}` only (never the lens's evidence text or the markdown report),
round/spec identity, attempt counts, and `budget.spent()` if available. See
`workflows/lib/ledger-append.mjs`'s `LEDGER_ENTRY_SCHEMA` for the exact,
exhaustive field list (the workflow scripts themselves cannot host this: the
runtime statically rejects any `import` before execution, so the schema,
validation and the write itself live in this one real-Node script instead,
invoked via Bash from each workflow's final step).

**Ledger failure signals.** Three signals mean a run's telemetry was not
recorded correctly. The first two come from a harness install that is out of
step with itself; the third comes from a terminal write that stopped or failed.

| Signal | Exact text | What it means | Remedy |
|---|---|---|---|
| (a) Stale writer | the `TELEMETRY NOT RECORDED for this run:` log line, naming `finding_entries: not an allowed property` and `ledger-append.mjs predates HARN-OPT-6` | The installed writer is older than the workflow and refuses the findings key, so the run leaves no telemetry. | Run `bin/install.sh` and `bin/install.sh --check`, then restart the session or dispatch by scriptPath, because named workflows are cached per session. |
| (b) Stale workflow | a `review_cycle` row carrying `legacy_payload: true` with no findings | The workflow is older than the writer, typically a session started before `bin/install.sh` ran, so it wrote through the new writer in the old shape. At run time the conductor sees a review whose `result.telemetry.outcome` is `"done"` but whose open_findings is null; on disk, find the rows with `grep '"legacy_payload":true' .claude/harness-ledger.jsonl`. | Run `bin/install.sh` and `bin/install.sh --check`, then restart the session or dispatch by scriptPath, because named workflows are cached per session. |
| (c) Terminal write payload | the log line `Terminal ledger write payload was N bytes (base64)` | The terminal write was stopped or failed. The size tells a size stop from any other: a payload near the 120,000-byte base64 ceiling (specs/harn-opt-6.md, AC-QA-9) is a size stop, a small one points at another cause. | The ceiling can be exceeded by a round with more than 60 findings in one disposition or more than 60 prior ids or fixed confirmations. The standing remedy is to record the stop and its size in the plan's conductor log and treat a repeat as grounds to reopen the transport spec (the AC-QA-13 tally in specs/harn-opt-6.md is the record during the acceptance window). Any other stop follows the `write_error` that came with it. |

A `tdd_task` line also carries `model`: the implementer model the run asked for
through `tdd-task`'s optional `model` argument, or null when none was given. It
is **requested, and confirmed by transcript**: the line records the token that
was passed to the implementer dispatches; which model actually ran is recorded
by the runtime in each subagent's transcript, not in the ledger. Measured on
2026-10-13 (HARN-OPT-5 AC-PROD-5): a probe run with `model: opus` ran both
implementer dispatches on claude-opus-5-5, where the same workflow with no
`model` ran them on claude-sonnet-5-5, the installed agent's pin.
`blocked_reason` on that line is one of `test_attempt_cap`,
`implement_attempt_cap`, `tests_modified` or `test_defect` (the implementer
reported that the frozen test itself is wrong).
The `model` value is null when no model was recorded: none was given, or the
key was stripped for a stale writer, or the row is degraded. The optimiser's
`byModel` null bucket carries the same three causes (HARN-OPT-5 T1 round 2 F3).

**Reading `test_defect` rows while the installed writer predates schema 6.**
While the installed `ledger-append.mjs` is older than schema 6, a `test_defect`
blocked_reason is neutralised to null by `degradeEntry`: the old enum does not
list it, and that is an enum mismatch, which the stale-writer retry does not
handle because it only retries on "not an allowed property". The row is stamped
5, with `invalid_record_values_dropped` incremented, so such runs read as "not
recorded" until the writer is reinstalled.

**The `schema_version` 3 boundary, and reading a window that spans it.**
`SCHEMA_VERSION` is 3 from the validator change onward. What changed at that
boundary, field by field:

- **`ac_id`** (in both `findings[]` and `ac_verdicts[]`) accepts two forms it
  used to reject: a prefix containing a digit, so `AC-A11Y-<n>` validates at
  last, and one bounded spec prefix for a review spanning several specs
  (`FEAT-011 AC-QA-1`, `FEAT-010/AC-QA-3`). Both used to be nulled into
  `ac_id_raw` and counted in `invalid_ac_ids_dropped`.
- **`spec_bug_count`** is `null`, not a number, on a review run where no spec
  was in play at all, and no finding on such a run carries the `spec_bug`
  disposition. Before, every finding on a spec-less run was classified
  `spec_bug`, because a finding with no AC behind it is what the synthesis
  step was asked for.
- **`findings_truncated`** is unchanged in meaning (findings the writer
  counted but could not fit on the line) and is now READ: the optimiser sums
  it across the window and renders it in the Rework attribution section, so a
  per-lens tally that is short says by how much. Per-lens counts are computed
  from the line's own `findings` array, which is capped, so on a truncated
  round those counts are short by exactly this number.
- **`ac_verdicts_truncated`** is its sibling for `ac_verdicts`, which is
  bounded separately. It is also summed and rendered, and any criterion in a
  (repo, plan) bucket whose window contains a truncated `ac_verdicts` array
  can no longer be reported as confidently never-failing: the surplus could
  have held the FAIL.

**Interpreting a window that spans the boundary (AC-OPS-8).** On lines
written BEFORE the boundary, accessibility criteria (`AC-A11Y-<n>`) and every
cross-spec-prefixed criterion live in `ac_id_raw` with `ac_id` null, and the
reader does not read `ac_id_raw` back into attribution. So a zero for those
criteria in a pre-boundary window means **never recorded**, never a measured
zero: the runs happened and their verdicts were discarded by the validator.
The report's own Never-failing acceptance criteria section carries this
caveat inline, and `perRepo[].schemaVersionsSeen` is what tells you which
population a window is made of.

**Malformed values degrade, they never destroy the line**: `ledger-append.mjs`'s
`degradeEntry` validates the whole entry once; when every error it finds is
value-level (a `findings[].lens`/`severity`/`ac_id` or `ac_verdicts[].verdict`
failing its pattern/enum, a bad `verdicts.<lens>`/`trigger_counts.<key>` dict
entry, a malformed `lenses_run[]` element, or an array item missing a required
field entirely), each is neutralised in place rather than the whole write
being refused. This is a general, schema-driven mechanism, not a per-field
allowlist: earlier rounds sanitised `ac_id`, then separately `lens`/`severity`,
each time only the field that round's review happened to name, and the next
round always found the next sibling; `degradeEntry` instead neutralises any
value-level violation the schema declares, present or future. A known sibling
field retains a bounded (32-byte), path-redacted raw form
(`ac_id_raw`/`lens_raw`/`severity_raw`/`verdict_raw`); anything else lands in
a bounded `degraded_raw` array (`{path, raw}`, redacted the same way, capped
at 10 entries). Every neutralisation is counted: `invalid_ac_ids_dropped` and
`invalid_finding_fields_dropped` for their own named fields,
`invalid_record_values_dropped` for everything else -- rendered in the
optimiser's report both as its own summary line and, per criterion, as the
reason a `never_failed` claim was degraded to unknown rather than a confident
true or false. A record is still refused outright when a STRUCTURAL error
remains: a required TOP-LEVEL field absent, an unknown top-level key, or the
entry (or an array element) not being an object at all.

**The `fixed` disposition**: `review-cycle`'s optional `prior_findings`
argument (`conduct-plan` supplies it on round two of review for the same
task, and every round after) carries the findings that round's conductor
reported open going into it. The synthesis step is asked which of those it
can confirm resolved in the built change, and a confirmed one is written
with disposition `fixed`. This is a lens CONFIRMING a previously reported
finding is resolved, never proof of repair.

What the guard actually proves, and what it does not (fix round 1, finding
3: an earlier version of this section claimed it "cannot be rubber-
stamped" -- it can, see below, and that was wrong to claim). A
`fixed_findings` entry is only recorded when its `findingId` hash (the same
hash `spec_bug`/`rejected`/`open` findings already use) matches one already
present among `prior_findings`' own hashes: **a confirmation must
reference one of the findings supplied in the same request**, it cannot
invent an id that was never in that list. A finding reworded between
rounds hashes differently and will not match, so it stays uncounted rather
than being wrongly cleared. That guard alone does **not** stop a synthesis
that echoes the entire supplied `prior_findings` list back as confirmed --
every one of those references is genuinely "in the list", so nothing is
dropped, and that is the literal shape of a rubber stamp. The guard closes
fabrication (an id that was never open), not blanket, unverified
confirmation of everything that was.

Two further guards keep the count itself honest, distinct from whether any
one confirmation is trustworthy:

- **Duplicates within one round** (fix round 1, finding 1): the same
  confirmed finding listed more than once in one `fixed_findings` array
  (once per affected lens section, or simply repeated) is recorded ONCE,
  with the repeats counted under `duplicate_fixed_ids_dropped`, never
  multiplying the count.
- **Duplicates across rounds** (fix round 1, finding 2): the ledger has no
  memory between lines, so a conductor that re-supplies an already-
  confirmed finding as `prior_findings` on a LATER round would otherwise
  record it fixed again. The writer cannot see this; `optimise-read.mjs`'s
  `aggregateRework` deduplicates by finding id, scoped per repo, across the
  whole analysis window, and reports the skip count as
  `duplicateFixedAcrossRounds`.

A finding a lens is still reporting open THIS round is never also recorded
fixed on the same line, even if a confirmation names it (fix round 1,
finding 8) -- reconciled to `invalid_fixed_ids_dropped`, the same field a
fabricated (never-open) claim is counted under, since both are a claim the
writer refuses to honour. Both `invalid_fixed_ids_dropped` and
`duplicate_fixed_ids_dropped` share `invalid_ac_ids_dropped`'s null-vs-zero
convention, and the record is still written when either fires -- the
offending value is dropped, the drop is counted, never the whole line.

**`HARNESS_LEDGER_READONLY`**: a lens that needs to run or probe
`ledger-append.mjs` itself (a mutation experiment during planning or review)
is instructed to set this on the SAME command line as the writer invocation --
when truthy, the writer returns `write_ok:false` before touching stdin, git or
the filesystem at all, so a lens's own probing can never land a test record in
the operator's real, unbacked-up ledger. This is enforced at the lens-prompt
boundary, not fully mechanical: a lens that ignores the instruction, or a
caller other than a lens, is not stopped by it.

**Terminal write and orphans**: a run normally leaves exactly the two lines
described above, paired by `run_id`. When that pairing does not complete, the
optimiser counts two separate orphan classes, broken down by workflow kind: a
start-only orphan (the process was killed before the terminal write ran, or
the terminal write's own payload was refused for a reason the degrade
mechanism above does not cover) and a terminal-only orphan (the start write
itself failed). An exception escaping a workflow's `run()` does not, by
itself, produce a start-only orphan: the exception guard's `try/finally`
always attempts a terminal write, landing as a paired `aborted` record
instead.

**Retention**: kept indefinitely as an ordinary untracked file; nothing in
this repo prunes or rotates it. Because the ledger is gitignored, `git clean
-xdf` deletes it too -- `-x` explicitly targets ignored files by design, and
this is a routine cleanup command, not an edge case. To keep the ledger
through a `git clean -xdf`, exclude the path yourself (`git clean -xdf -e
.claude/harness-ledger.jsonl`) or move it outside the working tree before
cleaning. **Delete it** with `rm .claude/harness-ledger.jsonl`
-- the next workflow run recreates it automatically, since there is no way to
opt a single run out (see above), and no setting to turn ledger writes off.
**Export**: it already is one — the file itself is newline-delimited JSON,
readable with any JSONL tool. If a line is ever deliberately committed (the
opt-in above), it survives in git history like any other tracked change.

**Durability (AC-DATA-17)**: the ledger is a single local copy — nothing
backs it up or replicates it anywhere, so it is lost along with the main
checkout (a lost disk, a reformatted machine, an accidental `rm -rf`) with
no way to recover it. It always resolves to the MAIN checkout root, via
`git rev-parse --git-common-dir` (`workflows/lib/ledger-append.mjs`), never
a linked worktree's own directory — so it survives a linked worktree
removal; worktree removal never removes it, only removing the main
checkout itself loses it. This is a deliberate, accepted trade-off (see the
AC-DATA-4/AC-SEC-1 arbitration above: making it cloud-reachable would
reopen that privacy decision), not an oversight, and would be revisited
only if the ledger were made cloud-reachable.

**Arbitration (AC-DATA-4 vs. AC-SEC-1)**: AC-DATA-4 (the ledger survives a
routine `git clean -xdf`) and AC-SEC-1 (the ledger is gitignored) are
mutually unsatisfiable for a single in-tree, ignored path -- `-x` removes
ignored files by definition, so a path that satisfies AC-SEC-1 cannot also
satisfy AC-DATA-4. Resolved in favour of AC-SEC-1: an accidentally
committed ledger (the risk an ungitignored path invites) is a live,
standing exposure, while a `git clean`-lost ledger is user-initiated,
telemetry-only, and fully preventable by the exclusion above. This is a
deliberate, accepted trade-off, not an oversight: AC-DATA-4's git-clean-
survival clause is an accepted FAIL for this path.

**The same discipline applies to `.claude/conductor-prior-findings.json`**
(specs/record-fixed-findings.md): `conduct-plan`'s cross-round state for the
`fixed`-disposition feature above, carrying every open finding's `location`
and `claim` VERBATIM -- the same class of free text (AC-SEC-2) the ledger
schema itself is designed to keep out. This file is written by prose
(`skills/conduct-plan/SKILL.md`), never by `ledger-append.mjs` or any other
real-Node script.

Fix round 3 protected it by listing it in THIS repo's own tracked
`.gitignore`. That line lives only in `claude-ai-harness`'s own git history
and is never installed anywhere else -- the harness install carries
`AGENT-HARNESS.md`, `agents/`, `workflows/`, `hooks/` and `skills/` into a
delivery repo, never `.gitignore` -- so a `conduct-plan` conductor running in
an operator's real delivery repo found this path genuinely untracked but NOT
ignored: one ordinary `git add -A` away from being committed. Fix round 4
replaces this with the same per-repo mechanism the run ledger's own
`ensureGitignored()` and the optimiser's own report already use:
`workflows/lib/optimise-report-ignore.mjs`'s `ensureIgnored(root,
relativePath)`, invoked by SKILL.md's own prose (not code -- there is still
no `ensureGitignored()` call site for this file) before every write. It
writes to the CURRENT repo's `.git/info/exclude`, never a tracked
`.gitignore`, and verifies with a real `git check-ignore`; SKILL.md instructs
refusing the write outright when that check does not report success. This
repo's own tracked `.gitignore` entry is left in place as a second,
redundant layer here, but the operative protection for a delivery repo is
the per-repo mechanism, proven in a throwaway repo (not `claude-ai-harness`)
by `test/conduct-plan-prior-findings-protection.test.js`.

**Retention**: entries are keyed `<plan file>:<task id>` and accumulate for
every task, of every plan, the repo ever conducts -- there is no automatic
expiry while a plan is in flight. SKILL.md's Done step prunes this plan's own
keys (the `<plan file>:` prefix) when the plan finishes, leaving any other
plan's entries untouched; before this fix (fix round 4, finding 3), nothing
ever deleted this data and it survived indefinitely.

**Known limitations**: an absolute `spec` path reached through a
**symlinked ANCESTOR directory** (e.g. a checkout cloned at, or accessed
via, a symlink somewhere above the repo root) records the out-of-repo
marker (`<redacted-path>`) rather than its true repo-relative key, even
though the file is genuinely inside the working tree. `plan_key` derivation
is deliberately **lexical only** — it compares the literal spec string
against known root strings, never resolving a symlink to check where it
actually points (AC-DATA-3, AC-SEC-2) — because the alternative (resolving
the spec's real path before matching) makes plan identity depend on
filesystem STATE at the moment of the write: the identical spec string
would record differently depending on whether a symlink happened to exist
on disk yet, which is worse than a narrow, deterministic degradation. Two
mitigations already avoid the common cases: a *relative* spec (or one
reached via `..` from a subdirectory) resolves correctly regardless of
symlinks, since it is matched against the writer's own already-resolved
`cwd`; and an absolute spec reached through a symlinked `cwd` **itself**
(not merely an ancestor) resolves correctly via the `PWD`-inode-match
candidate. Only the specific combination — an absolute spec, built from a
symlinked path, submitted from somewhere other than that exact symlinked
directory — hits the marker. The ledger's `spec_raw` field (AC-DATA-4)
keeps the caller's original spec string recoverable regardless, though
**not verbatim**: an absolute spec found to live inside the repo root has
only that in-repo prefix stripped (never the `./`/`..`-collapsing step
`plan_key` itself performs), so `spec_raw` and `plan_key` can legitimately
differ for the same record — `spec_raw` is the writer's insurance against
a canonicaliser defect, correctable without replaying the original
caller, not a byte-identical copy of what the caller sent. Retained only
when a canonical key was actually derived — a genuinely out-of-repo or
`..`-escaping spec is never retained raw, matching `spec`/`plan_key`'s own
redaction (AC-SEC-1).

## Install-consistency preflight (`specs/harn-fix-3.md`, AC-QA-1..5)

`workflows/lib/install-consistency.mjs`, invoked at the start of every
`plan-cycle.js`/`review-cycle.js` run (folded into the existing scope
`agent()` call, never a separate dispatch -- AC-QA-3), checks that the
installed `AGENT-HARNESS.md` and `agents/lens-*.md` agree with the findings
schema (`PLAN_SCHEMA`/`REVIEW_SCHEMA`) the cycle is about to use. This is
distinct from, and independent of, the consumer-install staleness check
below (AC-OPS-1..5): the preflight can halt a run over an INTERNALLY
inconsistent install regardless of what published `main` says (on proof --
see the next paragraph); the staleness check warns about drift from published
`main` regardless of internal consistency.

**Certainty refuses; uncertainty warns, never halts (AC-QA-2, amended
2026-08-23 after round-two review).** Two sources of truth feed the
decision:

- The **prose parse** of `AGENT-HARNESS.md`/`agents/lens-*.md` is a
  heuristic. It has been wrong once already: appending an ordinary
  `### NOTES` section to `AGENT-HARNESS.md`, inside the existing contract
  fence, used to make every install report `consistent:false` on a routine
  documentation edit (H1, fixed).
- The **in-process cross-check** compares the fields the plan or review
  cycle's first (scoping) step reports as instructed against the literal `PLAN_SCHEMA`/`REVIEW_SCHEMA`
  object the running workflow script itself holds -- no filesystem, no
  subprocess, no model, nothing left to parse. This is the reliable half.

The cycle refuses (no lens dispatched, exits non-zero, names the field and
both schema sides) only when the in-process cross-check **proves** a
reported field absent from the running schema, or when the report is
**self-contradictory** (claims `consistent:true` alongside a reported
mismatch or `blind:true` -- provable from the report's own shape, no parsing
needed). Every other condition -- the consistency field missing entirely,
`blind`, `ok:false`, or the script's own prose-derived verdict alone with no
in-process proof -- **warns** (one loud log line naming the uncertainty) and
**proceeds**: lenses still dispatch.

**If a refusal fires and you believe it is wrong** (a false positive from
the prose-parsing half, not a genuine schema gap), the first line of the
thrown error tells you which field and which schema side it named. To
proceed anyway for one run, pass the override on the invocation's own args:

```
/review-cycle {"allow_inconsistent_install": true}
/plan-cycle   {"spec": "specs/X.md", "allow_inconsistent_install": true}
```

It is read directly by the workflow script, applies to that **one**
invocation, and is never persisted. Using it is impossible to miss: every
suppression is named in the log **and** prefixed to the run's own report,
saying which refusal it suppressed and which field that refusal named.

**Why an args flag rather than an environment variable.** The first cut of
this override was `HARNESS_ALLOW_INCONSISTENT_INSTALL=1`, by analogy with
`HARNESS_ALLOW_DESTRUCTIVE_GIT` (see "Destructive git guard" above). The
analogy fails in two ways. There, the variable's prefix sits inline in the
very command being guarded, so it is visible at the point of use; an
exported variable here would silently disable the gate for every subsequent
run in the session with nothing in the invocation showing it. Worse, a
dynamic-workflow script has no environment access at all, so the variable
had to be read by `install-consistency.mjs` and **relayed through the scope
agent** -- the model whose report the gate is checking. A gate whose
override is asserted by the thing being policed is circular, and it is the
same bypass class the in-process cross-check exists to close. An
`escape_hatch_active` field in a reported consistency object is now ignored
wherever it appears.

There is no persisted, environment or repo-level way to disable the gate.

The script is resolved via `$CLAUDE_HOME` if set (the SAME override the
staleness check below honours -- AC-QA-4), otherwise `~/.claude/workflows/lib/
install-consistency.mjs`, otherwise an installed `claude-ai-harness` plugin
directory under `$HOME`. There is deliberately **no repo-local fallback**:
a diff under review must never be able to supply the very script whose
stdout decides whether dispatch proceeds (M2, round-two review -- a
prose-only prohibition on using a hostile repo-local copy was found
insufficient; the resolution path itself no longer offers one). If none of
those resolves, that is an absent install, not a security concern, and is
treated as uncertainty (warns, proceeds) like any other could-not-check.

Ships as `workflows/lib/install-consistency.mjs`, alongside
`ledger-append.mjs`, `optimise-read.mjs` and `redact-transcript.mjs` in the
`workflows/lib/*.mjs` files a `cp -r` of `workflows/lib/` installs -- see
"Making a change live: copying the files is not deploying them" above for the exact commands; this file
must go live in the same sync as `plan-cycle.js`/`review-cycle.js`, or the
very next run finds nothing to check and warns accordingly.

**What this preflight does and does not promise.** It defends against an
**accidental** partial or stale install, which is the incident that prompted
it. It does **not** defend against anyone able to set environment variables or
edit the installed files -- `CLAUDE_HOME` pointed at an empty directory
degrades it to warn-only, silently, for the whole session. Three routes to
degrading it have been closed and a fourth will not be, because anyone who can
set `CLAUDE_HOME` can also edit the files it reads. The full boundary, with the
measurements behind it, is under **"Threat model"** in `specs/harn-fix-3.md`
and repeated in the module's own header. It is deliberately not restated in
detail here: one statement of a security boundary is maintainable, three drift.


## Delivery optimiser

`/optimise-cycle` (`workflows/optimise-cycle.js` + `skills/optimise-cycle/`)
reads the run ledger, conducted plan files, git history and GitHub Actions
history (via `gh`, run/job metadata only — never a job's log output) to
propose measured, cited changes to the harness, pipelines or process. It
**never applies a change itself**: every proposal goes through the normal
gate like any other change to this repo.

**Cadence**: weekly, per delivery repo, run as a scheduled routine — never
per-PR. Two consecutive dry cycles (no adopted-and-confirmed proposal) halve
it (weekly → fortnightly → monthly); a third dry cycle at monthly retires
the routine. See `skills/optimise-cycle/SKILL.md` for the full rollout and
decay rule.

**How an attended run works.** There is one way to collect data and the
operator's own session drives it; the workflow only analyses what it is
handed. An attended run analyses **one repository**: several repositories
means one run in each. `skills/optimise-cycle/SKILL.md` gives the exact
commands, in this order: make a private directory (mode 0700) outside the
repository; run `workflows/lib/optimise-collect.mjs` into it for the
repository; resolve the repository's main checkout (the repository itself, or
the main checkout of a linked worktree, with `git rev-parse
--path-format=absolute --git-common-dir`) and make the two output paths
ignored there, both done by one command of the report-ignore helper
(`optimise-report-ignore.mjs prepare`), which confirms each path with git and
writes the proof the check needs before it will place anything; mint a nonce; read `digest.json`; call the `optimise-cycle`
workflow with `{digest, nonce}`; save the object it returns, unchanged; then
run `workflows/lib/optimise-verify.mjs attended` on it, giving it the
repository and the main checkout. That last step is the same result check the
weekly runner uses. It checks the main checkout against the repository,
holds every figure in the report against the collected files and every
proposal-targets entry the workflow returned against what this run names,
takes the sidecar lock, merges the sidecar and places the report and the
sidecar in the main checkout. Its first line is `VERDICT PASS` or `VERDICT
FAIL`: only a pass is a clean cycle, and a fail with `PLACE yes` (a lane could
not run, so the report was placed with that lane marked not measured) is a
FAIL with a report, not a clean cycle. The session never writes either file
by hand, and nothing else in this repository does: the attended and
unattended paths share one copy of the result check, the lock and the
placement. A call to the workflow with no digest, with a nonce that is not 32
lower-case hex characters, or with a `repos`, `window` or `digests` argument,
is refused before any model runs.

**Report**: written to `.claude/optimise-cycle-report.md` in the main checkout of the repo that
was analysed (the repo itself, or the main checkout of a linked worktree; a roster entry that
names a worktree therefore replaces the main checkout's report with one analysed from that
worktree's branch, and the weekly run logs a `NOTICE ... linked-worktree` line when that is
so), by the result check (never by a model) after it has checked the
report. The paths are gitignored through `.git/info/exclude` and confirmed with
git by `optimise-report-ignore.mjs` (which also decides the location) before either output
is written, and the result check places only when it is handed that step's proof; the write is
refused if that check fails (`workflows/lib/optimise-report-ignore.mjs`,
mirroring `ledger-append.mjs`'s own discipline). The proposal-targets sidecar,
`.claude/optimise-proposal-targets.json`, is placed beside it under the main
checkout. These two files are the only ones a run creates or modifies in the
analysed repository.

**What the report guarantees.** Every measured figure in it is on a line the script wrote, in
a fixed shape, and the result check matched that line to the data it collected (the ledger record
count, the CI run counts, the escaped-defect counts, the digest's omissions, the per-row tables and
the recorded adoption and rejection dates). Every piece of text that came from a repository (a CI
job name, a repository label, a plan key, a spec path, a criterion id, a lens name, ledger free
text, the collector's notes) or from a model (a proposal's statement, its measurements, its
citations, its reinstatement evidence and the words of its target) is shown as literal text in
code formatting: one line, with control, invisible and direction characters removed and any
backtick turned into an apostrophe, inside a Markdown code span that a viewer never interprets.
So it can never become a line of its own, a heading, a link, inline HTML or a measured figure,
however the report is rendered, and proposals and job names therefore look like code samples.
The check holds the report to that structurally: every line must be one of the shapes the script
writes, with an even number of backticks, so text outside code formatting that the script did not
write fails the run. A proposal may quote a headline label or cite a figure in its own words; that
text is shown literally and is never read as a figure. A report is not guaranteed to be free of
misleading prose in a proposal's wording: that is read by the operator before anything is acted on.

**Retention (F12, round-7 review)**: the report is a SECOND artefact
derived from the ledger (plan keys, run ids, per-plan seconds, orphan
counts) — deleting the ledger alone does not remove it. Overwritten in
place on every cycle run, otherwise kept indefinitely; nothing in this
repo prunes or rotates it. **Delete it** with `rm
.claude/optimise-cycle-report.md` — the next scheduled cycle recreates it.

Every proposal carries
the measurement that motivated it and the measurement that would confirm or
refute it after adoption, and cites a real ledger `run_id` or `gh` run id
present in what it actually read; an uncited proposal is dropped
mechanically, in script code, not by agent judgement. A proposal to remove
`lens-security` or `lens-qa` from the always-on roster is never emitted; any
other removal, demotion or skip proposal must state the evidence that would
reinstate it, alongside the escaped-defect counter-metric (a stated
heuristic derived from git history, not a verified per-PR attribution).

**Arguments of the workflow**: `{digest, nonce}` and nothing else: the digest
is one repository's `digest.json` from the collector and the nonce is 32
lower-case hex characters minted by the caller. The workflow reads no file and
runs no command; which repository and how much of its ledger (90 records)
are decided by the collector, not by an argument.

### Weekly scheduled run (HARN-OPT-2 T3)

The weekly cadence above runs as a local launchd job
(`com.local.optimise-cycle-weekly`, Mondays 07:41 local), driven by
`bin/optimise-cycle-weekly.sh` in this repo. For each configured delivery
repo the runner collects the ledger, git and GitHub Actions data itself, with
`workflows/lib/optimise-collect.mjs`, into a private directory; starts one
headless `claude -p` session that only analyses what it is handed and returns
text (read-only, never applying a proposal); checks what came back against
the files it collected; and writes the report and the sidecar itself. It
appends one `RESULT PASS` or `RESULT FAIL` line per repo, plus a few
fixed-vocabulary lines, to `~/.claude/logs/optimise-cycle-weekly.log`. No text
the model wrote reaches the log.

**PASS or FAIL is decided from content by the runner, never from what the
model said.** A repo passes only when every lane ran (the ledger, git and CI
lanes; a repo with no Actions history counts as having run, and the report
says so), the collector's digest was accepted, `claude` exited 0, the reply
was the agreed JSON, every measured figure in the report equals the figure in
the files the runner collected (ledger records, CI run counts, the raw
escaped-defect count and the rest of the checked lines), the report holds no
absolute path under `$HOME`, the repo or the per-run directory, every
proposal-targets entry the session returned is one this run names, the two
output paths are gitignored, and both files were placed. A report that merely
looks like a report no longer passes: a heading and a section heading are not
enough, and a report that says 0 ledger records beside a ledger the runner
found to hold records is a FAIL that names both numbers. A lane that could not
run for a reason outside the runner's control (for example `gh` not logged in)
is a FAIL that names the lane and the mode; the report is still written with
the other lanes' real figures and the missing lane says `Not measured`, so
PASS always means every lane ran. When the result is not trusted nothing is
placed and the last good report and sidecar stay as they were. **A run that is
not scored PASS does not count as a dry cycle** for the cadence-decay rule
above: only a PASS run's report can show a dry cycle. Each `RESULT` line
carries `ledger=<collected>/<reported>`, `ci=<runs>` and `git=<commits>` (or
`failed:<mode>`), and the digest's status, omission total and whether it was
trimmed, as fixed tokens and integers only; the script exits non-zero if any
repo failed.

A configured repo path that does not exist on disk is a **configuration
FAIL** (`RESULT FAIL ... reason="configured repo path does not exist"`),
distinct from a path that exists and genuinely is not a git repo
(`SKIP ... (not a git repo)`) -- and a linked git **worktree** (whose
`.git` is a file, not a directory) is processed exactly like an ordinary
checkout, never skipped, since this harness runs from worktrees routinely.

The header line carries `version=$SCRIPT_VERSION`, bumped whenever this
script's behaviour changes materially, so the log shows which copy of the
script actually produced a given run -- the same drift class AC-OPS-4
already covers for `workflows/`, extended to this file.

**Consumer-install staleness check (`specs/harn-fix-3.md`, AC-OPS-1..5).**
Once per invocation -- not once per delivery repo -- this script also
checks whether the consumer install at `$CLAUDE_HOME` (default
`~/.claude`) has drifted from published `main`. The consumer subset
(a manual multi-file copy can partially update it) has two halves:

- **Required** -- absence from the install is reported as drift:
  `AGENT-HARNESS.md`, every `agents/lens-*.md` and `agents/reviewer-*.md`,
  `workflows/*.js`, `workflows/lib/`, `hooks/` (except `hooks/hooks.json`,
  see below), and `skills/` (the whole directory, not only
  `skills/optimise-cycle/` -- `skills/conduct-plan/`, which drives every
  multi-PR plan, is genuinely published and installed the same way).
- **Optional** -- present-if-opted-in; absence from the install is a
  legitimate configuration, never drift, but presence with DIFFERENT
  content still is: `bin/optimise-cycle-weekly.sh` and
  `bin/redact-transcript.mjs` (the weekly job itself is opt-in; round-one
  review, HIGH-2 -- this script's own detector was previously excluded
  from the thing it checks, the same defect class the whole spec exists to
  close, sitting inside its own fix), and `hooks/hooks.json` (the plugin
  manifest, read only by a `/plugin install` -- a manual install wires the
  two `PreToolUse` hooks through `~/.claude/settings.json` instead, so its
  absence there is not drift; measured against a real manual install,
  where leaving it required fired drift on every weekly run, forever).
  `bin/com.local.optimise-cycle-weekly.plist` is deliberately EXCLUDED
  from both lists: it is a per-operator TEMPLATE (its own header comment
  says so), edited immediately after copying, so comparing it to the
  published template would report every genuinely working install as
  permanently drifted.

A user-owned file the repo does not ship, like `CLAUDE.md`, is never
compared. Warn-only, by design: a stale install is not necessarily broken,
so this never fails the run. The separate consistency preflight
`workflows/lib/install-consistency.mjs` runs inside
`plan-cycle.js`/`review-cycle.js` (AC-QA-1/2, above) CAN halt a run, but it
is not unconditional either: it refuses on proof and warns on doubt. This
sentence previously called it "unconditional, refuse-on-mismatch", which
described round one's behaviour and contradicted the amended description 130
lines above it (L-6, round-four review).

**A subset pattern matching zero published files also forces
`could-not-check`** (round-one review MED-8), never a bare `ok`, even when
every file the comparison DID see matches exactly: a pattern silently
matching nothing (a renamed or moved subset directory upstream) is the
same "found something, therefore looked at everything" blindness this
spec's anti-vacuity discipline exists to catch everywhere else in this
module, and is reported to the operator identically -- an install cannot
be called clean over content the check never actually looked at.

The comparison clones published `main` fresh, `--depth 1`, into its own
`mktemp -d` directory every run, deleted unconditionally on exit -- never a
persistent cache refreshed in place. This is a deliberate response to the
spec's own risk note ("a cache clone accumulates on a volume twice at 99%
full"): nothing here survives past one run, so there is nothing to
accumulate, no cache-staleness of its own to track, and two overlapping
runs (each gets a unique `mktemp` name) can never collide. `$CLAUDE_HOME`
itself is only ever read, never written -- proven by hashing every file
under a fixture install before and after a run that reports drift.

No network, an unreachable remote, or any other `git clone` failure
produces a `could-not-check` line naming the reason and never fails the
weekly run. The one line every run appends to the log carries a three-way
status token -- `STALENESS ok ...` (the install matches), `STALENESS drift
...` (it does not, with the drifted/missing file list in the JSON tail), or
`STALENESS could-not-check ...` -- rather than collapsing "matches" and
"does not match" into the same word. An earlier version used `ok` for both,
because the CLI's own `ok` field means "the check ran without error", not
"no drift found"; a person scanning the log for problems read `STALENESS
ok` on a genuinely drifted install and moved on, which is the "recorded but
invisible" failure the spec's own risk table names ("noisy and gets
ignored, becoming decoration" -- invisible is worse). On `drift`, this
script also prints one line to stderr naming the log path and a count of
drifted-plus-missing files (never the file list -- the log line already
carries that), mirroring the existing FAIL-summary stderr line below on the
same already-wired `StandardErrorPath` channel. This is visibility only:
drift never sets `overall_fail` and never fails the weekly run, exactly
like `could-not-check`. The run's own header line names `SCRIPT_VERSION`, so
a log entry states which copy of this SCRIPT ran (a per-commit install
stamp was tried and withdrawn -- specs/harn-fix-3.md's "Version stamp --
DROPPED 2026-08-23" -- because the hook that wrote it generated permanent
false drift and could leak unstaged edits into a commit; full-file
comparison against published `main` is this check's only staleness signal).

Covered by `test/weekly-runner.test.js`, which drives the real script
against real temp git repos with a stub `claude` on PATH -- no test run ever
makes a real model call.

**Two guards this script previously shipped were removed, not fixed a
third time (T3 subtraction round, specs/harn-opt-2.md conductor log ticks
46-48).** Both looked like real containment and were proven, by execution,
unable to fail in the way they claimed to -- and the owner's ruling on
that finding was to cut them rather than patch either again:

- **There is no per-run verdict nonce.** An earlier version had every
  script-written log line carry `run=<hex>`, meant to stop the model
  forging this script's own `RESULT PASS`. It did not work: the header
  carrying the nonce was written to the log **before** `claude -p` ran, at
  a path the model can read, so a forger only had to grep its own log for
  the genuine nonce and echo it back -- proven with a real stub. A
  hardcoded guessed nonce also shipped the test suite green, so the guard
  was not load-bearing against a guesser either. The real containment
  against a compromised or malicious model reply is, and always was, that
  the verdict never trusts the model's stdout at all (see PASS/FAIL above)
  -- the nonce added nothing to that.
- **There is no `<repo>/.claude/` read-only postcondition.** An earlier
  version also asserted, after the run, that nothing under the analysed
  repo's `.claude/` other than the report itself had a newer mtime than
  the run's own start. It was defeated by `touch`-back-dating a written
  file, missed any write outside `.claude/` entirely (a stub writing
  `.git/hooks/post-checkout` passed clean), and missed every deletion (no
  forward mtime to see). Measured against a real delivery repo whose
  `.claude/` held 50,120 files from orphaned worktrees (778 MB): the
  per-file walk cost ~94s and its reason-string join was quadratic,
  extrapolating to ~44 minutes and a single ~3.6 MB log line -- it would
  have wedged this job for tens of minutes after `claude` had already
  returned, guarding against a mutation a `touch -d` already defeated.

**The real per-repo session budget is the background-wait ceiling (1,200 s), not `timeout 3600`.** The
optimiser runs as a background workflow inside `claude -p`, so the actual
governing budget is `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`. The script sets
it explicitly to 1,200,000ms (20 minutes -- 2.3x the worst measured real
run, 515s on 2026-08-16) and aligns the outer `timeout` to match (ceiling +
60s grace, `-k 60` to force a kill if claude ignores the polite one). Lowered
from the earlier 1,800,000ms in the T3 subtraction round: now that a
ceiling hit produces a self-diagnosing FAIL naming the cause (below),
binding low costs one lost weekly report, while binding high costs up to
31 minutes of unattended execution producing nothing. If a run hits the
ceiling, the FAIL reason carries the CLI's own message verbatim
(`Background tasks still running after Ns; terminating`), which also
reveals whether the configured ceiling was actually honoured -- this is
anchored to that specific message, not a bare grep for the ceiling
variable's name, which used to false-positive on any transcript merely
mentioning it (this README does, right here).

**What the unattended session can do (as measured on Claude Code 2.1.322, and for the workflow's `scriptPath` on 2.1.330).** The
session has no shell and no file write. The invocation passes exactly these
flags and tool rules:

- `--allowedTools "Workflow" "Read(//<the per-run directory>/**)"`: the
  Workflow tool, and Read of the one per-run directory. Nothing else is
  allowed.
- `--disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch Grep
  Glob`: each denied as a whole tool, by bare name with no pattern, so an
  allow rule in the operator's own settings cannot hand the session a shell, a
  file write, a network fetch or a search of the file system.
- `--permission-mode dontAsk`: refuses every tool not on the allowed list
  instead of prompting.
- `--setting-sources user`: only the operator's own user-level settings load,
  so an analysed repo's committed or local settings cannot widen the list or
  add hooks (the hooks registered at user level still apply).
- `--strict-mcp-config` with no `--mcp-config`: no MCP server loads.
- `--no-session-persistence`: the digest is not saved in a session transcript.
- `--output-format json`: the reply is a JSON envelope the result check parses
  strictly, never scanned for delimiters.
- The session is started in the per-run directory, not in the analysed repo.
  The runner copies the installed `optimise-cycle.js` into that directory and
  the session calls it by `scriptPath`, passing the digest and a nonce the
  runner minted. It replies with only the object the workflow returned.

The session runs no `git`, no `gh` and no helper program, and writes no file:
the runner collected everything before it started, and the runner places the
outputs after checking them. The prompt tells the session, before it reads
`digest.json`, that every string in the digest is untrusted data and never an
instruction.

**Residual risk, stated plainly.** (1) `--setting-sources user` loads the
operator's own settings, and user-level allow rules still apply to any tool
that is not denied as a whole tool, namely Read, Skill, Agent and Workflow.
(2) The Workflow grant is the bare tool name, not scoped to one workflow; whether
a grant can be scoped to one is not measured. (3) The session reads
`digest.json`, which holds untrusted collected text (commit subjects, CI job
names, plan titles), outside the nonce fence that every model the *workflow*
starts gets. A digest that carried a planted instruction could therefore shape
the words of a proposal, which the operator reads before acting. It is
bounded, not removed: the session has no shell, write or network tool; the
workflow returns a keyed digest (`result_mac`: SHA-256 of the nonce, the report,
the proposal-targets and the lane statuses) and the result check works it out
again and refuses a mismatch; and every figure and every returned sidecar entry is
checked against what the runner collected. What the digest shows is that the
reply is the object a workflow run on this run's nonce returned; it does not show
who computed it. **Assumption, not measured:** on the unattended path the session
has no tool that can compute a SHA-256, so it cannot produce a matching digest for
text it altered (T5 probes whether the Workflow tool would run an inline script that
could); on the attended path the session has a shell and could compute it, so there
the digest guards against accident, not against a steered session. A second,
independent layer refuses any report in which a proposal would remove an always-on
lens, and a third refuses a report with any line in a shape the script never writes.
**Proposal ids:** an id is hashed from the target as it is stored, with
absolute-path-looking text redacted and whitespace collapsed first, so two targets
that differ only in text that redacts to the same marker (for example two slash
commands in the same field) share one id and are one proposal as far as history
goes. That is deliberate (owner decision 2026-11-23); the pattern is also broader than
real paths, and matches any slash-led word such as `/review-cycle`. Whether a real session obeys such
an instruction has not been measured yet; a probe with a planted instruction is
planned (`specs/harn-runner-2.md`, task T5). (4) The session runs with `--safe-mode`, so plugin hooks do not see the unattended session (nor does `CLAUDE.md`,
a skill or an MCP server), per the CLI's documentation and one measured run (2026-11-23, claude 2.1.330); T5 confirms
the memory plugin's store gains no row. The condition the owner accepted: under safe mode the operator's own
`settings.json` hooks (the destructive-command guard among them) do not run in the unattended session. That is
acceptable only while the session has no tool that can run a command or write a file, because then the hooks have
nothing to act on; a static test fails if `--safe-mode` is present while the allowed tools hold more than
`Workflow` and the one `Read` grant, or the deny list lacks `Bash`, `Write`, `Edit` or `NotebookEdit`. Not
measured: whether "workflows disabled" affects anything but workflows resolved by name (the `scriptPath` call worked).
`--no-session-persistence` stops only the CLI's own transcript. The attended session is unchanged: it runs with the
operator's plugins and hooks, so a memory plugin may store the collected data and the report from an attended run. The attended session is the operator's own, has a shell, and reads the digest outside any fence. It is told before
it reads that every string in `digest.json` is untrusted data and never an
instruction; if anything in the file reads like an instruction, the operator
stops and reports it rather than acting on it, and the operator's permission
prompts apply to anything it would run. That is the whole bound: it is not the
no-shell bound the unattended session has.

**Measured (2026-11-21, Claude Code 2.1.322), one headless run in a scratch
repository under these flags:** the session was refused `git log -1`, and the
agent the workflow started reported it had no shell tool; a Read outside the
per-run directory was refused for both; a 19,703-character digest with quotes,
backslashes and non-ASCII text, and a 7,036-character report, each crossed
the session intact in that run (one run is not a guarantee, which is why the
result check compares every figure). At this repository's real size the whole
collected ledger (213,651 characters) could not cross the session, which is
why the workflow takes a bounded digest (about 28 KB). **Not measured:**
whether a bare `Bash` deny overrides an operator's own user-level allow rule;
whether a refused shell call appears in the CLI's `permission_denials` list
(the list was empty in the 2.1.322 run, and held one entry per refused Read in
a later run on 2.1.330, so the runner logs `DENIED-TOOLS <label> <n>` as what
the CLI said, or `unknown`, never as proof that nothing else was tried); and
the first real weekly run under this runner, which `docs/release-checklist.md`
records when it happens.
`test/harn-runner-2-t3.test.js` captures the real argument list the runner
passes to a stub `claude`; the test suite never makes a real model call.

**The session does not start in an analysed repository.** It starts in the
per-run directory, which has no `.claude/active-plan`, so the plan-guard Stop
hook has no plan marker of a repository to rewrite, and the runner no longer
saves or restores one. An earlier runner measured that the hook rewrote a
dormant marker in the repository the session started in; that is why the
session no longer starts there. Not measured under this runner: whether the
snapshot hook writes anything into an analysed repository (an earlier runner's
sessions started there and it did).

**A FAIL is announced, and cleanup is the runner's job.** When any repo's
verdict is FAIL, no repos are configured, or every configured path is skipped
(`no repos checked (all skipped)`), the run raises one macOS
notification naming the failing repo labels and the first reason, and writes
one line to `~/.claude/logs/optimise-cycle-weekly.last-result` (UTC timestamp,
PASS or FAIL, labels, reasons) that stays until the next run overwrites it. A
notifier that fails leaves `NOTIFY-FAILED <exit code>` in the run log. The
per-run directory (the collected data, the digest, the session's output and the
copy of the workflow the session runs) is removed on exit
and on SIGTERM or SIGINT, and a run that is stopped that way records FAIL and
notifies like any other FAIL. Each invocation makes a directory of its own,
`run.XXXXXX` (from `mktemp -d`), inside a mode-700 parent that only the runner
writes to (`optimise-weekly-runner` under `$TMPDIR`, or under `~/.claude` when
that is unset), and every per-run file (the collected data and digest, the session's output,
the result check's two output files, the staleness clone) lives in it, so overlapping runs, or a
run overlapping a test, never share a file name. The run removes its own
directory on exit, after the outputs are placed.
The parent is checked after it is created (not a link, owned by this user, its
physical path as expected) and only then chmodded. At start-up a run removes
only stale `run.XXXXXX` directories: real directories (links are not followed)
owned by this user and older than 1,410 minutes (23.5 hours), which is longer than
any one repository can take (at worst 3,130 seconds, about 52 minutes: the collector's
1,810 s worst case, the session's 1,200 s ceiling and its two 60 s graces) and shorter than the
day between two weekly runs, logging
`REMOVED-STALE-RUN-DIR <name>`. A sibling's fresh directory is never touched.
There is no overlap lock: runs are never refused and never wait on each other.
The one lock is short and covers only the proposal-targets sidecar's read, merge
and rename, because that file is the only copy of the map from a decided
proposal's id to its target: a symlink named `optimise-sidecar.lock` in the
main checkout's git directory, whose target names its owner. A lock whose owner
process has gone, or that is older than 10 minutes whatever its owner says, is
taken over; something at that path that is not a link (a directory an older
version left) is set aside and removed; a live fresh one is waited for up to
about 30 seconds and then the repo FAILs with `could not take the sidecar
lock`. Its code is in `workflows/lib/optimise-verify.mjs`, in the one command
(`settle` for the runner, `attended` for the operator's session) that waits for
the lock, reads, validates and merges the sidecar, places both outputs and
releases the lock, so the runner holds no lock loop of its own. A staged temp
file a killed run left in `.claude/` is swept at the next run. After a SIGKILL the dead run's
directory stays until a later run's start-up sweep finds it older than 1,410 minutes
and removes it. The outcome file reads `RUNNING` from the moment a run starts, so a run that
dies without reporting leaves `RUNNING`, not last week's result, and a failed
write of it is logged as `LAST-RESULT-WRITE-FAILED`.

**Keep `~/.claude/bin/optimise-cycle-weekly.sh`
and `~/.claude/bin/com.local.optimise-cycle-weekly.plist` copied from this
repo's `bin/`** after merging any change to them. Unlike the top-level
workflow scripts above, copying these genuinely does deploy them: launchd
spawns a fresh shell process per run, which reads the file at exec, so there
is no snapshot and no restart step. **The runner also requires the matching
`workflows/optimise-cycle.js` and `workflows/lib/`** (the collector, the
reader, the result check and the report-ignore helper): the runner passes the
workflow a digest and a nonce and checks the object it returns, which an older
installed workflow neither accepts nor returns. Run `bin/install.sh` (which
installs `workflows/`) and confirm with `bin/install.sh --check`, as well as the
copy commands below. A run that finds an installed `optimise-cycle.js` whose
`WEEKLY_RUNNER_CONTRACT` constant is missing or lower than the runner's
`REQUIRED_WORKFLOW_CONTRACT` stops before any collection with `installed
optimise-cycle.js is older than this runner requires; run bin/install.sh`, and
one that finds a helper missing from the install fails the repo naming the
file. The `diff -q` lines below confirm the `bin/` copies only, so they are
necessary but not sufficient on their own:

```bash
cp claude-ai-harness/bin/optimise-cycle-weekly.sh ~/.claude/bin/optimise-cycle-weekly.sh
cp claude-ai-harness/bin/sonar-rules-table.mjs ~/.claude/bin/sonar-rules-table.mjs
chmod +x ~/.claude/bin/optimise-cycle-weekly.sh
diff -q claude-ai-harness/bin/optimise-cycle-weekly.sh ~/.claude/bin/optimise-cycle-weekly.sh
diff -q claude-ai-harness/bin/sonar-rules-table.mjs ~/.claude/bin/sonar-rules-table.mjs
```

Copying is a merge-time step, not something a branch does to a path outside
the repo, so a freshly merged change is live only once someone runs the
commands above. Run the two `diff -q` lines to find out; they are the check,
and this paragraph deliberately states no point-in-time claim about whether
the copy has happened, because such a claim goes stale the moment either
side moves.

`OPTIMISE_WEEKLY_REPOS` (newline-separated repo list) and
`OPTIMISE_WEEKLY_LOG` (log file path) are read by the script but exist only
as a test seam for `test/weekly-runner.test.js`; they are never operator
configuration and neither is documented as a knob to set.

**The delivery repo list is real operator configuration, not this file's
hardcoded content.** When `OPTIMISE_WEEKLY_REPOS` is unset, the script
reads `$HOME/.claude/optimise-weekly-repos` -- one repo path per line,
blank lines ignored, never tracked in this or any repo. Set it up once:

```bash
mkdir -p ~/.claude
cat > ~/.claude/optimise-weekly-repos <<'EOF'
/path/to/your/first/delivery/repo
/path/to/your/second/delivery/repo
EOF
```

If the file does not exist, the repo list is empty and the run FAILs
(`RESULT FAIL - reason="no repos configured"`, a notification and a non-zero exit: nothing
is being checked, which is not "nothing to do") rather than
crashing or falling back to any hardcoded path -- this public repo carries
no private repo names or account paths in its own tracked files
(`test/static-checks.test.js` guards `bin/` for exactly that).

#### Runbook: every fixed FAIL reason

Each repo's `RESULT FAIL` line in `~/.claude/logs/optimise-cycle-weekly.log`
ends with `reason="..."` and, when the failure has a class, a `cause=` token. The
reasons below are the fixed words the runner, the collector's digest and the
result check can print (a placeholder such as `<n>` stands for a number or a
fixed token the line fills in). Nothing the session said is ever in a reason.
The first cell is the reason's leading words, so search the log for them. A
test (`test/harn-runner-2-t4.test.js`) fails when the code can print a reason
that has no row here, and when a row here names a reason the code no longer
prints. Where a row says "re-run", start the job by hand with
`~/.claude/bin/optimise-cycle-weekly.sh` after the fix, or wait for the next
scheduled run.

| Reason or token | What it means | What to check | What to do |
|---|---|---|---|
| `no repos configured` | The runner has no repository to analyse. | `~/.claude/optimise-weekly-repos` exists and lists one path per line. | Add the paths (see above), then re-run. |
| `no repos checked (all skipped)` | Every configured path was skipped, so nothing was analysed. | Each path is a git repository and still exists. | Fix the list or the paths, then re-run. |
| `configured repo path does not exist` | A configured path is not on disk. | The spelling of the line in `~/.claude/optimise-weekly-repos`, and that the volume is mounted. | Correct or remove the line. |
| `git could not read the configured repository` | The path has a `.git` but git could not resolve it: git refused the repository for its ownership (`safe.directory`), or the `.git` is damaged. It is a FAIL, not a skip. | `git -C <repo> rev-parse --git-dir` by hand as the job's user; who owns the folder. | Fix the ownership (add it to `safe.directory` only if you trust it) or repair the repository. |
| `cd into repo failed` | The runner could not enter the configured path. | Permissions on the directory. | Fix the permissions or remove the path. |
| `could not create this run's temp directory` | The runner could not make its private per-run directory. | Free space and permissions under `$TMPDIR` (or `~/.claude` when `$TMPDIR` is unset). | Free space or fix permissions, then re-run. |
| `could not capture a valid run start time` | The runner could not read the clock for this repo. | `date +%s` prints a number. | Re-run; if it repeats, fix the system's `date`. |
| `installed optimise-cycle.js is older than this runner requires; run bin/install.sh` | The installed workflow predates this runner, so the run stopped before collecting anything. | `bin/install.sh --check` reports drift. | Run `bin/install.sh`, then `bin/install.sh --check`. |
| `workflows/optimise-cycle.js is missing from the install; run bin/install.sh` | The installed workflow file is not there. | `ls ~/.claude/workflows/optimise-cycle.js`. | Run `bin/install.sh`. |
| `workflows/lib/<file> is missing from the install; run bin/install.sh` | A helper program the runner needs is missing from the install. | The file named in the reason under `~/.claude/workflows/lib/`. | Run `bin/install.sh`, then `bin/install.sh --check`. |
| `could not copy the installed workflow into the per-run directory` | The runner could not copy the workflow beside the digest for the session. | Free space and permissions on the per-run directory. | Free space, then re-run. |
| `could not mint a containment nonce` | The runner could not make the random token that fences collected text. | That `node` runs from the job's PATH. | Fix the PATH or reinstall the tool, then re-run. |
| `collector timed out after` | Collecting one repo's data took longer than its bound. | `gh` and `git` answer quickly by hand in that repo, and the network is up. | Fix the slow command, then re-run. |
| `collector failed (exit <n>, <token>)` | The collector program crashed. | The token (a Node error code such as `ERR_MODULE_NOT_FOUND`), and `bin/install.sh --check`. | Run `bin/install.sh`; if it repeats, report the token. |
| `collector failed (no result line)` | The collector finished without its one summary line. | `bin/install.sh --check`, then run the collector by hand on the repo. | Run `bin/install.sh`; if it repeats, report it. |
| `collector failed (no digest field)` | The collector's summary line did not say whether the digest was made. | As above. | As above. |
| `digest refused` | The collector made no usable digest for this repo (the `digest=failed:<mode>` token on the line says why; see the `failed:` rows). | The mode on the `RESULT` line. | Follow the row for that mode. |
| `claude exited` | The headless session exited non-zero (the number follows). | `claude --version`, `claude auth status` or its equivalent, and the network. | Fix the sign-in or the network, then re-run. |
| `timed out after` | The session ran past its limit and was stopped. | Whether the network or the model service was slow. | Re-run. If it repeats, the digest may be too large for one session. |
| `killed after timeout grace` | The session ignored the polite stop and was killed. | As above. | As above. |
| `background wait ceiling reached before completion` | The CLI stopped waiting for the workflow to finish. The CLI's own words follow. | As above. | Re-run; if it repeats, raise the ceiling in the runner (it is a constant in the script). |
| `aborted before completion` | The runner itself ended early (a signal, or a script error). | `RESULT` lines above it, and whether the machine slept or was shut down. | Re-run. |
| `could not take the sidecar lock` | Another run held the short lock on the proposal-targets file for about 30 seconds. | Another weekly or attended run in the same repo. | Wait and re-run; if a lock is left by a crashed run it is taken over once its owner is gone or after 10 minutes. |
| `the sidecar lock path is not usable` | The main checkout has no ordinary git directory to hold the lock, or a lock link could not be made there (permissions, or a read-only disk). | `.git/` is a real directory in the main checkout and can be written to. | Fix the permissions, or run it in the main checkout. |
| `the sidecar lock helper failed` | The lock step itself failed in a way it does not name. | The `RESULT-CHECK-STATUS` line above it, and `bin/install.sh --check`. | Run `bin/install.sh`, then re-run; report it if it repeats. |
| `the output paths were not confirmed ignored for this checkout` | The check had no proof, or a stale, used or other-checkout proof, that the report and sidecar paths are ignored in the main checkout, so it placed nothing. For an attended run it means the ignore step (`optimise-report-ignore.mjs prepare`) was skipped. | That step ran for this run directory and printed `"ok":true`. | Run the step, then run the check again. |
| `main checkout does not match the repository` | The attended check was given a main-checkout path that is not this repository's own: another repository, a link, a relative path or one that does not exist. | The path is what `git rev-parse --path-format=absolute --git-common-dir` printed for this repository, without the trailing `/.git`. | Pass that path. |
| `workflow refused to run` | The workflow returned a refusal (a digest or nonce it does not accept), not a result. | `bin/install.sh --check`: the installed workflow and result check may not match the runner or the collector. | Run `bin/install.sh`, then re-run; report it if it repeats. |
| `the result check could not run` | The result check program crashed or was missing. | The `RESULT-CHECK-STATUS` line above it (exit code, bytes, error code). | Run `bin/install.sh`, then re-run. |
| `the result check wrote no output` | The check said the result was trusted but did not confirm it had placed it. | Free space in the per-run directory and in the repo's `.claude/`. | Free space, then re-run. |
| `report path is not gitignored` | A tracked rule re-includes the report or the proposal-targets path, so git still shows it and nothing was written. | A tracked `.gitignore` in the repo that re-includes `.claude/` files (`git check-ignore -v .claude/optimise-cycle-report.md`). | Remove that rule, then re-run. |
| `the repository's exclude file could not be written` | The ignore step could not add the two paths to `.git/info/exclude` of the main checkout (read-only file or folder, or no space). | `ls -l .git/info/exclude` in the main checkout and who owns it. | Make it writable, then re-run. |
| `the ignore proof was missing or stale when the check placed` | The ignore step said it had finished, but the check found no usable proof for this main checkout (it is consumed when used, and is good for two hours). | `bin/install.sh --check`: the installed ignore helper may not match the check. | Run `bin/install.sh`, then re-run. |
| `the main checkout could not be resolved for the output paths` | The ignore step could not find the repository's main checkout (an unusual layout, or git refused it). | `git -C <repo> rev-parse --path-format=absolute --git-common-dir` by hand. | Configure the main checkout of an ordinary repo. |
| `the ignore proof could not be written` | The ignore step made the paths ignored but could not write its proof into the per-run directory. | Free space and permissions under `$TMPDIR`. | Free space or fix permissions, then re-run. |
| `report-ignore helper failed` | The helper that makes the paths ignored crashed (the exit code and an error code follow). | `bin/install.sh --check`. | Run `bin/install.sh`, then re-run. |
| `report rejected:` | The checked report could not be staged for placing (it was a link, empty, over the size cap or its folder was a link). The rest of the line says which. | `.claude/` in the repo is a real folder and `.claude/optimise-cycle-report.md` is not a link or folder. | Remove the link or folder, then re-run. |
| `sidecar rejected:` | Same as above, for `.claude/optimise-proposal-targets.json` under the main checkout. | The same, for that file. | Same. |
| `runner temp directory is not a directory this user owns` | The runner's own temp folder under `$TMPDIR` is a link, not a folder, or someone else's. | `ls -ld "$TMPDIR/optimise-weekly-runner"`. | Remove it if it is yours and not in use, or fix `$TMPDIR`, then re-run. |
| `runner temp directory path cannot be given to the optimiser` | `$TMPDIR` has characters the session's read rule cannot name, or a `.claude` segment. | `echo "$TMPDIR"`. | Use a plain path for `$TMPDIR`. |
| `killed by signal` | The runner was stopped by a signal while a repository was being processed (the number follows). | When it happened. | Re-run. |
| `could not move the result into place` | The final rename failed. Nothing new was written (or only the proposal-targets file, which is always safe to keep). | Free space and permissions in the repo's `.claude/`. | Fix, then re-run. |
| `session output: empty` | The session printed nothing. | The log's `claude exited` line, and the network. | Re-run. |
| `session output: not a JSON envelope` | The session's output was not the agreed JSON. | Whether `claude` printed an error instead. | Re-run; if it repeats, report the CLI version. |
| `session output: envelope has no result` | The envelope had no result, or said it was an error. | As above. | As above. |
| `session output: result is not a JSON object` | The session returned something other than the workflow's object. | As above. | As above. |
| `session output: result has no lanes` | The returned object lacks the lane statuses. | As above. | As above. |
| `session output: result has no report` | The returned object lacks the report. | As above. | As above. |
| `session output: report is not a string` | The report is not text. | As above. | As above. |
| `session returned failed_step` | The workflow stopped at a step and said which (in brackets). | The step's name. | Re-run; report it if it repeats. |
| `report does not start with a markdown heading` | The report is malformed. | Nothing to check on your side. | Re-run; report it if it repeats. |
| `report contains a NUL byte` | The report holds a byte that never belongs in text. | As above. | As above. |
| `report is not valid UTF-8` | The report is not valid text. | As above. | As above. |
| `report is <n> bytes, over the <cap> cap` | The report is larger than 5,242,880 bytes. | The repo's ledger and CI history are not unusually large. | Report it; nothing was written. |
| `sidecar missing` | The result carries no proposal-targets object. | Nothing to check on your side. | Re-run; report it if it repeats. |
| `sidecar is not a JSON object` | The returned proposal-targets value is not an object. | As above. | As above. |
| `sidecar is over the size cap` | The returned proposal-targets object is over 1,048,576 bytes. | As above. | As above. |
| `sidecar is missing a proposal id the report names` | The report names a proposal that the returned map does not hold. | As above. | As above. |
| `sidecar on disk cannot be read as a JSON object; left as it was` | The existing `.claude/optimise-proposal-targets.json` is damaged, a link, or too big. It is the only copy of decided targets, so it was not touched and nothing was placed. | Open it: is it valid JSON and a plain file? Restore it from backup if you have one. | Repair or restore the file by hand, then re-run. |
| `returned sidecar has a key that is not a proposal id` | A returned proposal-targets entry has a key that is not 16 lower-case hex characters. Nothing was placed. | Nothing to check on your side. | Re-run; report it if it repeats. |
| `returned sidecar has a target that is not the fixed shape` | A returned target does not have exactly the fixed fields. | As above. | As above. |
| `returned sidecar has a target that does not hash to its id` | A returned target sits under another target's id. | As above. | As above. |
| `returned sidecar has an id this run does not name` | A returned entry's id appears neither in the report nor in the ledger's recorded outcomes. | As above. | As above. |
| `result carries no mac` | The returned object has no keyed digest (`result_mac`), or it is not a 64-character hash. | `bin/install.sh --check`: the installed workflow may predate the result check. | Run `bin/install.sh`, then re-run; report it if it repeats. |
| `result mac does not match this run` | The keyed digest does not match the nonce and the reply's report, targets and lane statuses, so the reply was edited after the workflow returned it (or came from another run). Nothing was placed. | Nothing to check on your side. | Re-run; report it if it repeats. |
| `report proposes removing an always-on lens` | A proposal in the report would remove `lens-security` or `lens-qa` from the always-on roster, which the workflow itself never lets through. Nothing was placed. | The report text in the session's reply, if you have it. | Re-run; report it if it repeats. |
| `report has a line with an odd number of backticks` | A line of the report has an unpaired backtick. The script writes backticks only in pairs, around text from a repository or a model, so the report was altered after the workflow produced it. Nothing was placed. | Nothing to check on your side. | Re-run; report it if it repeats. |
| `report has a line in a shape the check does not know` | A line of the report, read with its code-formatted text set aside, is not one of the lines the script writes, so text was added or changed outside code formatting after the workflow produced it, or the installed workflow and result check are out of step. Nothing was placed. | `bin/install.sh --check`. | Run `bin/install.sh` if it reports drift, then re-run; report it if it repeats. |
| `report contains an invisible or direction-control character` | The report holds a zero-width or text-direction character, which can make a line read differently from how it is stored. | Nothing to check on your side. | Re-run; report it if it repeats. |
| `result carries no nonce hash` | The returned object lacks the hash of this run's nonce. | The session may have called another workflow copy. | Re-run; report it if it repeats. |
| `result nonce hash does not match this run` | The hash does not match this run's nonce, so the result is not from this run's digest. | As above. | As above. |
| `report holds an absolute path` | The report names a path under the home directory, the repo or the per-run directory. | Nothing to check on your side. | Re-run; report it if it repeats. |
| `collected data unreadable` | A collected file the check needs could not be read. | The per-run directory and free space. | Re-run. |
| `figure mismatch` | A figure in the report differs from the one the runner collected (the lane and both numbers follow). Nothing was placed and the last good report stands. | The two numbers in the reason. | Re-run; if it repeats, the data changed on the way or the report is wrong: report it. |
| `lane could not run: <mode>` | The lane named before it could not run, so the report was written without it and the run is a FAIL by design. Follow the `failed:<mode>` row. | The mode. | See the `failed:` rows. |
| `the reader failed for` | The reader program failed on a collected command. | `bin/install.sh --check`. | Run `bin/install.sh`. |
| `the reader reported an error for` | The reader returned an error for this repo's data. | As above. | As above. |
| `is a symlink or not a regular file` | The ledger or the proposal-targets file named before it is a link or not a plain file. | The file under `.claude/` in the main checkout. | Replace it with a plain file. |
| `is over the size limit` | The ledger or the proposal-targets file named before it is over its size cap. | Its size. | Trim or archive it. |
| `could not be inspected` | The ledger or the proposal-targets file named before it could not be looked at. | Permissions on the file and its folders. | Fix them. |
| `gh was not found on PATH` | The `gh` program is not on the job's PATH (the `failed:absent_from_path` row). | `command -v gh` from the job's environment. | See the `failed:absent_from_path` row. |
| `gh is not authenticated` | `gh` is not signed in for the job (the `failed:unauthenticated` row). | `gh auth status` as the job's user. | See the `failed:unauthenticated` row. |
| `gh reported a rate limit` | GitHub said to slow down (the `failed:rate_limited` row). | `gh api rate_limit` by hand. | See the `failed:rate_limited` row. |
| `the repository root is not a directory` | The path given to the collector is not a folder. | The path. | Fix it. |
| `git <command> ...` | A git command in the collector failed or was not found. The rest of the line says how. | `git --version`, and `git -C <repo> log -1` by hand. | Fix git or the repo, then re-run. |
| `git log returned no commits` | The repo has a history the collector could not read. | `git -C <repo> log -1`. | Fix the repo. |
| `git toplevel does not match the repository root` | The configured path is inside another repository, not its root. | The configured path is the repository's top directory. | Configure the top directory. |
| `the configured path is not a git repository` | The path is not a git repository. | `git -C <repo> rev-parse --show-toplevel`. | Fix the path. |
| `git refused the repository because of its ownership` | Git refused the repo as owned by someone else (`safe.directory`). | Who owns the folder. | Fix the ownership; add it to `safe.directory` only if you trust it. |
| `git refused a bare repository layout` | The path is a bare repository, which the collector refuses. | The path is a normal checkout. | Configure the checkout. |
| `the repository has no commits` | There is nothing to analyse yet. | `git -C <repo> log -1`. | Wait until it has commits, or remove it from the list. |
| `the ledger location could not be determined for this checkout layout` | The checkout uses a layout (a separate git directory, a submodule) the collector cannot place the ledger for. | How the repo was set up. | Configure the main checkout of an ordinary repo instead. |
| `gh run list returned output that is not a JSON array` | `gh` printed something unexpected. | `gh run list --limit 1 --json databaseId` by hand in the repo. | Update `gh`, then re-run. |
| `gh run list returned no run with a usable id` | `gh` listed runs but none had a usable id. | As above. | As above. |
| `gh run list exited` | `gh run list` failed with a status other than the known ones. | The same command by hand. | Fix what it prints, then re-run. |
| `gh run view failed for all` | Every per-run job fetch failed, so no CI job data was measured. | `gh auth status` and the network. | Fix the sign-in or the network. |
| `ci lane budget exhausted` | The CI lane used up its overall time before every run's jobs were fetched. | How slow `gh` is. | Re-run; if it repeats, report it. |
| `timeout: exceeded <n> ms` | The command named before it ran past its own limit. | That command by hand. | Fix the slow command. |
| `the digest is over the` | Even with every list at its minimum the digest is over its size limit. | The size of the ledger and CI history. | Report it; the digest cannot be made for this repo yet. |
| `a line of the digest is over` | One digest line is too long to carry. | A very long commit subject, job name or plan title. | Shorten it at the source, or report it. |
| `cause=check_failed` | The result check itself could not run. | See `the result check could not run`. | Same. |
| `cause=timeout` | The session or the collector ran past its bound. | See `timed out after`. | Same. |
| `cause=exit` | The session exited non-zero. | See `claude exited`. | Same. |
| `cause=abort` | The runner ended early for a reason that was not a signal. | See `aborted before completion`. | Same. |
| `cause=signal` | The runner was stopped by a signal (a shutdown, a logout or a kill). | When it happened. | Re-run. |
| `cause=empty` | The session printed nothing. | See `session output: empty`. | Same. |
| `cause=malformed` | The session's output or result was not in the agreed shape. | See the `session output:` rows. | Same. |
| `notice=sidecar-referenced-evicted` | The proposal-targets file was at its 500-entry cap and every entry that could go was one the ledger still records an outcome for, so some recorded decisions lost the target text behind them (`NOTICE <repo> sidecar-referenced-evicted=<n>`: n entries). Unreferenced entries always go first. | How many recorded decisions you expect to keep; the ledger window. | Archive old decisions' targets elsewhere, or raise the cap in a change; the next run shows those proposals as new. |
| `notice=linked-worktree` | The weekly run analysed a linked worktree, so its report replaces the main checkout's report with one analysed from that worktree's branch (a `NOTICE <repo> linked-worktree` line in the log). | Whether the roster entry should name the main checkout instead. | Change the roster entry if that is not what you want. |
| `cause=mac` | The returned keyed digest was missing or did not match. | See the two `result ... mac` rows. | Same. |
| `cause=nonce` | The returned nonce hash did not match. | See the two `nonce hash` rows. | Same. |
| `cause=oversized` | The report or the proposal-targets object was over its size cap. | See the size rows. | Same. |
| `cause=failed_step` | The workflow stopped at a step. | See `session returned failed_step`. | Same. |
| `cause=refused` | The workflow refused the call. | See `workflow refused to run`. | Same. |
| `notice=lock-restore-failed` | A sidecar lock that turned out to be a live run's was taken away by mistake and could not be put back (a `NOTICE <repo> lock-restore-failed` line in the log). The run that owned it may have gone on without its lock. | Whether two runs were active on that repo at that moment, and that `.claude/optimise-proposal-targets.json` still holds every entry you expect. | Re-run; if an entry is missing, restore the file from backup. |
| `failed:timeout` | A lane's command ran past its limit. | The lane named on the line. | Fix the slow command, then re-run. |
| `failed:absent_from_path` | `gh` is not on the job's PATH (launchd's PATH is short). | `command -v gh` from the job's environment. | Put `gh` where launchd can find it, then re-run. |
| `failed:unauthenticated` | `gh` is not logged in for the job. | `gh auth status` as the job's user. | Run `gh auth login`, then re-run. |
| `failed:rate_limited` | GitHub said to slow down (HTTP 403 or 429). | `gh api rate_limit` by hand. | Wait, then re-run. |
| `failed:could_not_read` | The ledger file could not be read safely (a link, too big, not a file, or an unknown layout). | `.claude/harness-ledger.jsonl` is a plain file in the main checkout. | Fix the file. |
| `failed:over_size` | The digest is over its limit with every list at its minimum. | See `the digest is over the`. | Same. |
| `failed:line_too_long` | A digest line is too long. | See `a line of the digest is over`. | Same. |
| `failed:missing` | The digest, or a lane file, was not produced. | The collector's output line. | Re-run; if it repeats, run `bin/install.sh`. |
| `failed:other` | The lane failed for a reason with no name of its own (the reason text gives it). | The reason on the line. | Follow the matching row above, or report it. |

`failed:no_history` is not a failure: a repo with no GitHub Actions history
runs the CI lane, the report says there is none, and the repo can still PASS.

#### Installing and rolling back the launchd job

`bin/com.local.optimise-cycle-weekly.plist` in this repo is a **template**:
every `/Users/YOUR_USERNAME` path in it is a placeholder (launchd plists
are not shell-expanded, so `$HOME`/`~` do not work inside one) -- replace
all three with your own `$HOME` before installing, since a plist naming an
account path is not something this public repo carries verbatim for its
maintainer's own machine (the same class of leak the transcript redaction
above, and AC-SEC-3, both exist to prevent).

```bash
sed "s#/Users/YOUR_USERNAME#$HOME#g" claude-ai-harness/bin/com.local.optimise-cycle-weekly.plist \
  > ~/Library/LaunchAgents/com.local.optimise-cycle-weekly.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.optimise-cycle-weekly.plist
```

**Rollback.** A code revert in this repo (or in git history generally)
does **not** stop a scheduled launchd job by itself -- launchd reads the
installed plist independently of this repo's state, so the job keeps
firing weekly until the plist is explicitly removed from launchd. To
disable it:

```bash
launchctl bootout gui/$(id -u)/com.local.optimise-cycle-weekly
rm ~/Library/LaunchAgents/com.local.optimise-cycle-weekly.plist
```

To reinstate it later, re-run the two-line `sed`/`bootstrap` install above.

The runner stages nothing in an analysed repository (the copy of the workflow the
session runs lives in the per-run directory under `$TMPDIR/optimise-weekly-runner`),
so a rollback leaves nothing to delete there. A run killed with SIGKILL leaves its
per-run directory, which a later run's start-up removes once it is older than 1,410 minutes. Rolling the
runner back means booting the job out (above); copying an older runner over a newer
installed workflow, or the reverse, makes every repo FAIL until `bin/install.sh` and
the runner copy are brought level, so do both.

**This rollback has been executed, not merely documented** (2026-08-18, per
CLAUDE.md §11: a documented rollback nobody has run is an assumption). The
sequence run, and observed: the job resolved under `launchctl print`;
`bootout` exited 0; `launchctl print` then reported `Bad request`, confirming
the job was genuinely gone rather than idle; `bootstrap` exited 0; and
`launchctl print` resolved it again, pointing at the synced
`~/.claude/bin/optimise-cycle-weekly.sh`. The plist file itself was left in
place, so only the launchd registration was cycled.

One thing that surfaced while doing it, worth knowing before anyone
diagnoses a missed run: **`launchctl`'s `runs` counter resets on reboot.**
After the 2026-08-18 restart it read `runs = 0`, `last exit code = (never
exited)` for a job that had genuinely run on 2026-08-17. `launchctl` is not a
durable record of whether the weekly job has been firing; the log file is.

#### Log retention

The log is appended to indefinitely; nothing in this repo rotates or
prunes it. Each run writes a header line, the staleness check's line, and for each
repository a `COLLECT` line (the collector's fixed figures), a `TIMING` line, a
`DENIED-TOOLS` line, any `NOTICE` line, and one `RESULT` line (capped near 2 KB, fixed
tokens and integers only). **No session text is ever in it**: the session's reply is
checked, never logged, and no transcript is written. The earlier figure of about 640
bytes per run was measured for the pre-change runner and is superseded; the new figure
is measured in the real run recorded under T5. Rotation is deliberately **not** implemented, since
it would risk truncating the only place a real run's `RESULT` lines live,
for a growth rate too small to justify the risk. **Delete it** with
`rm ~/.claude/logs/optimise-cycle-weekly.log` -- the next scheduled run
recreates it automatically. Every line this script itself writes uses the repo's
basename rather than its absolute filesystem path, so the log carries no
`/Users/`, `/Volumes/`, `/home/` path or account name -- the same standard
the ledger and report already hold themselves to (AC-SEC-3 in
`specs/optimise-cycle.md`).

## Analyser rules table

Code built through the harness can pass its tests and its review and still trip the repository's static analyser after it merges. The rules table is one optional, plain-text file that tells the builder which patterns the analyser keeps flagging in this repository, so it avoids them the first time. When the file does not exist, nothing changes.

The table lives at `.claude/analyser-rules.md` and is tracked in git, not ignored, so the worktrees that builds run in receive it. The `implementer` agent reads it before writing a test or production code, in every phase of `tdd-task` and when dispatched directly by `conduct-plan`, and treats the guidance column as coding guidance and never as instructions. Each of its reports carries one line saying whether the table was read, absent, unstamped or unreadable. The instruction lives in `agents/implementer.md` and, as a short passage, in both phase prompts of `tdd-task` (where the status goes in an optional `rules_table` field and is logged once per phase as `Rules table (<phase>): ...`), so a repository that has replaced its implementer agent still gets the table read in `tdd-task` runs. A builder dispatched outside `tdd-task` (for example directly by `conduct-plan`) with a replaced implementer will not read it unless the replacement carries the `The analyser rules table` section from `agents/implementer.md`.

### Format

The table is written down here once. It has four neutral columns (rule, guidance, open, recent-new) and one derivation stamp line. The stamp is the single derivation record: the date, the analysed revision, the analyser's name, the window, the count of new issues in the window, the instant of the previous table, how many issues were created since that instant, how many of those were on rules the previous table already listed (the on-listed count, which shows whether the table is being used), the total open count, and the rules kept out of the rules available. The previous instant is the only thing the generator reads from an earlier stamp. When there is no previous table, or its stamp has no readable instant, the previous instant, the since-previous count and the on-listed count are each written as `n/a`, never as zero. When the server's list of rules is at its limit of 100, the total is written as `at least` that number, because the generator cannot see past the limit. When the since-previous list is cut at the same limit, the on-listed count is written as `at least` its value, for the same reason. A table is bounded at 20 rows and 8,192 bytes; a builder treats a larger one as absent.

```
# Analyser rules table
derived: 2026-11-21T10:30:00Z revision: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 analyser: SonarQube window: 2026-10-22..2026-11-21 new-issues: 3 previous: n/a since-previous: n/a on-listed: n/a open-total: 19 rules: 3 of 3

| rule | guidance | open | recent-new |
|---|---|---|---|
| js:S1 | Remove unused imports | 3 | 2 |
| no-todo-comments | Resolve a TODO before merging rather than leaving it in the code | 5 | 1 |
| js:S2 | Avoid nested ternaries | 10 | 0 |
```

The rule identifier is any key of up to 64 letters, digits and `_ . : -`, so a rule from another analyser, such as the second row above, reads exactly as a generated one does. Guidance is one line of plain text.

### The generator

`bin/sonar-rules-table.mjs` fills the table from a SonarQube server. It is dependency-free Node, and it needs these environment variables and no others:

| Variable | Meaning |
|---|---|
| `SONAR_HOST_URL` | The server address. https is accepted; a user name or password in the address is refused |
| `SONAR_TOKEN` | The token, sent only in an Authorization header |
| `SONAR_PROJECT_KEY` | The project to read |
| `SONAR_ALLOW_HTTP` | Set to `1` to allow plain http. With http the token travels in cleartext, and the generator says so on stderr before it sends a request |

A person runs it from the repository root, after the analyser has finished analysing a merge, from a checkout of this repository: `node bin/sonar-rules-table.mjs` from this repository's root, or, for another repository, from that repository's root with the path to the generator in a checkout of this one. `bin/install.sh` also copies the generator into `~/.claude/bin/` as one of the optional files the drift check watches (the installer and the check read the same list), so an installed copy works too; the manual copy and `diff -q` lines are with the other `bin/` files in the maintenance notes. Supply the token on the same command line that runs node, read from your token file at that moment:

```bash
SONAR_TOKEN="$(cat path/to/your-token-file)" SONAR_HOST_URL=https://sonar.example.invalid SONAR_PROJECT_KEY=my-project node bin/sonar-rules-table.mjs
```

Never export the token into a shell session, never write or copy it into another file and never echo it. Use a token with Browse permission on the one project it reads, not a global admin token. Plain http needs `SONAR_ALLOW_HTTP=1` and sends the token in cleartext. A token that may not read the analysed revision still works: the revision is recorded as unknown and the run says which cause applied: the token may not read it, the server returned no analysis, or the analysis carries no revision.

What it does: it asks the server for the rules new code tripped in the last 30 days and for the largest open rules, chooses up to 20 rows with recent-new rules first and then by open count, looks up each new rule's own name for the guidance, and replaces the table atomically. It exits zero after writing, whatever the counts, and non-zero without writing when anything is wrong. Its summary says the rules kept out of the rules available, so a cut is never silent.

It is never a gate. Nothing automated runs it: not the conductor, not CI, not a hook. It writes no ledger line, and a person decides when to run it and commits the result. Each run starts a new measurement interval (the previous instant in the stamp is the previous run), so run it once per analysed merge and commit the result; casual reruns leave short, empty intervals that say nothing about whether the table is used.

Hand-written guidance survives a refresh. For a rule already in the table the generator updates the counts and leaves the guidance text as it found it; a rule new to the table arrives with the analyser's own rule name until someone improves it, and a rule the run no longer selects is dropped.

To use another analyser, or none, write the table by hand to the format above, with the same four columns and a stamp line. The builder reads a hand-written table exactly as it reads a generated one.

### Rollback

Deleting the table is the rollback: with no file, the builder carries on as before. Commit the deletion: the table is tracked, so a table deleted only in one checkout is still in every new build worktree. The `tdd-task` change rolls out, or back, by reinstalling the harness with `bin/install.sh` and restarting the Claude Code session. The installer does not touch `agents/implementer.md`, so that file changes only when you copy it by hand.

### Troubleshooting

- The generator exits non-zero. Cause: a missing environment variable, an http address without the opt-in, a rejected token, a project key the server does not know, a timeout, a redirect, or an answer whose shape the generator does not recognise. Action: read the one stderr line, which names the condition and the request that failed, and fix that; the existing table is left untouched. A failure on the local side, such as a read-only `.claude` directory or a full disk, is named by the system call, the error code and the path relative to the repository root, for example `open failed (EACCES) on .claude/...`; the error's own text is never printed.
- The table says zero rules. Cause: no issues were created in the window (issues since fixed still count, false positives and accepted ones do not), or the wrong project key was read. Action: check `SONAR_PROJECT_KEY` and that the analyser has finished analysing the merge, then run it again.
- The builder reports absent although the file exists. Cause: the file is not at `.claude/analyser-rules.md` exactly, is a symlink, is over a bound, or is not committed so the worktree lacks it. Action: check the path and that the file is tracked in git.
- The builder's report carries no rules-table line at all. Cause: the builder was dispatched outside `tdd-task` and the installed implementer is a replacement or older than this change; `bin/install.sh` never installs or updates `agents/implementer.md` at all (it is outside the installer's file set), so an operator's copy, whether replaced or simply older, is never changed by an install and reinstalling does not help. `tdd-task` names the table in its own prompts either way. Action: copy the current `agents/implementer.md` from a checkout into your agents directory by hand, or add the `The analyser rules table` section from it to your replacement.

## Tests

This repo's own tests need only Node (no `npm install`, no dependency
manifest):

```bash
node --test test/*.test.js
```

(`node --test` with no args also picks up `test/helpers/` and `test/fixtures/`
as if they were test files, since Node's default discovery matches every
`.js` file under a directory named `test`; the explicit glob avoids that.)

`test/helpers/fake-runtime.js` loads a workflow script from disk and runs it
against stubbed `agent`, `parallel`, `pipeline`, `phase`, `log`, `args` and
`budget`, recording every agent call, so the three instrumented workflows are
tested by driving them to completion with scripted responses rather than by
invoking real subagents.

## What's in the box

| Path | What |
|---|---|
| `AGENT-HARNESS.md` | The contract: lens roster, output format, severity scale, evidence discipline, conflict precedence, exit condition |
| `agents/lens-*.md` | Nine single-focus lens definitions (read-only tools) |
| `agents/reviewer-verification.md` | Adversarial correctness pass, no plan context |
| `agents/reviewer-experience.md` | User-facing text reviewed as the person receiving it |
| `workflows/plan-cycle.js` | Planning orchestration: scope, parallel lenses, simplicity veto, AC write-back |
| `workflows/review-cycle.js` | Review orchestration: scope + SHA pin, deterministic triggering, parallel worktree-isolated lenses, synthesis |
| `workflows/tdd-task.js` | Script-enforced TDD for one scoped change: implement is unreachable until RED is verified for the right reason; commit refused if tests changed between RED and GREEN |
| `workflows/lib/ledger-append.mjs` | Real-Node script (invoked via Bash, never imported: workflow scripts cannot import) owning the ledger envelope schema, path resolution, `.git/info/exclude` ignore-ensure and the atomic single-line append; invoked by all three workflows above |
| `workflows/optimise-cycle.js` | Delivery optimiser analysis: takes the collector's digest and a nonce, runs the mechanical proposal gates (citation, insufficient-data, security-removal, sample-size) and returns the report, the proposal-targets sidecar, each lane's status and a keyed digest of them; it runs no lane, reads no file and writes none |
| `workflows/lib/optimise-read.mjs` | Real-Node script owning ledger parsing/aggregation, gh/CI aggregation, the escaped-defect heuristic and stable proposal ids; run by the collector (`optimise-collect.mjs`), read-only |
| `workflows/lib/optimise-report-ignore.mjs` | Real-Node script that decides, once, where the optimiser's two outputs go (the main checkout) and whether their paths are ignored (it makes them so, confirms with git, and writes the proof the result check needs before it places); mirrors `ledger-append.mjs`'s own discipline and is the one place that runs git for that decision, kept in a separate file on purpose |
| `workflows/lib/optimise-collect.mjs` | Real-Node collector: the one program that runs `gh` and `git` for the optimiser; collects the ledger, git and CI data into a private per-run directory and writes the bounded digest |
| `workflows/lib/optimise-verify.mjs` | Real-Node, spawn-free result check shared by the weekly runner and the attended run: holds the reply to the collected files and to its keyed digest, validates and merges the sidecar under the one lock, and places both outputs |
| `skills/conduct-plan/` | Controller-loop skill for executing multi-PR plans without stalling; also logs task-level wait/PR events to the ledger |
| `skills/optimise-cycle/` | Usage, cadence, report format and the proposal-decision recording protocol for the delivery optimiser |
| `hooks/plan-guard-stop.py` | Stop hook enforcing the no-stall invariant during conducted plans |
| `hooks/destructive-git-guard.py` | PreToolUse hook refusing the enumerated `git checkout`/`switch`/`restore`/`reset --hard` shapes that would discard uncommitted TRACKED work, plus `git clean` and `git stash drop`/`clear`, which are the two rules covering UNTRACKED and STASHED work (see "Destructive git guard" above) -- a best-effort early catch, not a boundary: it stops accidents, not a determined attempt to hide a command from it, and the measured bypass classes are listed in "What this guard does not stop" |
| `hooks/git-snapshot.py` | Independent PreToolUse hook snapshotting uncommitted TRACKED changes before every Bash call, so destroyed work is recoverable regardless of how the destroying command was spelled (see "Recovering destroyed work" above) |
| `test/` | This repo's own test suite (`node --test test/*.test.js`); see "Tests" above |

## Cost and proportionality

A full review run spawns one subagent per triggered lens plus scope and
synthesis; on a large diff that is real token spend against your plan limits
(a 108-file review during development of this harness cost ~1.5M tokens).
The harness is built to scale down: lenses trigger only when the diff touches
their surface, `lenses: [...]` restricts a run explicitly, and lens-qa's
mutation experiments are capped per run. Running everything on everything
trains people to skim the output, which is worse than not running it.

## Design notes

- Lens agents pin `model: opus` in their frontmatter; scope and synthesis
  inherit your session model. Edit the frontmatter to change the trade-off.
- Review lenses run in worktrees because QA's job (break the guard, watch the
  test fail, restore) mutates files; parallel lenses sharing one tree would
  corrupt each other's evidence. Planning lenses are pure readers.
- Every lens must return a coverage statement including what it **could not
  check**. A lens returning CLEAN because it never looked is the failure this
  harness exists to prevent; CLEAN itself is a legitimate, expected outcome.

## License

MIT
