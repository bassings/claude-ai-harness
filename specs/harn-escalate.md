# HARN-ESCALATE: try a stronger, fresh agent before escalating a stalled task to the owner

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft (plan-cycle not yet run)
**Lenses run:** none yet · **Skipped:** to be decided at plan-cycle (no UI, so design and accessibility are expected to be skipped)
**Applies to:** both harnesses (claude-ai-harness first; carried to codex-ai-harness under PLAN-harness-parity)

## Problem

Asked by the owner on 2026-10-12, after HARN-OPT-4 T6 sat blocked on a human decision for about six hours overnight: "Does our harness include trying a higher model before sending to a human for decision? Can you fix that so it happens."

Measured answer: no, and the two written rules contradict each other.

- `~/.claude/CLAUDE.md` §2, "The fix loop is bounded, and it escalates": rounds 1 to 3 resume the same implementer; rounds 4 to 5 use a **fresh implementer on a more capable model**; at 5, stop and adjudicate. The same section says this is prose and wants mechanising.
- `skills/conduct-plan/SKILL.md`, "Rework circuit-breaker" (added 2026-08-12): stop and write the block for the human at **three fix rounds or the first self-inflicted regression, whichever comes first**. This fires before the rounds-4-to-5 rung of the table can ever run, so that rung has never executed.
- Every roster agent (`agents/*.md`) is pinned `model: opus`; the conductor runs on the session model (Fable 5.1 today). No workflow (`tdd-task.js`, `review-cycle.js`, `plan-cycle.js`, `optimise-cycle.js`) passes a `model` option to any `agent()` call, so there is no mechanism to escalate with. The workflow runtime does support `opts.model` and `opts.agentType` on `agent()`.
- The ledger schema (`workflows/lib/ledger-schema-fields.json`) records no model per run, so the optimiser cannot tell whether a stronger model changes the fixed-per-round rate.

Cost today: one owner wait per circuit-breaker, measured at roughly six hours on T6; the owner is the slowest link in the loop and is woken for a correctness call the harness has not yet tried its own strongest tool on.

## Proposed shape (for plan-cycle to criticise)

1. **One escalation round before the human.** When the breaker condition is met (three fix rounds, or first self-inflicted regression), the conductor dispatches exactly one further round to a **fresh** implementer (no prior-round context, the review findings and the spec only) on the **stronger model tier**, via `tdd-task` with a `model` argument. If that round's review comes back clean, merge; if not, write the block for the owner as today, with the escalation round's result in the note. Never a second escalation round.
2. **Mechanism, not prose.** `tdd-task.js` accepts an optional `model` argument and passes it through to its implementer `agent()` calls (test and implement phases) and records it in the ledger row. The conductor skill names the exact invocation. `CLAUDE.md` §2's table and the skill's breaker paragraph are rewritten to say the same thing.
3. **Measured.** The ledger row for `tdd_task` and `review_cycle` runs carries `model` (string or null; absent for older rows; SCHEMA_VERSION bump), and the optimiser's rework attribution reports fixed-per-round split by model when both tiers are present, so a future cycle can retire the rung if it never helps.
4. **Bounded cost.** The escalation round is one tdd-task run plus one review round, at the stronger tier's price; the skill states the expected cost and the conductor logs it in the tick.

## Not in scope

- Changing which model lenses run on (review stays on Opus unless a later measurement says otherwise).
- Automatic merges without a clean review: the escalation round still goes through the review cycle.
- The Codex harness implementation itself: this spec defines the behaviour; the Codex-side change is tracked under `codex-ai-harness` `specs/PLAN-harness-parity.md`.
- Choosing a model tier by name in prose anywhere a mechanism can carry it.

## What this replaces

| What goes | Owning lens | Removal criterion |
|---|---|---|
| CLAUDE.md §2 rows "4 to 5: fresh implementer, more capable model" and "At 5: adjudicate" as written (superseded by the single escalation round at the breaker) | product | AC-PROD-n |
| The skill's breaker paragraph's direct hand-off to the human without an escalation round | operability | AC-OPS-n |

---

## Acceptance criteria

*To be written by plan-cycle.*

---

## Vetoes and trade-offs

| Item | Raised by | Decision | Rationale |
|---|---|---|---|
| | | | |

## Spec gaps found at review

*(none yet)*
