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

Then in any project:

```
/plan-cycle {"spec": "specs/MY-FEATURE.md"}
/review-cycle
```

### Keeping the installed mirror in sync (AC-OPS-4)

The manual-copy install above puts a **copy** of the whole `workflows/`
tree -- both the top-level workflow scripts (`tdd-task.js`, `review-cycle.js`,
`plan-cycle.js`, `optimise-cycle.js`) and `workflows/lib/` (and any plugin
install does the same, at its own plugin-managed path) -- at
`~/.claude/workflows/`. That installed copy, not this repo, is what
actually executes for a delivery repo -- a fix landed here can be green in
this repo's own test suite while the installed mirror keeps running the old
code, silently. Review round 1 of PR 2 (HARN-OPT-2) found this section had
only ever documented re-syncing `workflows/lib/`, while PR 2's entire fix
(the start/terminal exception guard) lives in the three TOP-LEVEL workflow
scripts -- an operator following only the `workflows/lib/` steps below would
get a clean exit 0 while the live top-level copies kept crashing without
terminal records.

**Re-sync the whole tree** after merging any change under `workflows/`,
whether it touched a top-level script or `workflows/lib/`:

```bash
cp -r claude-ai-harness/workflows/. ~/.claude/workflows/
```

Confirm the installed copy actually matches this repo (exits 0, no output,
when they agree; lists the differing files otherwise):

```bash
diff -rq claude-ai-harness/workflows ~/.claude/workflows
```

If you only touched `workflows/lib/` (e.g. `ledger-append.mjs` or
`optimise-read.mjs`) and want a narrower command, the equivalent pair
scoped to that directory still works:

```bash
cp -r claude-ai-harness/workflows/lib/. ~/.claude/workflows/lib/
diff -rq claude-ai-harness/workflows/lib ~/.claude/workflows/lib
```

**Always re-sync the whole tree, never an enumerated subset.** Review
round 2 of PR 2 found the previous revision of this section named "the four
files this PR touched" -- a list that was already stale by the time review
round 2 alone landed a further six commits touching all six files under
`workflows/` (the three top-level scripts, `ledger-append.mjs`,
`optimise-read.mjs`, `optimise-cycle.js`). Any hand-maintained per-PR
enumeration goes stale the moment a later round adds one more touched file;
the whole-tree `cp -r`/`diff -rq` pair above is the one command pair that is
correct regardless of which files a given PR touched, so it is the only
form documented here.

A stale `workflows/lib/` mirror is *sometimes* detectable from the
optimiser's own report without running either command by hand:
`workflows/lib/ledger-append.mjs`'s `SCHEMA_VERSION` was bumped (1 to 2) by
PR 1's plan-identity canonicalisation change, and `optimise-read.mjs
ledger`'s `perRepo[].schemaVersionsSeen` reports the schema-version mix
actually seen per repo -- a stale installed writer still emitting
`schema_version: 1` shows up there in the next report instead of continuing
silently. **This signal does not cover every staleness class.** PR 2's
exception-guard fix, and review round 2's `invalid_ac_ids_dropped`/
`ac_id_raw` fields, both bumped no `SCHEMA_VERSION` (they are additive and
optional, by design, so an older writer or reader omitting them is not
itself an error) -- a stale `tdd-task.js`/`review-cycle.js`/`plan-cycle.js`,
or a stale `optimise-read.mjs` reading a newer ledger, produces no
`schemaVersionsSeen` difference at all. What covers THAT gap is the
report's own rendering, not the schema version: a genuinely stale or absent
reader field renders as an explicit "unavailable (installed
optimise-read.mjs predates this field)" marker rather than a confident
zero (review round 2, H-1) -- so the report tells you when it cannot see a
signal, even though `schemaVersionsSeen` cannot. **The `diff -rq` command
above is still the only check that proves the installed tree is byte-for-byte
current** -- the report's markers are a second line of defence for when that
check was skipped, not a replacement for it.

### Sync ordering matters: never let the reader lag behind the writer (AC-OPS-11)

If `workflows/lib/` and the three top-level scripts are ever synced
separately rather than as one `cp -r`, sync them in this order: **the
reader (`optimise-read.mjs`) first, the writer (the top-level scripts) last**
-- never the other way round, and never leave them split for longer than the
one command it takes to finish the sync.

Verified directly against this repo: an installed reader from before this
PR (`git show main:workflows/lib/optimise-read.mjs`) has no concept of a
crashed run at all, because on `main` the top-level scripts have no
exception guard -- a crash there can only ever leave an *unpaired* start
record (correctly counted as unmeasured). This PR's exception guard makes a
crash produce a real, *paired* terminal record (`outcome: 'aborted'`) for
the first time. Fed that same pair, the OLD reader has no `outcome`-aware
branch at all: it counts any complete pair as a plain measured run,
indistinguishable from a real success --

```
OLD reader:  agentComputeSeconds: 5, agentComputeMeasuredRuns: 1   (the crash reads as a healthy 5-second run)
NEW reader:  agentComputeSeconds: null, agentComputeMeasuredRuns: 0, agentComputeAbortedPairs: 1, agentComputeAbortedSeconds: 5
```

That is the failure this section warns against: **a NEWER writer paired
with an OLDER reader silently converts a crashed run into an
apparently-healthy one**, because the writer's new capability (a guaranteed
terminal record even on crash) reaches a reader that has no idea that
capability, or the `aborted` outcome it produces, exists yet. A newer
reader paired with an older writer is comparatively safe: the older writer
simply never produces the fields the newer reader looks for, and those
fields render as the explicit "unavailable" marker above rather than a
wrong number.

**Rollback drill, executed against this repo's own tree** (not merely
described): populating a scratch "installed mirror" from `main`, then
applying only `workflows/lib/optimise-read.mjs` forward (the exact partial
sync this section warns against) still leaves `diff -rq` reporting five
further differing files -- the three top-level scripts and the other two
`workflows/lib/` files. `diff -rq` cannot see the outcome-classification
regression above directly (it compares files, not aggregation behaviour),
but it reliably flags that *some* file in the tree is out of sync whenever
a partial sync is attempted, which is why the "always re-sync/verify the
whole tree" rule above is the actual mitigation: a partial sync is only
possible by skipping the verification step, never by passing it.

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
every other invocation of the cycle), and appends one transcript per repo
to `~/.claude/logs/optimise-cycle-weekly.log`.

**PASS/FAIL is decided from the report artefact, never from what the model
said.** A repo passes only if, after the run, `<repo>/.claude/optimise-cycle-report.md`
exists, its mtime is at or after the timestamp captured immediately before
that repo's run started (this is what catches a stale report left over from
a previous week -- the one failure mode a status-only check cannot see, since
a leftover file looks identical to a fresh one to anything that only asks
"does it exist"), and it is non-empty with at least a markdown heading and a
section heading. The model's free-text reply is still appended to the log
as diagnostic context, but the verdict never depends on it: a run that exits
0 and says nothing is a PASS if the artefact is genuinely fresh, and a run
that exits 0 and says the right words is a FAIL if the artefact is stale,
missing or empty. Each repo gets one `RESULT PASS`/`RESULT FAIL` line naming
the reason; the script exits non-zero if any repo failed, and a non-git
directory in the repo list is skipped rather than counted as a failure.
Covered by `test/weekly-runner.test.js`, which drives the real script
against real temp git repos with a stub `claude` on PATH -- no test run ever
makes a real model call.

**Keep `~/.claude/bin/optimise-cycle-weekly.sh` synced from this repo's
`bin/optimise-cycle-weekly.sh`** after merging any change to it, the same
discipline as the `workflows/` mirror above (AC-OPS-4):

```bash
cp claude-ai-harness/bin/optimise-cycle-weekly.sh ~/.claude/bin/optimise-cycle-weekly.sh
chmod +x ~/.claude/bin/optimise-cycle-weekly.sh
diff -q claude-ai-harness/bin/optimise-cycle-weekly.sh ~/.claude/bin/optimise-cycle-weekly.sh
```

As of this change, that sync has not yet happened: `~/.claude/bin/optimise-cycle-weekly.sh`
is still the pre-existing, unreviewed version this PR replaces, and re-syncing
it is a merge-time step, not something this branch does to a path outside
the repo.

`OPTIMISE_WEEKLY_REPOS` (newline-separated repo list) and
`OPTIMISE_WEEKLY_LOG` (log file path) are read by the script but exist only
as a test seam for `test/weekly-runner.test.js`; they are never operator
configuration and neither is documented as a knob to set.

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
