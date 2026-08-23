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

```bash
git clone https://github.com/bassings/claude-ai-harness
cp claude-ai-harness/agents/*.md ~/.claude/agents/
cp -r claude-ai-harness/workflows/. ~/.claude/workflows/
cp -r claude-ai-harness/skills/. ~/.claude/skills/
cp -r claude-ai-harness/hooks/. ~/.claude/hooks/
cp claude-ai-harness/AGENT-HARNESS.md ~/.claude/
```

Then **start a new Claude Code session** -- the workflow scripts are read
when a session starts, so an install performed inside an already-open session
is invisible to it (see the next section) -- and in any project:

```
/plan-cycle {"spec": "specs/MY-FEATURE.md"}
/review-cycle
```

### Making a change live: copying the files is not deploying them (AC-OPS-4)

`cp -r` distributes **source**. It does not deploy. The two halves of
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
`redact-transcript.mjs`, `install-consistency.mjs` -- are not part of that capture. A workflow script has
no filesystem access, so it instructs an agent to shell out to
`node ~/.claude/workflows/lib/<file>.mjs` (see the resolution order in
`plan-cycle.js:100-106`, global mirror first). `node` reads the file when the
process starts, so a copied `.mjs` is live on the very next run, in the same
session.

Nothing detects this for you. The `schema_version` staleness signal described
further down does **not** detect a stale top-level workflow script: that fix
class bumps no `SCHEMA_VERSION` and adds no ledger field, so a session running
last week's `plan-cycle.js` produces a ledger indistinguishable from a current
one. The restart is the control; there is no alarm behind it.

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
report: `ledger-append.mjs`'s `SCHEMA_VERSION` was bumped (1 to 2) by the
plan-identity canonicalisation change, and `optimise-read.mjs ledger`'s
`perRepo[].schemaVersionsSeen` reports the schema-version mix actually seen
per repo, so a stale installed writer still emitting `schema_version: 1`
surfaces there instead of failing silently.

**This signal does not cover every staleness class**, and it covers none of
the session-snapshot class above. Additive, optional fields
(the start/terminal exception guard, `invalid_ac_ids_dropped`, `ac_id_raw`)
bump no `SCHEMA_VERSION` by design, so a stale top-level script or a stale
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
/optimise-cycle {"repos": ["../delivery-repo-a", "../delivery-repo-b"]}
```

Read-only: fans out to three parallel lanes (ledger, GitHub Actions via
`gh`, git history) and writes a ranked, cited report of proposed changes —
it never applies one itself.

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
  instructions. It never fires outside conducted plans, never double-blocks
  (`stop_hook_active`), and allows `status: blocked-on-human`.

Installing as a plugin wires the hook automatically. For manual installs,
copy the hook and add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "python3",
      "args": ["~/.claude/hooks/plan-guard-stop.py"], "timeout": 10 }] }]
  }
}
```

## Destructive git guard

An agent ran `git checkout -- <file>` on its own uncommitted work three
times in one session and destroyed its edits each time, despite
`docs/harn-opt-2-mutation-proofs.md` forbidding it by name. Prose did not
prevent it, so the rule is now a mechanism:

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
  unstages), and `git reset --hard` whenever the working tree, or the named
  paths, actually have something to lose. `git status` decides that on
  every call: a clean tree or clean named paths are let through untouched,
  including `git checkout -b`, a bare `git checkout <branch>` that resolves
  as a ref (git itself refuses the switch if it would actually overwrite
  uncommitted work), and `git restore --staged` -- a guard that blocks
  harmless commands gets disabled, which is worse than no guard. Refusal is
  exit code 2 with the reason on stderr (the one PreToolUse exit code Claude
  Code treats as blocking) and names the safe alternative: copy the file to
  a scratch path first, or `git stash`.
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
  expanded so `-f` is still seen as force. A `cd <path>` earlier in the same
  command changes which directory later segments are scoped against, so
  `cd <dir> && git checkout -- <path>` is judged against `<dir>`, not the
  tool call's own working directory -- and when that target cannot be
  resolved without actually running a shell (a variable, `cd -`, a bare
  `cd`), the guard now ALLOWS the rest of the command through (fails open,
  like every other shape this tokenizer cannot positively identify): the
  snapshot mechanism below is what actually covers that gap, not a refusal
  that used to guess wrong as often as it guessed right.
- **Escape hatch**: for a revert that is genuinely deliberate, set
  `HARNESS_ALLOW_DESTRUCTIVE_GIT=1`, either as this hook process's own
  environment (exported for the session) or as a genuine env-prefix
  assignment on the SAME command segment as the destructive call
  (`HARNESS_ALLOW_DESTRUCTIVE_GIT=1 git checkout -- file`, ordinary shell
  env-prefix syntax). This is deliberately not a text search over the whole
  command: a quoted mention, a code comment, or an assignment that prefixes
  a different, unrelated segment on the same line must not disarm a refusal
  it was never meant to cover.
- **Deliberately out of scope**: this hook does not intercept `git clean`
  (`-f`/`-x`/`-d` in any combination), `git stash drop`, `git worktree
  remove --force`, `git branch -D`, or any command reached through a
  subshell, backtick, here-doc or unbalanced quote the tokenizer cannot
  parse (all fail open by design -- see the module docstring). All of these
  can destroy content with no copy anywhere in git; an aggressive `git
  clean` (force, untracked directories and ignored files together) doing
  exactly that to a whole `.claude/` directory is recorded in
  `specs/harn-opt-3.md`'s AC-DATA-5. Untracked files generally are outside
  this guard's scope: none of the commands it DOES intercept can lose an
  untracked file, but that is not the same claim as "nothing here can lose
  one" -- know the boundary before relying on it.

**This detector is a best-effort early catch, not a boundary.** It is a
blocklist over a Turing-complete input language (the set of shell spellings
that reach the same destructive `git` call is unbounded), and three review
rounds each closed a batch of bypasses only for the next round to find more
(see `specs/harn-fix-2.md`'s Problem section for the round-by-round count).
It makes no completeness claim. Measured-open bypass classes, none of them
guarded and none of them planned to be (the recovery mechanism below is what
actually closes this): an `env` or `command` prefix, a command-substitution
binary path such as `$(which git)`, `eval`, a backtick or subshell, `bash
-c`, `xargs`, a here-document, and any input the tokenizer cannot parse.
Writing or quoting a guarded command as inert TEXT -- inside a here-document
body, a quoted string, or a `grep`/`echo` argument -- is deliberately not
refused: nothing there executes, and refusing it is exactly the noise
failure that gets a guard switched off.

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
        "args": ["/ABSOLUTE/PATH/TO/HOME/.claude/hooks/destructive-git-guard.py"], "timeout": 10 },
      { "type": "command", "command": "python3",
        "args": ["/ABSOLUTE/PATH/TO/HOME/.claude/hooks/git-snapshot.py"], "timeout": 10 }
    ] }]
  }
}
```

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
- The **in-process cross-check** compares the fields the scope agent
  reports as instructed against the literal `PLAN_SCHEMA`/`REVIEW_SCHEMA`
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

**Report**: written to `.claude/optimise-cycle-report.md` in the repo the
cycle was invoked in — gitignored via `.git/info/exclude` and verified with
`git check-ignore -q` before every write (the write is refused if that
check fails), mirroring `ledger-append.mjs`'s own discipline exactly via
`workflows/lib/optimise-report-ignore.mjs`, and the **only** file any of
its steps may create or modify.

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

**Args**: `{repos?: string[] (default: the current repo), window?: number
(ledger lines per repo; default 2000)}` — never a hardcoded path or repo
name; the repos it reads always come from `args` or its documented default.

### Weekly scheduled run (HARN-OPT-2 T3)

The weekly cadence above runs as a local launchd job
(`com.local.optimise-cycle-weekly`, Mondays 07:41 local), driven by
`bin/optimise-cycle-weekly.sh` in this repo. That script loops over the
configured delivery repos, invokes `claude -p "/optimise-cycle ..."`
headlessly against each (read-only, never applying a proposal, same as
every other invocation of the cycle), and appends one redacted transcript
per repo to `~/.claude/logs/optimise-cycle-weekly.log`.

**PASS/FAIL is decided from the report artefact and this script's own
observations, never from what the model said.** A repo passes only if,
after the run: `<repo>/.claude/optimise-cycle-report.md` exists; its mtime
is at or after the timestamp captured immediately before that repo's run
started (this is what catches a stale report left over from a previous
week -- the one failure mode a status-only check cannot see, since a
leftover file looks identical to a fresh one to anything that only asks
"does it exist"); and it is non-empty with at least a markdown heading and
a section heading. The model's free-text reply is still appended to the
log as diagnostic context, but the verdict never depends on it: a run that
exits 0 and says nothing is a PASS if the artefact is genuinely fresh, and
a run that exits 0 and says the right words is a FAIL if the artefact is
stale, missing or empty. Each repo gets one `RESULT PASS`/`RESULT FAIL`
line naming the reason; the script exits non-zero if any repo failed.

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

**The real per-repo timeout is ~600s by default, not `timeout 3600`.** The
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

**Permission constraints on the unattended job -- defence in depth, not a
boundary.** `claude -p` runs here with `--disallowedTools` denying the
destructive and outward-facing operations this read-only job never needs:
`Bash(rm:*)`, `Bash(sudo:*)`, `Bash(git push:*)`, `Bash(git commit:*)`,
`Bash(git reset:*)`, `Bash(gh pr merge:*)`, `Bash(gh pr create:*)`,
`Bash(gh issue create:*)`, `Bash(gh release create:*)`,
`Bash(gh workflow run:*)`, `Bash(curl:*)`, `Bash(wget:*)`, alongside
`--settings '{"disableAllHooks": true}'` (see the plan-guard note below).
Both are real: verified empirically, end to end, against a throwaway repo
with both flags applied, a well-formed report was still produced (exit 0),
and every one of the listed tools genuinely refused when invoked directly.
**They are not a sandbox, and nothing here claims they are one.** The same
real run showed `Write`, `Edit`, `mv` and `python3 -c` all succeed under
this exact flag set -- `--disallowedTools` denies only its literal
enumerated targets, and `--settings` **merges** with (does not replace)
the global `defaultMode: auto`, so a tool not on the list is still
reachable. The actual containment for this job is the prompt's own
read-only instruction plus the fact that the verdict never trusts what the
model says (PASS/FAIL above); these flags are real, additional defence in
depth behind that, not a second, independent boundary. `--permission-mode
plan` was considered and rejected: plan mode would prevent the optimiser
writing the report this script's own verdict depends on, silently trading
a permission problem for a job that runs and produces nothing.
`test/static-checks.test.js` pins the exact deny tokens and the
`disableAllHooks` blob in the script text, so neither can be quietly
dropped -- deleting either previously left the whole weekly-runner test
suite green, since every test there drives a stub `claude`, never the real
flags.

**The plan-guard Stop hook is the one measured mutation source, and
`disableAllHooks` genuinely stops it.** Measured 2026-08-16: the
globally-installed conductor plan-guard Stop hook touched
`.claude/active-plan` in both delivery repos during the real run, as a
side effect of the background workflow the optimiser launches -- nothing
this script does, but a mutation of the analysed repo all the same.
`--settings '{"disableAllHooks": true}'` stops that hook firing for this
one invocation (verified empirically: `.claude/active-plan`'s mtime was
unchanged after a real run against a repo with the identical hook wired
and an open-task plan active). There is no postcondition checking this
after the fact any more (see the subtraction-round note above for why).

**Keep `~/.claude/bin/optimise-cycle-weekly.sh`, `~/.claude/bin/redact-transcript.mjs`
and `~/.claude/bin/com.local.optimise-cycle-weekly.plist` copied from this
repo's `bin/`** after merging any change to them. Unlike the top-level
workflow scripts above, copying these genuinely does deploy them: launchd
spawns a fresh shell process per run, which reads the file at exec, so there
is no snapshot and no restart step. The `diff -q` pair is therefore a
sufficient check here, not merely a necessary one:

```bash
cp claude-ai-harness/bin/optimise-cycle-weekly.sh ~/.claude/bin/optimise-cycle-weekly.sh
cp claude-ai-harness/bin/redact-transcript.mjs ~/.claude/bin/redact-transcript.mjs
chmod +x ~/.claude/bin/optimise-cycle-weekly.sh
diff -q claude-ai-harness/bin/optimise-cycle-weekly.sh ~/.claude/bin/optimise-cycle-weekly.sh
diff -q claude-ai-harness/bin/redact-transcript.mjs ~/.claude/bin/redact-transcript.mjs
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

If the file does not exist, the script still runs cleanly with an empty
repo list (a clean start/done log, exit 0, nothing to do) rather than
crashing or falling back to any hardcoded path -- this public repo carries
no private repo names or account paths in its own tracked files
(`test/static-checks.test.js` guards `bin/` for exactly that).

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
prunes it. Measured: ~640 bytes per run (two repos), roughly 33 KB/year at
the weekly cadence -- rotation is deliberately **not** implemented, since
it would risk truncating the only place a real run's `RESULT` lines live,
for a growth rate too small to justify the risk. **Delete it** with
`rm ~/.claude/logs/optimise-cycle-weekly.log` -- the next scheduled run
recreates it automatically. The transcript portion of each entry is
redacted (`bin/redact-transcript.mjs`, reusing `workflows/lib/ledger-append.mjs`'s
`redactPaths`) and every line this script itself writes uses the repo's
basename rather than its absolute filesystem path, so the log carries no
`/Users/`, `/Volumes/`, `/home/` path or account name -- the same standard
the ledger and report already hold themselves to (AC-SEC-3 in
`specs/optimise-cycle.md`).

**Two redaction fixes landed in the T3 subtraction round (conductor log
tick 46), against a real leaked line**, not a synthetic one: an archived
2026-08-16 log line naming a real delivery repo's report path, fed through
the redactor as it shipped, came through **completely unchanged**, because
Claude formats a path in backticks by default and `ABSOLUTE_PATH_RE`'s
prefix class did not recognise one.

- `ABSOLUTE_PATH_RE` (`workflows/lib/ledger-append.mjs`) now also anchors
  on a backtick, `` = ``, `[`, `<` or `,` immediately before a path, and on
  `:` when not immediately followed by `//` (so a `https://`/`http://` URL
  in ordinary prose is never mistaken for a path and mangled -- proven
  both ways in `test/ledger-append.test.js`).
- `bin/redact-transcript.mjs` adds a second, belt-and-braces pass **after**
  the regex: a plain literal-substring replacement of this process's own
  `os.homedir()` and `os.userInfo().username`. This catches every form a
  regex over free-text prose can miss, including a bare `$(whoami)` leak
  with no path shape at all to anchor on (proven separately, in a stub
  that printed the account name with no surrounding path).

Separately: the redaction-failure fallback message (when
`redact-transcript.mjs` is missing or fails) now names the script by its
**relative** path (`bin/redact-transcript.mjs`), not `$REDACT_SCRIPT`'s
absolute one -- the earlier form put this operator's own account path into
the very fallback message that exists to protect against exactly that
leak, and that branch was live: the installed mirror had no
`redact-transcript.mjs` at all until the copy step documented above was
added.

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
| `workflows/optimise-cycle.js` | Delivery optimiser orchestration: three parallel lanes (ledger, gh, git), mechanical proposal gates (citation, insufficient-data, security-removal, sample-size), report persistence |
| `workflows/lib/optimise-read.mjs` | Real-Node script owning ledger parsing/aggregation, gh/CI aggregation, the escaped-defect heuristic and stable proposal ids; invoked by `optimise-cycle.js`, read-only |
| `workflows/lib/optimise-report-ignore.mjs` | Real-Node script ensuring the optimiser's report path is gitignored before every write, mirroring `ledger-append.mjs`'s own discipline; the one narrowly-scoped exception to `optimise-read.mjs`'s read-only contract, kept in a separate file on purpose |
| `skills/conduct-plan/` | Controller-loop skill for executing multi-PR plans without stalling; also logs task-level wait/PR events to the ledger |
| `skills/optimise-cycle/` | Usage, cadence, report format and the proposal-decision recording protocol for the delivery optimiser |
| `hooks/plan-guard-stop.py` | Stop hook enforcing the no-stall invariant during conducted plans |
| `hooks/destructive-git-guard.py` | PreToolUse hook refusing the enumerated `git checkout`/`switch`/`restore`/`reset --hard` shapes (see "Destructive git guard" above) that would discard uncommitted TRACKED work -- a best-effort early catch, not a boundary: `git clean`, `stash drop` and any spelling it cannot parse are explicitly out of scope |
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
