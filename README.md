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

The manual-copy install above puts a **copy** of `workflows/lib/` (and any
plugin install does the same, at its own plugin-managed path) at
`~/.claude/workflows/lib/`. That installed copy, not this repo, is what
actually executes for a delivery repo -- a fix landed here can be green in
this repo's own test suite while the installed mirror keeps running the old
code, silently. Every change to `workflows/lib/ledger-append.mjs` or
`workflows/lib/optimise-read.mjs` must be re-synced after merging:

```bash
cp -r claude-ai-harness/workflows/lib/. ~/.claude/workflows/lib/
```

Confirm the installed copy actually matches this repo (exits 0, no output,
when they agree; lists the differing files otherwise):

```bash
diff -rq claude-ai-harness/workflows/lib ~/.claude/workflows/lib
```

A stale mirror is also detectable from the optimiser's own report without
running either command by hand: `workflows/lib/ledger-append.mjs`'s
`SCHEMA_VERSION` was bumped (1 to 2) by the plan-identity canonicalisation
change, and `optimise-read.mjs ledger`'s `perRepo[].schemaVersionsSeen`
reports the schema-version mix actually seen per repo -- a stale installed
writer still emitting `schema_version: 1` shows up there in the next report
instead of continuing silently.

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
its steps may create or modify. Every proposal carries
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
