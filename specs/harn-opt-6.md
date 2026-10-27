# HARN-OPT-6: ledger payloads the agent emits carry no free text

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft
**Lenses run:** (filled by plan-cycle) · **Skipped:** (filled by plan-cycle)

## Problem

Every plan-cycle, review-cycle and tdd-task run appends a started row and a
terminal row to `.claude/harness-ledger.jsonl` by having a workflow agent
write a base64 payload to a temp file (Write tool) and pipe it to
`workflows/lib/ledger-append.mjs` (HARN-OPT-5 T5). HARN-OPT-5's AC-OPS-13
measured that transport live: of twelve writes, four were stopped by the
runtime's safety classifier before the writer ran. All four were review-cycle
runs, and the stopped payloads were the ones carrying lens text: the terminal
review payload sends `spec_bugs`, `rejected_findings`, `open_findings`,
`prior_findings` and `fixed_findings` as raw `{lens, location, claim, ...}`
descriptors, which the writer then hashes into finding ids and discards. The
classifier reacts to the agent emitting a large opaque blob in any tool call
(tick 55 of `specs/harn-opt-5.md`), not to the shell command.

Cost today: roughly a third of review-cycle rows are missing or conductor-
written by hand, so `/optimise-cycle` reads a ledger with gaps exactly where
rework is measured, and every conducted plan spends conductor time minting
replacement rows. The descriptors also put a lens's quoted evidence, which can
include a source line or a path under the operator's home directory, inside
an agent tool call whose only purpose is to be hashed away.

Direction, recorded at HARN-OPT-5 tick 55: the payload the agent emits carries
no free text and stays small. Finding ids are computed inside the workflow
script with a pure-JS sha256 (the way `toBase64` is already pure JS, since
workflow scripts have no `node:crypto`), so the descriptors never travel.

## Not in scope

- Changing the ledger file's location, its gitignore discipline, or the
  started/terminal row pairing.
- Changing what the optimiser reads or reports. Rows keep their current shape
  on disk; only how they get there changes.
- Replacing the agent-mediated write with a different transport (a hook, an
  MCP server). Worth revisiting only if a no-free-text payload is still
  stopped in live runs.
- tdd-task and plan-cycle payload content beyond what the shared change
  touches: they carry no lens text today.

## What this replaces

| What goes | Owning lens | Removal criterion |
|---|---|---|
| Raw finding descriptors (`lens`, `location`, `claim`) in review-cycle's terminal ledger payload | security | AC-SEC-<n> |
| ledger-append.mjs hashing descriptors it receives from a payload, for review_cycle rows | data | AC-DATA-<n> |
| Conductor hand-written replacement rows for classifier-stopped review writes, as a routine step | operability | AC-OPS-<n> |

---

## Acceptance criteria

(Written by plan-cycle.)

---

## Vetoes and trade-offs

| Item | Raised by | Decision | Rationale |
|---|---|---|---|

## Spec gaps found at review

## Tasks
